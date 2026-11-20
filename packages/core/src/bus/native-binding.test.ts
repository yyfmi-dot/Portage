import { describe, expect, it } from "vitest";
import type { Readiness } from "../adapter.js";
import type { Session } from "../types.js";
import { MemoryBus, type InjectHook, type MemoryBusOptions } from "./memory-bus.js";

type Injected = { sessionId: string; nativeIdentity: string; query: string; epoch?: number };

function setup(options: { inject?: InjectHook; readiness?: (s: Session) => Readiness | Promise<Readiness> } = {}) {
  const injected: Injected[] = [];
  const hooks: MemoryBusOptions = {
    inject:
      options.inject ??
      (async ({ session, compiledQuery, delivery }) => {
        injected.push({ sessionId: session.id, nativeIdentity: session.nativeIdentity, query: compiledQuery, epoch: delivery.bindingEpoch });
        return { ok: true, adapterId: "codex-native", proof: "submitted" };
      }),
    readiness: options.readiness ? async (s) => options.readiness!(s) : undefined,
  };
  const bus = new MemoryBus(hooks);
  for (const [id, alias] of [["s_lead", "lead"], ["s_builder", "builder"]] as const) {
    bus.registerSession({
      session: {
        id,
        provider: "codex",
        harness: "cli",
        host: "headless",
        nativeIdentity: `thread-${alias}`,
        displayName: alias,
        alias,
        communicationEnabled: true,
        adapterId: "codex-native",
        workdir: "/tmp/w",
      },
      participantId: `p_${alias}`,
    });
  }
  const dm = (sessionId: string, text: string, key: string) =>
    bus.send({
      conversationId: bus.ensureDirectConversation(sessionId).id,
      senderId: "user",
      target: { kind: "participant", id: `p_${sessionId.slice(2)}` },
      text,
      idempotencyKey: key,
      source: "user",
    });
  const state = (id: string) => bus.getDelivery(id)!;
  return { bus, injected, dm, state };
}

describe("binding epoch", () => {
  it("holds deliveries accepted under the old binding until the user confirms the new one, then submits to the new identity", async () => {
    const { bus, injected, dm, state } = setup();
    bus.setSessionExecution("s_builder", "running");
    const sent = await dm("s_builder", "第一条", "e1");
    const id = sent.deliveries[0]!.id;
    expect(state(id)).toMatchObject({ state: "queued", reason: "busy", bindingEpoch: 1 });

    const unchanged = bus.rebindSession({ sessionId: "s_builder", nativeIdentity: "thread-builder" });
    expect(unchanged.bindingEpoch).toBe(1);

    const rebound = bus.rebindSession({ sessionId: "s_builder", nativeIdentity: "thread-builder-2" });
    expect(rebound).toMatchObject({ nativeIdentity: "thread-builder-2", bindingEpoch: 2 });
    expect(state(id)).toMatchObject({ state: "held", reason: "identity_changed" });
    expect(bus.events.at(-2)).toMatchObject({ eventType: "SessionBindingChanged", payload: { epoch: 2, nativeIdentity: "thread-builder-2" } });

    // the session going idle is not consent to send old-binding input to the new identity
    await bus.markSessionReady("s_builder");
    expect(state(id).state).toBe("held");
    expect(injected).toEqual([]);

    // a message accepted after the rebind belongs to the new binding and goes straight out
    const fresh = await dm("s_builder", "第二条", "e2");
    expect(state(fresh.deliveries[0]!.id)).toMatchObject({ state: "submitted", bindingEpoch: 2 });

    await bus.confirmBinding("s_builder");
    expect(state(id)).toMatchObject({ state: "submitted", bindingEpoch: 2 });
    expect(injected.map((i) => [i.nativeIdentity, i.epoch, i.query.includes("第一条")])).toEqual([
      ["thread-builder-2", 2, false],
      ["thread-builder-2", 2, true],
    ]);
    expect((await bus.getReceipts(id))[0]).toMatchObject({ proofLevel: "submitted", bindingEpoch: 2 });
  });

  it("a rebind restarts native read-back for the new transcript", async () => {
    const { bus } = setup();
    bus.recordNativeRead("s_lead", "codex-native", { observations: [], cursor: 900, source: "/a.jsonl" });
    expect(bus.nativeCheckpoints.get("s_lead")?.cursor).toBe(900);
    bus.rebindSession({ sessionId: "s_lead", nativeIdentity: "thread-other" });
    expect(bus.nativeCheckpoints.has("s_lead")).toBe(false);
  });
});

