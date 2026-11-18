import { DatabaseSync } from "node:sqlite";
import { MemoryBus, type RoomState, type SessionRuntime } from "../bus/memory-bus.js";
import type { ContextSnapshot } from "../context.js";
import type {
  Artifact,
  BusEvent,
  Conversation,
  Delivery,
  DeliveryReceipt,
  Membership,
  Message,
  NativeEvent,
  NativeSyncCheckpoint,
  Participant,
  PolicyDocument,
  RoomPolicy,
  Session,
} from "../types.js";

/** Events kept in memory after load; the database keeps the full EventLog. */
const EVENTS_LOADED = 5000;
/** Native transcript records kept in memory after load (newest); the database keeps all of them. */
const NATIVE_EVENTS_LOADED = 20000;

type KeyedTable =
  | "sessions"
  | "participants"
  | "conversations"
  | "memberships"
  | "policies"
  | "room_state"
  | "runtime"
  | "policy_documents"
  | "artifacts"
  | "native_checkpoints";

/**
 * Durable store for MemoryBus using Node's built-in sqlite (WAL).
 *
 * `save` writes only what changed since the previous save, in one transaction: messages and
 * deliveries the bus marked dirty, events and receipts appended since last time, and rows of the
 * small keyed tables whose content changed. The daemon calls it before answering a mutating
 * request, so `accepted` is only returned once the change is on disk.
 */
