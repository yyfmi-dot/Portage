import { execFile } from "node:child_process";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { markedMessageIds } from "@portage/core";
import type {
  AdapterCapabilityFlags,
  Delivery,
  DiscoveredEndpoint,
  InjectResult,
  Message,
  NativeReadResult,
  Readiness,
  Session,
  SessionAdapter,
  VerifyResult,
} from "@portage/core";
import { processTable } from "../cli/process-discovery.js";
import { readTranscript, turnState, type TranscriptDialect } from "./transcripts.js";

const execFileAsync = promisify(execFile);

/** How Portage's MCP server is started inside a turn, so the agent can answer through Portage. */
export type McpLaunch = { command: string; args: string[] };

export type TurnEnd = { sessionId: string; ok: boolean; error?: string };

export type TranscriptAdapterOptions = {
  id: string;
  dialect: TranscriptDialect;
  /** Portage MCP server launch; `--session <id>` is appended per session. */
  mcp: McpLaunch;
  onTurnEnd: (end: TurnEnd) => void;
  /** How long a turn may take to report it started before the submission counts as uncertain. */
  startTimeoutMs?: number;
  /** A transcript written this recently by someone else means an interactive client is using it. */
  recentWriteMs?: number;
  /**
   * A turn left open with no live process holding the session and no write for this long was
   * abandoned (a crashed client), not running.
   */
  staleTurnMs?: number;
  discoverLimit?: number;
};

/** History imported when a session is first read: enough to show where the conversation is. */
const INITIAL_HISTORY = 20;

/**
 * A native CLI session Portage drives through the CLI and reads back from its on-disk transcript.
 * Subclasses decide how a turn runs; discovery, readiness, read-back, proof and titles are shared.
 *
 * Portage is where the session is driven from. Another client merely having it open (an app or
 * editor that loaded it days ago) does not block; a turn running there does — the delivery waits
 * for it to finish (`attached`), as the CLI's own queue would. That client shows Portage's turns
 * once it reloads the session.
 */
export abstract class TranscriptAdapter implements SessionAdapter {
  readonly id: string;
  abstract readonly capabilities: AdapterCapabilityFlags;
  private readonly paths = new Map<string, string>();
  /** When our own last turn on a session ended — its transcript writes are not someone else's. */
  private readonly lastTurnEnd = new Map<string, number>();
  private readonly titles = new Map<string, { source: string; mtime: number; title?: string }>();

  constructor(protected readonly base: TranscriptAdapterOptions) {
    this.id = base.id;
  }

  get provider() {
    return this.base.dialect.provider;
  }

  /** Where the CLI is, or undefined when it is not installed. */
  protected abstract binary(): Promise<string | undefined>;
  /** Whether Portage is running a turn on the session right now. */
  abstract isRunning(sessionId: string): boolean;
  /** Stop a running Portage turn. */
  abstract interrupt(sessionId: string): boolean;
  abstract inject(session: Session, message: Message, compiledQuery: string, delivery?: Delivery): Promise<InjectResult>;
  /** Rename through the CLI's own mechanism. */
  protected abstract renameNative(input: { binary: string; session: Session; transcript: string; title: string }): Promise<void>;
  /** Processes that are Portage's own (its turns), never "another client". */
  protected abstract ownChildPids(): number[];
  /** Readiness only the subclass knows (its own turn in flight); undefined to continue the shared checks. */
  protected ownReadiness(_session: Session): Readiness | undefined {
    return undefined;
  }

  async discover(): Promise<DiscoveredEndpoint[]> {
    const { dialect } = this.base;
    const paths = await dialect.recent(this.base.discoverLimit ?? 40);
    const attached = await this.openTranscripts(paths);
    const out: DiscoveredEndpoint[] = [];
    for (const path of paths) {
      const info = await dialect.describe(path).catch(() => undefined);
      if (!info) continue;
      out.push({
        suggestedSessionKey: `${dialect.provider}:${info.nativeSessionId}`,
        provider: dialect.provider,
        harness: "cli",
        host: info.host,
        nativeSessionId: info.nativeSessionId,
        displayName: info.title || `${dialect.provider} · ${info.nativeSessionId.slice(0, 8)}`,
        capabilities: this.capabilities,
        adapterId: this.id,
        workdir: info.workdir,
        updatedAt: info.updatedAt,
        attached: attached.has(path),
      });
    }
    return out;
  }

  async readiness(session: Session): Promise<Readiness> {
    const own = this.ownReadiness(session);
    if (own) return own;
    if (!(await this.binary())) return { ready: false, reason: "offline", detail: `${this.provider} CLI not found` };
    if (!session.workdir || !(await stat(session.workdir).catch(() => undefined)))
      return { ready: false, reason: "offline", detail: `working directory missing: ${session.workdir ?? "(none)"}` };
    const path = await this.transcript(session);
    if (!path) return { ready: false, reason: "offline", detail: "native session transcript not found" };
    const elsewhere = await this.busyElsewhere(session, path);
    if (elsewhere) return { ready: false, reason: "attached", detail: elsewhere };
    return { ready: true };
  }

  async rename(session: Session, title: string): Promise<void> {
    const binary = await this.binary();
    if (!binary) throw new Error(`${this.provider} CLI not found`);
    const transcript = await this.transcript(session);
    if (!transcript) throw new Error("native session transcript not found");
    await this.renameNative({ binary, session, transcript, title });
    this.titles.delete(session.nativeIdentity);
  }

