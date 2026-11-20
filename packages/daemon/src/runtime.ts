import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileInboxAdapter,
  NativeTurnAdapter,
  claudeCli,
  claudeDialect,
  codexCli,
  codexDialect,
  discoverCliProcesses,
  processesToEndpoints,
  type TurnEnd,
} from "@portage/adapters";
import type { ContextSnapshot, Delivery, DiscoveredEndpoint, Message, Readiness, Session, SessionAdapter } from "@portage/core";
import { MemoryBus } from "@portage/core";
import { SqliteSnapshotStore } from "@portage/core/node";

/** Resolved at call time so tests can set PORTAGE_HOME before createRuntime. */
export function portageHome() {
  return process.env.PORTAGE_HOME ?? join(homedir(), ".portage");
}

export type DaemonRuntime = {
  bus: MemoryBus;
  inbox: FileInboxAdapter;
  native: NativeTurnAdapter[];
  store: SqliteSnapshotStore;
  persist: () => void;
  /** Time-driven work: uncertain read-back, reopened rate windows, adapter holds, native transcript sync. */
  tick: () => Promise<boolean>;
  /** Read new native transcript records of one session into the bus. */
  syncNative: (sessionId: string) => Promise<void>;
  /** Give the native session its Portage name through its own CLI, so its app shows the same title. */
  renameNative: (sessionId: string) => Promise<void>;
  /** Stop a running Portage turn on a native session. */
  interrupt: (sessionId: string) => boolean;
  refreshDiscovery: () => Promise<DiscoveredEndpoint[]>;
  paths: { home: string; db: string; inbox: string; artifacts: string };
};

export type RuntimeOptions = {
  hydrate?: boolean;
  /** Daemon URL agents' MCP servers talk back to. */
  daemonUrl?: string;
  /** Test seam: the native adapters to use instead of the real Codex / Claude CLIs. */
  native?: (onTurnEnd: (end: TurnEnd) => void) => NativeTurnAdapter[];
};

const DEFAULT_GLOBAL_POLICY = `# PORTAGE.md

- Every session keeps its native identity and the work in hand; Portage only carries messages.
- When you need someone else, @ them and say what you expect back.
- Cite sources and artifacts in replies; say so plainly when a result is uncertain.`;

