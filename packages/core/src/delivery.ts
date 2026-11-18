import type { Delivery, DeliveryState, HoldReason } from "./types.js";

export type DeliveryTransition =
  | { type: "hold"; reason: HoldReason; detail?: string }
  | { type: "release" }
  | { type: "lease" }
  | { type: "submitted" }
  | { type: "fail"; reason?: HoldReason }
  | { type: "uncertain" }
  | { type: "confirm" }
  | { type: "retry" }
  | { type: "cancel"; reason?: HoldReason };

const ALLOWED: Record<DeliveryState, DeliveryTransition["type"][]> = {
  queued: ["hold", "lease", "cancel"],
  held: ["release", "cancel"],
  dispatching: ["submitted", "fail", "uncertain", "retry"],
  submitted: [],
  failed: [],
  uncertain: ["confirm", "retry", "fail"],
  cancelled: [],
};

export function canTransition(state: DeliveryState, type: DeliveryTransition["type"]): boolean {
  return ALLOWED[state].includes(type);
}

/**
 * Pure delivery state machine. Callers persist the result.
 * Does not invent vendor behavior — only encodes DOMAIN.md transitions.
 */
export function applyDeliveryTransition(
  delivery: Delivery,
  transition: DeliveryTransition,
): { ok: true; delivery: Delivery } | { ok: false; error: string } {
  if (!canTransition(delivery.state, transition.type)) {
    return {
      ok: false,
      error: `illegal transition ${delivery.state} → ${transition.type}`,
    };
  }

  const { detail: _previous, ...rest } = delivery;
  const next: Delivery = rest;

  switch (transition.type) {
    case "hold":
      next.state = "held";
      next.reason = transition.reason;
      if (transition.detail) next.detail = transition.detail;
      break;
    case "release":
      next.state = "queued";
      next.reason = undefined;
      next.nextAttemptAt = undefined;
      break;
    case "lease":
      next.state = "dispatching";
      next.attemptCount += 1;
      next.reason = undefined;
      break;
    case "submitted":
      next.state = "submitted";
      next.reason = undefined;
      break;
    case "fail":
      next.state = "failed";
      next.reason = transition.reason;
      break;
    case "uncertain":
      next.state = "uncertain";
      break;
    case "confirm":
      next.state = "submitted";
      next.reason = undefined;
      break;
    case "retry":
      next.state = "queued";
      next.reason = undefined;
      break;
    case "cancel":
      next.state = "cancelled";
      next.reason = transition.reason ?? next.reason;
      break;
  }

  return { ok: true, delivery: next };
}

/** Whether automatic wake should create/keep a Delivery for this recipient. */
export function shouldHoldForConditions(input: {
  communicationEnabled: boolean;
  writable: boolean;
  roomPaused: boolean;
  leftRoom: boolean;
  execution: "idle" | "running" | "waiting_human" | "offline" | "unknown";
  roundBudgetExceeded: boolean;
  rateLimited: boolean;
}): { action: "dispatch" | "queue" | "hold"; reason?: HoldReason } {
  if (input.leftRoom) return { action: "hold", reason: "left_room" };
  if (!input.communicationEnabled) return { action: "hold", reason: "disabled" };
  if (!input.writable) return { action: "hold", reason: "readonly" };
  if (input.roomPaused) return { action: "hold", reason: "room_paused" };
  if (input.roundBudgetExceeded) return { action: "hold", reason: "round_budget" };
  if (input.rateLimited) return { action: "hold", reason: "budget" };
  if (input.execution === "offline") return { action: "hold", reason: "offline" };
  if (input.execution === "running" || input.execution === "waiting_human") {
    return { action: "queue", reason: "busy" };
  }
  return { action: "dispatch" };
}

/** Auto-round counter: agent auto wake increments; user manual does not. */
export function nextAutoRound(input: {
  currentRounds: number;
  maxAutoRounds: number;
  isUserSender: boolean;
  isManualWake: boolean;
}): { rounds: number; exceeded: boolean } {
  if (input.isUserSender || input.isManualWake) {
    return { rounds: input.isUserSender ? 0 : input.currentRounds, exceeded: false };
  }
  const rounds = input.currentRounds + 1;
  return { rounds, exceeded: rounds > input.maxAutoRounds };
}
