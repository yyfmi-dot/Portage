import { describe, expect, it } from "vitest";
import { MemoryBus } from "./memory-bus.js";

function seedBus() {
  const bus = new MemoryBus();
  const lead = bus.registerSession({
    session: {
      id: "s_lead",
      provider: "codex",
      harness: "cli",
      host: "terminal",
      nativeIdentity: "native-lead",
      displayName: "Lead",
      alias: "lead",
      communicationEnabled: true,
    },
    participantId: "p_lead",
  });
  const builder = bus.registerSession({
    session: {
      id: "s_builder",
      provider: "claude",
      harness: "cli",
      host: "terminal",
      nativeIdentity: "native-builder",
      displayName: "Builder",
      alias: "builder",
      communicationEnabled: true,
    },
    participantId: "p_builder",
  });
  const reviewer = bus.registerSession({
    session: {
      id: "s_reviewer",
      provider: "claude",
      harness: "cli",
      host: "vscode_cli",
      nativeIdentity: "native-reviewer",
      displayName: "Reviewer",
      alias: "reviewer",
      communicationEnabled: true,
    },
    participantId: "p_reviewer",
  });
  bus.createRoom({
    id: "room_dev",
    title: "Portage 开发室",
    createdBy: "user",
    wakeMode: "coordinator",
    coordinatorParticipantId: "p_lead",
  });
  return { bus, lead, builder, reviewer };
}

