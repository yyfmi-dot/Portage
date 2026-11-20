import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterCapabilityFlags, InjectResult, Message, Readiness, Session } from "@portage/core";
import { lastLine, TranscriptAdapter, type McpLaunch, type TranscriptAdapterOptions, type TurnEnd } from "./transcript-adapter.js";
import { readPolicy, type NativeTurnPolicy } from "./transcripts.js";

export type { McpLaunch, TurnEnd };

/** One CLI's headless-turn interface: how to resume a session with input on stdin, and how to read its stream. */
export type TurnCli = {
  binary(): Promise<string | undefined>;
  args(input: { nativeSessionId: string; mcp: McpLaunch; policy: NativeTurnPolicy }): string[];
  /** One line of the CLI's machine-readable stdout. */
  signal(line: Record<string, any>): { started?: true; failed?: string; done?: true } | undefined;
  /** Rename the native session through the CLI's own mechanism, so its app and CLI show the new title. */
  rename(input: { binary: string; nativeSessionId: string; transcript: string; title: string }): Promise<void>;
};

export type NativeTurnAdapterOptions = TranscriptAdapterOptions & { cli: TurnCli };

/**
 * Submits to a native session by resuming it for one headless turn (the CLI's own
 * `exec resume` / `-p --resume`): the input lands in the real native transcript, the turn runs
 * with the session's own context, and the transcript is read back as proof and as the reply.
 */
export class NativeTurnAdapter extends TranscriptAdapter {
  readonly capabilities: AdapterCapabilityFlags = {
    discover: true,
    read: true,
    write: true,
    idleSignal: true,
    tail: true,
    createSession: false,
  };
  private readonly turns = new Map<string, ChildProcess>();

  constructor(private readonly options: NativeTurnAdapterOptions) {
    super(options);
  }

  protected binary() {
    return this.options.cli.binary();
  }

  isRunning(sessionId: string) {
    return this.turns.has(sessionId);
  }

  protected ownReadiness(session: Session): Readiness | undefined {
    if (this.turns.has(session.id)) return { ready: false, reason: "busy", detail: "a Portage turn is running" };
    return undefined;
  }

  protected ownChildPids() {
    return [...this.turns.values()].flatMap((child) => (child.pid ? [child.pid] : []));
  }

  protected renameNative({ binary, session, transcript, title }: { binary: string; session: Session; transcript: string; title: string }) {
    return this.options.cli.rename({ binary, nativeSessionId: session.nativeIdentity, transcript, title });
  }

  async inject(session: Session, _message: Message, compiledQuery: string): Promise<InjectResult> {
    const binary = await this.options.cli.binary();
    if (!binary) return { ok: false, error: `${this.provider} CLI not found`, retryable: false };
    const mcp = { command: this.options.mcp.command, args: [...this.options.mcp.args, "--session", session.id] };
    const path = await this.transcript(session);
    const policy = path ? await readPolicy(this.options.dialect, path).catch(() => ({})) : {};
    const child = spawn(binary, this.options.cli.args({ nativeSessionId: session.nativeIdentity, mcp, policy }), {
      cwd: session.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.turns.set(session.id, child);

    let started = false;
    let failure: string | undefined;
    let stderr = "";
    let buffered = "";
    const startWait = new Promise<"started" | "exited" | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), this.options.startTimeoutMs ?? 60_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line.startsWith("{")) continue;
          let record: Record<string, any>;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const signal = this.options.cli.signal(record);
          if (signal?.failed) failure = signal.failed;
          if (signal?.started && !started) {
            started = true;
            clearTimeout(timer);
            resolve("started");
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", (error) => {
        failure = error.message;
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve("exited");
      });
    });

    child.on("close", (code) => {
      this.turns.delete(session.id);
      const error = failure ?? (code === 0 ? undefined : lastLine(stderr) || `${this.provider} exited with ${code}`);
      this.turnEnded(session.id, !error, error);
    });
    child.stdin!.on("error", () => {
      // the CLI exited before reading stdin; reported through `close`
    });
    child.stdin!.end(compiledQuery);

    const outcome = await startWait;
    if (outcome === "started") return { ok: true, proof: "submitted", nativeMessageId: session.nativeIdentity };
    if (outcome === "exited") {
      const error = failure ?? (lastLine(stderr) || `${this.provider} exited before the turn started`);
      if (isActiveWriterConflict(error)) {
        return {
          ok: false,
          hold: "attached",
          detail: "another client holds this thread's writer; Portage will retry when it can take the turn",
          error,
        };
      }
      return { ok: false, error, retryable: false };
    }
    // Still running but silent: the input may or may not be in the transcript yet; read-back decides.
    return { ok: false, uncertain: true, error: "the turn did not report a start in time" };
  }

  /** Stop a running Portage turn (the CLI's own interrupt first). */
  interrupt(sessionId: string): boolean {
    const child = this.turns.get(sessionId);
    if (!child) return false;
    child.kill("SIGINT");
    setTimeout(() => {
      if (this.turns.get(sessionId) === child) child.kill("SIGTERM");
    }, 3000).unref();
    return true;
  }
}

/** Codex refuses a second resume while App / IDE still holds the thread writer. */
export function isActiveWriterConflict(error: string): boolean {
  return /active writer|already has an active writer/i.test(error);
}