export function createRuntime(options: RuntimeOptions = {}): DaemonRuntime {
  const home = portageHome();
  const paths = {
    home,
    db: join(home, "portage.db"),
    inbox: join(home, "inbox"),
    artifacts: join(home, "artifacts"),
  };
  for (const dir of [paths.home, paths.inbox, paths.artifacts]) mkdirSync(dir, { recursive: true });

  const mcp = {
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve("@portage/mcp/launcher"), "--daemon", options.daemonUrl ?? "http://127.0.0.1:8787"],
  };
  // Turn ends arrive outside any request; `runtime` is assigned below before the first turn can end.
  let runtime: DaemonRuntime;
  const onTurnEnd = (end: TurnEnd) => void finishTurn(runtime, end);
  const native =
    options.native?.(onTurnEnd) ?? [
      new NativeTurnAdapter({ id: "codex-native", dialect: codexDialect(), cli: codexCli, mcp, onTurnEnd }),
      new NativeTurnAdapter({ id: "claude-native", dialect: claudeDialect(), cli: claudeCli, mcp, onTurnEnd }),
    ];
  const inbox = new FileInboxAdapter(paths.inbox);
  const adapters = new Map<string, SessionAdapter>([[inbox.id, inbox], ...native.map((a) => [a.id, a] as const)]);
  const adapterFor = (session: Session): SessionAdapter => adapters.get(session.adapterId ?? inbox.id) ?? inbox;

  const store = new SqliteSnapshotStore(paths.db);
  const fresh = new MemoryBus({
    inject: async ({ session, message, delivery, compiledQuery }) => {
      const adapter = adapterFor(session);
      const result = await adapter.inject!(session, message, compiledQuery, delivery);
      if (!result.ok) return result;
      return {
        ok: true as const,
        nativeMessageId: result.nativeMessageId,
        adapterId: adapter.id,
        proof: result.proof,
        // Only when the adapter started a Portage-owned turn (not `codex queue` into the IDE).
        running: result.running === true,
      };
    },
    verify: async ({ session, message, delivery }: { session: Session; message: Message; delivery: Delivery }) =>
      adapterFor(session).verify?.(session, message, delivery.compiledContextHash ?? "") ?? { status: "unknown" as const },
    readiness: async (session): Promise<Readiness> => (await adapterFor(session).readiness?.(session)) ?? { ready: true },
  });
  const bus = options.hydrate ? store.load(fresh) : fresh;
  const persist = () => store.save(bus);

  const nativeSessions = () =>
    [...bus.sessions.values()].filter((s) => !s.archivedAt && adapterFor(s) instanceof NativeTurnAdapter);

  const syncNative = async (sessionId: string) => {
    const session = bus.sessions.get(sessionId);
    if (!session) return;
    const adapter = adapterFor(session);
    if (!adapter.readNative) return;
    const previous = bus.nativeCheckpoints.get(sessionId);
    try {
      // Codex may move a thread to a newer forked rollout; a cursor into the old file is meaningless there.
      let read = await adapter.readNative(session, previous?.cursor ?? 0);
      if (previous?.source && read.source !== previous.source) read = await adapter.readNative(session, 0);
      bus.recordNativeRead(sessionId, adapter.id, read);
    } catch (error) {
      bus.recordNativeReadError(sessionId, session.nativeIdentity, error instanceof Error ? error.message : String(error));
    }
  };

  const tick = async () => {
    let changed = await bus.tick();
    for (const session of nativeSessions()) {
      const state = () => `${bus.nativeCheckpoints.get(session.id)?.cursor}|${session.nativeTitle}|${session.displayName}`;
      const before = state();
      await syncNative(session.id);
      if (state() !== before) changed = true;
      // Queue submits used to mark the session running forever (no Portage child to end). Heal that.
      const adapter = adapterFor(session);
      if (
        bus.runtime.get(session.id)?.execution === "running" &&
        adapter instanceof NativeTurnAdapter &&
        !adapter.isRunning(session.id)
      ) {
        await bus.reportExecution(session.id, "idle");
        changed = true;
      }
    }
    return changed;
  };

  const renameNative = async (sessionId: string) => {
    const session = bus.sessions.get(sessionId);
    const adapter = session && adapterFor(session);
    if (!session || !adapter?.rename || session.nativeTitle === session.displayName) return;
    await adapter.rename(session, session.displayName);
    bus.markNativeTitle(session.id, session.displayName);
  };

  const refreshDiscovery = async () => {
    const [processes, ...sessions] = await Promise.all([
      discoverCliProcesses().then(processesToEndpoints),
      ...native.map((a) => a.discover()),
    ]);
    return [...sessions.flat(), ...processes];
  };

  const interrupt = (sessionId: string) => native.some((a) => a.interrupt(sessionId));

  runtime = { bus, inbox, native, store, persist, tick, syncNative, renameNative, interrupt, refreshDiscovery, paths };

  // A turn that was running when the daemon stopped is not ours anymore — clear every session, not
  // only native ones (the demo seed used to leave a file-inbox session "Working" forever). No detail:
  // that string used to linger on the office floor as a host note.
  for (const [id, state] of bus.runtime) {
    if (state.execution === "running" || state.detail?.startsWith("Portage restarted")) bus.setSessionExecution(id, "idle");
  }
  // Pre-hold-era Failed rows for Codex writer conflicts become cancelled(attached), not a graveyard.
  if (bus.healWriterBusyFailures() > 0) persist();
  return runtime;
}

/** A native turn ended: read what it wrote, then free the session so its inbox continues in order. */
async function finishTurn(runtime: DaemonRuntime, end: TurnEnd) {
  try {
    await runtime.syncNative(end.sessionId);
    await runtime.bus.reportExecution(end.sessionId, "idle", end.ok ? undefined : `Native turn failed: ${end.error}`);
    runtime.persist();
  } catch (error) {
    console.error("[portage] finishing a native turn failed:", error);
  }
}

/** Studio demo identities (file inbox). Used only for the in-app animation / `portage demo`. */
export function isStudioDemoSession(nativeIdentity: string) {
  return nativeIdentity.startsWith("demo-");
}

/**
 * Seed the demo room: three demo identities over the file inbox, clearly not real sessions.
 * Opt-in only — production `serve` stays real-sessions-only.
 */
export async function seedDemoRoom(runtime: DaemonRuntime) {
  const { bus } = runtime;
  if (!bus.getPolicyDocument("global", "PORTAGE")) {
    bus.publishPolicy({ scope: "global", id: "PORTAGE", markdown: DEFAULT_GLOBAL_POLICY, updatedBy: "system" });
  }
  // Re-activate if a previous serve archived them.
  for (const session of bus.sessions.values()) {
    if (!isStudioDemoSession(session.nativeIdentity) || !session.archivedAt) continue;
    bus.updateSession({ sessionId: session.id, archived: false });
  }
  if (bus.conversations.has("room_dev")) {
    for (const alias of ["lead", "builder", "reviewer"]) {
      const pid = `p_${alias}`;
      if (!bus.participants.has(pid)) continue;
      const active = bus.memberships.some((m) => m.conversationId === "room_dev" && m.participantId === pid && !m.leftAt);
      if (!active) await bus.joinRoom({ conversationId: "room_dev", participantId: pid });
    }
    return;
  }

  const demo = (id: string, provider: string, host: string, name: string, alias: string) =>
    bus.registerSession({
      session: {
        id: `s_${alias}`,
        provider,
        harness: "cli",
        host,
        nativeIdentity: id,
        displayName: name,
        alias,
        communicationEnabled: true,
      },
      participantId: `p_${alias}`,
    });
  demo("demo-codex-lead", "codex", "terminal", "Coordinator", "lead");
  demo("demo-claude-builder", "claude", "vscode_cli", "Adapter builder", "builder");
  demo("demo-claude-reviewer", "claude", "terminal", "Code reviewer", "reviewer");

  bus.createRoom({
    id: "room_dev",
    title: "Portage Studio",
    createdBy: "user",
    wakeMode: "coordinator",
    coordinatorParticipantId: "p_lead",
  });
  for (const alias of ["lead", "builder", "reviewer"]) await bus.joinRoom({ conversationId: "room_dev", participantId: `p_${alias}` });
}