export class SqliteSnapshotStore {
  private db: DatabaseSync;
  private savedHashes = new Map<string, string>();
  private savedReceipts = 0;
  private primed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_state (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_documents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, recipient_session_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_snapshots (delivery_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, trace_id TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_checkpoints (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
    this.migrateLegacySnapshot();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS deliveries_by_recipient ON deliveries(recipient_session_id, state);
      CREATE INDEX IF NOT EXISTS events_by_trace ON events(trace_id);
      CREATE INDEX IF NOT EXISTS native_events_by_session ON native_events(session_id);
    `);
  }

  save(bus: MemoryBus) {
    // A store that never loaded starts from whatever is on disk: write everything once.
    const fullPass = !this.primed;
    const dirty = bus.takeDirty();
    const messageIds = fullPass ? bus.messages.map((m) => m.id) : dirty.messages;
    const deliveryIds = fullPass ? bus.deliveries.map((d) => d.id) : dirty.deliveries;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run("workspaceId", bus.workspaceId);
      this.syncKeyed("sessions", bus.sessions);
      this.syncKeyed("participants", bus.participants);
      this.syncKeyed("conversations", bus.conversations);
      this.syncKeyed("memberships", new Map(bus.memberships.map((m) => [`${m.conversationId}|${m.participantId}`, m])));
      this.syncKeyed("policies", bus.policies);
      this.syncKeyed("room_state", bus.roomState);
      this.syncKeyed("runtime", bus.runtime);
      this.syncKeyed("policy_documents", bus.policyDocuments);
      this.syncKeyed("artifacts", bus.artifacts);
      this.syncKeyed("native_checkpoints", bus.nativeCheckpoints);

      const upsertMessage = this.db.prepare(
        "INSERT OR REPLACE INTO messages(id, conversation_id, seq, json) VALUES(?, ?, ?, ?)",
      );
      for (const id of messageIds) {
        const message = bus.getMessage(id);
        if (message) upsertMessage.run(id, message.conversationId, message.seq, JSON.stringify(message));
      }

      const upsertDelivery = this.db.prepare(
        "INSERT OR REPLACE INTO deliveries(id, recipient_session_id, state, json) VALUES(?, ?, ?, ?)",
      );
      const upsertSnapshot = this.db.prepare("INSERT OR REPLACE INTO context_snapshots(delivery_id, json) VALUES(?, ?)");
      for (const id of deliveryIds) {
        const delivery = bus.getDelivery(id);
        if (!delivery) continue;
        upsertDelivery.run(id, delivery.recipientSessionId, delivery.state, JSON.stringify(delivery));
        const snapshot = bus.contextSnapshots.get(id);
        if (snapshot) upsertSnapshot.run(id, JSON.stringify(snapshot));
      }

      const insertReceipt = this.db.prepare("INSERT OR REPLACE INTO receipts(id, delivery_id, json) VALUES(?, ?, ?)");
      for (const receipt of bus.receipts.slice(fullPass ? 0 : this.savedReceipts)) {
        insertReceipt.run(`${receipt.deliveryId}|${receipt.proofLevel}|${receipt.observedAt}`, receipt.deliveryId, JSON.stringify(receipt));
      }

      const insertEvent = this.db.prepare("INSERT OR IGNORE INTO events(seq, trace_id, json) VALUES(?, ?, ?)");
      for (const event of fullPass ? [...bus.events, ...dirty.events] : dirty.events) {
        insertEvent.run(event.seq, event.traceId ?? null, JSON.stringify(event));
      }

      const insertNative = this.db.prepare("INSERT OR IGNORE INTO native_events(id, session_id, json) VALUES(?, ?, ?)");
      for (const event of fullPass ? bus.nativeEvents : dirty.nativeEvents) {
        insertNative.run(event.id, event.sessionId, JSON.stringify(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      // Nothing was written: put the change set back so the next save retries it.
      bus.markDirty(dirty);
      throw error;
    }
    this.savedReceipts = bus.receipts.length;
    this.primed = true;
  }

  load(bus = new MemoryBus()): MemoryBus {
    const workspace = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("workspaceId") as
      | { value?: string }
      | undefined;
    if (workspace?.value) (bus as { workspaceId: string }).workspaceId = workspace.value;

    const rows = (table: KeyedTable) => {
      const result = this.db.prepare(`SELECT id, json FROM ${table}`).all() as Array<{ id: string; json: string }>;
      for (const row of result) this.savedHashes.set(`${table}:${row.id}`, row.json);
      return result.map((row) => [row.id, JSON.parse(row.json)] as const);
    };

    for (const [id, value] of rows("sessions")) bus.sessions.set(id, value as Session);
    for (const [id, value] of rows("participants")) bus.participants.set(id, value as Participant);
    for (const [id, value] of rows("conversations")) bus.conversations.set(id, value as Conversation);
    bus.memberships = rows("memberships").map(([, value]) => value as Membership);
    for (const [id, value] of rows("policies")) bus.policies.set(id, value as RoomPolicy);
    for (const [id, value] of rows("room_state")) {
      const state = value as Partial<RoomState>;
      bus.roomState.set(id, {
        paused: Boolean(state.paused),
        rounds: state.rounds ?? 0,
        activeTraceId: state.activeTraceId,
        traceRounds: state.traceRounds ?? {},
        policyRevision: state.policyRevision ?? "1",
      });
    }
    for (const [id, value] of rows("runtime")) bus.runtime.set(id, value as SessionRuntime);
    for (const [id, value] of rows("policy_documents")) bus.policyDocuments.set(id, value as PolicyDocument);
    for (const [id, value] of rows("artifacts")) bus.artifacts.set(id, value as Artifact);
    for (const [id, value] of rows("native_checkpoints")) bus.nativeCheckpoints.set(id, value as NativeSyncCheckpoint);
    bus.nativeEvents = (
      this.db
        .prepare("SELECT json FROM (SELECT rowid, json FROM native_events ORDER BY rowid DESC LIMIT ?) ORDER BY rowid")
        .all(NATIVE_EVENTS_LOADED) as Array<{ json: string }>
    ).map((row) => JSON.parse(row.json) as NativeEvent);

    bus.messages = (this.db.prepare("SELECT json FROM messages ORDER BY conversation_id, seq").all() as Array<{ json: string }>)
      .map((row) => JSON.parse(row.json) as Message)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
    bus.deliveries = (this.db.prepare("SELECT json FROM deliveries ORDER BY rowid").all() as Array<{ json: string }>).map(
      (row) => JSON.parse(row.json) as Delivery,
    );
    for (const row of this.db.prepare("SELECT delivery_id, json FROM context_snapshots").all() as Array<{
      delivery_id: string;
      json: string;
    }>) {
      bus.contextSnapshots.set(row.delivery_id, JSON.parse(row.json) as ContextSnapshot);
    }
    bus.receipts = (this.db.prepare("SELECT json FROM receipts ORDER BY rowid").all() as Array<{ json: string }>).map(
      (row) => JSON.parse(row.json) as DeliveryReceipt,
    );
    bus.events = (
      this.db.prepare("SELECT json FROM (SELECT seq, json FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(EVENTS_LOADED) as Array<{
        json: string;
      }>
    ).map((row) => JSON.parse(row.json) as BusEvent);
    const maxSeq = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };

    bus.restoreIndexes(maxSeq.seq ?? 0);
    bus.takeDirty();
    this.savedReceipts = bus.receipts.length;
    this.primed = true;
    return bus;
  }

  /** Full EventLog for one trace, including events no longer held in memory. */
  traceEvents(traceId: string): BusEvent[] {
    return (this.db.prepare("SELECT json FROM events WHERE trace_id = ? ORDER BY seq").all(traceId) as Array<{ json: string }>).map(
      (row) => JSON.parse(row.json) as BusEvent,
    );
  }

  close() {
    this.db.close();
  }

  private syncKeyed(table: KeyedTable, values: Map<string, unknown>) {
    const upsert = this.db.prepare(`INSERT OR REPLACE INTO ${table}(id, json) VALUES(?, ?)`);
    const prefix = `${table}:`;
    for (const [id, value] of values) {
      const json = JSON.stringify(value);
      const key = prefix + id;
      if (this.savedHashes.get(key) === json) continue;
      upsert.run(id, json);
      this.savedHashes.set(key, json);
    }
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const key of [...this.savedHashes.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (values.has(id)) continue;
      remove.run(id);
      this.savedHashes.delete(key);
    }
  }

  /** Databases written by the v1.0 full-rewrite snapshot used other key columns; move them over once. */
  private migrateLegacySnapshot() {
    const columns = (table: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const legacy: Array<[string, string]> = [
      ["policies", "conversationId"],
      ["room_state", "conversationId"],
      ["runtime", "sessionId"],
      ["policy_documents", "key"],
      ["context_snapshots", "deliveryId"],
    ];
    const needs = (table: string, column: string) => columns(table).includes(column);
    const legacyMessages = !columns("messages").includes("conversation_id");
    const legacyDeliveries = !columns("deliveries").includes("recipient_session_id");
    const legacyReceipts = !columns("receipts").includes("delivery_id");
    const legacyMemberships = columns("memberships").includes("id") && this.isIntegerKey("memberships");
    const legacyEvents = !columns("events").includes("trace_id");
    if (!legacy.some(([t, c]) => needs(t, c)) && !legacyMessages && !legacyDeliveries && !legacyReceipts && !legacyMemberships && !legacyEvents) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, column] of legacy) {
        if (!needs(table, column)) continue;
        const rows = this.db.prepare(`SELECT ${column} AS id, json FROM ${table}`).all() as Array<{ id: string; json: string }>;
        this.db.exec(`DROP TABLE ${table}`);
        const key = table === "context_snapshots" ? "delivery_id" : "id";
        this.db.exec(`CREATE TABLE ${table} (${key} TEXT PRIMARY KEY, json TEXT NOT NULL)`);
        const insert = this.db.prepare(`INSERT INTO ${table}(${key}, json) VALUES(?, ?)`);
        for (const row of rows) insert.run(row.id, row.json);
      }
      if (legacyMemberships) {
        const rows = this.db.prepare("SELECT json FROM memberships").all() as Array<{ json: string }>;
        this.db.exec("DROP TABLE memberships; CREATE TABLE memberships (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
        const insert = this.db.prepare("INSERT OR REPLACE INTO memberships(id, json) VALUES(?, ?)");
        for (const row of rows) {
          const m = JSON.parse(row.json) as Membership;
          insert.run(`${m.conversationId}|${m.participantId}`, row.json);
        }
      }
      if (legacyMessages) {
        const rows = this.db.prepare("SELECT json FROM messages").all() as Array<{ json: string }>;
        this.db.exec(
          "DROP TABLE messages; CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, seq)",
        );
        const insert = this.db.prepare("INSERT INTO messages(id, conversation_id, seq, json) VALUES(?, ?, ?, ?)");
        for (const row of rows) {
          const m = JSON.parse(row.json) as Message;
          insert.run(m.id, m.conversationId, m.seq, row.json);
        }
      }
      if (legacyDeliveries) {
        const rows = this.db.prepare("SELECT json FROM deliveries").all() as Array<{ json: string }>;
        this.db.exec(
          "DROP TABLE deliveries; CREATE TABLE deliveries (id TEXT PRIMARY KEY, recipient_session_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS deliveries_by_recipient ON deliveries(recipient_session_id, state)",
        );
        const insert = this.db.prepare("INSERT INTO deliveries(id, recipient_session_id, state, json) VALUES(?, ?, ?, ?)");
        for (const row of rows) {
          const d = JSON.parse(row.json) as Delivery;
          insert.run(d.id, d.recipientSessionId, d.state, row.json);
        }
      }
      if (legacyReceipts) {
        const rows = this.db.prepare("SELECT json FROM receipts").all() as Array<{ json: string }>;
        this.db.exec("DROP TABLE receipts; CREATE TABLE receipts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, json TEXT NOT NULL)");
        const insert = this.db.prepare("INSERT OR REPLACE INTO receipts(id, delivery_id, json) VALUES(?, ?, ?)");
        for (const row of rows) {
          const r = JSON.parse(row.json) as DeliveryReceipt;
          insert.run(`${r.deliveryId}|${r.proofLevel}|${r.observedAt}`, r.deliveryId, row.json);
        }
      }
      if (legacyEvents) {
        const rows = this.db.prepare("SELECT seq, json FROM events").all() as Array<{ seq: number; json: string }>;
        this.db.exec(
          "DROP TABLE events; CREATE TABLE events (seq INTEGER PRIMARY KEY, trace_id TEXT, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_by_trace ON events(trace_id)",
        );
        const insert = this.db.prepare("INSERT INTO events(seq, trace_id, json) VALUES(?, ?, ?)");
        for (const row of rows) insert.run(row.seq, (JSON.parse(row.json) as BusEvent).traceId ?? null, row.json);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private isIntegerKey(table: string) {
    const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>;
    return info.some((c) => c.pk === 1 && c.type.toUpperCase() === "INTEGER");
  }
}
