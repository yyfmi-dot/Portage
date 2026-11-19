import { describe, expect, it } from "vitest";
import {
  applyDeliveryTransition,
  nextAutoRound,
  shouldHoldForConditions,
} from "./delivery.js";
import type { Delivery } from "./types.js";

function delivery(state: Delivery["state"] = "queued"): Delivery {
  return {
    id: "d1",
    messageId: "m1",
    messageRevision: 1,
    recipientSessionId: "s1",
    conversationId: "r1",
    state,
    attemptCount: 0,
    dispatchPolicyRevision: "1",
  };
}

describe("applyDeliveryTransition", () => {
  it("queues → hold → release → lease → submitted", () => {
    let d = delivery();
    let r = applyDeliveryTransition(d, { type: "hold", reason: "busy" });
    expect(r.ok && r.delivery.state).toBe("held");
    d = (r as { ok: true; delivery: Delivery }).delivery;

    r = applyDeliveryTransition(d, { type: "release" });
    expect(r.ok && r.delivery.state).toBe("queued");
    d = (r as { ok: true; delivery: Delivery }).delivery;

    r = applyDeliveryTransition(d, { type: "lease" });
    expect(r.ok && r.delivery.attemptCount).toBe(1);
    d = (r as { ok: true; delivery: Delivery }).delivery;

    r = applyDeliveryTransition(d, { type: "submitted" });
    expect(r.ok && r.delivery.state).toBe("submitted");
  });

  it("rejects illegal transitions", () => {
    const r = applyDeliveryTransition(delivery("submitted"), { type: "lease" });
    expect(r.ok).toBe(false);
  });

  it("uncertain can confirm or retry", () => {
    let d = delivery("dispatching");
    let r = applyDeliveryTransition(d, { type: "uncertain" });
    d = (r as { ok: true; delivery: Delivery }).delivery;
    expect(d.state).toBe("uncertain");

    r = applyDeliveryTransition(d, { type: "confirm" });
    expect(r.ok && r.delivery.state).toBe("submitted");
  });

  it("left_room cancel path from queued", () => {
    const r = applyDeliveryTransition(delivery(), { type: "cancel" });
    expect(r.ok && r.delivery.state).toBe("cancelled");
  });
});

describe("shouldHoldForConditions", () => {
  const ready = {
    communicationEnabled: true,
    writable: true,
    roomPaused: false,
    leftRoom: false,
    execution: "idle" as const,
    roundBudgetExceeded: false,
    rateLimited: false,
  };

  it("dispatches when idle and allowed", () => {
    expect(shouldHoldForConditions(ready)).toEqual({ action: "dispatch" });
  });

  it("queues while busy", () => {
    expect(shouldHoldForConditions({ ...ready, execution: "running" })).toEqual({
      action: "queue",
      reason: "busy",
    });
  });

  it("holds when left room or budget", () => {
    expect(shouldHoldForConditions({ ...ready, leftRoom: true }).reason).toBe("left_room");
    expect(shouldHoldForConditions({ ...ready, roundBudgetExceeded: true }).reason).toBe(
      "round_budget",
    );
  });
});

describe("nextAutoRound", () => {
  it("user send resets rounds", () => {
    expect(
      nextAutoRound({
        currentRounds: 2,
        maxAutoRounds: 4,
        isUserSender: true,
        isManualWake: false,
        wakesSomeone: true,
      }),
    ).toEqual({ rounds: 0, exceeded: false });
  });

  it("agent auto increments and can exceed", () => {
    expect(
      nextAutoRound({
        currentRounds: 4,
        maxAutoRounds: 4,
        isUserSender: false,
        isManualWake: false,
        wakesSomeone: true,
      }),
    ).toEqual({ rounds: 5, exceeded: true });
  });

  it("manual wake does not consume auto rounds", () => {
    expect(
      nextAutoRound({
        currentRounds: 2,
        maxAutoRounds: 4,
        isUserSender: false,
        isManualWake: true,
        wakesSomeone: true,
      }),
    ).toEqual({ rounds: 2, exceeded: false });
  });

  it("an agent message that wakes nobody is not a round, even at the limit", () => {
    expect(
      nextAutoRound({
        currentRounds: 4,
        maxAutoRounds: 4,
        isUserSender: false,
        isManualWake: false,
        wakesSomeone: false,
      }),
    ).toEqual({ rounds: 4, exceeded: false });
  });
});
