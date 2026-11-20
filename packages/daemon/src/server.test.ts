import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./server.js";

type Started = Awaited<ReturnType<typeof startServer>>;
// Response bodies are asserted field by field; a loose type keeps the assertions readable.
type Json = any;

describe("daemon HTTP API L4 closed loop", () => {
  let home = "";
  let started: Started | undefined;
  let base = "";

  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: (await r.json()) as Json }));
  const snapshot = () => fetch(`${base}/api/snapshot`).then((r) => r.json() as Promise<Json>);
  const latestInboxText = (provider: string, nativeIdentity: string) => {
    const dir = join(home, "inbox", provider, nativeIdentity);
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
    return readFileSync(join(dir, files.at(-1)!), "utf8");
  };
  const stop = (s: Started) =>
    new Promise<void>((resolve, reject) => s.server.close((e) => (e ? reject(e) : resolve())));

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "portage-home-"));
    process.env.PORTAGE_HOME = home;
    started = await startServer(8791, { seedDemo: true });
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    if (started) await stop(started);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("refuses pages from other origins and rebinding hosts, allows this machine's pages", async () => {
    const evil = await fetch(`${base}/api/conversations/room_dev/send`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
      body: JSON.stringify({ text: "wake everyone" }),
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/api/snapshot`, { headers: { Origin: "null" } })).status).toBe(403);
    const { request } = await import("node:http");
    const rebound = await new Promise<number>((resolve, reject) =>
      request(`${base}/api/health`, { headers: { Host: "attacker.example:8791" } }, (r) => resolve(r.statusCode ?? 0)).on("error", reject).end(),
    );
    expect(rebound).toBe(403);
    const local = await fetch(`${base}/api/health`, { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });

  it("serves dual-provider three-member room with valid native identities", async () => {
    const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<Json>);
    expect(health.ok).toBe(true);
    const snap = await snapshot();
    const room = snap.conversations.find((c: { id: string }) => c.id === "room_dev");
    expect(room.policy.wakeMode).toBe("coordinator");
    expect(room.document.publishedRevision).toBe(1);
    expect(snap.globalDocument.publishedRevision).toBe(1);
    const providers = new Set(snap.sessions.map((s: { provider: string }) => s.provider));
    expect(providers).toEqual(new Set(["codex", "claude"]));
    for (const session of snap.sessions) {
      expect(String(session.nativeIdentity)).not.toMatch(/undefined/);
    }
    expect(snap.memberships.filter((m: { conversationId: string; leftAt?: string }) => m.conversationId === "room_dev" && !m.leftAt)).toHaveLength(3);
  });

  it("user → coordinator → @members with global + room layers in the native inbox", async () => {
    const published = await post("/api/rooms/room_dev/policy", {
      markdown: "# collaboration.md\n\n- 仅约束协作边界\n- 不改写原生人格",
      maxAutoRounds: 4,
    });
    expect(published.json.document.publishedRevision).toBe(2);

    const user = await post("/api/conversations/room_dev/send", {
      text: "请统筹推进适配器契约",
      idempotencyKey: "l4_user",
    });
    expect(user.json.deliveries).toHaveLength(1);
    expect(user.json.deliveries[0]).toMatchObject({ recipientSessionId: "s_lead", state: "submitted" });

    const snap = await snapshot();
    const lead = snap.sessions.find((s: { id: string }) => s.id === "s_lead");
    const leadText = latestInboxText(lead.provider, lead.nativeIdentity);
    expect(leadText).toContain("请统筹推进适配器契约");
    expect(leadText).toContain("[Global PORTAGE.md · v1");
    expect(leadText).toContain("[Room collaboration.md · v2");
    expect(leadText).toContain("current lead (routing)");
    expect(snap.contexts[user.json.deliveries[0].id].hash).toBeTruthy();
    expect(snap.contexts[user.json.deliveries[0].id].query).toBeUndefined();
    const context = await fetch(`${base}/api/deliveries/${user.json.deliveries[0].id}/context`).then((r) => r.json() as Promise<Json>);
    expect(context.query).toBe(leadText);
    const receipt = snap.receipts.find((r: { deliveryId: string }) => r.deliveryId === user.json.deliveries[0].id);
    expect(receipt).toMatchObject({ adapterId: "cli-file-inbox", proofLevel: "submitted" });

    // Builder is mid-turn: its delivery waits in order; reviewer is free and gets it now.
    expect((await post("/api/agent/s_builder/status", { execution: "running" })).status).toBe(200);
    const agent = await post("/api/conversations/room_dev/send", {
      senderId: "p_lead",
      source: "agent",
      text: "@builder @reviewer 请分别核对",
      mentionParticipantIds: ["p_builder", "p_reviewer"],
      traceId: user.json.message.traceId,
      causalParentIds: [user.json.message.id],
      idempotencyKey: "l4_lead",
    });
    const by = Object.fromEntries(agent.json.deliveries.map((d: { recipientSessionId: string }) => [d.recipientSessionId, d]));
    expect(by.s_builder).toMatchObject({ state: "queued", reason: "busy" });
    expect(by.s_reviewer.state).toBe("submitted");
    expect(agent.json.message.traceId).toBe(user.json.message.traceId);

    const after = await snapshot();
    expect(after.conversations.find((c: { id: string }) => c.id === "room_dev").state.rounds).toBe(1);
    const reviewer = after.sessions.find((s: { id: string }) => s.id === "s_reviewer");
    expect(latestInboxText(reviewer.provider, reviewer.nativeIdentity)).toContain("请分别核对");

    const ready = await post("/api/sessions/s_builder/ready");
    expect(ready.json.deliveries.find((d: { id: string }) => d.id === by.s_builder.id).state).toBe("submitted");
    const builder = after.sessions.find((s: { id: string }) => s.id === "s_builder");
    expect(latestInboxText(builder.provider, builder.nativeIdentity)).toContain("请分别核对");

    const trace = (await snapshot()).events.filter((e: { traceId?: string }) => e.traceId === user.json.message.traceId);
    expect(trace.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(["MessageAccepted", "DeliveryQueued", "DeliverySubmitted"]),
    );
  });

  it("pause holds and resume flushes; disabled communication holds and re-enable flushes", async () => {
    await post("/api/rooms/room_dev/pause", { paused: true });
    const paused = await post("/api/conversations/room_dev/send", { text: "暂停期间", idempotencyKey: "l4_pause" });
    expect(paused.json.deliveries[0]).toMatchObject({ state: "held", reason: "room_paused" });
    const resumed = await post("/api/rooms/room_dev/pause", { paused: false });
    expect(resumed.json.deliveries[0].state).toBe("submitted");

    await post("/api/sessions/s_lead/communication", { enabled: false });
    const off = await post("/api/conversations/room_dev/send", { text: "关闭期间", idempotencyKey: "l4_off" });
    expect(off.json.deliveries[0]).toMatchObject({ state: "held", reason: "disabled" });
    const on = await post("/api/sessions/s_lead/communication", { enabled: true });
    expect(on.json.deliveries[0].state).toBe("submitted");
  });

  it("preview compiles what the recipient will get; artifacts and direct chat reach the inbox", async () => {
    const preview = await post("/api/conversations/room_dev/preview", { text: "预览正文" });
    expect(preview.json.recipientSessionId).toBe("s_lead");
    expect(preview.json.snapshot.layers).toEqual(["Global PORTAGE.md", "Room collaboration.md", "Execution policy", "Original message", "How to reply"]);

    const artifact = await post("/api/artifacts", {
      name: "review.md",
      mime: "text/markdown",
      contentBase64: Buffer.from("# review").toString("base64"),
      conversationId: "room_dev",
    });
    expect(artifact.json.byteSize).toBe(8);
    expect(readFileSync(artifact.json.storageKey, "utf8")).toBe("# review");
    const content = await fetch(`${base}/api/artifacts/${artifact.json.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(content.headers.get("content-security-policy")).toBe("sandbox");
    expect(content.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''review.md");
    expect(await content.text()).toBe("# review");
    expect((await fetch(`${base}/api/artifacts/nope/content`)).status).toBe(404);
    const untyped = await post("/api/artifacts", { name: "count.py", contentBase64: Buffer.from("print(1)").toString("base64") });
    expect(untyped.json.mime).toBe("text/plain");
    const shown = await fetch(`${base}/api/artifacts/${untyped.json.id}/content`);
    expect(shown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const withFile = await post("/api/conversations/room_dev/send", {
      text: "附上评审",
      artifactIds: [artifact.json.id],
      idempotencyKey: "l4_art",
    });
    const snap = await snapshot();
    const fileContext = await fetch(`${base}/api/deliveries/${withFile.json.deliveries[0].id}/context`).then((r) => r.json() as Promise<Json>);
    expect(fileContext.query).toContain(`artifactId=${artifact.json.id}`);
    expect(fileContext.query).toContain("review.md · v1 · 8 bytes");
    expect(fileContext.query).toContain("portage_artifact_get");

    const dm = await post("/api/sessions/s_reviewer/direct");
    expect(dm.json.kind).toBe("direct");
    const direct = await post(`/api/conversations/${dm.json.id}/send`, {
      text: "私聊审查",
      target: { kind: "participant", id: "p_reviewer" },
      idempotencyKey: "l4_dm",
    });
    expect(direct.json.deliveries[0]).toMatchObject({ recipientSessionId: "s_reviewer", state: "submitted" });
    const reviewer = snap.sessions.find((s: { id: string }) => s.id === "s_reviewer");
    const text = latestInboxText(reviewer.provider, reviewer.nativeIdentity);
    expect(text).toContain("私聊审查");
    expect(text).not.toContain("collaboration.md");

    const got = await post("/api/agent/s_builder/artifacts/get", { artifactId: artifact.json.id });
    expect(got.status).toBe(200);
    expect(Buffer.from(got.json.contentBase64, "base64").toString("utf8")).toBe("# review");
    const put = await post("/api/agent/s_builder/artifacts/put", {
      name: "result.txt",
      contentBase64: Buffer.from("built").toString("base64"),
      conversationId: "room_dev",
    });
    expect(put.status).toBe(200);
    expect(put.json.name).toBe("result.txt");
    const attached = await post("/api/agent/s_builder/send", {
      text: "done",
      artifactIds: [put.json.artifactId],
      roomId: "room_dev",
    });
    expect(attached.status).toBe(200);
    const sent = attached.json.message;
    expect(sent.parts.some((p: { kind: string; artifactId?: string }) => p.kind === "artifact_ref" && p.artifactId === put.json.artifactId)).toBe(true);
  });

  it("renames a room without touching its members or history", async () => {
    const before = (await snapshot()).conversations.find((c: { id: string }) => c.id === "room_dev");
    const renamed = await post("/api/rooms/room_dev", { title: "  设计评审  " });
    expect(renamed.status).toBe(200);
    expect(renamed.json.title).toBe("设计评审");
    const after = await snapshot();
    expect(after.conversations.find((c: { id: string }) => c.id === "room_dev")).toMatchObject({ title: "设计评审", kind: before.kind });
    expect(after.events.some((e: { eventType: string; payload: { previous?: string } }) => e.eventType === "RoomRenamed" && e.payload.previous === before.title)).toBe(true);
    expect((await post("/api/rooms/room_dev", { title: "   " })).status).toBe(400);
    expect((await post("/api/rooms/room_dev", { title: "x".repeat(51) })).status).toBe(400);
    expect((await post("/api/rooms/room_missing", { title: "Nope" })).status).toBe(404);
    await post("/api/rooms/room_dev", { title: before.title });
  });

  it("registers a discovered session, joins/leaves, swarm suppresses wake, conflicts are explicit", async () => {
    const registered = await post("/api/sessions", {
      provider: "codex",
      host: "terminal",
      nativeIdentity: "pid-424242",
      displayName: "资料会话",
    });
    expect(registered.status).toBe(200);
    const participantId = `p_${registered.json.id.slice(2)}`;
    expect((await post("/api/sessions", { provider: "codex", nativeIdentity: "pid-424242" })).status).toBe(409);

    await post("/api/rooms/room_dev/members", { participantId });
    const left = await post(`/api/rooms/room_dev/members/${participantId}/leave`);
    expect(left.json.leftAt).toBeTruthy();
    const afterLeave = await snapshot();
    expect(afterLeave.sessions.find((s: { id: string }) => s.id === registered.json.id)).toMatchObject({ displayName: "资料会话", nativeIdentity: "pid-424242" });
    expect((await post("/api/rooms/room_dev/members", { participantId })).status).toBe(200);
    await post(`/api/rooms/room_dev/members/${participantId}/leave`);

    await post("/api/rooms/room_dev/wake-mode", { mode: "swarm" });
    const swarm = await post("/api/conversations/room_dev/send", { text: "开放讨论", idempotencyKey: "l4_swarm" });
    expect(swarm.json.deliveries).toHaveLength(0);
    const events = (await snapshot()).events;
    expect(events.some((e: { eventType: string; entityId: string }) => e.eventType === "WakeSuppressed" && e.entityId === swarm.json.message.id)).toBe(true);

    const conflict = await post("/api/conversations/room_dev/send", { text: "不同正文", idempotencyKey: "l4_swarm" });
    expect(conflict.status).toBe(400);
    expect(conflict.json.error).toMatch(/conflict/);
    await post("/api/rooms/room_dev/wake-mode", { mode: "coordinator", coordinatorParticipantId: "p_lead" });
  });

  it("streams bus events over SSE", async () => {
    const controller = new AbortController();
    const since = (await snapshot()).lastEventSeq;
    const response = await fetch(`${base}/api/events/stream?since=${since}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await post("/api/conversations/room_dev/send", { text: "sse", idempotencyKey: "l4_sse" });
    let buffer = "";
    while (!buffer.includes("DeliverySubmitted")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(buffer).toContain("event: bus");
    expect(buffer).toContain("MessageAccepted");
    expect(buffer).toContain("DeliverySubmitted");
  });

  it("collaboration.md frontmatter is executable policy; an invalid doc is rejected whole", async () => {
    const markdown = "---\nversion: 1\nwake:\n  max_concurrent: 1\nbudget:\n  max_auto_rounds: 6\n---\n# 约定\n\n完成后附产物引用。";
    const ok = await post("/api/rooms/room_dev/policy", { markdown });
    expect(ok.status).toBe(200);
    expect(ok.json.policy).toMatchObject({ maxConcurrent: 1, maxAutoRounds: 6 });

    const bad = await post("/api/rooms/room_dev/policy", { markdown: "---\nbudget:\n  max_auto_rounds: 0\n---\nx" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("max_auto_rounds");
    const room = (await snapshot()).conversations.find((c: { id: string }) => c.id === "room_dev");
    expect(room.policy.maxAutoRounds).toBe(6);
    expect(room.document.publishedRevision).toBe(ok.json.document.publishedRevision);

    const budget = await post("/api/rooms/room_dev/policy", { maxConcurrent: 2, maxWakeupsPerTrace: 30 });
    expect(budget.json.policy).toMatchObject({ maxConcurrent: 2, maxWakeupsPerTrace: 30 });
  });

  it("restart hydrates state and continues seq without losing snapshots", async () => {
    const before = await snapshot();
    const lastSeq = Math.max(...before.messages.filter((m: { conversationId: string }) => m.conversationId === "room_dev").map((m: { seq: number }) => m.seq));
    await stop(started!);
    // A fresh port: the client must not reuse keep-alive sockets of the stopped server.
    started = await startServer(8795, { seedDemo: true });
    base = `http://127.0.0.1:${started.port}`;
    const after = await snapshot();
    expect(after.messages.length).toBe(before.messages.length);
    expect(Object.keys(after.contexts).length).toBe(Object.keys(before.contexts).length);
    const next = await post("/api/conversations/room_dev/send", { text: "重启后", idempotencyKey: "l4_restart" });
    expect(next.json.message.seq).toBe(lastSeq + 1);
    const replay = await post("/api/conversations/room_dev/send", { text: "请统筹推进适配器契约", idempotencyKey: "l4_user" });
    expect(replay.json.message.seq).toBe(1);
  });

  it("the snapshot stays bounded: a recent window per conversation, older history paged on demand", async () => {
    const room = (await post("/api/rooms", { title: "长历史" })).json;
    for (let i = 0; i < 80; i += 1) await post(`/api/conversations/${room.id}/send`, { text: `h${i}`, idempotencyKey: `long_${i}` });
    const snap = await snapshot();
    const recent = snap.messages.filter((m: Json) => m.conversationId === room.id);
    expect(recent).toHaveLength(50);
    expect(recent[0].parts[0].text).toBe("h30");
    expect(snap.history[room.id]).toEqual({ hasMore: true, fromSeq: recent[0].seq });
    expect(snap.history.room_dev.hasMore).toBe(false);

    const page = await fetch(`${base}/api/conversations/${room.id}/messages?beforeSeq=${recent[0].seq}&limit=20`).then((r) => r.json() as Promise<Json>);
    expect(page.messages.map((m: Json) => m.parts[0].text)).toEqual(Array.from({ length: 20 }, (_, i) => `h${i + 10}`));
    expect(page.hasMore).toBe(true);
    const first = await fetch(`${base}/api/conversations/${room.id}/messages?beforeSeq=${page.messages[0].seq}&limit=20`).then((r) => r.json() as Promise<Json>);
    expect(first.messages).toHaveLength(10);
    expect(first.hasMore).toBe(false);
    expect((await fetch(`${base}/api/conversations/nope/messages`)).status).toBe(404);
    expect((await fetch(`${base}/api/deliveries/nope/context`)).status).toBe(404);
  });
}, 60000);
