import { DatabaseSync } from "node:sqlite";
import { MemoryBus } from "../bus/memory-bus.js";
import type { ContextSnapshot } from "../context.js";
import type {
  Artifact,
  BusEvent,
  Conversation,
  Delivery,
  DeliveryReceipt,
  Membership,
  Message,
  Participant,
  PolicyDocument,
  RoomPolicy,
  Session,
} from "../types.js";

/**
 * Snapshot persistence for MemoryBus using Node's built-in sqlite.
 * Keeps the Bus API unchanged; daemon restarts can hydrate.
 */
export class SqliteSnapshotStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies (conversationId TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_state (conversationId TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (sessionId TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_documents (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_snapshots (deliveryId TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
    `);
  }

  save(bus: MemoryBus) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM sessions").run();
      this.db.prepare("DELETE FROM participants").run();
      this.db.prepare("DELETE FROM conversations").run();
      this.db.prepare("DELETE FROM memberships").run();
      this.db.prepare("DELETE FROM policies").run();
      this.db.prepare("DELETE FROM room_state").run();
      this.db.prepare("DELETE FROM runtime").run();
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM deliveries").run();
      this.db.prepare("DELETE FROM receipts").run();
      this.db.prepare("DELETE FROM policy_documents").run();
      this.db.prepare("DELETE FROM context_snapshots").run();
      this.db.prepare("DELETE FROM artifacts").run();
      this.db.prepare("DELETE FROM events").run();
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(
        "workspaceId",
        bus.workspaceId,
      );

      const insert = (table: string, id: string, json: unknown) => {
        this.db.prepare(`INSERT INTO ${table}(id, json) VALUES(?, ?)`).run(id, JSON.stringify(json));
      };

      for (const [id, session] of bus.sessions) insert("sessions", id, session);
      for (const [id, participant] of bus.participants) insert("participants", id, participant);
      for (const [id, conversation] of bus.conversations) insert("conversations", id, conversation);
      for (const membership of bus.memberships) {
        this.db
          .prepare("INSERT INTO memberships(json) VALUES(?)")
          .run(JSON.stringify(membership));
      }
      for (const [id, policy] of bus.policies) {
        this.db
          .prepare("INSERT INTO policies(conversationId, json) VALUES(?, ?)")
          .run(id, JSON.stringify(policy));
      }
      for (const [id, state] of bus.roomState) {
        this.db
          .prepare("INSERT INTO room_state(conversationId, json) VALUES(?, ?)")
          .run(id, JSON.stringify(state));
      }
      for (const [id, runtime] of bus.runtime) {
        this.db
          .prepare("INSERT INTO runtime(sessionId, json) VALUES(?, ?)")
          .run(id, JSON.stringify(runtime));
      }
      for (const message of bus.messages) insert("messages", message.id, message);
      for (const delivery of bus.deliveries) insert("deliveries", delivery.id, delivery);
      for (const receipt of bus.receipts) {
        this.db.prepare("INSERT INTO receipts(json) VALUES(?)").run(JSON.stringify(receipt));
      }
      for (const [key, doc] of bus.policyDocuments) {
        this.db
          .prepare("INSERT INTO policy_documents(key, json) VALUES(?, ?)")
          .run(key, JSON.stringify(doc));
      }
      for (const [deliveryId, snapshot] of bus.contextSnapshots) {
        this.db
          .prepare("INSERT INTO context_snapshots(deliveryId, json) VALUES(?, ?)")
          .run(deliveryId, JSON.stringify(snapshot));
      }
      for (const [id, artifact] of bus.artifacts) insert("artifacts", id, artifact);
      for (const event of bus.events) {
        this.db
          .prepare("INSERT INTO events(seq, json) VALUES(?, ?)")
          .run(event.seq, JSON.stringify(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  load(bus = new MemoryBus()): MemoryBus {
    const workspace = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("workspaceId") as { value?: string } | undefined;
    if (workspace?.value) {
      (bus as { workspaceId: string }).workspaceId = workspace.value;
    }

    for (const row of this.db.prepare("SELECT id, json FROM sessions").all() as Array<{
      id: string;
      json: string;
    }>) {
      bus.sessions.set(row.id, JSON.parse(row.json) as Session);
    }
    for (const row of this.db.prepare("SELECT id, json FROM participants").all() as Array<{
      id: string;
      json: string;
    }>) {
      bus.participants.set(row.id, JSON.parse(row.json) as Participant);
    }
    for (const row of this.db.prepare("SELECT id, json FROM conversations").all() as Array<{
      id: string;
      json: string;
    }>) {
      bus.conversations.set(row.id, JSON.parse(row.json) as Conversation);
    }
    bus.memberships = (
      this.db.prepare("SELECT json FROM memberships").all() as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as Membership);
    for (const row of this.db
      .prepare("SELECT conversationId, json FROM policies")
      .all() as Array<{ conversationId: string; json: string }>) {
      bus.policies.set(row.conversationId, JSON.parse(row.json) as RoomPolicy);
    }
    for (const row of this.db
      .prepare("SELECT conversationId, json FROM room_state")
      .all() as Array<{ conversationId: string; json: string }>) {
      const state = JSON.parse(row.json) as {
        paused: boolean | number;
        rounds: number;
        policyRevision: string;
      };
      bus.roomState.set(row.conversationId, {
        paused: Boolean(state.paused),
        rounds: state.rounds,
        policyRevision: state.policyRevision,
      });
    }
    for (const row of this.db.prepare("SELECT sessionId, json FROM runtime").all() as Array<{
      sessionId: string;
      json: string;
    }>) {
      const runtime = JSON.parse(row.json) as {
        execution: "idle" | "running" | "waiting_human" | "offline" | "unknown";
        writable: boolean;
      };
      bus.runtime.set(row.sessionId, {
        execution: runtime.execution,
        writable: Boolean(runtime.writable),
      });
    }
    bus.messages = (
      this.db.prepare("SELECT json FROM messages").all() as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as Message);
    bus.deliveries = (
      this.db.prepare("SELECT json FROM deliveries").all() as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as Delivery);
    bus.receipts = (
      this.db.prepare("SELECT json FROM receipts").all() as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as DeliveryReceipt);
    for (const row of this.db.prepare("SELECT key, json FROM policy_documents").all() as Array<{
      key: string;
      json: string;
    }>) {
      bus.policyDocuments.set(row.key, JSON.parse(row.json) as PolicyDocument);
    }
    for (const row of this.db
      .prepare("SELECT deliveryId, json FROM context_snapshots")
      .all() as Array<{ deliveryId: string; json: string }>) {
      bus.contextSnapshots.set(row.deliveryId, JSON.parse(row.json) as ContextSnapshot);
    }
    for (const row of this.db.prepare("SELECT id, json FROM artifacts").all() as Array<{
      id: string;
      json: string;
    }>) {
      bus.artifacts.set(row.id, JSON.parse(row.json) as Artifact);
    }
    bus.events = (
      this.db.prepare("SELECT json FROM events ORDER BY seq").all() as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as BusEvent);
    bus.restoreIndexes();
    return bus;
  }

  close() {
    this.db.close();
  }
}
