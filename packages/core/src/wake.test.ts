import { describe, expect, it } from "vitest";
import { assertCoordinatorInvariant, resolveWakeTargets } from "./wake.js";

describe("resolveWakeTargets", () => {
  const base = {
    memberParticipantIds: ["lead", "builder", "reviewer"],
    senderParticipantId: "user",
    mentionParticipantIds: [] as string[],
    senderIsUser: true,
  };

  it("mentions always win", () => {
    const targets = resolveWakeTargets({
      ...base,
      mode: "coordinator",
      coordinatorParticipantId: "lead",
      mentionParticipantIds: ["reviewer", "builder"],
    });
    expect(targets).toEqual(["reviewer", "builder"]);
  });

  it("coordinator mode wakes only the lead for user room posts", () => {
    const targets = resolveWakeTargets({
      ...base,
      mode: "coordinator",
      coordinatorParticipantId: "lead",
    });
    expect(targets).toEqual(["lead"]);
  });

  it("coordinator does not wake self", () => {
    const targets = resolveWakeTargets({
      ...base,
      mode: "coordinator",
      coordinatorParticipantId: "lead",
      senderParticipantId: "lead",
      senderIsUser: false,
    });
    expect(targets).toEqual([]);
  });

  it("swarm without mentions records history only", () => {
    expect(
      resolveWakeTargets({
        ...base,
        mode: "swarm",
      }),
    ).toEqual([]);
  });

  it("manual never auto-wakes even with mentions", () => {
    expect(
      resolveWakeTargets({
        ...base,
        mode: "manual",
        mentionParticipantIds: ["builder"],
      }),
    ).toEqual([]);
  });

  it("ignores mentions outside active members", () => {
    expect(
      resolveWakeTargets({
        ...base,
        mode: "swarm",
        mentionParticipantIds: ["ghost"],
      }),
    ).toEqual([]);
  });
});

describe("assertCoordinatorInvariant", () => {
  it("requires active coordinator in coordinator mode", () => {
    const bad = assertCoordinatorInvariant(
      { wakeMode: "coordinator", coordinatorParticipantId: "lead" },
      [
        {
          conversationId: "r1",
          participantId: "lead",
          permissions: ["read", "write"],
          historyScope: "full",
          joinedAt: "t0",
          leftAt: "t1",
        },
      ],
    );
    expect(bad.ok).toBe(false);

    const good = assertCoordinatorInvariant(
      { wakeMode: "coordinator", coordinatorParticipantId: "lead" },
      [
        {
          conversationId: "r1",
          participantId: "lead",
          permissions: ["read", "write"],
          historyScope: "full",
          joinedAt: "t0",
        },
      ],
    );
    expect(good.ok).toBe(true);
  });

  it("swarm does not require coordinator", () => {
    expect(
      assertCoordinatorInvariant({ wakeMode: "swarm" }, []).ok,
    ).toBe(true);
  });
});