/** Archive seeded studio identities so the UI defaults to real Codex/Claude sessions. */
export function retireStudioDemo(runtime: DaemonRuntime) {
  let n = 0;
  for (const session of runtime.bus.sessions.values()) {
    if (!isStudioDemoSession(session.nativeIdentity) || session.archivedAt) continue;
    runtime.bus.updateSession({ sessionId: session.id, archived: true });
    n += 1;
  }
  return n;
}

/** Messages per conversation the UI starts with; older ones are paged in on demand. */
export const UI_HISTORY_WINDOW = 50;

/** Context metadata without the compiled text; the full snapshot is fetched per delivery when opened. */
type ContextMeta = Omit<ContextSnapshot, "query">;

/** Messages plus their deliveries, receipts and context metadata — what the UI needs to show them. */
function withDeliveries(bus: MemoryBus, messages: Message[], extra: Delivery[] = []) {
  const deliveries = new Map<string, Delivery>();
  for (const message of messages) for (const d of bus.deliveriesForMessage(message.id)) deliveries.set(d.id, d);
  for (const d of extra) deliveries.set(d.id, d);
  const contexts: Record<string, ContextMeta> = {};
  for (const id of deliveries.keys()) {
    const snapshot = bus.contextSnapshots.get(id);
    if (snapshot) {
      const { query: _query, ...meta } = snapshot;
      contexts[id] = meta;
    }
  }
  return {
    messages,
    deliveries: [...deliveries.values()],
    receipts: [...deliveries.keys()].flatMap((id) => bus.receiptsForDelivery(id)),
    contexts,
  };
}

/** One page of a conversation's older history. */
export function historyPage(bus: MemoryBus, conversationId: string, beforeSeq: number, limit: number) {
  const page = bus.messagePage(conversationId, limit, beforeSeq);
  return { ...withDeliveries(bus, page.messages), hasMore: page.hasMore };
}

/**
 * The UI's starting view, bounded regardless of history: the recent window of every conversation,
 * every delivery still in flight (and its message), and the recent events.
 */
export function snapshotForUi(bus: MemoryBus, window = UI_HISTORY_WINDOW) {
  const conversations = [...bus.conversations.values()];
  const messages = new Map<string, Message>();
  /** `fromSeq`: where the window starts, so a client holding older pages can tell when a burst left a gap. */
  const history: Record<string, { hasMore: boolean; fromSeq?: number }> = {};
  for (const c of conversations) {
    const page = bus.messagePage(c.id, window);
    for (const m of page.messages) messages.set(m.id, m);
    history[c.id] = { hasMore: page.hasMore, fromSeq: page.messages[0]?.seq };
  }
  const inFlight = bus.deliveries.filter((d) => !["submitted", "failed", "cancelled"].includes(d.state));
  for (const d of inFlight) {
    const message = bus.getMessage(d.messageId);
    if (message) messages.set(message.id, message);
  }
  const ordered = [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
  return {
    workspaceId: bus.workspaceId,
    conversations: conversations.map((c) => ({
      ...c,
      policy: bus.policies.get(c.id),
      state: bus.roomState.get(c.id),
      document: c.policyDocumentId ? bus.getPolicyDocument("room", c.policyDocumentId) ?? null : null,
    })),
    globalDocument: bus.getPolicyDocument("global", "PORTAGE") ?? null,
    sessions: [...bus.sessions.values()],
    participants: [...bus.participants.values()],
    memberships: bus.memberships,
    ...withDeliveries(bus, ordered, inFlight),
    history,
    runtimes: Object.fromEntries(bus.runtime),
    artifacts: [...bus.artifacts.values()],
    nativeCheckpoints: Object.fromEntries(bus.nativeCheckpoints),
    events: bus.events.slice(-400),
    lastEventSeq: bus.events.at(-1)?.seq ?? 0,
  };
}
