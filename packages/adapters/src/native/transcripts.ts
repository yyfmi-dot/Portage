import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NativeObservation } from "@portage/core";

/** What a native transcript says about its session. */
export type NativeSessionInfo = {
  nativeSessionId: string;
  path: string;
  workdir: string;
  host: "terminal" | "vscode_cli" | "app" | "headless";
  title: string;
  updatedAt: string;
};

/**
 * How the session itself last ran its turns. A headless resume does not inherit it (Codex falls back
 * to a read-only sandbox, Claude to default permissions), so a Portage turn passes it on explicitly.
 */
export type NativeTurnPolicy = {
  /** Codex `sandbox_mode`: read-only | workspace-write | danger-full-access. */
  sandbox?: string;
  networkAccess?: boolean;
  /** Claude `--permission-mode`. */
  permissionMode?: string;
};

/**
 * One CLI's on-disk transcript format. Both CLIs append one JSON record per line; the byte offset
 * of a line is a stable cursor and a stable native event id.
 */
export type TranscriptDialect = {
  provider: "codex" | "claude";
  /** Newest transcripts first, at most `limit`. */
  recent(limit: number): Promise<string[]>;
  locate(nativeSessionId: string): Promise<string | undefined>;
  describe(path: string): Promise<NativeSessionInfo | undefined>;
  parse(record: Record<string, any>, offset: number): NativeObservation[];
  /** The policy a record states, if it states one; the newest such record wins. */
  policyOf(record: Record<string, any>): NativeTurnPolicy | undefined;
  /** Whether a record opens or closes a turn; the newest such record says whether one is running. */
  turnOf(record: Record<string, any>): "open" | "closed" | undefined;
  /** The title the session's own app or CLI shows (renamed or generated), if it has one. */
  title(path: string, nativeSessionId: string): Promise<string | undefined>;
  /** The file whose change can change `title`, so callers re-read it only then. */
  titleSource(path: string): string;
};

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const TITLE_CHARS = 60;

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl ─────────────────────────────

/** Context Codex itself injects as a "user" message; not something anyone typed. */
const CODEX_INJECTED = /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<user_shell_command>|<turn_aborted>)/;

export function codexDialect(root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")): TranscriptDialect {
  // Codex names threads (renamed, or titled by the app) in an append-only index beside `sessions/`.
  const index = join(dirname(root), "session_index.jsonl");
  let names: { mtime: number; byId: Map<string, string> } | undefined;
  const threadNames = async () => {
    const info = await stat(index).catch(() => undefined);
    if (!info) return new Map<string, string>();
    if (names?.mtime !== info.mtimeMs) {
      const byId = new Map<string, string>();
      for (const line of (await readFile(index, "utf8").catch(() => "")).split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (entry.id && typeof entry.thread_name === "string" && entry.thread_name.trim()) byId.set(String(entry.id), entry.thread_name.trim());
        } catch {
          // a torn last line while Codex appends
        }
      }
      names = { mtime: info.mtimeMs, byId };
    }
    return names.byId;
  };
  const days = async () => {
    const out: string[] = [];
    for (const year of await listDesc(root))
      for (const month of await listDesc(join(root, year)))
        for (const day of await listDesc(join(root, year, month))) out.push(join(root, year, month, day));
    return out;
  };
  return {
    provider: "codex",
    async recent(limit) {
      const files: Array<{ path: string; mtime: number }> = [];
      for (const day of await days()) {
        for (const name of await listDesc(day)) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const path = join(day, name);
          files.push({ path, mtime: (await stat(path)).mtimeMs });
        }
        if (files.length >= limit * 3) break;
      }
      return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
    },
    async locate(id) {
      for (const day of await days()) {
        const name = (await listDesc(day)).find((n) => n.endsWith(`-${id}.jsonl`));
        if (name) return join(day, name);
      }
      return undefined;
    },
    async describe(path) {
      const { records, mtime } = await readHead(path);
      const meta = records[0]?.type === "session_meta" ? records[0].payload : undefined;
      if (!meta?.id || meta.thread_source === "subagent") return undefined;
      const firstInput = records.flatMap((r, i) => this.parse(r, i)).find((o) => o.kind === "input");
      const originator = String(meta.originator ?? "");
      return {
        nativeSessionId: String(meta.id),
        path,
        workdir: String(meta.cwd ?? ""),
        host: originator.includes("exec") ? "headless" : originator.includes("vscode") ? "vscode_cli" : "terminal",
        title: (await this.title(path, String(meta.id))) ?? titleOf(firstInput?.text),
        updatedAt: new Date(mtime).toISOString(),
      };
    },
    async title(_path, id) {
      return (await threadNames()).get(id);
    },
    titleSource: () => index,
    turnOf(record) {
      if (record.type !== "event_msg") return undefined;
      const type = record.payload?.type;
      if (type === "task_started") return "open";
      if (type === "task_complete" || type === "turn_aborted") return "closed";
      return undefined;
    },
    policyOf(record) {
      if (record.type !== "turn_context") return undefined;
      const sandbox = record.payload?.sandbox_policy;
      if (!sandbox?.type) return undefined;
      return { sandbox: String(sandbox.type), networkAccess: sandbox.network_access === true };
    },
    parse(record, offset) {
      const payload = record.payload ?? {};
      const at = String(record.timestamp ?? "");
      const id = `L${offset}`;
      if (record.type === "response_item" && payload.type === "message") {
        const text = (payload.content ?? [])
          .filter((c: any) => c.type === "input_text" || c.type === "output_text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (!text) return [];
        if (payload.role === "user") return CODEX_INJECTED.test(text) ? [] : [{ nativeEventId: id, nativeTime: at, kind: "input", text }];
        if (payload.role === "assistant") return [{ nativeEventId: id, nativeTime: at, kind: "output", text }];
        return [];
      }
      if (record.type === "event_msg") {
        if (payload.type === "task_started") return [{ nativeEventId: id, nativeTime: at, kind: "turn_started", text: "" }];
        if (payload.type === "task_complete") return [{ nativeEventId: id, nativeTime: at, kind: "turn_completed", text: "" }];
        if (payload.type === "turn_aborted" || payload.type === "error")
          return [{ nativeEventId: id, nativeTime: at, kind: "turn_failed", text: String(payload.message ?? payload.reason ?? payload.type) }];
      }
      return [];
    },
  };
}