describe("MemoryBus L2/L3", () => {
  it("coordinator room send wakes only lead and submits when idle", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_reviewer" });

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "推进适配器",
      idempotencyKey: "u1",
      source: "user",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.recipientSessionId).toBe("s_lead");
    expect(result.deliveries[0]?.state).toBe("submitted");
    expect(await bus.getReceipts(result.deliveries[0]!.id)).toHaveLength(1);
  });

  it("idempotent send returns same logical result", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    const a = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "same",
      idempotencyKey: "idem-1",
      source: "user",
    });
    const b = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "same",
      idempotencyKey: "idem-1",
      source: "user",
    });
    expect(b.message.id).toBe(a.message.id);
    expect(b.deliveries[0]?.id).toBe(a.deliveries[0]?.id);
    expect((await bus.listMessages("room_dev")).length).toBe(1);
  });

  it("busy queues then markSessionReady submits", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.setSessionExecution("s_lead", "running");

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "wait",
      idempotencyKey: "busy-1",
      source: "user",
    });
    expect(result.deliveries[0]?.state).toBe("queued");
    expect(result.deliveries[0]?.reason).toBe("busy");

    const flushed = await bus.markSessionReady("s_lead");
    expect(flushed[0]?.state).toBe("submitted");
    expect((await bus.listInbox("s_lead")).length).toBe(0);
  });

  it("leave room holds open deliveries and removes coordinator if needed", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    bus.setSessionExecution("s_lead", "running");

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "to lead",
      idempotencyKey: "leave-1",
      source: "user",
    });
    expect(result.deliveries[0]?.state).toBe("queued");

    await bus.leaveRoom({ conversationId: "room_dev", participantId: "p_lead" });
    const delivery = bus.deliveries.find((d) => d.id === result.deliveries[0]?.id);
    expect(delivery?.state).toBe("held");
    expect(delivery?.reason).toBe("left_room");

    const policy = await bus.getRoomPolicy("room_dev");
    expect(policy.coordinatorParticipantId).toBe("p_builder");
  });

  it("swarm without mentions creates history only", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.setWakeMode({ conversationId: "room_dev", mode: "swarm" });

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "open discussion",
      idempotencyKey: "swarm-1",
      source: "user",
    });
    expect(result.deliveries).toHaveLength(0);
    expect((await bus.listMessages("room_dev")).length).toBe(1);
  });

  it("mentions in swarm wake targeted member", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.setWakeMode({ conversationId: "room_dev", mode: "swarm" });

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "@builder please",
      mentionParticipantIds: ["p_builder"],
      idempotencyKey: "mention-1",
      source: "user",
    });
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.recipientSessionId).toBe("s_builder");
    expect(result.deliveries[0]?.state).toBe("submitted");
  });

  it("room pause holds new automatic deliveries", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.setRoomPaused("room_dev", true);

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "paused",
      idempotencyKey: "pause-1",
      source: "user",
    });
    expect(result.deliveries[0]?.state).toBe("held");
    expect(result.deliveries[0]?.reason).toBe("room_paused");
  });

  it("disabled communication holds delivery", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.setCommunicationEnabled("s_lead", false);

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "off",
      idempotencyKey: "off-1",
      source: "user",
    });
    expect(result.deliveries[0]?.state).toBe("held");
    expect(result.deliveries[0]?.reason).toBe("disabled");
  });

  it("coordinator lead @mentions members and consumes auto rounds", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_reviewer" });

    const userSend = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "请统筹推进",
      idempotencyKey: "coord-user-1",
      source: "user",
    });
    expect(userSend.deliveries).toHaveLength(1);
    expect(userSend.deliveries[0]?.recipientSessionId).toBe("s_lead");
    expect((await bus.getRoomPolicy("room_dev")).maxAutoRounds).toBe(4);
    expect(bus.roomState.get("room_dev")?.rounds).toBe(0);

    const leadSend = await bus.send({
      conversationId: "room_dev",
      senderId: "p_lead",
      target: { kind: "room", id: "room_dev" },
      text: "@builder @reviewer 请分别核对契约",
      mentionParticipantIds: ["p_builder", "p_reviewer"],
      idempotencyKey: "coord-lead-1",
      source: "agent",
      traceId: userSend.message.traceId,
      causalParentIds: [userSend.message.id],
    });
    expect(leadSend.deliveries.map((d) => d.recipientSessionId).sort()).toEqual([
      "s_builder",
      "s_reviewer",
    ]);
    expect(leadSend.deliveries.every((d) => d.state === "submitted")).toBe(true);
    expect(bus.roomState.get("room_dev")?.rounds).toBe(1);
    expect(leadSend.message.traceId).toBe(userSend.message.traceId);
  });

  it("auto rounds hold when maxAutoRounds exceeded", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    const policy = bus.policies.get("room_dev")!;
    policy.maxAutoRounds = 1;
    bus.roomState.get("room_dev")!.rounds = 1;

    const result = await bus.send({
      conversationId: "room_dev",
      senderId: "p_lead",
      target: { kind: "room", id: "room_dev" },
      text: "@builder again",
      mentionParticipantIds: ["p_builder"],
      idempotencyKey: "round-cap-1",
      source: "agent",
    });
    expect(result.deliveries[0]?.state).toBe("held");
    expect(result.deliveries[0]?.reason).toBe("round_budget");
    expect(bus.roomState.get("room_dev")?.rounds).toBe(2);
  });

  it("agent messages per minute budget holds with reason budget, raising budget releases", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.updateRoomPolicy({ conversationId: "room_dev", agentMessagesPerMinute: 1, maxAutoRounds: 10 });

    const first = await bus.send({
      conversationId: "room_dev",
      senderId: "p_lead",
      target: { kind: "room", id: "room_dev" },
      text: "@builder one",
      mentionParticipantIds: ["p_builder"],
      idempotencyKey: "rate-1",
      source: "agent",
    });
    expect(first.deliveries[0]?.state).toBe("submitted");

    const second = await bus.send({
      conversationId: "room_dev",
      senderId: "p_lead",
      target: { kind: "room", id: "room_dev" },
      text: "@builder two",
      mentionParticipantIds: ["p_builder"],
      idempotencyKey: "rate-2",
      source: "agent",
    });
    expect(second.deliveries[0]?.state).toBe("held");
    expect(second.deliveries[0]?.reason).toBe("budget");

    await bus.updateRoomPolicy({ conversationId: "room_dev", agentMessagesPerMinute: 5 });
    const released = bus.deliveries.find((d) => d.id === second.deliveries[0]!.id);
    expect(released?.state).toBe("submitted");
  });

  it("resuming a paused room and re-enabling communication flush held deliveries", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.setRoomPaused("room_dev", true);
    const paused = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "while paused",
      idempotencyKey: "resume-1",
      source: "user",
    });
    expect(paused.deliveries[0]?.state).toBe("held");
    await bus.setRoomPaused("room_dev", false);
    expect(bus.deliveries.find((d) => d.id === paused.deliveries[0]!.id)?.state).toBe("submitted");

    await bus.setCommunicationEnabled("s_lead", false);
    const off = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "while off",
      idempotencyKey: "resume-2",
      source: "user",
    });
    expect(off.deliveries[0]?.reason).toBe("disabled");
    await bus.setCommunicationEnabled("s_lead", true);
    expect(bus.deliveries.find((d) => d.id === off.deliveries[0]!.id)?.state).toBe("submitted");
  });

  it("left member stays held after room resumes", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.setRoomPaused("room_dev", true);
    const sent = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "@builder later",
      mentionParticipantIds: ["p_builder"],
      idempotencyKey: "left-resume",
      source: "user",
    });
    await bus.leaveRoom({ conversationId: "room_dev", participantId: "p_builder" });
    await bus.setRoomPaused("room_dev", false);
    const delivery = bus.deliveries.find((d) => d.id === sent.deliveries[0]!.id);
    expect(delivery?.state).toBe("held");
    expect(delivery?.reason).toBe("left_room");
  });

  it("idempotency key reused with different content is a conflict", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    const base = {
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room" as const, id: "room_dev" },
      idempotencyKey: "idem-conflict",
      source: "user" as const,
    };
    await bus.send({ ...base, text: "a" });
    await expect(bus.send({ ...base, text: "b" })).rejects.toThrow(/conflict/);
  });

  it("event log records the causal chain for a delivery", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    const seen: string[] = [];
    const off = bus.onEvent((e) => seen.push(e.eventType));
    const sent = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "trace me",
      idempotencyKey: "evt-1",
      source: "user",
    });
    off();
    expect(seen).toEqual(["MessageAccepted", "DeliveryQueued", "DeliverySubmitted"]);
    const events = bus.listEvents({ conversationId: "room_dev" });
    const submitted = events.find((e) => e.eventType === "DeliverySubmitted");
    expect(submitted?.traceId).toBe(sent.message.traceId);
    expect(submitted?.causalParentIds).toEqual([sent.message.id]);
    expect(submitted?.payload.compiledContextHash).toBe(sent.deliveries[0]?.compiledContextHash);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("revise bumps revision and pending deliveries carry the new version", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.setSessionExecution("s_lead", "running");
    const sent = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "draft",
      idempotencyKey: "rev-1",
      source: "user",
    });
    const revised = bus.reviseMessage({ messageId: sent.message.id, text: "final", actorId: "user" });
    expect(revised.revision).toBe(2);
    await bus.markSessionReady("s_lead");
    expect(bus.contextSnapshots.get(sent.deliveries[0]!.id)?.query).toContain("final");
    expect(bus.deliveries.find((d) => d.id === sent.deliveries[0]!.id)?.messageRevision).toBe(2);
    expect(() =>
      bus.reviseMessage({ messageId: sent.message.id, text: "x", actorId: "p_lead" }),
    ).toThrow();
  });

  it("direct conversation wakes only the target session without room policy layer", async () => {
    const { bus } = seedBus();
    const dm = bus.ensureDirectConversation("s_builder");
    const sent = await bus.send({
      conversationId: dm.id,
      senderId: "user",
      target: { kind: "participant", id: "p_builder" },
      text: "hi builder",
      idempotencyKey: "dm-1",
      source: "user",
    });
    expect(sent.deliveries).toHaveLength(1);
    expect(sent.deliveries[0]?.recipientSessionId).toBe("s_builder");
    const snap = bus.contextSnapshots.get(sent.deliveries[0]!.id)!;
    expect(snap.layers).not.toContain("房间 collaboration.md");
    expect(snap.layers).not.toContain("执行策略");
  });

  it("previewContext compiles the same layers a real delivery would", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.publishPolicy({ scope: "global", id: "PORTAGE", markdown: "全局约定", updatedBy: "user" });
    const preview = bus.previewContext({ conversationId: "room_dev", text: "same text" });
    expect(preview.recipientSessionId).toBe("s_lead");
    expect(preview.snapshot.layers).toEqual([
      "全局 PORTAGE.md",
      "房间 collaboration.md",
      "执行策略",
      "原始消息",
    ]);
    expect(preview.snapshot.query).toContain("当前统筹者（路由）");
  });

  it("artifacts are referenced in parts and in the compiled query", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    const artifact = bus.createArtifact({
      originalName: "review.md",
      mime: "text/markdown",
      byteSize: 12,
      hash: "habcdef12",
      storageKey: "/tmp/review.md",
      createdBy: "user",
    });
    const sent = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "see file",
      artifactIds: [artifact.id],
      idempotencyKey: "art-1",
      source: "user",
    });
    expect(sent.message.parts.some((p) => p.kind === "artifact_ref")).toBe(true);
    expect(bus.contextSnapshots.get(sent.deliveries[0]!.id)?.query).toContain("review.md · v1");
    expect(bus.artifacts.get(artifact.id)?.sourceMessageId).toBe(sent.message.id);
  });

  it("agent_ack: submitted is not read until the agent acknowledges, in acceptance order", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    const send = (key: string, text: string) =>
      bus.send({
        conversationId: "room_dev",
        senderId: "user",
        target: { kind: "room", id: "room_dev" },
        text,
        idempotencyKey: key,
        source: "user",
      });
    const first = await send("ack-1", "first");
    const second = await send("ack-2", "second");

    expect(bus.unreadDeliveries("s_lead").map((u) => u.message.id)).toEqual([
      first.message.id,
      second.message.id,
    ]);
    expect(bus.unreadDeliveries("s_builder")).toEqual([]);
    expect(bus.unreadDeliveries("s_lead")[0]?.snapshot?.query).toContain("first");

    const seen: string[] = [];
    bus.onEvent((e) => seen.push(e.eventType));
    const receipt = bus.acknowledgeDelivery({ deliveryId: first.deliveries[0]!.id, sessionId: "s_lead" });
    expect(receipt).toMatchObject({ proofLevel: "agent_ack", adapterId: "mcp" });
    expect(seen).toEqual(["DeliveryAcknowledged"]);
    expect(bus.unreadDeliveries("s_lead").map((u) => u.message.id)).toEqual([second.message.id]);

    // idempotent: no duplicate receipt, no duplicate event
    bus.acknowledgeDelivery({ deliveryId: first.deliveries[0]!.id, sessionId: "s_lead" });
    expect(bus.receipts.filter((r) => r.proofLevel === "agent_ack")).toHaveLength(1);
    expect(seen).toEqual(["DeliveryAcknowledged"]);
    // the original submitted receipt stays — acks add proof, they do not replace it
    expect((await bus.getReceipts(first.deliveries[0]!.id)).map((r) => r.proofLevel)).toEqual([
      "submitted",
      "agent_ack",
    ]);
  });

  it("agent_ack rejects other sessions and deliveries that were never submitted", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.setSessionExecution("s_lead", "running");
    const queued = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "room", id: "room_dev" },
      text: "wait",
      idempotencyKey: "ack-bad",
      source: "user",
    });
    expect(() => bus.acknowledgeDelivery({ deliveryId: queued.deliveries[0]!.id, sessionId: "s_lead" })).toThrow(/queued/);
    await bus.markSessionReady("s_lead");
    expect(() => bus.acknowledgeDelivery({ deliveryId: queued.deliveries[0]!.id, sessionId: "s_builder" })).toThrow(/another session/);
    expect(() => bus.acknowledgeDelivery({ deliveryId: "nope", sessionId: "s_lead" })).toThrow(/not found/);
  });

  it("activeRoomsForSession follows join and leave", async () => {
    const { bus } = seedBus();
    expect(bus.activeRoomsForSession("s_builder")).toEqual([]);
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    expect(bus.activeRoomsForSession("s_builder").map((c) => c.id)).toEqual(["room_dev"]);
    await bus.leaveRoom({ conversationId: "room_dev", participantId: "p_builder" });
    expect(bus.activeRoomsForSession("s_builder")).toEqual([]);
  });

  it("inject hook failure can mark uncertain", async () => {
    const bus = new MemoryBus({
      inject: async () => ({ ok: false, uncertain: true, error: "lost after write" }),
    });
    bus.registerSession({
      session: {
        id: "s1",
        provider: "codex",
        harness: "cli",
        host: "terminal",
        nativeIdentity: "n1",
        displayName: "S1",
        alias: "s1",
        communicationEnabled: true,
      },
      participantId: "p1",
    });
    bus.createRoom({
      id: "r1",
      title: "R",
      createdBy: "user",
      wakeMode: "coordinator",
      coordinatorParticipantId: "p1",
    });
    await bus.joinRoom({ conversationId: "r1", participantId: "p1" });
    const result = await bus.send({
      conversationId: "r1",
      senderId: "user",
      target: { kind: "room", id: "r1" },
      text: "x",
      idempotencyKey: "unc-1",
      source: "user",
    });
    expect(result.deliveries[0]?.state).toBe("uncertain");
  });
});
