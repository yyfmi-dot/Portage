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
    const agentSend = (key: string, traceId: string) =>
      bus.send({
        conversationId: "room_dev",
        senderId: "p_lead",
        target: { kind: "room", id: "room_dev" },
        text: "@builder again",
        mentionParticipantIds: ["p_builder"],
        idempotencyKey: key,
        source: "agent",
        traceId,
      });

    expect((await agentSend("round-cap-0", "trace_a")).deliveries[0]?.state).toBe("submitted");
    const result = await agentSend("round-cap-1", "trace_a");
    expect(result.deliveries[0]?.state).toBe("held");
    expect(result.deliveries[0]?.reason).toBe("round_budget");
    expect(bus.roomState.get("room_dev")?.rounds).toBe(2);

    // raising the cap releases only deliveries whose own trace is back within budget
    await bus.updateRoomPolicy({ conversationId: "room_dev", maxAutoRounds: 2 });
    expect(bus.deliveries.find((d) => d.id === result.deliveries[0]!.id)?.state).toBe("submitted");
  });

  it("auto rounds are counted per trace and a user message resets only its own trace", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    bus.policies.get("room_dev")!.maxAutoRounds = 2;
    const send = (key: string, traceId: string, user = false) =>
      bus.send({
        conversationId: "room_dev",
        senderId: user ? "user" : "p_lead",
        target: { kind: "room", id: "room_dev" },
        text: "@builder ping",
        mentionParticipantIds: ["p_builder"],
        idempotencyKey: key,
        source: user ? "user" : "agent",
        traceId,
      });

    await send("a1", "trace_a");
    await send("a2", "trace_a");
    // a busy parallel discussion must not spend trace_b's budget
    expect((await send("b1", "trace_b")).deliveries[0]?.state).toBe("submitted");
    expect((await send("a3", "trace_a")).deliveries[0]?.reason).toBe("round_budget");
    await send("u-b", "trace_b", true);
    expect((await send("a4", "trace_a")).deliveries[0]?.reason).toBe("round_budget");
    expect(bus.roomState.get("room_dev")?.traceRounds).toMatchObject({ trace_a: 4, trace_b: 0 });

    await send("u-a", "trace_a", true);
    expect((await send("a5", "trace_a")).deliveries[0]?.state).toBe("submitted");
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
    const revised = await bus.reviseMessage({ messageId: sent.message.id, text: "final", actorId: "user" });
    expect(revised.revision).toBe(2);
    await bus.markSessionReady("s_lead");
    expect(bus.contextSnapshots.get(sent.deliveries[0]!.id)?.query).toContain("final");
    expect(bus.deliveries.find((d) => d.id === sent.deliveries[0]!.id)?.messageRevision).toBe(2);
    await expect(bus.reviseMessage({ messageId: sent.message.id, text: "x", actorId: "p_lead" })).rejects.toThrow();
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
    expect(snap.layers).not.toContain("Room collaboration.md");
    expect(snap.layers).not.toContain("Execution policy");
  });

  it("previewContext compiles the same layers a real delivery would", async () => {
    const { bus } = seedBus();
    await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
    bus.publishPolicy({ scope: "global", id: "PORTAGE", markdown: "全局约定", updatedBy: "user" });
    const preview = bus.previewContext({ conversationId: "room_dev", text: "same text" });
    expect(preview.recipientSessionId).toBe("s_lead");
    expect(preview.snapshot.layers).toEqual([
      "Global PORTAGE.md",
      "Room collaboration.md",
      "Execution policy",
      "Original message",
      "How to reply",
    ]);
    expect(preview.snapshot.query).toContain("current lead (routing)");
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

  it("an adapter that throws mid-submit leaves the delivery uncertain instead of stuck dispatching", async () => {
    const bus = soloRoomBus({
      inject: async () => {
        throw new Error("EIO");
      },
    });
    const result = await sendToSolo(bus, "throw-1");
    expect(result.deliveries[0]?.state).toBe("uncertain");
  });

  it("read-back confirms a submission that landed and safely retries one that did not", async () => {
    let landed = true;
    let calls = 0;
    const bus = soloRoomBus({
      inject: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, uncertain: true, error: "timeout" } : { ok: true, nativeMessageId: "inbox/2.txt" };
      },
      verify: async () => (landed ? { status: "present", nativeMessageId: "inbox/1.txt" } : { status: "absent" }),
    });

    const first = await sendToSolo(bus, "rb-1");
    expect(first.deliveries[0]?.state).toBe("uncertain");
    expect(await bus.tick()).toBe(true);
    const confirmed = bus.deliveries.find((d) => d.id === first.deliveries[0]!.id)!;
    expect(confirmed.state).toBe("submitted");
    expect(bus.receipts.find((r) => r.deliveryId === confirmed.id)?.nativeMessageId).toBe("inbox/1.txt");
    expect(calls).toBe(1);

    calls = 0;
    landed = false;
    const second = await sendToSolo(bus, "rb-2");
    expect(second.deliveries[0]?.state).toBe("uncertain");
    await bus.tick();
    expect(bus.deliveries.find((d) => d.id === second.deliveries[0]!.id)?.state).toBe("submitted");
    expect(calls).toBe(2);
  });

  it("read-back that cannot tell keeps the delivery uncertain", async () => {
    const bus = soloRoomBus({
      inject: async () => ({ ok: false, uncertain: true, error: "timeout" }),
      verify: async () => ({ status: "unknown" }),
    });
    const result = await sendToSolo(bus, "unk-1");
    expect(await bus.tick()).toBe(false);
    expect(bus.deliveries.find((d) => d.id === result.deliveries[0]!.id)?.state).toBe("uncertain");
  });

  it("a delivery interrupted while dispatching restores as uncertain", async () => {
    const bus = soloRoomBus({ inject: async () => ({ ok: false, uncertain: true, error: "x" }) });
    const result = await sendToSolo(bus, "crash-1");
    const delivery = bus.deliveries.find((d) => d.id === result.deliveries[0]!.id)!;
    delivery.state = "dispatching";
    bus.restoreIndexes();
    expect(delivery.state).toBe("uncertain");
  });

  it("automatic wakeups wait for a free seat and take it when a running member finishes", async () => {
    const { bus } = seedBus();
    for (const p of ["p_lead", "p_builder", "p_reviewer"]) {
      await bus.joinRoom({ conversationId: "room_dev", participantId: p });
    }
    await bus.updateRoomPolicy({ conversationId: "room_dev", maxConcurrent: 1, maxAutoRounds: 10 });
    bus.setSessionExecution("s_builder", "running");

    const agent = await bus.send({
      conversationId: "room_dev",
      senderId: "p_lead",
      target: { kind: "room", id: "room_dev" },
      text: "@reviewer 请看一下",
      mentionParticipantIds: ["p_reviewer"],
      idempotencyKey: "seat-1",
      source: "agent",
    });
    expect(agent.deliveries[0]).toMatchObject({ state: "queued", reason: "seats" });

    // the user is never throttled by automatic seats
    const user = await bus.send({
      conversationId: "room_dev",
      senderId: "user",
      target: { kind: "participant", id: "p_reviewer" },
      text: "直接问你",
      idempotencyKey: "seat-user",
      source: "user",
    });
    expect(user.deliveries[0]?.state).toBe("submitted");

    await bus.reportExecution("s_builder", "waiting_human");
    expect(bus.deliveries.find((d) => d.id === agent.deliveries[0]!.id)?.state).toBe("submitted");
  });

  it("one trace cannot wake agents more than maxWakeupsPerTrace times", async () => {
    const { bus } = seedBus();
    for (const p of ["p_lead", "p_builder", "p_reviewer"]) {
      await bus.joinRoom({ conversationId: "room_dev", participantId: p });
    }
    await bus.updateRoomPolicy({
      conversationId: "room_dev",
      maxWakeupsPerTrace: 3,
      maxAutoRounds: 50,
      agentMessagesPerMinute: 100,
    });
    const send = (key: string) =>
      bus.send({
        conversationId: "room_dev",
        senderId: "p_lead",
        target: { kind: "room", id: "room_dev" },
        text: "@builder @reviewer 继续",
        mentionParticipantIds: ["p_builder", "p_reviewer"],
        idempotencyKey: key,
        source: "agent",
        traceId: "trace_storm",
      });
    expect((await send("w1")).deliveries.map((d) => d.state)).toEqual(["submitted", "submitted"]);
    const second = await send("w2");
    expect(second.deliveries.map((d) => d.state)).toEqual(["submitted", "held"]);
    expect(second.deliveries[1]?.reason).toBe("wakeup_budget");
    expect((await send("w3")).deliveries.every((d) => d.reason === "wakeup_budget")).toBe(true);
  });

  it("rate-limited deliveries carry nextAttemptAt and are released by tick once the window reopens", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const bus = new MemoryBus({ now: () => new Date(clock).toISOString() });
    const seeded = seedInto(bus);
    await seeded.joinAll();
    await bus.updateRoomPolicy({ conversationId: "room_dev", agentMessagesPerMinute: 1, maxAutoRounds: 10 });
    const send = (key: string) =>
      bus.send({
        conversationId: "room_dev",
        senderId: "p_lead",
        target: { kind: "room", id: "room_dev" },
        text: "@builder",
        mentionParticipantIds: ["p_builder"],
        idempotencyKey: key,
        source: "agent",
      });
    await send("tick-1");
    clock += 10_000;
    const held = (await send("tick-2")).deliveries[0]!;
    expect(held).toMatchObject({ state: "held", reason: "budget", nextAttemptAt: "2026-01-01T00:01:00.000Z" });

    clock += 20_000;
    expect(await bus.tick()).toBe(false);
    clock += 31_000;
    expect(await bus.tick()).toBe(true);
    const after = bus.deliveries.find((d) => d.id === held.id)!;
    expect(after.state).toBe("submitted");
    expect(after.nextAttemptAt).toBeUndefined();
  });
});

