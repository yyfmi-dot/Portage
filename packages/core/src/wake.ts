import type { Membership, RoomPolicy, WakeMode } from "./types.js";

export type WakeTargetInput = {
  mode: WakeMode;
  coordinatorParticipantId?: string;
  /** Active members only (no leftAt). */
  memberParticipantIds: string[];
  /** Sender participant id; never wake self. */
  senderParticipantId: string;
  /** Mentioned participant ids parsed from message. */
  mentionParticipantIds: string[];
  /** If true, sender is the human user posting to the room. */
  senderIsUser: boolean;
};

/**
 * Resolve who gets a Delivery (wake), separate from who may read history.
 * Mentions always win when present.
 */
export function resolveWakeTargets(input: WakeTargetInput): string[] {
  const members = new Set(input.memberParticipantIds);
  // Manual: no automatic Delivery; user must wake explicitly.
  if (input.mode === "manual") return [];

  const mentions = input.mentionParticipantIds.filter(
    (id) => members.has(id) && id !== input.senderParticipantId,
  );
  if (mentions.length) return unique(mentions);

  switch (input.mode) {
    case "mentions":
    case "swarm":
      return [];
    case "coordinator": {
      const lead = input.coordinatorParticipantId;
      if (!lead || !members.has(lead)) return [];
      if (input.senderParticipantId === lead) return [];
      // User (or non-coordinator) → wake coordinator first
      return [lead];
    }
    default:
      return [];
  }
}

export function assertCoordinatorInvariant(
  policy: Pick<RoomPolicy, "wakeMode" | "coordinatorParticipantId">,
  activeMemberships: Membership[],
): { ok: true } | { ok: false; error: string } {
  if (policy.wakeMode !== "coordinator") return { ok: true };
  const lead = policy.coordinatorParticipantId;
  if (!lead) return { ok: false, error: "coordinator mode requires coordinatorParticipantId" };
  const active = activeMemberships.filter((m) => !m.leftAt);
  if (!active.some((m) => m.participantId === lead)) {
    return { ok: false, error: "coordinator must be an active room member" };
  }
  return { ok: true };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}