describe("cancel", () => {
  it("withdraws a waiting delivery so it never reaches the agent; a submitted one cannot be cancelled", async () => {
    const { bus, injected, dm, state } = setup();
    bus.setSessionExecution("s_builder", "running");
    const waiting = (await dm("s_builder", "撤回我", "c1")).deliveries[0]!.id;
    const cancelled = bus.cancelDelivery({ deliveryId: waiting, actorId: "user" });
    expect(cancelled).toMatchObject({ state: "cancelled", reason: "cancelled_by_user" });
    expect(bus.events.at(-1)).toMatchObject({ eventType: "DeliveryCancelled", entityId: waiting });

    await bus.markSessionReady("s_builder");
    expect(injected).toEqual([]);

    const sent = (await dm("s_builder", "已送达", "c2")).deliveries[0]!.id;
    expect(state(sent).state).toBe("submitted");
    expect(() => bus.cancelDelivery({ deliveryId: sent, actorId: "user" })).toThrow(/only queued or held/);
    expect(() => bus.cancelDelivery({ deliveryId: "nope", actorId: "user" })).toThrow(/not found/);
  });
});

describe("native read-back", () => {
  it("correlates the native input exactly by message id, confirms natively, and links the reply as inferred", async () => {
    const { bus, dm, injected } = setup();
    const sent = await dm("s_lead", "请评审", "n1");
    const delivery = sent.deliveries[0]!;
    const query = injected[0]!.query;

    const added = bus.recordNativeRead("s_lead", "codex-native", {
      observations: [
        { nativeEventId: "L0", nativeTime: "t0", kind: "input", text: "用户自己在终端里问的" },
        { nativeEventId: "L1", nativeTime: "t0", kind: "output", text: "终端回答" },
        { nativeEventId: "L2", nativeTime: "t1", kind: "input", text: query },
        { nativeEventId: "L3", nativeTime: "t2", kind: "output", text: "评审完成" },
        { nativeEventId: "L4", nativeTime: "t2", kind: "turn_completed", text: "" },
        { nativeEventId: "L5", nativeTime: "t3", kind: "turn_started", text: "" },
        { nativeEventId: "L6", nativeTime: "t3", kind: "output", text: "下一回合在输入写入前的输出" },
      ],
      cursor: 500,
      source: "/r.jsonl",
    });
    expect(added.map((e) => [e.nativeEventId, e.kind, e.correlation, e.correlatedMessageId ?? null])).toEqual([
      ["L0", "input", "unknown", null],
      ["L1", "output", "unknown", null],
      ["L2", "input", "exact", sent.message.id],
      ["L3", "output", "inferred", sent.message.id],
      ["L4", "turn_completed", "inferred", sent.message.id],
      ["L5", "turn_started", "unknown", null],
      ["L6", "output", "unknown", null],
    ]);
    expect((await bus.getReceipts(delivery.id)).map((r) => [r.proofLevel, r.adapterId, r.nativeMessageId ?? null])).toEqual([
      ["submitted", "codex-native", null],
      ["native_confirmed", "codex-native", "L2"],
    ]);
    const observed = bus.events.filter((e) => e.eventType === "NativeEventObserved");
    expect(observed.at(-4)).toMatchObject({ conversationId: delivery.conversationId, traceId: sent.message.traceId, causalParentIds: [sent.message.id] });
    expect(bus.nativeCheckpoints.get("s_lead")).toMatchObject({ cursor: 500, source: "/r.jsonl" });

    // re-reading the same records (e.g. after a cursor reset) adds nothing and confirms nothing twice
    expect(bus.recordNativeRead("s_lead", "codex-native", { observations: [{ nativeEventId: "L2", nativeTime: "t1", kind: "input", text: query }], cursor: 500, source: "/r.jsonl" })).toEqual([]);
    expect(await bus.getReceipts(delivery.id)).toHaveLength(2);
    expect(bus.listNativeEvents("s_lead", 2).map((e) => e.nativeEventId)).toEqual(["L5", "L6"]);
    expect(bus.takeDirty().nativeEvents).toHaveLength(7);
  });

  it("settles an uncertain submission when its input shows up in the transcript, but never another session's", async () => {
    let mode: "uncertain" | "ok" = "uncertain";
    const { bus, dm, state } = setup({
      inject: async () => (mode === "uncertain" ? { ok: false, uncertain: true, error: "no start signal" } : { ok: true }),
    });
    const sent = await dm("s_lead", "可能没送到", "u1");
    const id = sent.deliveries[0]!.id;
    expect(state(id).state).toBe("uncertain");
    const marker = `[Original message · v1 · ${sent.message.id}]`;

    bus.recordNativeRead("s_builder", "codex-native", { observations: [{ nativeEventId: "B0", nativeTime: "t", kind: "input", text: marker }], cursor: 1, source: "/b" });
    expect(state(id).state).toBe("uncertain");

    bus.recordNativeRead("s_lead", "codex-native", { observations: [{ nativeEventId: "L9", nativeTime: "t", kind: "input", text: `header\n${marker}\n可能没送到` }], cursor: 1, source: "/a" });
    expect(state(id).state).toBe("submitted");
    expect((await bus.getReceipts(id)).map((r) => r.proofLevel)).toEqual(["native_confirmed"]);
    mode = "ok";
  });

  it("follows a rename made in the session's own app; the first reading and Portage's own write-back change nothing", () => {
    const { bus } = setup();
    const read = (title: string, cursor: number) => bus.recordNativeRead("s_lead", "codex-native", { observations: [], cursor, source: "/a", title });
    const name = () => bus.sessions.get("s_lead")!.displayName;

    read("A title the app generated", 1);
    expect(name()).toBe("lead");
    expect(bus.sessions.get("s_lead")!.nativeTitle).toBe("A title the app generated");

    read("Renamed in Codex", 2);
    expect(name()).toBe("Renamed in Codex");
    expect(bus.events.at(-1)).toMatchObject({ eventType: "SessionUpdated", entityId: "s_lead", payload: { displayName: "Renamed in Codex", source: "native" } });

    bus.updateSession({ sessionId: "s_lead", displayName: "Renamed in Portage" });
    bus.markNativeTitle("s_lead", "Renamed in Portage");
    const events = bus.events.length;
    read("Renamed in Portage", 3);
    expect(name()).toBe("Renamed in Portage");
    expect(bus.events.length).toBe(events);
  });

  it("a read failure keeps the cursor and records the error", () => {
    const { bus } = setup();
    bus.recordNativeRead("s_lead", "codex-native", { observations: [], cursor: 42, source: "/a" });
    bus.recordNativeReadError("s_lead", "/a", "EACCES");
    expect(bus.nativeCheckpoints.get("s_lead")).toMatchObject({ cursor: 42, error: "EACCES" });
  });
});

