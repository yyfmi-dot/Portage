import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBus } from "@portage/core";
import { afterEach, describe, expect, it } from "vitest";
import { FileInboxAdapter } from "./file-inbox-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("FileInboxAdapter", () => {
  it("writes compiled query into per-session inbox via Bus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-inbox-"));
    dirs.push(dir);
    const adapter = new FileInboxAdapter(dir);
    const bus = new MemoryBus({
      inject: async ({ session, message, compiledQuery }) => {
        const result = await adapter.inject(
          session,
          {
            id: "ep",
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
        nativeIdentity: "pid-100",
        displayName: "Codex",
        alias: "codex",
        communicationEnabled: true,
      },
      participantId: "p_codex",
    });
    bus.createRoom({
      id: "room1",
      title: "Dev",
      createdBy: "user",
      wakeMode: "coordinator",
      coordinatorParticipantId: "p_codex",
    });
    await bus.joinRoom({ conversationId: "room1", participantId: "p_codex" });
    const sent = await bus.send({
      conversationId: "room1",
      senderId: "user",
      target: { kind: "room", id: "room1" },
      text: "deliver via file inbox",
      idempotencyKey: "file-1",
      source: "user",
    });

    expect(sent.deliveries[0]?.state).toBe("submitted");
    const nativePath = (await bus.getReceipts(sent.deliveries[0]!.id))[0]?.nativeMessageId;
    expect(nativePath).toBeTruthy();
    const body = readFileSync(nativePath!, "utf8");
    expect(body).toContain("deliver via file inbox");
    expect(body).toContain("约束与指导");
  });
});