// ── Claude Code: ~/.claude/projects/<encoded cwd>/<id>.jsonl ──────────────────────────────────

const CLAUDE_TURN_ENDS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

export function claudeDialect(root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")): TranscriptDialect {
  return {
    provider: "claude",
    async recent(limit) {
      const projects: Array<{ dir: string; mtime: number }> = [];
      for (const name of await listDesc(root)) {
        const dir = join(root, name);
        const info = await stat(dir).catch(() => undefined);
        if (info?.isDirectory()) projects.push({ dir, mtime: info.mtimeMs });
      }
      projects.sort((a, b) => b.mtime - a.mtime);
      const files: Array<{ path: string; mtime: number }> = [];
      for (const { dir } of projects.slice(0, limit)) {
        for (const name of await listDesc(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(dir, name);
          files.push({ path, mtime: (await stat(path)).mtimeMs });
        }
      }
      return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
    },
    async locate(id) {
      for (const name of await listDesc(root)) {
        const path = join(root, name, `${id}.jsonl`);
        if (await stat(path).catch(() => undefined)) return path;
      }
      return undefined;
    },
    async describe(path) {
      const { records, mtime } = await readHead(path);
      const first = records.find((r) => r.type === "user" && r.sessionId && r.cwd);
      if (!first) return undefined;
      const firstInput = records.flatMap((r, i) => this.parse(r, i)).find((o) => o.kind === "input");
      const entry = String(first.entrypoint ?? "");
      return {
        nativeSessionId: String(first.sessionId),
        path,
        workdir: String(first.cwd),
        host: entry.includes("sdk") ? "headless" : entry.includes("vscode") ? "vscode_cli" : "terminal",
        title: (await this.title(path, String(first.sessionId))) ?? titleOf(firstInput?.text),
        updatedAt: new Date(mtime).toISOString(),
      };
    },
    // Claude re-appends the session's title every few records; a `/rename` title outranks its generated one.
    async title(path) {
      let generated: string | undefined;
      let renamed: string | undefined;
      await scanTail(path, (record) => {
        if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) renamed = record.customTitle.trim();
        else if (!generated && record.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) generated = record.aiTitle.trim();
        return Boolean(renamed);
      });
      return renamed ?? generated;
    },
    titleSource: (path) => path,
    turnOf(record) {
      if (record.isSidechain || record.isMeta) return undefined;
      if (record.type === "assistant") {
        if (record.isApiErrorMessage) return "closed";
        return CLAUDE_TURN_ENDS.has(record.message?.stop_reason) ? "closed" : "open";
      }
      if (record.type !== "user") return undefined;
      const content = record.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? String(content.find((c: any) => c.type === "text")?.text ?? "") : "";
      if (text.startsWith("[Request interrupted")) return "closed";
      // local slash commands (/rename, /clear …) never reach the model
      if (text.startsWith("<command-") || text.startsWith("<local-command")) return undefined;
      return "open";
    },
    policyOf(record) {
      return record.type === "user" && typeof record.permissionMode === "string" ? { permissionMode: record.permissionMode } : undefined;
    },
    parse(record, offset) {
      if (record.isSidechain || record.isMeta) return [];
      const at = String(record.timestamp ?? "");
      const id = String(record.uuid ?? `L${offset}`);
      const content = record.message?.content;
      const text = (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "").trim();
      if (record.type === "user" && text && !text.startsWith("<command-") && !text.startsWith("<local-command"))
        return [{ nativeEventId: id, nativeTime: at, kind: "input", text }];
      if (record.type === "assistant") {
        if (record.isApiErrorMessage) return [{ nativeEventId: id, nativeTime: at, kind: "turn_failed", text: text || String(record.error ?? "api error") }];
        if (text) return [{ nativeEventId: id, nativeTime: at, kind: "output", text }];
      }
      return [];
    },
  };
}