describe("native input lock and turn execution", () => {
  it("never submits two inputs to one session at once, and keeps acceptance order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const { bus, dm } = setup({
      inject: async ({ message }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        order.push(message.id);
        inFlight -= 1;
        return { ok: true };
      },
    });
    const sends = await Promise.all([dm("s_lead", "a", "l1"), dm("s_lead", "b", "l2"), dm("s_lead", "c", "l3"), dm("s_builder", "x", "l4")]);
    await new Promise((r) => setTimeout(r, 80));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    const leadOrder = order.filter((id) => sends.slice(0, 3).some((s) => s.message.id === id));
    expect(leadOrder).toEqual(sends.slice(0, 3).map((s) => s.message.id));
    expect(sends.flatMap((s) => s.deliveries.map((d) => bus.getDelivery(d.id)!.state))).toEqual(["submitted", "submitted", "submitted", "submitted"]);
  });

  it("dispatches to different sessions concurrently, and an in-flight dispatch already takes an activity seat", async () => {
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { bus } = setup({
      inject: async ({ session }) => {
        started.push(session.id);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 120));
        inFlight -= 1;
        return { ok: true };
      },
    });
    const room = bus.createRoom({ id: "room_c", title: "c", createdBy: "user", wakeMode: "swarm" });
    await bus.joinRoom({ conversationId: room.id, participantId: "p_lead" });
    await bus.joinRoom({ conversationId: room.id, participantId: "p_builder" });
    const both = await bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: "两位都看看", mentionParticipantIds: ["p_lead", "p_builder"], idempotencyKey: "cc1", source: "user" });
    // overlap, not wall-clock time: a loaded machine must not turn this into a false failure
    expect(maxInFlight).toBe(2);
    expect(both.deliveries.map((d) => d.state)).toEqual(["submitted", "submitted"]);

    await bus.updateRoomPolicy({ conversationId: room.id, maxConcurrent: 1, maxAutoRounds: 10 });
    started.length = 0;
    const agent = await bus.send({ conversationId: room.id, senderId: "p_lead", target: { kind: "room", id: room.id }, text: "@builder 一起", mentionParticipantIds: ["p_builder"], idempotencyKey: "cc2", source: "agent" });
    expect(agent.deliveries[0]!.state).toBe("submitted");
    const pending = bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: "@lead", mentionParticipantIds: ["p_lead"], idempotencyKey: "cc3", source: "user" });
    const second = bus.send({ conversationId: room.id, senderId: "p_lead", target: { kind: "room", id: room.id }, text: "@builder 再来", mentionParticipantIds: ["p_builder"], idempotencyKey: "cc4", source: "agent" });
    const [, queued] = await Promise.all([pending, second]);
    expect(queued.deliveries[0]).toMatchObject({ state: "queued", reason: "seats" });
  });

  it("a submission that starts a native turn marks the session running; the next input waits for the turn to end", async () => {
    const { bus, dm, state } = setup({ inject: async () => ({ ok: true, proof: "submitted", running: true }) });
    await dm("s_lead", "第一轮", "r1");
    expect(bus.runtime.get("s_lead")?.execution).toBe("running");
    const second = (await dm("s_lead", "第二轮", "r2")).deliveries[0]!.id;
    expect(state(second)).toMatchObject({ state: "queued", reason: "busy" });
    await bus.reportExecution("s_lead", "idle", "Native turn failed: model refused");
    expect(state(second).state).toBe("submitted");
    expect(bus.runtime.get("s_lead")).toMatchObject({ execution: "running" });
    expect(bus.events.filter((e) => e.eventType === "SessionExecutionChanged").map((e) => e.payload)).toContainEqual({
      execution: "idle",
      detail: "Native turn failed: model refused",
    });
  });
});