function soloRoomBus(options: ConstructorParameters<typeof MemoryBus>[0]) {
  const bus = new MemoryBus(options);
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
  bus.createRoom({ id: "r1", title: "R", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p1" });
  return bus;
}

async function sendToSolo(bus: MemoryBus, key: string) {
  if (!bus.memberships.some((m) => m.conversationId === "r1")) {
    await bus.joinRoom({ conversationId: "r1", participantId: "p1" });
  }
  return bus.send({
    conversationId: "r1",
    senderId: "user",
    target: { kind: "room", id: "r1" },
    text: key,
    idempotencyKey: key,
    source: "user",
  });
}

function seedInto(bus: MemoryBus) {
  for (const [alias, provider] of [["lead", "codex"], ["builder", "claude"]] as const) {
    bus.registerSession({
      session: {
        id: `s_${alias}`,
        provider,
        harness: "cli",
        host: "terminal",
        nativeIdentity: `native-${alias}`,
        displayName: alias,
        alias,
        communicationEnabled: true,
      },
      participantId: `p_${alias}`,
    });
  }
  bus.createRoom({ id: "room_dev", title: "R", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p_lead" });
  return {
    joinAll: async () => {
      await bus.joinRoom({ conversationId: "room_dev", participantId: "p_lead" });
      await bus.joinRoom({ conversationId: "room_dev", participantId: "p_builder" });
    },
  };
}
