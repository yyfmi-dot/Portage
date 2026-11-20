import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeTurnAdapter, codexCli, codexDialect } from "@portage/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./server.js";

type Json = any;
type Started = Awaited<ReturnType<typeof startServer>>;

const FAKE = fileURLToPath(new URL("../../adapters/src/native/fixtures/fake-codex.mjs", import.meta.url));
const PORT = 8794;
const base = `http://127.0.0.1:${PORT}`;

/**
 * L3 chain over HTTP with the real runtime, real NativeTurnAdapter and a fake Codex CLI that writes
 * real-format transcripts and answers through the daemon the way the mounted Portage MCP server does.
 */
describe.skipIf(process.platform === "win32")("daemon · native Codex room", () => {
  let home = "";
  let codexHome = "";
  let workdir = "";
  let started: Started | undefined;

  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(
      async (r) => ({ status: r.status, json: (await r.json()) as Json }),
    );
  const get = (path: string) => fetch(`${base}${path}`).then((r) => r.json() as Promise<Json>);

  function thread(id: string, title: string) {
    const day = join(codexHome, "sessions", "2026", "11", "18");
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-11-18T10-00-00-${id}.jsonl`);
    const records = [
      { type: "session_meta", payload: { id, cwd: workdir, originator: "codex_exec" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: title }] } },
    ];
    writeFileSync(path, records.map((r) => JSON.stringify({ timestamp: "2026-11-18T10:00:00Z", ...r })).join("\n") + "\n");
    const old = new Date(Date.now() - 600_000);
    utimesSync(path, old, old);
  }

  async function settle(ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const snap = await get("/api/snapshot");
      const pending = snap.deliveries.filter((d: Json) => ["queued", "dispatching"].includes(d.state));
      const running = Object.entries(snap.runtimes).filter(([id, r]: [string, Json]) => id.startsWith("s_codex_") && r.execution === "running");
      if (!pending.length && !running.length) return snap;
      if (Date.now() > deadline) throw new Error(`not settled: ${pending.length} pending, ${running.length} running`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "portage-home-"));
    codexHome = mkdtempSync(join(tmpdir(), "portage-codex-"));
    workdir = mkdtempSync(join(tmpdir(), "portage-work-"));
    process.env.PORTAGE_HOME = home;
    process.env.CODEX_HOME = codexHome;
    thread("th-lead", "统筹这个仓库的改动");
    thread("th-builder", "实现适配器");
    thread("th-reviewer", "代码审查");
    started = await startServer(PORT, {
      native: (onTurnEnd) => [
        new NativeTurnAdapter({
          id: "codex-native",
          dialect: codexDialect(join(codexHome, "sessions")),
          cli: { ...codexCli, binary: async () => FAKE },
          mcp: { command: process.execPath, args: ["portage-mcp.mjs", "--daemon", base] },
          onTurnEnd,
        }),
      ],
    });
  });

  afterAll(async () => {
    if (started) {
      started.server.closeAllConnections();
      await new Promise((r) => started!.server.close(r));
    }
    for (const dir of [home, codexHome, workdir]) rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_CODEX_REPLIES;
  });

  it("discovers native threads, registers them with their adapter and workdir, and imports recent history", async () => {
    const { endpoints } = await get("/api/discover");
    const native = endpoints.filter((e: Json) => e.adapterId === "codex-native");
    expect(native.map((e: Json) => e.nativeSessionId).sort()).toEqual(["th-builder", "th-lead", "th-reviewer"]);
    expect(native.every((e: Json) => e.registered === false && e.workdir === workdir && e.attached === false)).toBe(true);

    for (const [id, alias] of [["th-lead", "lead2"], ["th-builder", "builder2"], ["th-reviewer", "reviewer2"]]) {
      const e = native.find((x: Json) => x.nativeSessionId === id);
      const created = await post("/api/sessions", { provider: "codex", nativeIdentity: id, adapterId: "codex-native", workdir: e.workdir, host: e.host, displayName: e.displayName, alias });
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ adapterId: "codex-native", workdir, bindingEpoch: 1, alias });
    }
    expect((await post("/api/sessions", { provider: "codex", nativeIdentity: "x", adapterId: "nope" })).json.error).toMatch(/unknown adapterId nope/);

    const history = await get("/api/sessions/s_codex_th-lead/native");
    expect(history.events.map((e: Json) => [e.kind, e.text])).toEqual([["input", "统筹这个仓库的改动"]]);
    expect(history.checkpoint.source).toContain("th-lead");
    expect((await get("/api/discover")).endpoints.filter((e: Json) => e.registered).length).toBeGreaterThanOrEqual(3);
  });

  it("user → coordinator turn → @members turns → replies back to the coordinator → summary, all proven natively", async () => {
    process.env.FAKE_CODEX_REPLIES = JSON.stringify({
      "s_codex_th-lead": ["@builder2 请实现解析器；@reviewer2 请评审接口", "收到一份结果", "总结：解析器已实现并通过评审"],
      "s_codex_th-builder": ["解析器已实现"],
      "s_codex_th-reviewer": ["接口评审通过"],
    });
    const room = (await post("/api/rooms", { title: "原生协作" })).json;
    for (const p of ["p_codex_th-lead", "p_codex_th-builder", "p_codex_th-reviewer"])
      expect((await post(`/api/rooms/${room.id}/members`, { participantId: p })).status).toBe(200);
    expect((await post(`/api/rooms/${room.id}/wake-mode`, { mode: "coordinator", coordinatorParticipantId: "p_codex_th-lead" })).status).toBe(200);

    const sent = await post(`/api/conversations/${room.id}/send`, { text: "实现 JSONL 解析器并评审", idempotencyKey: "native-1" });
    expect(sent.json.deliveries).toHaveLength(1);
    expect(sent.json.deliveries[0]).toMatchObject({ recipientSessionId: "s_codex_th-lead", state: "submitted" });

    const snap = await settle();
    const messages = snap.messages.filter((m: Json) => m.conversationId === room.id);
    const who = (m: Json) => (m.senderId === "user" ? "user" : snap.sessions.find((s: Json) => `p_${s.id.slice(2)}` === m.senderId)?.alias);
    expect(messages.map((m: Json) => [who(m), m.parts[0].text])).toEqual(
      expect.arrayContaining([
        ["user", "实现 JSONL 解析器并评审"],
        ["lead2", "@builder2 请实现解析器；@reviewer2 请评审接口"],
        ["builder2", "解析器已实现"],
        ["reviewer2", "接口评审通过"],
      ]),
    );
    expect(messages).toHaveLength(6);
    expect(new Set(messages.map((m: Json) => m.traceId)).size).toBe(1);
    expect(messages.at(-1).parts[0].text).toBe("总结：解析器已实现并通过评审");

    const deliveries = snap.deliveries.filter((d: Json) => d.conversationId === room.id);
    expect(deliveries.map((d: Json) => d.state)).toEqual(deliveries.map(() => "submitted"));
    const proofs = (id: string) => snap.receipts.filter((r: Json) => r.deliveryId === id).map((r: Json) => `${r.proofLevel}:${r.adapterId}`);
    for (const d of deliveries) {
      expect(proofs(d.id)).toEqual(expect.arrayContaining(["submitted:codex-native", "native_confirmed:codex-native"]));
    }
    // each member answered what it was given, so every delivery it answered is acknowledged by that reply
    const answered = deliveries.filter((d: Json) => proofs(d.id).includes("agent_ack:reply"));
    expect(answered.length).toBeGreaterThanOrEqual(4);
    // five agent messages on the trace, three of them wake someone; the coordinator's last two wake no one and are not rounds
    expect(snap.conversations.find((c: Json) => c.id === room.id).state.rounds).toBe(3);

    const lead = await get("/api/sessions/s_codex_th-lead/native");
    const inputs = lead.events.filter((e: Json) => e.kind === "input" && e.correlation === "exact");
    expect(inputs).toHaveLength(3);
    expect(inputs[0].text).toContain("[How to reply]");
    expect(inputs[0].text).toContain("实现 JSONL 解析器并评审");
    const outputs = lead.events.filter((e: Json) => e.kind === "output" && e.correlation === "inferred");
    expect(outputs.map((e: Json) => e.text)).toContain("总结：解析器已实现并通过评审");
    const observed = snap.events.filter((e: Json) => e.eventType === "NativeEventObserved" && e.conversationId === room.id);
    expect(observed.length).toBeGreaterThan(0);
  }, 20_000);

  it("a failed native turn frees the session with the reason, and the next input still goes out", async () => {
    process.env.FAKE_CODEX_MODE = "fail";
    const dm = (await post("/api/sessions/s_codex_th-builder/direct")).json;
    const first = await post(`/api/conversations/${dm.id}/send`, { text: "这一轮会失败", target: { kind: "participant", id: "p_codex_th-builder" }, idempotencyKey: "fail-1" });
    expect(first.json.deliveries[0].state).toBe("submitted");
    let snap = await settle();
    expect(snap.runtimes["s_codex_th-builder"]).toMatchObject({ execution: "idle", detail: "Native turn failed: model refused" });

    delete process.env.FAKE_CODEX_MODE;
    const second = await post(`/api/conversations/${dm.id}/send`, { text: "再来一次", target: { kind: "participant", id: "p_codex_th-builder" }, idempotencyKey: "fail-2" });
    expect(second.json.deliveries[0].state).toBe("submitted");
    snap = await settle();
    expect(snap.runtimes["s_codex_th-builder"].detail ?? null).toBeNull();
  });

  it("rebinding to another thread holds old input until confirmed; cancel withdraws it instead", async () => {
    thread("th-builder-v2", "新的实现线程");
    await post("/api/sessions/s_codex_th-builder/ready");
    const dm = (await post("/api/sessions/s_codex_th-builder/direct")).json;
    await post("/api/agent/s_codex_th-builder/status", { execution: "running" });
    const queued = await post(`/api/conversations/${dm.id}/send`, { text: "排队中", target: { kind: "participant", id: "p_codex_th-builder" }, idempotencyKey: "rb-1" });
    const cancelMe = await post(`/api/conversations/${dm.id}/send`, { text: "撤回这条", target: { kind: "participant", id: "p_codex_th-builder" }, idempotencyKey: "rb-2" });
    expect(queued.json.deliveries[0]).toMatchObject({ state: "queued", reason: "busy" });

    const rebound = await post("/api/sessions/s_codex_th-builder/rebind", { nativeIdentity: "th-builder-v2" });
    expect(rebound.json).toMatchObject({ nativeIdentity: "th-builder-v2", bindingEpoch: 2 });
    const cancelled = await post(`/api/deliveries/${cancelMe.json.deliveries[0].id}/cancel`);
    expect(cancelled.json).toMatchObject({ state: "cancelled" });
    expect((await post(`/api/deliveries/${cancelMe.json.deliveries[0].id}/cancel`)).json.error).toMatch(/only queued or held/);

    await post("/api/agent/s_codex_th-builder/status", { execution: "idle" });
    let snap = await get("/api/snapshot");
    expect(snap.deliveries.find((d: Json) => d.id === queued.json.deliveries[0].id)).toMatchObject({ state: "held", reason: "identity_changed" });

    await post("/api/sessions/s_codex_th-builder/confirm-binding");
    snap = await settle();
    expect(snap.deliveries.find((d: Json) => d.id === queued.json.deliveries[0].id).state).toBe("submitted");
    const native = await get("/api/sessions/s_codex_th-builder/native");
    expect(native.checkpoint.source).toContain("th-builder-v2");
    expect(native.events.filter((e: Json) => e.correlation === "exact").map((e: Json) => e.correlatedMessageId)).toContain(queued.json.message.id);
    expect(native.events.some((e: Json) => e.text.includes("撤回这条"))).toBe(false);
  });

  it("keeps the session name in sync with Codex both ways", async () => {
    const index = join(codexHome, "session_index.jsonl");
    const lastEntry = () => JSON.parse(readFileSync(index, "utf8").trim().split("\n").pop()!);
    const renamed = await post("/api/sessions/s_codex_th-reviewer", { displayName: "评审员" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ displayName: "评审员", nativeTitle: "评审员" });
    expect(renamed.json.nativeRenameError).toBeUndefined();
    expect(lastEntry()).toMatchObject({ id: "th-reviewer", thread_name: "评审员" });

    // renamed in the Codex app: Portage follows on its next sync
    appendFileSync(index, `${JSON.stringify({ id: "th-reviewer", thread_name: "Codex 里改的名", updated_at: new Date().toISOString() })}\n`);
    const deadline = Date.now() + 12_000;
    let snap = await get("/api/snapshot");
    while (snap.sessions.find((s: Json) => s.id === "s_codex_th-reviewer").displayName !== "Codex 里改的名" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      snap = await get("/api/snapshot");
    }
    expect(snap.sessions.find((s: Json) => s.id === "s_codex_th-reviewer").displayName).toBe("Codex 里改的名");
    expect(snap.events.some((e: Json) => e.eventType === "SessionUpdated" && e.entityId === "s_codex_th-reviewer" && e.payload.source === "native")).toBe(true);

    // Codex unreachable: the Portage name stands, and the response says why Codex kept its title
    process.env.FAKE_CODEX_MODE = "fail";
    const refused = await post("/api/sessions/s_codex_th-reviewer", { displayName: "只在 Portage" });
    delete process.env.FAKE_CODEX_MODE;
    expect(refused.json).toMatchObject({ displayName: "只在 Portage", nativeTitle: "Codex 里改的名", nativeRenameError: "thread not found" });
    expect(lastEntry().thread_name).toBe("Codex 里改的名");
  }, 20_000);

  it("interrupt stops a running Portage turn", async () => {
    process.env.FAKE_CODEX_MODE = "silent";
    process.env.FAKE_CODEX_TURN_MS = "0";
    const dm = (await post("/api/sessions/s_codex_th-reviewer/direct")).json;
    const pending = post(`/api/conversations/${dm.id}/send`, { text: "长任务", target: { kind: "participant", id: "p_codex_th-reviewer" }, idempotencyKey: "int-1" });
    let interrupted = false;
    for (let i = 0; i < 100 && !interrupted; i += 1) {
      interrupted = (await post("/api/sessions/s_codex_th-reviewer/interrupt")).json.interrupted;
      if (!interrupted) await new Promise((r) => setTimeout(r, 30));
    }
    expect(interrupted).toBe(true);
    await pending;
    delete process.env.FAKE_CODEX_MODE;
    const snap = await settle();
    expect(snap.runtimes["s_codex_th-reviewer"].execution).toBe("idle");
    expect((await post("/api/sessions/s_codex_th-reviewer/interrupt")).json).toEqual({ interrupted: false });
  });
});