describe("adapter readiness", () => {
  it("holds while another client has the session open and releases on the tick that finds it free", async () => {
    let readiness: Readiness = { ready: false, reason: "attached", detail: "in use by pid 42" };
    const { bus, dm, state, injected } = setup({ readiness: () => readiness });
    const id = (await dm("s_lead", "等你空下来", "a1")).deliveries[0]!.id;
    expect(state(id)).toMatchObject({ state: "held", reason: "attached", detail: "in use by pid 42" });
    expect(bus.events.at(-1)).toMatchObject({ eventType: "DeliveryHeld", payload: { reason: "attached", detail: "in use by pid 42" } });
    expect(await bus.tick()).toBe(false);
    expect(state(id).state).toBe("held");

    readiness = { ready: false, reason: "busy" };
    await bus.tick();
    expect(state(id)).toMatchObject({ state: "held", reason: "attached" });

    readiness = { ready: true };
    expect(await bus.tick()).toBe(true);
    expect(state(id).state).toBe("submitted");
    expect(state(id).detail).toBeUndefined();
    expect(injected).toHaveLength(1);
  });

  it("a busy adapter keeps the delivery queued in order instead of holding it", async () => {
    const { dm, state } = setup({ readiness: () => ({ ready: false, reason: "busy" }) });
    const id = (await dm("s_lead", "排队", "b1")).deliveries[0]!.id;
    expect(state(id)).toMatchObject({ state: "queued", reason: "busy" });
  });
});