// ── shared ────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse complete lines after byte `cursor`. A trailing partial line (the CLI is mid-write) is left
 * for the next read, so the returned cursor always sits on a line boundary.
 */
export async function readTranscript(
  dialect: TranscriptDialect,
  path: string,
  cursor: number,
): Promise<{ observations: NativeObservation[]; cursor: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < cursor) cursor = 0;
    if (size === cursor) return { observations: [], cursor };
    const buffer = Buffer.alloc(size - cursor);
    await handle.read(buffer, 0, buffer.length, cursor);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { observations: [], cursor };
    const observations: NativeObservation[] = [];
    let start = 0;
    while (start <= end) {
      const newline = buffer.indexOf(0x0a, start);
      const line = buffer.subarray(start, newline).toString("utf8");
      const offset = cursor + start;
      start = newline + 1;
      if (!line.trim()) continue;
      let record: Record<string, any>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      observations.push(...dialect.parse(record, offset));
    }
    return { observations, cursor: cursor + end + 1 };
  } finally {
    await handle.close();
  }
}

/** The newest policy the transcript states (looked up from the end; falls back to the head). */
export async function readPolicy(dialect: TranscriptDialect, path: string): Promise<NativeTurnPolicy> {
  let policy: NativeTurnPolicy | undefined;
  const whole = await scanTail(path, (record) => Boolean((policy = dialect.policyOf(record))));
  if (policy) return policy;
  if (!whole) {
    const { records } = await readHead(path);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const stated = dialect.policyOf(records[i]!);
      if (stated) return stated;
    }
  }
  return {};
}

/** Whether the transcript's newest turn is still running ("open"), per its own turn records. */
export async function turnState(dialect: TranscriptDialect, path: string): Promise<"open" | "closed" | undefined> {
  let state: "open" | "closed" | undefined;
  await scanTail(path, (record) => Boolean((state = dialect.turnOf(record))));
  return state;
}

/**
 * Visit the transcript's last records newest first until `visit` returns true. Returns whether the
 * whole file was covered (a short file), so callers know if older records were left unread.
 */
async function scanTail(path: string, visit: (record: Record<string, any>) => boolean): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]!.trim()) continue;
      let record: Record<string, any>;
      try {
        record = JSON.parse(lines[i]!);
      } catch {
        continue; // a torn last line while the CLI writes
      }
      if (visit(record)) break;
    }
    return start === 0;
  } finally {
    await handle.close();
  }
}

async function readHead(path: string) {
  const handle = await open(path, "r");
  try {
    const { mtimeMs } = await handle.stat();
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = bytesRead === HEAD_BYTES ? text.split("\n").slice(0, -1) : text.split("\n");
    const records: Array<Record<string, any>> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // a torn line at the head boundary; describe works with what parsed
      }
    }
    return { records, mtime: mtimeMs };
  } finally {
    await handle.close();
  }
}

async function listDesc(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

const IDE_CONTEXT = /<(ide_[a-z_]+|system-reminder|pasted_content)\b[^>]*>[\s\S]*?(<\/\1>|$)/g;

function titleOf(text?: string) {
  const raw = text ?? "";
  const human = raw.replace(IDE_CONTEXT, " ").trim() || raw.replace(/<[^>]+>/g, " ");
  const line = human
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot);/g, (_, n) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[n as "amp"])
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}
