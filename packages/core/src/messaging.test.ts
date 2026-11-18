import { describe, expect, it } from "vitest";
import { acceptMessage } from "./messaging.js";
import type { RoomPolicy } from "./types.js";

const policy: RoomPolicy = {
  conversationId: "room1",
  wakeMode: "coordinator",
  coordinatorParticipantId: "p_lead",
  batchWindowMs: 750,
  maxConcurrent: 2,
  agentMessagesPerMinute: 12,
  maxAutoRounds: 4,
  maxWakeupsPerTrace: 20,
  maxContextBytes: 32768,
};

describe("acceptMessage", () => {
  it("user room post in coordinator mode creates lead delivery", () => {
    const result = acceptMessage({
      workspaceId: "ws",
      conversationId: "room1",
      policy,
      policyRevision: "3",
      activeMemberParticipantIds: ["p_lead", "p_builder"],
      participantSessionId: { p_lead: "s_lead", p_builder: "s_builder" },
      senderId: "user",
      senderIsUser: true,
      target: { kind: "room", id: "room1" },
      text: "请推进适配器",
      idempotencyKey: "k1",
      seq: 1,
      currentRounds: 2,
      sessionGate: {
        s_lead: {
          communicationEnabled: true,
          writable: true,
          roomPaused: false,
          leftRoom: false,
          execution: "idle",
          rateLimited: false,
        },
      },
    });

    expect(result.message.traceId).toBeTruthy();
    expect(result.rounds).toBe(0);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.recipientSessionId).toBe("s_lead");
    expect(result.deliveries[0]?.state).toBe("queued");
  });

  it("swarm without mentions creates message with zero deliveries", () => {
    const result = acceptMessage({
      workspaceId: "ws",
      conversationId: "room1",
      policy: { ...policy, wakeMode: "swarm", coordinatorParticipantId: undefined },
      policyRevision: "1",
      activeMemberParticipantIds: ["p_lead", "p_builder"],
      participantSessionId: { p_lead: "s_lead", p_builder: "s_builder" },
      senderId: "user",
      senderIsUser: true,
      target: { kind: "room", id: "room1" },
      text: "大家看看",
      idempotencyKey: "k2",
      seq: 2,
      currentRounds: 0,
      sessionGate: {},
    });
    expect(result.deliveries).toHaveLength(0);
  });

  it("busy recipient stays queued with busy reason", () => {
    const result = acceptMessage({
      workspaceId: "ws",
      conversationId: "room1",
      policy,
      policyRevision: "1",
      activeMemberParticipantIds: ["p_lead"],
      participantSessionId: { p_lead: "s_lead" },
      senderId: "user",
      senderIsUser: true,
      target: { kind: "room", id: "room1" },
      text: "hi",
      idempotencyKey: "k3",
      seq: 3,
      currentRounds: 0,
      sessionGate: {
        s_lead: {
          communicationEnabled: true,
          writable: true,
          roomPaused: false,
          leftRoom: false,
          execution: "running",
          rateLimited: false,
        },
      },
    });
    expect(result.deliveries[0]?.state).toBe("queued");
    expect(result.deliveries[0]?.reason).toBe("busy");
  });

  it("left room holds delivery", () => {
    const result = acceptMessage({
      workspaceId: "ws",
      conversationId: "room1",
      policy,
      policyRevision: "1",
      activeMemberParticipantIds: ["p_lead"],
      participantSessionId: { p_lead: "s_lead" },
      senderId: "user",
      senderIsUser: true,
      target: { kind: "room", id: "room1" },
      text: "hi",
      idempotencyKey: "k4",
      seq: 4,
      currentRounds: 0,
      sessionGate: {
        s_lead: {
          communicationEnabled: true,
          writable: true,
          roomPaused: false,
          leftRoom: true,
          execution: "idle",
          rateLimited: false,
        },
      },
    });
    expect(result.deliveries[0]?.state).toBe("held");
    expect(result.deliveries[0]?.reason).toBe("left_room");
  });
});