describe("context overflow", () => {
  it("never cuts the message: outer layers go first, a message that alone does not fit is held until the limit or the text changes", async () => {
    const { bus, state, injected } = setup();
    const room = bus.createRoom({ id: "room_x", title: "x", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p_lead" });
    await bus.joinRoom({ conversationId: room.id, participantId: "p_lead" });
    await bus.publishRoomPolicy({ conversationId: room.id, markdown: "协作约定\n".repeat(150), updatedBy: "user" });
    await bus.updateRoomPolicy({ conversationId: room.id, maxContextBytes: 1500 });

    const fits = await bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: "短消息", idempotencyKey: "o1", source: "user" });
    const fitSnapshot = bus.contextSnapshots.get(fits.deliveries[0]!.id)!;
    expect(fitSnapshot.dropped).toContain("Room collaboration.md");
    expect(fitSnapshot.overflow).toBe(false);
    expect(fitSnapshot.query).toContain("短消息");
    expect(fitSnapshot.layers).toEqual(expect.arrayContaining(["Original message", "How to reply"]));

    const long = "长".repeat(800);
    const big = await bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: long, idempotencyKey: "o2", source: "user" });
    const id = big.deliveries[0]!.id;
    expect(state(id)).toMatchObject({ state: "held", reason: "context_too_large" });
    expect(injected).toHaveLength(1);

    await bus.reviseMessage({ messageId: big.message.id, text: "改短了", actorId: "user" });
    expect(state(id).state).toBe("submitted");
    expect(injected.at(-1)!.query).toContain("改短了");

    const big2 = await bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: long, idempotencyKey: "o3", source: "user" });
    expect(state(big2.deliveries[0]!.id).reason).toBe("context_too_large");
    await bus.updateRoomPolicy({ conversationId: room.id, maxContextBytes: 8192 });
    expect(state(big2.deliveries[0]!.id).state).toBe("submitted");
    expect(injected.at(-1)!.query).toContain(long);
  });
});

describe("reply acknowledges", () => {
  it("an agent answering a message through Portage counts as reading it (agent_ack via reply)", async () => {
    const { bus } = setup();
    const room = bus.createRoom({ id: "room_r", title: "r", createdBy: "user", wakeMode: "swarm" });
    await bus.joinRoom({ conversationId: room.id, participantId: "p_lead" });
    await bus.joinRoom({ conversationId: room.id, participantId: "p_builder" });
    const ask = await bus.send({ conversationId: room.id, senderId: "user", target: { kind: "room", id: room.id }, text: "谁来？", mentionParticipantIds: ["p_lead", "p_builder"], idempotencyKey: "q", source: "user" });
    const toBuilder = ask.deliveries.find((d) => d.recipientSessionId === "s_builder")!;
    await bus.send({
      conversationId: room.id,
      senderId: "p_builder",
      target: { kind: "room", id: room.id },
      text: "我来",
      idempotencyKey: "a",
      causalParentIds: [ask.message.id],
      traceId: ask.message.traceId,
      source: "agent",
    });
    const receipts = await bus.getReceipts(toBuilder.id);
    expect(receipts.map((r) => [r.proofLevel, r.adapterId])).toEqual([
      ["submitted", "codex-native"],
      ["agent_ack", "reply"],
    ]);
    const toLead = ask.deliveries.find((d) => d.recipientSessionId === "s_lead")!;
    expect((await bus.getReceipts(toLead.id)).map((r) => r.proofLevel)).toEqual(["submitted"]);
  });
});
