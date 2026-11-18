import { MemoryBus } from "@portage/core";
import { describe, expect, it } from "vitest";
import {
  StubCliAdapter,
  demoClaudeSurface,
  demoCodexSurface,
} from "./stub-cli-adapter.js";

describe("StubCliAdapter + MemoryBus", () => {
  it("discovers two CLI surfaces and injects through Bus hook", async () => {
    const adapter = new StubCliAdapter({
      id: "cli-stub",
      surfaces: [demoCodexSurface("c1"), demoClaudeSurface("h1")],
    });
    const discovered = await adapter.discover();
    expect(discovered).toHaveLength(2);

    const bus = new MemoryBus({
      inject: async ({ session, message, compiledQuery }) => {
        const result = await adapter.inject(
          session,
          {
            id: "ep1",
            deviceId: "local",
            kind: "terminal",
            host: "terminal",
            adapterId: adapter.id,
            capabilities: adapter.capabilities,
          },
          message,
          compiledQuery,
        );
        if (!result.ok) return result;
        return { ok: true, nativeMessageId: result.nativeMessageId };
      },
    });

    bus.registerSession({
      session: {
        id: "s_codex",
        provider: "codex",
        harness: "cli",
        host: "terminal",
        nativeIdentity: "c1",
        displayName: "Codex c1",
        alias: "codex",
        communicationEnabled: true,
      },
      participantId: "p_codex",
    });
    bus.createRoom({
      id: "room1",
      title: "Pair",
      createdBy: "user",
      wakeMode: "coordinator",
      coordinatorParticipantId: "p_codex",
    });
    await bus.joinRoom({ conversationId: "room1", participantId: "p_codex" });

    const sent = await bus.send({
      conversationId: "room1",
      senderId: "user",
      target: { kind: "room", id: "room1" },
      text: "check binding",
      idempotencyKey: "cli-1",
      source: "user",
    });

    expect(sent.deliveries[0]?.state).toBe("submitted");
    expect(adapter.injected).toHaveLength(1);
    expect(adapter.injected[0]?.sessionId).toBe("s_codex");
    expect(adapter.injected[0]?.query).toContain("check binding");
    expect(adapter.injected[0]?.query).toContain("约束与指导");
  });
});
