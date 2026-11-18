import { describe, expect, it } from "vitest";
import { MemoryBus } from "./bus/memory-bus.js";
import { PolicyFrontmatterError, parsePolicyDocument } from "./policy-frontmatter.js";

const DOC = `---
version: 1
wake:
  mode: coordinator   # coordinator | swarm | mentions | manual
  coordinator: "@reviewer"
  batch_window_ms: 750
  max_concurrent: 1
budget:
  agent_messages_per_minute: 6
  max_wakeups_per_trace: 9
  max_auto_rounds: 3
  max_context_bytes: 32768
---

# Portage 开发室

需要他人处理时明确 @ 对方。`;

describe("collaboration.md frontmatter", () => {
  it("parses the documented schema and separates the guidance body", () => {
    const parsed = parsePolicyDocument(DOC);
    expect(parsed.policy).toEqual({
      version: 1,
      wakeMode: "coordinator",
      coordinator: "@reviewer",
      batchWindowMs: 750,
      maxConcurrent: 1,
      agentMessagesPerMinute: 6,
      maxWakeupsPerTrace: 9,
      maxAutoRounds: 3,
      maxContextBytes: 32768,
    });
    expect(parsed.body.startsWith("# Portage 开发室")).toBe(true);
  });

  it("documents without frontmatter are guidance only", () => {
    expect(parsePolicyDocument("# 约定\n\n别刷屏")).toEqual({ policy: {}, body: "# 约定\n\n别刷屏", hasFrontmatter: false });
  });

  it("rejects unknown keys, bad values and stray indentation together", () => {
    const bad = `---\nversion: 2\nwake:\n  mode: chaos\n  turbo: true\nbudget:\n  max_auto_rounds: 0\nroles:\n  lead: x\n---\nbody`;
    try {
      parsePolicyDocument(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyFrontmatterError);
      const problems = (error as PolicyFrontmatterError).problems.join("\n");
      for (const fragment of ["version", "wake.mode", "wake.turbo", "max_auto_rounds", 'section "roles"'])
        expect(problems).toContain(fragment);
    }
  });

  it("publishing a room doc applies the policy and injects only the body", async () => {
    const bus = new MemoryBus();
    for (const alias of ["lead", "reviewer"]) {
      bus.registerSession({
        session: {
          id: `s_${alias}`,
          provider: "codex",
          harness: "cli",
          host: "terminal",
          nativeIdentity: alias,
          displayName: alias,
          alias,
          communicationEnabled: true,
        },
        participantId: `p_${alias}`,
      });
    }
    bus.createRoom({ id: "r", title: "R", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p_lead" });
    await bus.joinRoom({ conversationId: "r", participantId: "p_lead" });
    await bus.joinRoom({ conversationId: "r", participantId: "p_reviewer" });

    const { document, policy } = await bus.publishRoomPolicy({ conversationId: "r", markdown: DOC, updatedBy: "user" });
    expect(policy).toMatchObject({
      wakeMode: "coordinator",
      coordinatorParticipantId: "p_reviewer",
      maxConcurrent: 1,
      agentMessagesPerMinute: 6,
      maxWakeupsPerTrace: 9,
      maxAutoRounds: 3,
    });
    expect(document.publishedRevision).toBeGreaterThan(0);

    const { snapshot } = bus.previewContext({ conversationId: "r", recipientSessionId: "s_reviewer", text: "hi" });
    expect(snapshot.query).toContain("需要他人处理时明确 @ 对方");
    expect(snapshot.query).not.toContain("max_concurrent: 1");
  });

  it("an invalid coordinator rejects the publish and changes nothing", async () => {
    const bus = new MemoryBus();
    bus.registerSession({
      session: {
        id: "s_lead",
        provider: "codex",
        harness: "cli",
        host: "terminal",
        nativeIdentity: "lead",
        displayName: "lead",
        alias: "lead",
        communicationEnabled: true,
      },
      participantId: "p_lead",
    });
    bus.createRoom({ id: "r", title: "R", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p_lead" });
    await bus.joinRoom({ conversationId: "r", participantId: "p_lead" });
    const before = structuredClone(bus.policies.get("r"));
    const revision = bus.getPolicyDocument("room", "r")?.publishedRevision;

    await expect(
      bus.publishRoomPolicy({
        conversationId: "r",
        markdown: "---\nwake:\n  coordinator: ghost\nbudget:\n  max_auto_rounds: 9\n---\nbody",
        updatedBy: "user",
      }),
    ).rejects.toThrow(/ghost/);
    expect(bus.policies.get("r")).toEqual(before);
    expect(bus.getPolicyDocument("room", "r")?.publishedRevision).toBe(revision);
  });
});
