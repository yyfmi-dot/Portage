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
    expect(loaded.policyDocuments.get("room:r1")?.markdown).toContain("Keep your own identity");
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

  it("saves incrementally: only changed rows are rewritten and a reload sees every change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "portage.db");
    const bus = new MemoryBus();
    bus.registerSession({
      session: { id: "s1", provider: "codex", harness: "cli", host: "terminal", nativeIdentity: "n1", displayName: "S1", alias: "s1", communicationEnabled: true },
      participantId: "p1",
    });
    bus.createRoom({ id: "r1", title: "Room", createdBy: "user", wakeMode: "coordinator", coordinatorParticipantId: "p1" });
    await bus.joinRoom({ conversationId: "r1", participantId: "p1" });
    bus.setSessionExecution("s1", "running");
    const store = new SqliteSnapshotStore(path);
    const queued = await bus.send({
      conversationId: "r1", senderId: "user", target: { kind: "room", id: "r1" }, text: "first", idempotencyKey: "k1", source: "user",
    });
    store.save(bus);
    expect(bus.takeDirty()).toEqual({ messages: [], deliveries: [], events: [], nativeEvents: [] });

    // the delivery changes state after the first save; only it needs writing
    await bus.markSessionReady("s1");
    const changed = bus.takeDirty();
    expect(changed.deliveries).toEqual([queued.deliveries[0]!.id]);
    bus.markDirty(changed);
    bus.reviseMessage({ messageId: queued.message.id, text: "first, revised", actorId: "user" });
    await bus.leaveRoom({ conversationId: "r1", participantId: "p1" });
    store.save(bus);
    store.close();

    const loaded = new SqliteSnapshotStore(path).load(new MemoryBus());
    expect(loaded.deliveries[0]?.state).toBe("submitted");
    expect(loaded.messages[0]?.revision).toBe(2);
    expect(loaded.memberships[0]?.leftAt).toBeTruthy();
    expect(loaded.runtime.get("s1")?.execution).toBe("idle");
    // the coordinator left, so membership change is followed by the automatic coordinator handover
    expect(loaded.events.slice(-2).map((e) => e.eventType)).toEqual(["MembershipChanged", "RoomPolicyChanged"]);
  });

  it("keeps the full EventLog on disk while memory holds only the recent window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "portage.db");
    const bus = new MemoryBus();
    bus.createRoom({ id: "r1", title: "Room", createdBy: "user" });
    const store = new SqliteSnapshotStore(path);
    store.save(bus);
    const firstSeq = bus.events[0]!.seq;
    for (let i = 0; i < 5200; i += 1) await bus.setRoomPaused("r1", i % 2 === 0);
    store.save(bus);
    store.close();

    const reader = new SqliteSnapshotStore(path);
    const loaded = reader.load(new MemoryBus());
    expect(loaded.events.length).toBe(5000);
    expect(loaded.events[0]!.seq).toBeGreaterThan(firstSeq);
    const total = (reader as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get().n;
    expect(total).toBe(5201);
    reader.close();
  });

  it("persists native records and read cursors; a reload neither loses nor re-imports them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "portage.db");
    const bus = new MemoryBus();
    bus.registerSession({
      session: { id: "s1", provider: "codex", harness: "cli", host: "headless", nativeIdentity: "t1", displayName: "S1", alias: "s1", communicationEnabled: true, adapterId: "codex-native" },
      participantId: "p1",
    });
    const observations = [
      { nativeEventId: "L0", nativeTime: "t0", kind: "input" as const, text: "问" },
      { nativeEventId: "L9", nativeTime: "t1", kind: "output" as const, text: "答" },
    ];
    bus.recordNativeRead("s1", "codex-native", { observations, cursor: 120, source: "/r.jsonl" });
    const store = new SqliteSnapshotStore(path);
    store.save(bus);
    bus.recordNativeRead("s1", "codex-native", { observations: [{ nativeEventId: "L20", nativeTime: "t2", kind: "input", text: "再问" }], cursor: 200, source: "/r.jsonl" });
    store.save(bus);
    store.close();

    const loaded = new SqliteSnapshotStore(path).load(new MemoryBus());
    expect(loaded.listNativeEvents("s1").map((e) => [e.nativeEventId, e.text])).toEqual([
      ["L0", "问"],
      ["L9", "答"],
      ["L20", "再问"],
    ]);
    expect(loaded.nativeCheckpoints.get("s1")).toMatchObject({ cursor: 200, source: "/r.jsonl" });
    expect(loaded.recordNativeRead("s1", "codex-native", { observations, cursor: 120, source: "/r.jsonl" })).toEqual([]);
  });
});