  /** The submission landed iff the native transcript holds an input carrying this message id. */
  async verify(session: Session, message: Message): Promise<VerifyResult> {
    const path = await this.transcript(session);
    if (!path) return { status: "unknown", error: "native session transcript not found" };
    try {
      const { observations } = await readTranscript(this.base.dialect, path, 0);
      const hit = observations.find((o) => o.kind === "input" && markedMessageIds(o.text).includes(message.id));
      if (hit) return { status: "present", nativeMessageId: hit.nativeEventId };
      return this.isRunning(session.id) ? { status: "unknown", error: "turn still starting" } : { status: "absent" };
    } catch (error) {
      return { status: "unknown", error: String(error) };
    }
  }

  async readNative(session: Session, cursor: number): Promise<NativeReadResult> {
    const path = await this.transcript(session);
    if (!path) throw new Error("native session transcript not found");
    const read = await readTranscript(this.base.dialect, path, cursor);
    const observations = cursor === 0 ? lastMessages(read.observations, INITIAL_HISTORY) : read.observations;
    return { observations, cursor: read.cursor, source: path, title: await this.title(session, path) };
  }

  /** A Portage turn ended: its writes are Portage's own, and the bus hears how it went. */
  protected turnEnded(sessionId: string, ok: boolean, error?: string) {
    this.lastTurnEnd.set(sessionId, Date.now());
    this.base.onTurnEnd({ sessionId, ok, error });
  }

  protected async transcript(session: Session): Promise<string | undefined> {
    const cached = this.paths.get(session.nativeIdentity);
    if (cached && (await stat(cached).catch(() => undefined))) return cached;
    const path = await this.base.dialect.locate(session.nativeIdentity);
    if (path) this.paths.set(session.nativeIdentity, path);
    return path;
  }

  /** The native title, re-read only when the file it lives in changed. */
  private async title(session: Session, path: string): Promise<string | undefined> {
    const { dialect } = this.base;
    const source = dialect.titleSource(path);
    const mtime = (await stat(source).catch(() => undefined))?.mtimeMs ?? 0;
    const cached = this.titles.get(session.nativeIdentity);
    if (cached?.source === source && cached.mtime === mtime) return cached.title;
    const title = await dialect.title(path, session.nativeIdentity).catch(() => undefined);
    this.titles.set(session.nativeIdentity, { source, mtime, title });
    return title;
  }

  /**
   * Another client is working in the session right now: it wrote a moment ago, or its newest turn
   * is still open and something still holds the session (a process, or writes recent enough).
   * Nothing written since Portage's own last turn means nothing is running elsewhere.
   */
  private async busyElsewhere(session: Session, path: string): Promise<string | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info || info.mtimeMs <= (this.lastTurnEnd.get(session.id) ?? 0) + 2000) return undefined;
    const quiet = Date.now() - info.mtimeMs;
    if (quiet < (this.base.recentWriteMs ?? 15_000)) return "written moments ago by another client";
    if ((await turnState(this.base.dialect, path)) !== "open") return undefined;
    const holder = await this.holder(session, path);
    if (holder) return `a turn is running in pid ${holder}`;
    if (quiet < (this.base.staleTurnMs ?? 30 * 60_000)) return "a turn is running in another client";
    return undefined;
  }

  /** A live process other than Portage with the transcript open or naming the session. */
  private async holder(session: Session, path: string): Promise<number | undefined> {
    const open = await this.openTranscripts([path]);
    if (open.has(path)) return open.get(path);
    const own = this.ownPids();
    return (await processTable()).find(
      (p) => !own.has(p.pid) && !p.exiting && p.commandLine.includes(session.nativeIdentity) && /codex|claude/i.test(p.commandLine),
    )?.pid;
  }

  private ownPids() {
    return new Set([process.pid, ...this.ownChildPids()]);
  }

  /** Transcripts some live process other than Portage and its turns holds open, with the holder pid. */
  private async openTranscripts(paths: string[]): Promise<Map<string, number>> {
    if (!paths.length || process.platform === "win32") return new Map();
    // open-file tables name files by their resolved path; map back to the paths we were asked about
    const asked = new Map<string, string>();
    for (const path of paths) asked.set(await realpath(path).catch(() => path), path);
    const own = this.ownPids();
    const held = new Map<string, number>();
    const opens = process.platform === "linux" ? await procOpenFiles(asked) : await lsofOpenFiles(paths);
    for (const [pid, file] of opens) {
      const path = asked.get(file);
      if (path && !own.has(pid) && !held.has(path)) held.set(path, pid);
    }
    return held;
  }
}

/** Linux: read `/proc/<pid>/fd` directly; `lsof` is often not installed on servers and minimal images. */
async function procOpenFiles(wanted: Map<string, string>): Promise<Array<[number, string]>> {
  const found: Array<[number, string]> = [];
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));
  await Promise.all(
    pids.map(async (pid) => {
      // other users' processes are unreadable without privileges, as with lsof
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
        if (wanted.has(target)) found.push([Number(pid), target]);
      }
    }),
  );
  return found;
}

async function lsofOpenFiles(paths: string[]): Promise<Array<[number, string]>> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("lsof", ["-F", "pn", "--", ...paths], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    // lsof exits 1 when some path is not open, which is the common case; its output is still valid
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const found: Array<[number, string]> = [];
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) found.push([pid, line.slice(1)]);
  }
  return found;
}

function lastMessages<T extends { kind: string }>(observations: T[], count: number): T[] {
  const messages = observations.filter((o) => o.kind === "input" || o.kind === "output");
  return messages.slice(-count);
}

export function lastLine(text: string) {
  return text.trim().split("\n").filter((l) => l.trim() && !/^\s*at\s/.test(l)).pop()?.trim() ?? "";
}
