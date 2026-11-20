import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Session } from "@portage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCli, codexCli } from "./clis.js";
import { NativeTurnAdapter, type TurnEnd } from "./native-turn-adapter.js";
import { claudeDialect, codexDialect, readPolicy, readTranscript, turnState } from "./transcripts.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const posix = process.platform !== "win32";

let home: string;
let workdir: string;
let argsLog: string;
let ends: TurnEnd[];

function rollout(id: string, records: Array<Record<string, unknown>>, cwd = workdir) {
  const day = join(home, "sessions", "2026", "11", "18");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-11-18T10-00-00-${id}.jsonl`);
  const lines = [{ type: "session_meta", payload: { id, cwd, originator: "codex_exec" } }, ...records];
  writeFileSync(path, lines.map((r) => JSON.stringify({ timestamp: "2026-11-18T10:00:00Z", ...r })).join("\n") + "\n");
  // not "written moments ago": these fixtures stand for existing, idle sessions
  const old = new Date(Date.now() - 600_000);
  utimesSync(path, old, old);
  return path;
}

const said = (role: "user" | "assistant", text: string) => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const event = (type: string) => ({ type: "event_msg", payload: { type } });

/** Last written `ms` ago (negative: right now). */
function age(path: string, ms: number) {
  const at = new Date(Date.now() - Math.max(ms, 0));
  utimesSync(path, at, at);
}

function adapter(overrides: { binary?: string | null; startTimeoutMs?: number; staleTurnMs?: number } = {}) {
  return new NativeTurnAdapter({
    id: "codex-native",
    dialect: codexDialect(join(home, "sessions")),
    cli: { ...codexCli, binary: async () => (overrides.binary === null ? undefined : (overrides.binary ?? FAKE)) },
    mcp: { command: "node", args: ["/opt/portage-mcp.mjs", "--daemon", "http://127.0.0.1:1"] },
    onTurnEnd: (end) => ends.push(end),
    startTimeoutMs: overrides.startTimeoutMs ?? 5000,
    staleTurnMs: overrides.staleTurnMs,
  });
}

const session = (nativeIdentity: string, extra: Partial<Session> = {}): Session => ({
  id: `s_${nativeIdentity}`,
  workspaceId: "default",
  provider: "codex",
  harness: "cli",
  host: "headless",
  nativeIdentity,
  displayName: nativeIdentity,
  alias: nativeIdentity,
  communicationEnabled: true,
  adapterId: "codex-native",
  workdir,
  ...extra,
});

const message = (id: string) => ({ id }) as Message;
const query = (id: string, body: string) => `[来自 lead]\n\n[原始消息 · v1 · ${id}]\n${body}`;

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "portage-native-"));
  workdir = mkdtempSync(join(tmpdir(), "portage-work-"));
  argsLog = join(home, "argv.jsonl");
  ends = [];
  process.env.CODEX_HOME = home;
  process.env.FAKE_CODEX_ARGS_LOG = argsLog;
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_CODEX_TURN_MS;
});

afterEach(() => {
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_CODEX_TURN_MS;
});

describe.skipIf(!posix)("NativeTurnAdapter · discovery", () => {
  it("lists real threads with workdir, host and a human title; skips subagent threads and injected context", async () => {
    rollout("t-main", [said("user", "# AGENTS.md instructions for /x\n..."), said("user", "&#x20;修复 <b>门禁</b>"), said("assistant", "ok")]);
    rollout("t-ide", [said("user", "<ide_opened_file>/a/b.ts</ide_opened_file>\n看看这个文件")]);
    rollout("t-link", [said("user", "[Chat thread](codex://threads/01a1) 接着这个线程做")]);
    const day = join(home, "sessions", "2026", "11", "18");
    writeFileSync(
      join(day, "rollout-2026-11-18T09-00-00-t-sub.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "t-sub", cwd: workdir, thread_source: "subagent" } }) + "\n",
    );
    const found = await adapter().discover();
    expect(found.map((e) => e.nativeSessionId).sort()).toEqual(["t-ide", "t-link", "t-main"]);
    const main = found.find((e) => e.nativeSessionId === "t-main")!;
    expect(main).toMatchObject({
      provider: "codex",
      adapterId: "codex-native",
      host: "headless",
      workdir,
      attached: false,
      displayName: "修复 <b>门禁</b>",
      suggestedSessionKey: "codex:t-main",
    });
    expect(found.find((e) => e.nativeSessionId === "t-ide")!.displayName).toBe("看看这个文件");
    expect(found.find((e) => e.nativeSessionId === "t-link")!.displayName).toBe("Chat thread 接着这个线程做");
  });

  it("follows the newest forked Codex rollout for a thread, not the frozen original", async () => {
    const day = join(home, "sessions", "2026", "11", "18");
    mkdirSync(day, { recursive: true });
    const root = join(day, "rollout-2026-11-18T10-00-00-t-fork.jsonl");
    const fork = join(day, "rollout-2026-11-18T12-00-00-t-fork_01a1dead-beef-0000-0000-000000000001.jsonl");
    const meta = { type: "session_meta", payload: { id: "t-fork", cwd: workdir, originator: "codex_exec" } };
    writeFileSync(root, JSON.stringify(meta) + "\n" + JSON.stringify(said("user", "old file")) + "\n");
    writeFileSync(fork, JSON.stringify(meta) + "\n" + JSON.stringify(said("user", "new fork")) + "\n");
    const old = new Date(Date.now() - 600_000);
    const recent = new Date(Date.now() - 1_000);
    utimesSync(root, old, old);
    utimesSync(fork, recent, recent);
    const dialect = codexDialect(join(home, "sessions"));
    expect(await dialect.locate("t-fork")).toBe(fork);
    const found = await adapter().discover();
    expect(found.filter((e) => e.nativeSessionId === "t-fork")).toHaveLength(1);
    expect(found.find((e) => e.nativeSessionId === "t-fork")!.displayName).toBe("new fork");
  });
});

describe.skipIf(!posix)("NativeTurnAdapter · readiness", () => {
  it("is ready for an idle session and offline with the concrete cause otherwise", async () => {
    rollout("t1", [said("user", "hi")]);
    const a = adapter();
    expect(await a.readiness(session("t1"))).toEqual({ ready: true });
    expect(await a.readiness(session("t1", { workdir: join(workdir, "gone") }))).toMatchObject({ ready: false, reason: "offline", detail: expect.stringContaining("working directory missing") });
    expect(await a.readiness(session("nope"))).toMatchObject({ reason: "offline", detail: "native session transcript not found" });
    expect(await adapter({ binary: null }).readiness(session("t1"))).toMatchObject({ reason: "offline", detail: "codex CLI not found" });
  });

  it("stays ready when another app holds the thread, because Codex can queue into that holder", async () => {
    const path = rollout("t2", [event("task_started"), said("user", "hi"), said("assistant", "hello"), event("task_complete")]);
    const holder = spawn("tail", ["-f", path], { stdio: "ignore" });
    try {
      expect(await adapter().readiness(session("t2"))).toEqual({ ready: true });
      appendFileSync(path, JSON.stringify(event("task_started")) + "\n");
      age(path, 120_000);
      // Mid-turn in the other client: still ready — inject will queue instead of waiting forever.
      expect(await adapter().readiness(session("t2"))).toEqual({ ready: true });
    } finally {
      holder.kill();
      await new Promise((r) => holder.once("exit", r));
    }
    expect(await adapter().readiness(session("t2"))).toEqual({ ready: true });
  });

  it("Portage's own turn left open (interrupted mid-turn) never blocks the next delivery", async () => {
    const path = rollout("t2b", []);
    const a = adapter();
    await a.inject(session("t2b"), message("msg_o"), query("msg_o", "x"));
    await until(() => ends[0]);
    appendFileSync(path, JSON.stringify(event("task_started")) + "\n");
    age(path, -1); // same moment as Portage's own turn end
    expect(await a.readiness(session("t2b"))).toEqual({ ready: true });
  });

  it("a fresh write by someone else does not block Codex either; queue can still land", async () => {
    const path = rollout("t3", [said("user", "hi")]);
    appendFileSync(path, JSON.stringify(said("user", "typed in the TUI just now")) + "\n");
    expect(await adapter().readiness(session("t3"))).toEqual({ ready: true });

    rollout("t4", [said("user", "hi")]);
    const a = adapter();
    await a.inject(session("t4"), message("msg_a"), query("msg_a", "ping"));
    await until(() => ends[0]);
    expect(await a.readiness(session("t4"))).toEqual({ ready: true });
  });

  it("without a queue fallback, an open turn elsewhere still holds", async () => {
    const path = rollout("t2h", [said("user", "hi"), event("task_started")]);
    age(path, 120_000);
    const noQueue = new NativeTurnAdapter({
      id: "codex-native",
      dialect: codexDialect(join(home, "sessions")),
      cli: { ...codexCli, queue: undefined, binary: async () => FAKE },
      mcp: { command: "node", args: ["/opt/portage-mcp.mjs", "--daemon", "http://127.0.0.1:1"] },
      onTurnEnd: (end) => ends.push(end),
    });
    expect(await noQueue.readiness(session("t2h"))).toMatchObject({
      ready: false,
      reason: "attached",
      detail: "a turn is running in another client",
    });
  });
});

describe.skipIf(!posix)("NativeTurnAdapter · titles", () => {
  const index = () => join(home, "session_index.jsonl");

  it("reads the Codex thread name (newest wins) and renames through the app server", async () => {
    rollout("t10", [said("user", "first thing typed")]);
    const a = adapter();
    expect((await a.discover()).find((e) => e.nativeSessionId === "t10")!.displayName).toBe("first thing typed");
    expect((await a.readNative(session("t10"), 0)).title).toBeUndefined();

    writeFileSync(index(), [{ id: "t10", thread_name: "Old name" }, { id: "other", thread_name: "x" }, { id: "t10", thread_name: "Named in the app" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    age(index(), 5_000);
    expect((await a.discover()).find((e) => e.nativeSessionId === "t10")!.displayName).toBe("Named in the app");
    expect((await a.readNative(session("t10"), 0)).title).toBe("Named in the app");

    await a.rename(session("t10"), "Renamed in Portage");
    const last = JSON.parse(readFileSync(index(), "utf8").trim().split("\n").pop()!);
    expect(last).toMatchObject({ id: "t10", thread_name: "Renamed in Portage" });
    expect((await a.readNative(session("t10"), 0)).title).toBe("Renamed in Portage");
  });

  it("a rename the app server refuses is an error, not a silent no-op", async () => {
    process.env.FAKE_CODEX_MODE = "fail";
    rollout("t11", []);
    await expect(adapter().rename(session("t11"), "x")).rejects.toThrow("thread not found");
    await expect(adapter({ binary: null }).rename(session("t11"), "x")).rejects.toThrow("codex CLI not found");
  });
});

describe.skipIf(!posix)("NativeTurnAdapter · a turn", () => {
  it("resumes the native thread in its workdir with Portage MCP mounted, is busy while running, then reads back proof and reply", async () => {
    process.env.FAKE_CODEX_TURN_MS = "300";
    rollout("t5", [
      { type: "turn_context", payload: { sandbox_policy: { type: "read-only" } } },
      said("user", "earlier question"),
      said("assistant", "earlier answer"),
      { type: "turn_context", payload: { sandbox_policy: { type: "workspace-write", network_access: true } } },
    ]);
    const a = adapter();
    const s = session("t5");

    const result = await a.inject(s, message("msg_q1"), query("msg_q1", "请评审方案"));
    expect(result).toEqual({ ok: true, proof: "submitted", nativeMessageId: "t5", running: true });
    expect(await a.readiness(s)).toMatchObject({ ready: false, reason: "busy" });

    const [{ argv, cwd }] = readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(argv.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(argv.slice(-3)).toEqual(["resume", "t5", "-"]);
    expect(argv).toContain(`mcp_servers.portage.args=["/opt/portage-mcp.mjs","--daemon","http://127.0.0.1:1","--session","s_t5"]`);
    // the session's own latest sandbox, which a bare `exec resume` would drop to read-only
    expect(argv).toContain(`sandbox_mode="workspace-write"`);
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(realpathSync(cwd)).toBe(realpathSync(workdir));

    expect(await until(() => ends[0])).toEqual({ sessionId: "s_t5", ok: true, error: undefined });
    expect(await a.verify(s, message("msg_q1"))).toMatchObject({ status: "present" });
    expect(await a.verify(s, message("msg_other"))).toEqual({ status: "absent" });

    const first = await a.readNative(s, 0);
    expect(first.observations.map((o) => [o.kind, o.text.split("\n").pop()])).toEqual([
      ["input", "earlier question"],
      ["output", "earlier answer"],
      ["input", "请评审方案"],
      ["output", "ACK msg_q1"],
    ]);
    expect(first.source).toContain("-t5.jsonl");

    process.env.FAKE_CODEX_TURN_MS = "10";
    await a.inject(s, message("msg_q2"), query("msg_q2", "第二轮"));
    await until(() => ends[1]);
    const next = await a.readNative(s, first.cursor);
    expect(next.observations.map((o) => o.kind)).toEqual(["turn_started", "input", "output", "turn_completed"]);
    expect(next.observations[2]!.text).toBe("ACK msg_q2");
    expect((await a.readNative(s, next.cursor)).observations).toEqual([]);
  });

  it("a session that never stated a sandbox gets no override", async () => {
    rollout("t9", []);
    await adapter().inject(session("t9"), message("msg_p"), query("msg_p", "x"));
    await until(() => ends[0]);
    const [{ argv }] = readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(argv.some((a: string) => a.startsWith("sandbox_mode="))).toBe(false);
  });

  it("a turn the model fails is reported at turn end with the CLI's reason", async () => {
    process.env.FAKE_CODEX_MODE = "fail";
    rollout("t6", []);
    const a = adapter();
    expect(await a.inject(session("t6"), message("msg_f"), query("msg_f", "x"))).toMatchObject({ ok: true });
    expect(await until(() => ends[0])).toEqual({ sessionId: "s_t6", ok: false, error: "model refused" });
    const read = await a.readNative(session("t6"), 0);
    expect(read.observations.map((o) => o.kind)).toEqual(["input"]);
  });

  it("a CLI that dies before starting is a non-retryable failure carrying its stderr", async () => {
    process.env.FAKE_CODEX_MODE = "crash";
    rollout("t7", []);
    const result = await adapter().inject(session("t7"), message("msg_c"), query("msg_c", "x"));
    expect(result).toEqual({ ok: false, retryable: false, error: "Error: thread/resume failed: no rollout found for thread id t7" });
  });

  it("an active writer conflict queues into the holding client instead of asking the user to close it", async () => {
    process.env.FAKE_CODEX_MODE = "writer";
    rollout("t7w", []);
    const result = await adapter().inject(session("t7w"), message("msg_w"), query("msg_w", "x"));
    expect(result).toEqual({ ok: true, proof: "submitted", nativeMessageId: "fake-queue-1", running: false });
    expect(ends).toEqual([]);
  });

  it("a silent turn is uncertain, can be interrupted, and then verifies absent", async () => {
    process.env.FAKE_CODEX_MODE = "silent";
    rollout("t8", []);
    const a = adapter({ startTimeoutMs: 300 });
    const s = session("t8");
    expect(await a.inject(s, message("msg_s"), query("msg_s", "x"))).toEqual({ ok: false, uncertain: true, error: "the turn did not report a start in time" });
    expect(await a.verify(s, message("msg_s"))).toEqual({ status: "unknown", error: "turn still starting" });
    expect(a.interrupt(s.id)).toBe(true);
    expect(await until(() => ends[0])).toMatchObject({ sessionId: s.id });
    expect(a.isRunning(s.id)).toBe(false);
    expect(await a.verify(s, message("msg_s"))).toEqual({ status: "absent" });
    expect(a.interrupt(s.id)).toBe(false);
  });
});

describe("claudeDialect", () => {
  it("keeps typed input and replies, drops sidechains/meta/slash-command plumbing, and surfaces API errors as failed turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "portage-claude-"));
    mkdirSync(join(root, "-tmp-w"));
    const base = { sessionId: "c1", cwd: "/tmp/w", entrypoint: "sdk-cli", timestamp: "2026-11-18T10:00:00Z" };
    const records = [
      { ...base, type: "user", uuid: "u1", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      { ...base, type: "user", uuid: "u2", permissionMode: "acceptEdits", message: { role: "user", content: "[原始消息 · v1 · msg_x]\n请实现" } },
      { ...base, type: "user", uuid: "u3", isMeta: true, message: { role: "user", content: "meta" } },
      { ...base, type: "assistant", uuid: "a1", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
      { ...base, type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", name: "x" }, { type: "text", text: "完成" }] } },
      { ...base, type: "assistant", uuid: "a3", isApiErrorMessage: true, error: "authentication_failed", message: { content: [{ type: "text", text: "API Error: 403" }] } },
    ];
    const path = join(root, "-tmp-w", "c1.jsonl");
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const dialect = claudeDialect(root);
    expect(await dialect.locate("c1")).toBe(path);
    expect(await dialect.describe(path)).toMatchObject({ nativeSessionId: "c1", workdir: "/tmp/w", host: "headless", title: "[原始消息 · v1 · msg_x] 请实现" });
    const { observations } = await readTranscript(dialect, path, 0);
    expect(observations.map((o) => [o.nativeEventId, o.kind, o.text])).toEqual([
      ["u2", "input", "[原始消息 · v1 · msg_x]\n请实现"],
      ["a2", "output", "完成"],
      ["a3", "turn_failed", "API Error: 403"],
    ]);
    expect(await readPolicy(dialect, path)).toEqual({ permissionMode: "acceptEdits" });
    expect(await turnState(dialect, path)).toBe("closed");
    expect(claudeCli.args({ nativeSessionId: "c1", mcp: { command: "node", args: ["m.mjs"] }, policy: { permissionMode: "acceptEdits" } })).toEqual(
      expect.arrayContaining(["--resume", "c1", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__portage"]),
    );
  });

  it("knows whether a turn is running: open through tool calls, closed at a final stop or an interrupt", async () => {
    const root = mkdtempSync(join(tmpdir(), "portage-claude-"));
    mkdirSync(join(root, "-tmp-w"));
    const path = join(root, "-tmp-w", "c2.jsonl");
    const base = { sessionId: "c2", cwd: "/tmp/w", timestamp: "2026-11-18T10:00:00Z" };
    const dialect = claudeDialect(root);
    const add = (record: Record<string, unknown>) => appendFileSync(path, JSON.stringify({ ...base, ...record }) + "\n");
    add({ type: "user", message: { content: "看看测试" } });
    expect(await turnState(dialect, path)).toBe("open");
    add({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] } });
    add({ type: "user", message: { content: [{ type: "tool_result" }] } });
    add({ type: "last-prompt", lastPrompt: "看看测试" });
    expect(await turnState(dialect, path)).toBe("open");
    add({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "都过了" }] } });
    add({ type: "user", message: { content: "<command-name>/rename</command-name>" } });
    expect(await turnState(dialect, path)).toBe("closed");
    add({ type: "user", message: { content: "再跑一次" } });
    add({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(await turnState(dialect, path)).toBe("closed");
  });

  it("titles: a /rename outranks the generated title; renaming appends the record Claude's /rename writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "portage-claude-"));
    mkdirSync(join(root, "-tmp-w"));
    const path = join(root, "-tmp-w", "c3.jsonl");
    const base = { sessionId: "c3", cwd: "/tmp/w", timestamp: "2026-11-18T10:00:00Z" };
    writeFileSync(path, JSON.stringify({ ...base, type: "user", message: { content: "帮我看下日志" } }) + "\n");
    const dialect = claudeDialect(root);
    expect((await dialect.describe(path))!.title).toBe("帮我看下日志");
    appendFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: "Log triage", sessionId: "c3" }) + "\n");
    expect(await dialect.title(path, "c3")).toBe("Log triage");
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: "日志排查", sessionId: "c3" }) + "\n");
    appendFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: "Log triage", sessionId: "c3" }) + "\n");
    expect(await dialect.title(path, "c3")).toBe("日志排查");
    expect((await dialect.describe(path))!.title).toBe("日志排查");

    await claudeCli.rename({ binary: "claude", nativeSessionId: "c3", transcript: path, title: "Portage 改的名" });
    expect(JSON.parse(readFileSync(path, "utf8").trim().split("\n").pop()!)).toEqual({ type: "custom-title", customTitle: "Portage 改的名", sessionId: "c3" });
    expect(await dialect.title(path, "c3")).toBe("Portage 改的名");
  });
});

describe("readTranscript", () => {
  it("leaves a torn trailing line for the next read", async () => {
    home = mkdtempSync(join(tmpdir(), "portage-native-"));
    const path = join(home, "t.jsonl");
    const whole = JSON.stringify(said("user", "one")) + "\n";
    const torn = JSON.stringify(said("assistant", "two"));
    writeFileSync(path, whole + torn.slice(0, 20));
    const dialect = codexDialect(home);
    const a = await readTranscript(dialect, path, 0);
    expect(a.observations.map((o) => o.text)).toEqual(["one"]);
    expect(a.cursor).toBe(Buffer.byteLength(whole));
    appendFileSync(path, torn.slice(20) + "\n");
    const b = await readTranscript(dialect, path, a.cursor);
    expect(b.observations.map((o) => o.text)).toEqual(["two"]);
    expect(b.observations[0]!.nativeEventId).toBe(`L${a.cursor}`);
  });
});
