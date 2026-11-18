import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBus } from "../bus/memory-bus.js";
import { SqliteSnapshotStore } from "./sqlite-snapshot.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteSnapshotStore", () => {
  it("round-trips sessions, room membership, and submitted delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "portage.db");

    const bus = new MemoryBus();
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
      title: "Room",
      createdBy: "user",
      wakeMode: "coordinator",
      coordinatorParticipantId: "p1",
    });
    await bus.joinRoom({ conversationId: "r1", participantId: "p1" });
    await bus.send({
      conversationId: "r1",
      senderId: "user",
      target: { kind: "room", id: "r1" },
      text: "persist me",
      idempotencyKey: "p1",
      source: "user",
    });

    const store = new SqliteSnapshotStore(path);
    store.save(bus);
    store.close();

    const reader = new SqliteSnapshotStore(path);
    const loaded = reader.load(new MemoryBus());
    expect(loaded.sessions.get("s1")?.displayName).toBe("S1");
    expect(loaded.memberships).toHaveLength(1);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.deliveries[0]?.state).toBe("submitted");
    expect(loaded.policyDocuments.get("room:r1")?.markdown).toContain("约束与指导");
    expect(loaded.contextSnapshots.get(loaded.deliveries[0]!.id)?.query).toContain("persist me");
    expect(loaded.events.map((e) => e.eventType)).toContain("DeliverySubmitted");

    // Restart continues seq, keeps idempotency and event ordering.
    const again = await loaded.send({
      conversationId: "r1",
      senderId: "user",
      target: { kind: "room", id: "r1" },
      text: "after restart",
      idempotencyKey: "p2",
      source: "user",
    });
    expect(again.message.seq).toBe(2);
    const replay = await loaded.send({
      conversationId: "r1",
      senderId: "user",
      target: { kind: "room", id: "r1" },
      text: "persist me",
      idempotencyKey: "p1",
      source: "user",
    });
    expect(replay.message.seq).toBe(1);
    expect(loaded.messages).toHaveLength(2);
    const seqs = loaded.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    reader.close();
  });
});
