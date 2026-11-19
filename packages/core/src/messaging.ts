import {
  applyDeliveryTransition,
  nextAutoRound,
  shouldHoldForConditions,
} from "./delivery.js";
import type { ContentPart, Delivery, Message, RoomPolicy } from "./types.js";
import { resolveWakeTargets } from "./wake.js";

export type SendContext = {
  workspaceId: string;
  conversationId: string;
  policy: RoomPolicy;
  policyRevision: string;
  /** Active member participant ids (not left). */
  activeMemberParticipantIds: string[];
  /** Map participant → session for Delivery targets. */
  participantSessionId: Record<string, string>;
  senderId: string;
  senderIsUser: boolean;
  isManualWake?: boolean;
  target: Message["target"];
  text: string;
  /** Non-text parts such as artifact references, appended after the text part. */
  extraParts?: ContentPart[];
  mentionParticipantIds?: string[];
  idempotencyKey: string;
  traceId?: string;
  causalParentIds?: string[];
  source?: Message["source"];
  seq: number;
  /** Current auto-round counter on the room. */
  currentRounds: number;
  /** Per-session runtime gates used when creating deliveries. */
  sessionGate: Record<
    string,
    {
      communicationEnabled: boolean;
      writable: boolean;
      roomPaused: boolean;
      leftRoom: boolean;
      execution: "idle" | "running" | "waiting_human" | "offline" | "unknown";
      rateLimited: boolean;
    }
  >;
};

export type SendResult = {
  message: Message;
  deliveries: Delivery[];
  rounds: number;
  roundBudgetExceeded: boolean;
};

/**
 * Accept a message and create per-recipient Deliveries.
 * Pure function — persistence and adapter inject happen outside.
 */
export function acceptMessage(ctx: SendContext): SendResult {
  const wakeTargets =
    ctx.target.kind === "participant"
      ? [ctx.target.id].filter((id) => id !== ctx.senderId)
      : resolveWakeTargets({
          mode: ctx.policy.wakeMode,
          coordinatorParticipantId: ctx.policy.coordinatorParticipantId,
          memberParticipantIds: ctx.activeMemberParticipantIds,
          senderParticipantId: ctx.senderId,
          mentionParticipantIds: ctx.mentionParticipantIds ?? [],
          senderIsUser: ctx.senderIsUser,
        });
  const round = nextAutoRound({
    currentRounds: ctx.currentRounds,
    maxAutoRounds: ctx.policy.maxAutoRounds,
    isUserSender: ctx.senderIsUser,
    isManualWake: Boolean(ctx.isManualWake),
    wakesSomeone: wakeTargets.some((id) => ctx.participantSessionId[id]),
  });

  const message: Message = {
    id: `msg_${ctx.idempotencyKey}`,
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    seq: ctx.seq,
    senderId: ctx.senderId,
    target: ctx.target,
    mentions: ctx.mentionParticipantIds ?? [],
    parts: [{ kind: "text", text: ctx.text }, ...(ctx.extraParts ?? [])],
    causalParentIds: ctx.causalParentIds ?? [],
    traceId: ctx.traceId ?? `trace_${ctx.idempotencyKey}`,
    source: ctx.source ?? (ctx.senderIsUser ? "user" : "agent"),
    idempotencyKey: ctx.idempotencyKey,
    acceptedPolicyRevision: ctx.policyRevision,
    revision: 1,
    createdAt: new Date().toISOString(),
  };

  const deliveries: Delivery[] = [];
  for (const participantId of wakeTargets) {
    const sessionId = ctx.participantSessionId[participantId];
    if (!sessionId) continue;

    let delivery: Delivery = {
      id: `dlv_${ctx.idempotencyKey}_${sessionId}`,
      messageId: message.id,
      messageRevision: 1,
      recipientSessionId: sessionId,
      conversationId: ctx.conversationId,
      state: "queued",
      attemptCount: 0,
      dispatchPolicyRevision: ctx.policyRevision,
    };

    const gate = ctx.sessionGate[sessionId] ?? {
      communicationEnabled: true,
      writable: true,
      roomPaused: false,
      leftRoom: false,
      execution: "idle" as const,
      rateLimited: false,
    };

    const decision = shouldHoldForConditions({
      ...gate,
      roundBudgetExceeded: round.exceeded,
    });

    if (decision.action === "hold" && decision.reason) {
      const held = applyDeliveryTransition(delivery, {
        type: "hold",
        reason: decision.reason,
      });
      if (held.ok) delivery = held.delivery;
    } else if (decision.action === "queue" && decision.reason) {
      delivery.reason = decision.reason;
      delivery.state = "queued";
    }

    deliveries.push(delivery);
  }

  return {
    message,
    deliveries,
    rounds: round.rounds,
    roundBudgetExceeded: round.exceeded,
  };
}
