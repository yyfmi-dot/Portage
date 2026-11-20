import { compileContext, fnv1a, markedMessageIds, type ContextSnapshot } from "../context.js";
import { applyDeliveryTransition, shouldHoldForConditions, type DeliveryTransition } from "../delivery.js";
import { acceptMessage } from "../messaging.js";
import type { PortageBusApi } from "../api.js";
import type { NativeReadResult, Readiness, VerifyResult } from "../adapter.js";
import { PolicyFrontmatterError, parsePolicyDocument } from "../policy-frontmatter.js";
import type {
  Artifact,
  BusEvent,
  BusEventType,
  ContentPart,
  Conversation,
  Delivery,
  DeliveryReceipt,
  DeliveryState,
  HoldReason,
  Membership,
  Message,
  NativeEvent,
  NativeSyncCheckpoint,
  Participant,
  PolicyDocument,
  ProofLevel,
  RoomPolicy,
  Session,
  WakeMode,
} from "../types.js";
import { assertCoordinatorInvariant } from "../wake.js";

export type SessionRuntime = {
  execution: "idle" | "running" | "waiting_human" | "offline" | "unknown";
  writable: boolean;
  /** Last thing the host said about this state, e.g. why a native turn failed. */
  detail?: string;
};

export type InjectHook = (input: {
  session: Session;
  message: Message;
  delivery: Delivery;
  compiledQuery: string;
  snapshot: ContextSnapshot;
}) => Promise<
  /** `running`: the submission started a native turn; the session is busy until the host reports otherwise. */
  | { ok: true; nativeMessageId?: string; adapterId?: string; proof?: ProofLevel; running?: boolean }
  | { ok: false; retryable?: boolean; uncertain?: boolean; error: string }
>;

/** Adapter-side readiness of the recipient, checked right before a submission. */
export type ReadinessHook = (session: Session) => Promise<Readiness>;

/** Hold reasons that only the adapter can lift; the daemon tick re-checks them. */
const ADAPTER_HOLD_REASONS: HoldReason[] = ["attached", "offline"];

export const TUNABLE_BUDGETS = [
  "maxAutoRounds",
  "agentMessagesPerMinute",
  "maxConcurrent",
  "maxWakeupsPerTrace",
  "batchWindowMs",
  "maxContextBytes",
] as const;
export type TunableBudget = (typeof TUNABLE_BUDGETS)[number];

const BUDGET_RANGES: Record<TunableBudget, [number, number]> = {
  maxAutoRounds: [1, 100],
  agentMessagesPerMinute: [1, 1000],
  maxConcurrent: [1, 20],
  maxWakeupsPerTrace: [1, 1000],
  batchWindowMs: [0, 60_000],
  maxContextBytes: [1024, 1_048_576],
};

export function validateBudgets(input: Partial<Record<TunableBudget, unknown>>): Partial<Record<TunableBudget, number>> {
  const out: Partial<Record<TunableBudget, number>> = {};
  for (const key of TUNABLE_BUDGETS) {
    const value = input[key];
    if (value === undefined) continue;
    const [min, max] = BUDGET_RANGES[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer ${min}-${max}`);
    out[key] = value;
  }
  return out;
}

/** Read back an uncertain submission through the adapter that made it. */
export type VerifyHook = (input: { session: Session; message: Message; delivery: Delivery }) => Promise<VerifyResult>;

export type MemoryBusOptions = {
  workspaceId?: string;
  inject?: InjectHook;
  verify?: VerifyHook;
  readiness?: ReadinessHook;
  now?: () => string;
};

export type RoomState = {
  paused: boolean;
  /** Auto rounds of the most recently active trace — what the room summary shows as `rounds/max`. */
  rounds: number;
  activeTraceId?: string;
  /** Auto rounds per trace: one trace's agent ping-pong never spends another trace's budget. */
  traceRounds: Record<string, number>;
  policyRevision: string;
};

const TRACE_ROUNDS_KEPT = 200;

type EventInput = {
  eventType: BusEventType;
  entityId: string;
  actorId?: string;
  conversationId?: string;
  traceId?: string;
  causalParentIds?: string[];
  payload?: BusEvent["payload"];
};

const NATIVE_TEXT_LIMIT = 8000;
/** Native records kept in memory (newest); older ones stay on disk. */
const NATIVE_EVENTS_KEPT = 20_000;

const DELIVERY_EVENT: Partial<Record<DeliveryState, BusEventType>> = {
  queued: "DeliveryQueued",
  held: "DeliveryHeld",
  submitted: "DeliverySubmitted",
  uncertain: "DeliveryUncertain",
  failed: "DeliveryFailed",
  cancelled: "DeliveryCancelled",
};

const EVENT_LIMIT = 5000;
const RATE_WINDOW_MS = 60_000;

/**
 * In-memory Bus for L2/L3 verification and local daemon.
 * SqliteSnapshotStore persists the same maps without changing the API.
 */
export class MemoryBus implements PortageBusApi {
  readonly workspaceId: string;
  private readonly now: () => string;
  private injectHook?: InjectHook;
  private verifyHook?: VerifyHook;
  private readinessHook?: ReadinessHook;

  sessions = new Map<string, Session>();
  participants = new Map<string, Participant>();
  conversations = new Map<string, Conversation>();
  memberships: Membership[] = [];
  policies = new Map<string, RoomPolicy>();
  roomState = new Map<string, RoomState>();
  runtime = new Map<string, SessionRuntime>();
  messages: Message[] = [];
  deliveries: Delivery[] = [];
  receipts: DeliveryReceipt[] = [];
  policyDocuments = new Map<string, PolicyDocument>();
  contextSnapshots = new Map<string, ContextSnapshot>();
  artifacts = new Map<string, Artifact>();
  nativeEvents: NativeEvent[] = [];
  nativeCheckpoints = new Map<string, NativeSyncCheckpoint>();
  events: BusEvent[] = [];
  private eventSeq = 0;
  private listeners = new Set<(event: BusEvent) => void>();
  /** Messages / deliveries changed since the store last persisted them. */
  private dirtyMessages = new Set<string>();
  private dirtyDeliveries = new Set<string>();
  /** Events not yet persisted; unlike `events`, never trimmed, so the EventLog on disk stays complete. */
  private unsavedEvents: BusEvent[] = [];
  private unsavedNative: NativeEvent[] = [];
  private idempotency = new Map<string, { message: Message; deliveries: Delivery[] }>();
  private seqByConversation = new Map<string, number>();
  private messageById = new Map<string, Message>();
  private messagesByConversation = new Map<string, Message[]>();
  private messagesByTrace = new Map<string, Message[]>();
  private deliveryById = new Map<string, Delivery>();
  private deliveriesByMessage = new Map<string, Delivery[]>();
  private receiptsByDelivery = new Map<string, DeliveryReceipt[]>();
  private nativeEventIds = new Set<string>();
  private nativeBySession = new Map<string, NativeEvent[]>();
  /** Native input lock: one submission in flight per session, across concurrent flushes. */
  private inputLocks = new Set<string>();
  /** Deliveries another flush skipped while the lock was held; flushed when it is released. */
  private lockWaiters = new Map<string, string[]>();

  constructor(options: MemoryBusOptions = {}) {
    this.workspaceId = options.workspaceId ?? "ws_local";
    this.now = options.now ?? (() => new Date().toISOString());
    this.injectHook = options.inject;
    this.verifyHook = options.verify;
    this.readinessHook = options.readiness;
  }

  getMessage(id: string): Message | undefined {
    return this.messageById.get(id);
  }

  getDelivery(id: string): Delivery | undefined {
    return this.deliveryById.get(id);
  }

  private indexMessage(message: Message) {
    this.messageById.set(message.id, message);
    push(this.messagesByConversation, message.conversationId, message);
    push(this.messagesByTrace, message.traceId, message);
  }

  private indexDelivery(delivery: Delivery) {
    this.deliveryById.set(delivery.id, delivery);
    push(this.deliveriesByMessage, delivery.messageId, delivery);
  }

  // ── events ────────────────────────────────────────────────────────────

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listEvents(input: { conversationId?: string; sinceSeq?: number } = {}): BusEvent[] {
    return this.events.filter(
      (e) =>
        (!input.conversationId || e.conversationId === input.conversationId) &&
        (input.sinceSeq === undefined || e.seq > input.sinceSeq),
    );
  }

  private emit(input: EventInput) {
    this.eventSeq += 1;
    const event: BusEvent = {
      id: `evt_${this.eventSeq}`,
      workspaceId: this.workspaceId,
      conversationId: input.conversationId,
      seq: this.eventSeq,
      eventType: input.eventType,
      entityId: input.entityId,
      actorId: input.actorId ?? "system",
      traceId: input.traceId,
      causalParentIds: input.causalParentIds ?? [],
      serverTime: this.now(),
      payloadVersion: 1,
      payload: input.payload ?? {},
    };
    this.events.push(event);
    this.unsavedEvents.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener failures must not break bus transitions
      }
    }
  }

  /** Return a change set the store could not persist, so the next save retries it. */
  markDirty(changed: { messages: string[]; deliveries: string[]; events?: BusEvent[]; nativeEvents?: NativeEvent[] }) {
    for (const id of changed.messages) this.dirtyMessages.add(id);
    for (const id of changed.deliveries) this.dirtyDeliveries.add(id);
    if (changed.events?.length) this.unsavedEvents = [...changed.events, ...this.unsavedEvents];
    if (changed.nativeEvents?.length) this.unsavedNative = [...changed.nativeEvents, ...this.unsavedNative];
  }

  /**
   * Rebuild derived indexes after hydrating maps from persistent storage.
   * `lastEventSeq` continues numbering after events that were persisted but not loaded into memory.
   */
  restoreIndexes(lastEventSeq = 0) {
    this.seqByConversation.clear();
    this.messageById.clear();
    this.messagesByConversation.clear();
    this.messagesByTrace.clear();
    this.deliveryById.clear();
    this.deliveriesByMessage.clear();
    for (const message of this.messages) {
      const current = this.seqByConversation.get(message.conversationId) ?? 0;
      if (message.seq > current) this.seqByConversation.set(message.conversationId, message.seq);
      this.indexMessage(message);
    }
    for (const delivery of this.deliveries) this.indexDelivery(delivery);
    this.receiptsByDelivery.clear();
    for (const receipt of this.receipts) push(this.receiptsByDelivery, receipt.deliveryId, receipt);
    this.idempotency.clear();
    for (const message of this.messages) {
      this.idempotency.set(message.idempotencyKey, {
        message,
        deliveries: this.deliveriesByMessage.get(message.id) ?? [],
      });
    }
    this.indexNative();
    this.eventSeq = this.events.reduce((max, e) => Math.max(max, e.seq), lastEventSeq);
    for (const state of this.roomState.values()) state.traceRounds ??= {};
    // A delivery still `dispatching` was interrupted mid-submit: whether it landed is unknown.
    for (const delivery of this.deliveries) {
      if (delivery.state === "dispatching") this.transition(delivery, { type: "uncertain" });
    }
  }

  /** Hand the changed message / delivery ids to the store and start a new change set. */
  takeDirty(): { messages: string[]; deliveries: string[]; events: BusEvent[]; nativeEvents: NativeEvent[] } {
    const changed = {
      messages: [...this.dirtyMessages],
      deliveries: [...this.dirtyDeliveries],
      events: this.unsavedEvents,
      nativeEvents: this.unsavedNative,
    };
    this.dirtyMessages.clear();
    this.dirtyDeliveries.clear();
    this.unsavedEvents = [];
    this.unsavedNative = [];
    return changed;
  }

  // ── policy documents ──────────────────────────────────────────────────

  publishPolicyDocument(doc: PolicyDocument) {
    this.policyDocuments.set(`${doc.scope}:${doc.id}`, doc);
    if (doc.scope === "room") {
      const conversation = [...this.conversations.values()].find(
        (c) => c.policyDocumentId === doc.id || c.id === doc.id,
      );
      if (conversation) {
        conversation.policyDocumentId = doc.id;
        this.bumpPolicyRevision(conversation.id);
      }
    }
  }

  /**
   * Publish a room collaboration.md. Its frontmatter is executable policy: it is validated against
   * the schema and the current membership first, and the revision is only published if it applies.
   */
  async publishRoomPolicy(input: { conversationId: string; markdown: string; updatedBy: string }) {
    const { policy: wanted } = parsePolicyDocument(input.markdown.trim());
    const policy = this.requirePolicy(input.conversationId);
    const budgets = validateBudgets(wanted);

    const mode = wanted.wakeMode ?? (wanted.coordinator ? "coordinator" : undefined);
    let coordinatorParticipantId: string | undefined;
    if (wanted.coordinator) {
      coordinatorParticipantId = this.resolveMember(input.conversationId, wanted.coordinator);
      if (!coordinatorParticipantId)
        throw new PolicyFrontmatterError([`wake.coordinator "${wanted.coordinator}" is not an active member`]);
    } else if (mode === "coordinator" && policy.wakeMode !== "coordinator" && !this.activeMemberIds(input.conversationId).length) {
      throw new PolicyFrontmatterError(["wake.mode coordinator needs at least one active member"]);
    }

    const changesWake =
      mode !== undefined &&
      (mode !== policy.wakeMode || (coordinatorParticipantId && coordinatorParticipantId !== policy.coordinatorParticipantId));
    if (changesWake) {
      await this.setWakeMode({
        conversationId: input.conversationId,
        mode: mode!,
        coordinatorParticipantId,
        actorId: input.updatedBy,
      });
    }
    const changesBudget = Object.entries(budgets).some(([k, v]) => policy[k as TunableBudget] !== v);
    if (changesBudget) {
      await this.updateRoomPolicy({ conversationId: input.conversationId, actorId: input.updatedBy, ...budgets });
    }
    const document = this.publishPolicy({
      scope: "room",
      id: input.conversationId,
      markdown: input.markdown,
      updatedBy: input.updatedBy,
    });
    return { document, policy: structuredClone(policy) };
  }

  /** Publish a new revision of a policy document; revision and hash are owned by the bus. */
  publishPolicy(input: {
    scope: PolicyDocument["scope"];
    id: string;
    markdown: string;
    updatedBy: string;
  }): PolicyDocument {
    const markdown = input.markdown.trim();
    if (!markdown) throw new Error("markdown required");
    parsePolicyDocument(markdown);
    const existing = this.getPolicyDocument(input.scope, input.id);
    const doc: PolicyDocument = {
      id: input.id,
      scope: input.scope,
      markdown,
      publishedRevision: (existing?.publishedRevision ?? 0) + 1,
      hash: fnv1a(markdown),
      updatedBy: input.updatedBy,
      publishedAt: this.now(),
    };
    this.publishPolicyDocument(doc);
    this.emit({
      eventType: "PolicyPublished",
      entityId: `${doc.scope}:${doc.id}`,
      actorId: input.updatedBy,
      conversationId: doc.scope === "room" ? doc.id : undefined,
      payload: { scope: doc.scope, revision: doc.publishedRevision, hash: doc.hash },
    });
    return structuredClone(doc);
  }

  getPolicyDocument(scope: PolicyDocument["scope"], id: string): PolicyDocument | undefined {
    return this.policyDocuments.get(`${scope}:${id}`);
  }

  // ── sessions ──────────────────────────────────────────────────────────

  registerSession(input: {
    session: Omit<Session, "workspaceId"> & { workspaceId?: string };
    participantId?: string;
    runtime?: Partial<SessionRuntime>;
  }): { session: Session; participant: Participant } {
    const session: Session = {
      ...input.session,
      workspaceId: input.session.workspaceId ?? this.workspaceId,
      bindingEpoch: input.session.bindingEpoch ?? 1,
    };
    this.sessions.set(session.id, session);
    const participantId = input.participantId ?? `part_${session.id}`;
    const participant: Participant = {
      id: participantId,
      workspaceId: this.workspaceId,
      kind: "agent",
      sessionId: session.id,
    };
    this.participants.set(participantId, participant);
    this.runtime.set(session.id, {
      execution: input.runtime?.execution ?? "idle",
      writable: input.runtime?.writable ?? true,
    });
    this.emit({
      eventType: "SessionRegistered",
      entityId: session.id,
      actorId: "user",
      payload: {
        provider: session.provider,
        host: session.host,
        nativeIdentity: session.nativeIdentity,
      },
    });
    return { session, participant };
  }

  updateSession(input: {
    sessionId: string;
    displayName?: string;
    alias?: string;
    archived?: boolean;
  }): Session {
    const session = this.requireSession(input.sessionId);
    if (input.displayName !== undefined) {
      const name = input.displayName.trim();
      if (!name) throw new Error("displayName required");
      session.displayName = name;
    }
    if (input.alias !== undefined) {
      const alias = input.alias.trim();
      if (!/^[\w-]{1,32}$/.test(alias)) throw new Error("alias must be 1-32 word characters");
      const taken = [...this.sessions.values()].some((s) => s.id !== session.id && s.alias === alias);
      if (taken) throw new Error(`alias already used: ${alias}`);
      session.alias = alias;
    }
    if (input.archived !== undefined) {
      session.archivedAt = input.archived ? this.now() : undefined;
    }
    this.emit({
      eventType: "SessionUpdated",
      entityId: session.id,
      actorId: "user",
      payload: {
        displayName: session.displayName,
        alias: session.alias,
        archived: Boolean(session.archivedAt),
      },
    });
    return structuredClone(session);
  }

  /**
   * Point the session at another native identity / adapter. The binding epoch moves on, so
   * deliveries accepted under the old binding are held (`identity_changed`) until confirmed.
   */
  rebindSession(input: { sessionId: string; nativeIdentity?: string; adapterId?: string; workdir?: string }): Session {
    const session = this.requireSession(input.sessionId);
    const next = {
      nativeIdentity: input.nativeIdentity ?? session.nativeIdentity,
      adapterId: input.adapterId ?? session.adapterId,
      workdir: input.workdir ?? session.workdir,
    };
    if (next.nativeIdentity === session.nativeIdentity && next.adapterId === session.adapterId && next.workdir === session.workdir)
      return structuredClone(session);
    Object.assign(session, next);
    session.bindingEpoch = (session.bindingEpoch ?? 1) + 1;
    this.nativeCheckpoints.delete(session.id);
    this.emit({
      eventType: "SessionBindingChanged",
      entityId: session.id,
      actorId: "user",
      payload: { nativeIdentity: session.nativeIdentity, adapterId: session.adapterId ?? null, epoch: session.bindingEpoch },
    });
    for (const delivery of this.deliveries) {
      if (delivery.recipientSessionId === session.id && delivery.state === "queued")
        this.transition(delivery, { type: "hold", reason: "identity_changed" });
    }
    return structuredClone(session);
  }

  /** The user confirmed the current binding: deliveries held for an identity change go out under it. */
  async confirmBinding(sessionId: string): Promise<Delivery[]> {
    const session = this.requireSession(sessionId);
    for (const delivery of this.deliveries) {
      if (delivery.recipientSessionId !== sessionId || delivery.reason !== "identity_changed") continue;
      delivery.bindingEpoch = session.bindingEpoch ?? 1;
      this.dirtyDeliveries.add(delivery.id);
    }
    return this.reevaluate((d) => d.recipientSessionId === sessionId, ["identity_changed"]);
  }

  setSessionExecution(sessionId: string, execution: SessionRuntime["execution"], detail?: string) {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.execution === execution && runtime.detail === detail) return;
    runtime.execution = execution;
    runtime.detail = detail;
    this.emit({
      eventType: "SessionExecutionChanged",
      entityId: sessionId,
      payload: { execution, detail: detail ?? null },
    });
  }

  async setCommunicationEnabled(sessionId: string, enabled: boolean): Promise<Delivery[]> {
    const session = this.requireSession(sessionId);
    session.communicationEnabled = enabled;
    this.emit({
      eventType: "SessionCommunicationChanged",
      entityId: sessionId,
      actorId: "user",
      payload: { enabled },
    });
    if (!enabled) return [];
    return this.reevaluate((d) => d.recipientSessionId === sessionId, ["disabled"]);
  }

  /** Mark session ready/idle and dispatch its inbox in order. */
  async markSessionReady(sessionId: string, detail?: string): Promise<Delivery[]> {
    this.setSessionExecution(sessionId, "idle", detail);
    const own = await this.reevaluate((d) => d.recipientSessionId === sessionId, ["busy", "offline"]);
    await this.releaseSeats(sessionId);
    return own;
  }

  /** Host-reported execution change; leaving `running` frees an automatic activity seat. */
  async reportExecution(sessionId: string, execution: SessionRuntime["execution"], detail?: string): Promise<Delivery[]> {
    if (execution === "idle") return this.markSessionReady(sessionId, detail);
    this.setSessionExecution(sessionId, execution, detail);
    if (execution !== "running") await this.releaseSeats(sessionId);
    return [];
  }

  /** Withdraw a delivery that has not been submitted yet. */
  cancelDelivery(input: { deliveryId: string; actorId: string }): Delivery {
    const delivery = this.deliveryById.get(input.deliveryId);
    if (!delivery) throw new Error(`delivery not found: ${input.deliveryId}`);
    if (!this.transition(delivery, { type: "cancel", reason: "cancelled_by_user" }))
      throw new Error(`delivery is ${delivery.state}; only queued or held deliveries can be cancelled`);
    return structuredClone(delivery);
  }

  /**
   * Store records read from a session's native transcript. An input that carries a Portage message
   * id is the native proof of that submission (`native_confirmed`, and it settles an uncertain
   * delivery); outputs after it are that turn's reply, an inferred relation.
   */
  recordNativeRead(sessionId: string, adapterId: string, read: NativeReadResult): NativeEvent[] {
    this.requireSession(sessionId);
    const added: NativeEvent[] = [];
    const own = this.nativeBySession.get(sessionId) ?? [];
    let lastInput = findLast(own, (e) => e.kind === "input");
    for (const observation of read.observations) {
      const id = `${sessionId}:${observation.nativeEventId}`;
      if (this.nativeEventIds.has(id)) continue;
      const event: NativeEvent = {
        id,
        sessionId,
        adapterId,
        nativeEventId: observation.nativeEventId,
        nativeTime: observation.nativeTime,
        ingestedAt: this.now(),
        kind: observation.kind,
        text: observation.text.length > NATIVE_TEXT_LIMIT ? `${observation.text.slice(0, NATIVE_TEXT_LIMIT)}…` : observation.text,
        correlation: "unknown",
      };
      if (event.kind === "input") {
        const delivery = this.deliveryForNativeInput(sessionId, observation.text);
        if (delivery) {
          event.correlatedDeliveryId = delivery.id;
          event.correlatedMessageId = delivery.messageId;
          event.correlation = "exact";
          this.confirmNatively(delivery, event);
        }
        lastInput = event;
      } else if (event.kind === "turn_started") {
        // a new turn begins before its input is written: it is not the previous message's
        lastInput = undefined;
      } else if (lastInput?.correlatedMessageId) {
        event.correlatedDeliveryId = lastInput.correlatedDeliveryId;
        event.correlatedMessageId = lastInput.correlatedMessageId;
        event.correlation = "inferred";
      }
      this.nativeEventIds.add(id);
      this.nativeEvents.push(event);
      push(this.nativeBySession, sessionId, event);
      this.unsavedNative.push(event);
      added.push(event);
      const message = event.correlatedMessageId ? this.messageById.get(event.correlatedMessageId) : undefined;
      this.emit({
        eventType: "NativeEventObserved",
        entityId: event.id,
        actorId: this.participantForSession(sessionId).id,
        conversationId: message?.conversationId,
        traceId: message?.traceId,
        causalParentIds: message ? [message.id] : [],
        payload: { sessionId, kind: event.kind, correlation: event.correlation, deliveryId: event.correlatedDeliveryId ?? null },
      });
      // The turn answered in its own transcript without portage_send — still show it in Portage chat.
      if (event.kind === "output" && event.correlation === "inferred" && event.correlatedMessageId && event.text.trim()) {
        void this.ingestNativeReply(sessionId, event);
      }
    }
    if (this.nativeEvents.length > NATIVE_EVENTS_KEPT * 1.25) {
      this.nativeEvents = this.nativeEvents.slice(-NATIVE_EVENTS_KEPT);
      this.indexNative();
    }
    this.nativeCheckpoints.set(sessionId, {
      sessionId,
      source: read.source,
      cursor: read.cursor,
      lastSuccessAt: this.now(),
    });
    if (read.title) this.observeNativeTitle(sessionId, read.title);
    return added;
  }

  /**
   * The native title changed since Portage last saw or wrote it: the session was renamed in its own
   * app or CLI, so Portage follows. The first reading only records it, never overriding a name.
   */
  private observeNativeTitle(sessionId: string, title: string) {
    const session = this.requireSession(sessionId);
    const name = title.trim();
    if (!name || name === session.nativeTitle) return;
    const seenBefore = session.nativeTitle !== undefined;
    session.nativeTitle = name;
    if (!seenBefore || name === session.displayName) return;
    session.displayName = name;
    this.emit({
      eventType: "SessionUpdated",
      entityId: session.id,
      actorId: this.participantForSession(session.id).id,
      payload: { displayName: name, alias: session.alias, archived: Boolean(session.archivedAt), source: "native" },
    });
  }

  /** Portage wrote this title to the native session; reading it back is not a rename there. */
  markNativeTitle(sessionId: string, title: string) {
    this.requireSession(sessionId).nativeTitle = title;
  }

  /** Record that reading the native transcript failed; the cursor stays where it was. */
  recordNativeReadError(sessionId: string, source: string, error: string) {
    const previous = this.nativeCheckpoints.get(sessionId);
    this.nativeCheckpoints.set(sessionId, { sessionId, source, cursor: previous?.cursor ?? 0, lastSuccessAt: previous?.lastSuccessAt, error });
  }

  listNativeEvents(sessionId: string, limit = 200): NativeEvent[] {
    return (this.nativeBySession.get(sessionId) ?? []).slice(-limit);
  }

  private indexNative() {
    this.nativeEventIds = new Set(this.nativeEvents.map((e) => e.id));
    this.nativeBySession.clear();
    for (const event of this.nativeEvents) push(this.nativeBySession, event.sessionId, event);
  }

  /** The submitted (or unconfirmed) delivery to this session of a message the native input names. */
  private deliveryForNativeInput(sessionId: string, text: string): Delivery | undefined {
    for (const messageId of markedMessageIds(text).reverse()) {
      const delivery = findLast(
        this.deliveriesByMessage.get(messageId) ?? [],
        (d) => d.recipientSessionId === sessionId && ["submitted", "uncertain", "dispatching"].includes(d.state),
      );
      if (delivery) return delivery;
    }
    return undefined;
  }

  private confirmNatively(delivery: Delivery, event: NativeEvent) {
    if (this.hasReceipt(delivery.id, "native_confirmed")) return;
    this.addReceipt({
      deliveryId: delivery.id,
      proofLevel: "native_confirmed",
      adapterId: event.adapterId,
      bindingEpoch: delivery.bindingEpoch ?? 1,
      nativeMessageId: event.nativeEventId,
      observedAt: this.now(),
    });
    if (delivery.state === "uncertain") this.transition(delivery, { type: "confirm" });
  }

  /**
   * Resolve uncertain deliveries by reading back through the adapter: confirmed → submitted with
   * the native evidence; provably absent → queued again (safe retry); otherwise left uncertain.
   */
  async reconcileUncertain(): Promise<boolean> {
    if (!this.verifyHook) return false;
    let changed = false;
    for (const delivery of this.deliveries.filter((d) => d.state === "uncertain")) {
      const message = this.messageById.get(delivery.messageId);
      const session = this.sessions.get(delivery.recipientSessionId);
      if (!message || !session || !delivery.compiledContextHash) continue;
      let result: VerifyResult;
      try {
        result = await this.verifyHook({ session, message, delivery });
      } catch (error) {
        result = { status: "unknown", error: String(error) };
      }
      if (result.status === "present") {
        this.addReceipt({
          deliveryId: delivery.id,
          proofLevel: "submitted",
          adapterId: "readback",
          bindingEpoch: delivery.bindingEpoch ?? 1,
          nativeMessageId: result.nativeMessageId,
          observedAt: this.now(),
        });
        this.transition(delivery, { type: "confirm" });
        changed = true;
      } else if (result.status === "absent") {
        this.transition(delivery, { type: "retry" });
        await this.flushDeliveries([delivery.id]);
        changed = true;
      }
    }
    return changed;
  }

  /** Re-check deliveries waiting for a seat in every room this session belongs to. */
  private async releaseSeats(sessionId: string) {
    const rooms = new Set(this.activeRoomsForSession(sessionId).map((r) => r.id));
    if (!rooms.size) return;
    await this.reevaluate((d) => rooms.has(d.conversationId) && d.state === "queued" && d.reason === "seats", []);
  }

  /**
   * Time-driven recovery, called periodically by the daemon: rate-limited deliveries are released
   * once their room's one-minute window has room again. Returns whether anything changed.
   */
  async tick(): Promise<boolean> {
    let changed = await this.reconcileUncertain();
    for (const [conversationId, policy] of this.policies) {
      const waiting = this.deliveries.some(
        (d) => d.conversationId === conversationId && d.state === "held" && d.reason === "budget",
      );
      if (!waiting || this.agentMessagesInWindow(conversationId) > policy.agentMessagesPerMinute) continue;
      await this.reevaluate((d) => d.conversationId === conversationId && d.reason === "budget", ["budget"]);
      changed = true;
    }
    if (await this.recheckAdapterHolds()) changed = true;
    return changed;
  }

  /** Release deliveries held by the adapter (session attached elsewhere, host unavailable) once it is ready. */
  private async recheckAdapterHolds(): Promise<boolean> {
    if (!this.readinessHook) return false;
    const sessions = new Set(
      this.deliveries
        .filter((d) => d.state === "held" && d.reason && ADAPTER_HOLD_REASONS.includes(d.reason))
        .map((d) => d.recipientSessionId),
    );
    let changed = false;
    for (const sessionId of sessions) {
      const session = this.sessions.get(sessionId);
      if (!session || this.runtime.get(sessionId)?.execution === "offline") continue;
      if (!(await this.readinessHook(session)).ready) continue;
      await this.reevaluate((d) => d.recipientSessionId === sessionId, ADAPTER_HOLD_REASONS);
      changed = true;
    }
    return changed;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) => !s.archivedAt);
  }

  // ── rooms ─────────────────────────────────────────────────────────────

  createRoom(input: {
    id: string;
    title: string;
    createdBy: string;
    wakeMode?: WakeMode;
    coordinatorParticipantId?: string;
  }): Conversation {
    if (this.conversations.has(input.id)) throw new Error(`conversation exists: ${input.id}`);
    const title = input.title.trim();
    if (!title) throw new Error("title required");
    const conversation: Conversation = {
      id: input.id,
      workspaceId: this.workspaceId,
      kind: "room",
      title,
      createdBy: input.createdBy,
      policyDocumentId: input.id,
    };
    this.conversations.set(conversation.id, conversation);
    this.policyDocuments.set(`room:${input.id}`, {
      id: input.id,
      scope: "room",
      markdown:
        "# Working together\n\nKeep your own identity and the work you have in hand.\nWhen you need someone, @ them and say what you expect back. Attach your artifacts when you finish.",
      publishedRevision: 1,
      hash: "seed",
      updatedBy: input.createdBy,
      publishedAt: this.now(),
    });
    this.policies.set(conversation.id, defaultPolicy(conversation.id, {
      wakeMode: input.wakeMode ?? "swarm",
      coordinatorParticipantId: input.coordinatorParticipantId,
    }));
    this.roomState.set(conversation.id, { paused: false, rounds: 0, traceRounds: {}, policyRevision: "1" });
    this.emit({
      eventType: "RoomCreated",
      entityId: conversation.id,
      actorId: input.createdBy,
      conversationId: conversation.id,
      payload: { title, wakeMode: input.wakeMode ?? "swarm" },
    });
    return conversation;
  }

  /** Only the room's label changes; members, history, rules and deliveries stay as they are. */
  renameRoom(input: { conversationId: string; title: string; actorId?: string }): Conversation {
    const conversation = this.requireConversation(input.conversationId);
    if (conversation.kind !== "room") throw new Error("only rooms can be renamed");
    const title = input.title.trim();
    if (!title) throw new Error("title required");
    if (title.length > 50) throw new Error("title must be 50 characters or fewer");
    if (title === conversation.title) return structuredClone(conversation);
    const previous = conversation.title;
    conversation.title = title;
    this.emit({
      eventType: "RoomRenamed",
      entityId: conversation.id,
      actorId: input.actorId ?? "user",
      conversationId: conversation.id,
      payload: { title, previous },
    });
    return structuredClone(conversation);
  }

  /** One direct conversation per session; the user talks to the session without room policy. */
  ensureDirectConversation(sessionId: string): Conversation {
    const session = this.requireSession(sessionId);
    const participant = this.participantForSession(sessionId);
    const id = `dm_${sessionId}`;
    const existing = this.conversations.get(id);
    if (existing) return existing;
    const conversation: Conversation = {
      id,
      workspaceId: this.workspaceId,
      kind: "direct",
      title: session.displayName,
      createdBy: "user",
    };
    this.conversations.set(id, conversation);
    this.policies.set(id, defaultPolicy(id, { wakeMode: "manual" }));
    this.roomState.set(id, { paused: false, rounds: 0, traceRounds: {}, policyRevision: "1" });
    this.memberships.push({
      conversationId: id,
      participantId: participant.id,
      permissions: ["read", "write"],
      historyScope: "full",
      joinedAt: this.now(),
    });
    return conversation;
  }

  async setRoomPaused(conversationId: string, paused: boolean): Promise<Delivery[]> {
    const state = this.requireRoomState(conversationId);
    state.paused = paused;
    this.emit({
      eventType: "RoomPaused",
      entityId: conversationId,
      actorId: "user",
      conversationId,
      payload: { paused },
    });
    if (paused) return [];
    return this.reevaluate((d) => d.conversationId === conversationId, ["room_paused"]);
  }

  async updateRoomPolicy(
    input: { conversationId: string; actorId?: string } & Partial<Record<TunableBudget, number>>,
  ): Promise<RoomPolicy> {
    const policy = this.requirePolicy(input.conversationId);
    const changes = validateBudgets(input);
    Object.assign(policy, changes);
    this.bumpPolicyRevision(input.conversationId);
    this.emit({
      eventType: "RoomPolicyChanged",
      entityId: input.conversationId,
      actorId: input.actorId ?? "user",
      conversationId: input.conversationId,
      payload: Object.fromEntries(TUNABLE_BUDGETS.map((key) => [key, policy[key]])),
    });
    const releasable: HoldReason[] = ["round_budget", "wakeup_budget", "context_too_large"];
    if (this.agentMessagesInWindow(input.conversationId) <= policy.agentMessagesPerMinute)
      releasable.push("budget");
    await this.reevaluate(
      (d) =>
        d.conversationId === input.conversationId &&
        !(d.reason === "round_budget" && this.roundsForDelivery(d) > policy.maxAutoRounds) &&
        !(d.reason === "wakeup_budget" && this.wakeupRank(d) > (policy.maxWakeupsPerTrace ?? 20)),
      releasable,
    );
    return structuredClone(policy);
  }

  async listRooms(): Promise<Conversation[]> {
    return [...this.conversations.values()].filter((c) => c.kind === "room");
  }

  async getMemberships(conversationId: string): Promise<Membership[]> {
    return this.memberships.filter((m) => m.conversationId === conversationId);
  }

  async getRoomPolicy(conversationId: string): Promise<RoomPolicy> {
    return structuredClone(this.requirePolicy(conversationId));
  }

  async joinRoom(input: {
    conversationId: string;
    participantId: string;
  }): Promise<Membership> {
    this.requireConversation(input.conversationId);
    this.requireParticipant(input.participantId);
    const existing = this.memberships.find(
      (m) =>
        m.conversationId === input.conversationId && m.participantId === input.participantId,
    );
    if (existing && !existing.leftAt) return structuredClone(existing);
    let membership: Membership;
    if (existing?.leftAt) {
      existing.leftAt = undefined;
      existing.joinedAt = this.now();
      membership = existing;
    } else {
      membership = {
        conversationId: input.conversationId,
        participantId: input.participantId,
        permissions: ["read", "write"],
        historyScope: "full",
        joinedAt: this.now(),
      };
      this.memberships.push(membership);
    }
    this.emit({
      eventType: "MembershipChanged",
      entityId: input.participantId,
      actorId: "user",
      conversationId: input.conversationId,
      payload: { action: "joined" },
    });
    return structuredClone(membership);
  }

  async leaveRoom(input: {
    conversationId: string;
    participantId: string;
  }): Promise<Membership> {
    const membership = this.memberships.find(
      (m) =>
        m.conversationId === input.conversationId &&
        m.participantId === input.participantId &&
        !m.leftAt,
    );
    if (!membership) throw new Error("membership not found");
    membership.leftAt = this.now();
    this.emit({
      eventType: "MembershipChanged",
      entityId: input.participantId,
      actorId: "user",
      conversationId: input.conversationId,
      payload: { action: "left" },
    });

    const policy = this.requirePolicy(input.conversationId);
    if (
      policy.wakeMode === "coordinator" &&
      policy.coordinatorParticipantId === input.participantId
    ) {
      const active = this.activeMemberIds(input.conversationId);
      policy.coordinatorParticipantId = active[0];
      if (!policy.coordinatorParticipantId) policy.wakeMode = "swarm";
      this.bumpPolicyRevision(input.conversationId);
      this.emit({
        eventType: "RoomPolicyChanged",
        entityId: input.conversationId,
        conversationId: input.conversationId,
        payload: {
          wakeMode: policy.wakeMode,
          coordinatorParticipantId: policy.coordinatorParticipantId ?? null,
          reason: "coordinator_left",
        },
      });
    }

    const participant = this.requireParticipant(input.participantId);
    if (participant.sessionId) {
      for (const delivery of this.deliveries) {
        if (
          delivery.conversationId === input.conversationId &&
          delivery.recipientSessionId === participant.sessionId &&
          delivery.state === "queued"
        ) {
          this.transition(delivery, { type: "hold", reason: "left_room" });
        } else if (
          delivery.conversationId === input.conversationId &&
          delivery.recipientSessionId === participant.sessionId &&
          delivery.state === "held" &&
          delivery.reason !== "left_room"
        ) {
          delivery.reason = "left_room";
          this.emitDelivery(delivery);
        }
      }
    }

    return structuredClone(membership);
  }

  async setWakeMode(input: {
    conversationId: string;
    mode: RoomPolicy["wakeMode"];
    coordinatorParticipantId?: string;
    actorId?: string;
  }): Promise<RoomPolicy> {
    const policy = this.requirePolicy(input.conversationId);
    const previous = structuredClone(policy);
    policy.wakeMode = input.mode;
    if (input.mode === "coordinator") {
      const active = this.activeMemberIds(input.conversationId);
      const requested = input.coordinatorParticipantId ?? policy.coordinatorParticipantId;
      policy.coordinatorParticipantId =
        requested && active.includes(requested) ? requested : active[0];
    }
    const check = assertCoordinatorInvariant(policy, await this.getMemberships(input.conversationId));
    if (!check.ok) {
      Object.assign(policy, previous);
      throw new Error(check.error);
    }
    this.bumpPolicyRevision(input.conversationId);
    this.emit({
      eventType: "RoomPolicyChanged",
      entityId: input.conversationId,
      actorId: input.actorId ?? "user",
      conversationId: input.conversationId,
      payload: {
        wakeMode: policy.wakeMode,
        coordinatorParticipantId: policy.coordinatorParticipantId ?? null,
      },
    });
    return structuredClone(policy);
  }

  // ── artifacts ─────────────────────────────────────────────────────────

  createArtifact(input: {
    originalName: string;
    mime: string;
    byteSize: number;
    hash: string;
    storageKey: string;
    createdBy: string;
    conversationId?: string;
    sourceSessionId?: string;
  }): Artifact {
    const name = input.originalName.trim();
    if (!name) throw new Error("originalName required");
    const previous = [...this.artifacts.values()].filter(
      (a) => a.originalName === name && a.conversationId === input.conversationId,
    );
    const artifact: Artifact = {
      id: `art_${this.artifacts.size + 1}_${input.hash.slice(1, 9)}`,
      workspaceId: this.workspaceId,
      conversationId: input.conversationId,
      hash: input.hash,
      mime: input.mime || "application/octet-stream",
      byteSize: input.byteSize,
      originalName: name,
      sourceSessionId: input.sourceSessionId,
      version: previous.length + 1,
      storageKey: input.storageKey,
      createdBy: input.createdBy,
      createdAt: this.now(),
    };
    this.artifacts.set(artifact.id, artifact);
    this.emit({
      eventType: "ArtifactCreated",
      entityId: artifact.id,
      actorId: input.createdBy,
      conversationId: input.conversationId,
      payload: { name, version: artifact.version, byteSize: artifact.byteSize },
    });
    return structuredClone(artifact);
  }

  // ── messaging ─────────────────────────────────────────────────────────

  async send(input: {
    conversationId: string;
    senderId: string;
    target: Message["target"];
    text: string;
    artifactIds?: string[];
    mentionParticipantIds?: string[];
    idempotencyKey: string;
    traceId?: string;
    causalParentIds?: string[];
    source?: Message["source"];
    isManualWake?: boolean;
  }): Promise<{ message: Message; deliveries: Delivery[] }> {
    const cached = this.idempotency.get(input.idempotencyKey);
    if (cached) {
      const cachedText = cached.message.parts.find((p) => p.kind === "text");
      if (cachedText && "text" in cachedText && cachedText.text !== input.text) {
        throw new Error(`idempotency conflict: ${input.idempotencyKey} already used with different content`);
      }
      return structuredClone({
        message: cached.message,
        deliveries: this.deliveriesByMessage.get(cached.message.id) ?? [],
      });
    }

    const conversation = this.requireConversation(input.conversationId);
    const policy = this.requirePolicy(input.conversationId);
    const room = this.requireRoomState(input.conversationId);
    const senderIsUser = input.senderId === "user" || input.source === "user";
    if (!senderIsUser) {
      const sender = this.participants.get(input.senderId);
      if (sender?.sessionId && !this.sessions.get(sender.sessionId)?.communicationEnabled) {
        throw new Error("sender communication disabled");
      }
    }
    const rateLimited =
      !senderIsUser &&
      this.agentMessagesInWindow(input.conversationId) + 1 > policy.agentMessagesPerMinute;

    const extraParts: ContentPart[] = [];
    for (const artifactId of input.artifactIds ?? []) {
      const artifact = this.artifacts.get(artifactId);
      if (!artifact) throw new Error(`artifact not found: ${artifactId}`);
      extraParts.push({ kind: "artifact_ref", artifactId, version: artifact.version });
    }

    const activeMemberParticipantIds = this.activeMemberIds(input.conversationId);
    const participantSessionId: Record<string, string> = {};
    const sessionGate: Parameters<typeof acceptMessage>[0]["sessionGate"] = {};

    for (const participantId of activeMemberParticipantIds) {
      const participant = this.requireParticipant(participantId);
      if (!participant.sessionId) continue;
      participantSessionId[participantId] = participant.sessionId;
      const session = this.requireSession(participant.sessionId);
      const runtime = this.requireRuntime(participant.sessionId);
      sessionGate[participant.sessionId] = {
        communicationEnabled: session.communicationEnabled,
        writable: runtime.writable,
        roomPaused: room.paused,
        leftRoom: false,
        execution: runtime.execution,
        rateLimited,
      };
    }

    // Mentioned members who already left still resolve, so the Delivery is held with a reason.
    for (const mentionId of input.mentionParticipantIds ?? []) {
      const participant = this.participants.get(mentionId);
      if (participant?.sessionId && !participantSessionId[mentionId]) {
        participantSessionId[mentionId] = participant.sessionId;
        const session = this.sessions.get(participant.sessionId);
        const runtime = this.runtime.get(participant.sessionId);
        if (session && runtime) {
          sessionGate[participant.sessionId] = {
            communicationEnabled: session.communicationEnabled,
            writable: runtime.writable,
            roomPaused: room.paused,
            leftRoom: true,
            execution: runtime.execution,
            rateLimited,
          };
        }
      }
    }

    const seq = (this.seqByConversation.get(input.conversationId) ?? 0) + 1;
    this.seqByConversation.set(input.conversationId, seq);
    const traceId = input.traceId ?? `trace_${input.idempotencyKey}`;

    const result = acceptMessage({
      workspaceId: conversation.workspaceId,
      conversationId: input.conversationId,
      policy,
      policyRevision: room.policyRevision,
      activeMemberParticipantIds,
      participantSessionId,
      senderId: input.senderId,
      senderIsUser,
      isManualWake: input.isManualWake,
      target: input.target,
      text: input.text,
      extraParts,
      mentionParticipantIds: input.mentionParticipantIds,
      idempotencyKey: input.idempotencyKey,
      traceId,
      causalParentIds: input.causalParentIds,
      source: input.source,
      seq,
      currentRounds: room.traceRounds[traceId] ?? 0,
      sessionGate,
    });

    this.recordTraceRounds(room, traceId, result.rounds);
    result.message.createdAt = this.now();
    if (!senderIsUser && !input.isManualWake) {
      const spent = this.agentWakeupsOnTrace(input.conversationId, traceId);
      const cap = policy.maxWakeupsPerTrace ?? 20;
      result.deliveries.forEach((delivery, index) => {
        if (spent + index + 1 <= cap || delivery.state !== "queued") return;
        const held = applyDeliveryTransition(delivery, { type: "hold", reason: "wakeup_budget" });
        if (held.ok) Object.assign(delivery, held.delivery);
      });
    }
    for (const delivery of result.deliveries) {
      if (delivery.reason === "budget") delivery.nextAttemptAt = this.rateWindowReopensAt(input.conversationId);
      delivery.bindingEpoch = this.sessions.get(delivery.recipientSessionId)?.bindingEpoch ?? 1;
    }
    this.messages.push(result.message);
    this.indexMessage(result.message);
    this.deliveries.push(...result.deliveries);
    this.dirtyMessages.add(result.message.id);
    for (const delivery of result.deliveries) {
      this.indexDelivery(delivery);
      this.dirtyDeliveries.add(delivery.id);
    }
    this.idempotency.set(input.idempotencyKey, {
      message: result.message,
      deliveries: result.deliveries,
    });
    for (const part of extraParts) {
      if (part.kind !== "artifact_ref") continue;
      const artifact = this.artifacts.get(part.artifactId);
      if (artifact) {
        artifact.sourceMessageId ??= result.message.id;
        artifact.conversationId ??= input.conversationId;
      }
    }

    this.emit({
      eventType: "MessageAccepted",
      entityId: result.message.id,
      actorId: input.senderId,
      conversationId: input.conversationId,
      traceId: result.message.traceId,
      causalParentIds: result.message.causalParentIds,
      payload: {
        targetKind: input.target.kind,
        targetId: input.target.id,
        recipients: result.deliveries.length,
        rounds: result.rounds,
        roundBudgetExceeded: result.roundBudgetExceeded,
      },
    });
    if (!result.deliveries.length) {
      this.emit({
        eventType: "WakeSuppressed",
        entityId: result.message.id,
        actorId: input.senderId,
        conversationId: input.conversationId,
        traceId: result.message.traceId,
        payload: { wakeMode: policy.wakeMode },
      });
    }
    for (const delivery of result.deliveries) this.emitDelivery(delivery);
    if (!senderIsUser) this.acknowledgeByReply(input.senderId, result.message.causalParentIds);

    await this.flushDeliveries(result.deliveries.map((d) => d.id));

    return structuredClone({
      message: result.message,
      deliveries: this.deliveriesByMessage.get(result.message.id) ?? [],
    });
  }

  /**
   * A native assistant output that follows a Portage-delivered input becomes a Portage message, so
   * the chat updates even when the model replies in-transcript instead of calling portage_send.
   */
  private async ingestNativeReply(sessionId: string, event: NativeEvent) {
    const parentId = event.correlatedMessageId;
    if (!parentId || !event.text.trim()) return;
    const parent = this.messageById.get(parentId);
    const participant = this.participantForSession(sessionId);
    if (!parent) return;
    const already = [...this.messages.values()].some(
      (m) => m.senderId === participant.id && m.causalParentIds.includes(parentId),
    );
    if (already) return;
    const direct = parent.conversationId === `dm_${sessionId}`;
    try {
      await this.send({
        conversationId: parent.conversationId,
        senderId: participant.id,
        target: direct ? { kind: "participant", id: "user" } : { kind: "room", id: parent.conversationId },
        text: event.text.trim(),
        traceId: parent.traceId,
        causalParentIds: [parentId],
        source: "agent",
        idempotencyKey: `native_reply_${sessionId}_${event.nativeEventId}`,
      });
    } catch {
      // Room membership / communication gates can refuse; the NativeEvent is still kept for the record tab.
    }
  }

  /** Answering a message is verifiable proof its recipient read it. */
  private acknowledgeByReply(senderId: string, parentIds: string[]) {
    const sessionId = this.participants.get(senderId)?.sessionId;
    if (!sessionId) return;
    for (const parentId of parentIds) {
      const delivery = (this.deliveriesByMessage.get(parentId) ?? []).find(
        (d) => d.recipientSessionId === sessionId && d.state === "submitted",
      );
      if (delivery) this.acknowledgeDelivery({ deliveryId: delivery.id, sessionId, via: "reply" });
    }
  }

  /** Revise a user message: keeps id, bumps revision; pending deliveries pick up the new version. */
  async reviseMessage(input: { messageId: string; text: string; actorId: string }): Promise<Message> {
    const message = this.messageById.get(input.messageId);
    if (!message) throw new Error(`message not found: ${input.messageId}`);
    if (message.senderId !== input.actorId) throw new Error("only the sender can revise");
    const text = input.text.trim();
    if (!text) throw new Error("text required");
    message.parts = [{ kind: "text", text }, ...message.parts.filter((p) => p.kind !== "text")];
    message.revision += 1;
    this.dirtyMessages.add(message.id);
    const pending = (this.deliveriesByMessage.get(message.id) ?? []).filter(
      (d) => d.state === "queued" || d.state === "held",
    );
    for (const delivery of pending) {
      delivery.messageRevision = message.revision;
      this.dirtyDeliveries.add(delivery.id);
    }
    this.emit({
      eventType: "MessageRevised",
      entityId: message.id,
      actorId: input.actorId,
      conversationId: message.conversationId,
      traceId: message.traceId,
      payload: { revision: message.revision },
    });
    // A shorter revision may fit the context budget now.
    await this.reevaluate((d) => d.messageId === message.id, ["context_too_large"]);
    return structuredClone(message);
  }

  /** Compile the query a recipient would receive, without accepting a message. */
  previewContext(input: {
    conversationId: string;
    text: string;
    senderId?: string;
    recipientSessionId?: string;
    artifactIds?: string[];
  }): { recipientSessionId?: string; snapshot: ContextSnapshot } {
    const conversation = this.requireConversation(input.conversationId);
    const policy = this.requirePolicy(input.conversationId);
    let recipientSessionId = input.recipientSessionId;
    if (!recipientSessionId) {
      const lead =
        policy.wakeMode === "coordinator" ? policy.coordinatorParticipantId : undefined;
      const fallback = this.activeMemberIds(input.conversationId)[0];
      recipientSessionId = this.participants.get(lead ?? fallback ?? "")?.sessionId;
    }
    const draft: Message = {
      id: "msg_preview",
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      seq: (this.seqByConversation.get(conversation.id) ?? 0) + 1,
      senderId: input.senderId ?? "user",
      target: { kind: "room", id: conversation.id },
      mentions: [],
      parts: [
        { kind: "text", text: input.text },
        ...(input.artifactIds ?? [])
          .map((id) => this.artifacts.get(id))
          .filter((a): a is Artifact => Boolean(a))
          .map((a) => ({ kind: "artifact_ref" as const, artifactId: a.id, version: a.version })),
      ],
      causalParentIds: [],
      traceId: "trace_preview",
      source: input.senderId && input.senderId !== "user" ? "agent" : "user",
      idempotencyKey: "preview",
      acceptedPolicyRevision: this.requireRoomState(conversation.id).policyRevision,
      revision: 1,
      createdAt: this.now(),
    };
    return {
      recipientSessionId,
      snapshot: this.compileFor(conversation.id, recipientSessionId, draft),
    };
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return [...(this.messagesByConversation.get(conversationId) ?? [])];
  }

  /** Up to `limit` messages of a conversation before `beforeSeq` (oldest first), and whether older ones exist. */
  messagePage(conversationId: string, limit: number, beforeSeq = Number.POSITIVE_INFINITY): { messages: Message[]; hasMore: boolean } {
    const all = this.messagesByConversation.get(conversationId) ?? [];
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]!.seq < beforeSeq) lo = mid + 1;
      else hi = mid;
    }
    const start = Math.max(0, lo - limit);
    return { messages: all.slice(start, lo), hasMore: start > 0 };
  }

  deliveriesForMessage(messageId: string): Delivery[] {
    return this.deliveriesByMessage.get(messageId) ?? [];
  }

  receiptsForDelivery(deliveryId: string): DeliveryReceipt[] {
    return this.receiptsByDelivery.get(deliveryId) ?? [];
  }

  async listInbox(sessionId: string): Promise<Delivery[]> {
    return this.deliveries.filter(
      (d) =>
        d.recipientSessionId === sessionId &&
        (d.state === "queued" || d.state === "held" || d.state === "dispatching"),
    );
  }

  async getReceipts(deliveryId: string): Promise<DeliveryReceipt[]> {
    return [...(this.receiptsByDelivery.get(deliveryId) ?? [])];
  }

  private hasReceipt(deliveryId: string, proofLevel: ProofLevel) {
    return (this.receiptsByDelivery.get(deliveryId) ?? []).some((r) => r.proofLevel === proofLevel);
  }

  private addReceipt(receipt: DeliveryReceipt) {
    this.receipts.push(receipt);
    push(this.receiptsByDelivery, receipt.deliveryId, receipt);
  }

  /**
   * Submitted deliveries the session's agent has not read yet, oldest first.
   * `submitted` only proves the text reached the native inbox; `agent_ack` proves the agent read it.
   */
  unreadDeliveries(sessionId: string): Array<{ delivery: Delivery; message: Message; snapshot?: ContextSnapshot }> {
    return this.deliveries
      .filter((d) => d.recipientSessionId === sessionId && d.state === "submitted" && !this.hasReceipt(d.id, "agent_ack"))
      .map((delivery) => ({
        delivery,
        message: this.messageById.get(delivery.messageId)!,
        snapshot: this.contextSnapshots.get(delivery.id),
      }))
      .filter((item) => item.message)
      .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.message.seq - b.message.seq);
  }

  /** Record that the agent behind `sessionId` read a delivery (`via` how we know). Idempotent per delivery. */
  acknowledgeDelivery(input: { deliveryId: string; sessionId: string; via?: "mcp" | "reply" }): DeliveryReceipt {
    const delivery = this.deliveryById.get(input.deliveryId);
    if (!delivery) throw new Error(`delivery not found: ${input.deliveryId}`);
    if (delivery.recipientSessionId !== input.sessionId) throw new Error("delivery belongs to another session");
    if (delivery.state !== "submitted") throw new Error(`delivery is ${delivery.state}, not submitted`);
    const existing = this.receiptsByDelivery.get(delivery.id)?.find((r) => r.proofLevel === "agent_ack");
    if (existing) return structuredClone(existing);
    const receipt: DeliveryReceipt = {
      deliveryId: delivery.id,
      proofLevel: "agent_ack",
      adapterId: input.via ?? "mcp",
      bindingEpoch: delivery.bindingEpoch ?? 1,
      observedAt: this.now(),
    };
    this.addReceipt(receipt);
    const message = this.messageById.get(delivery.messageId);
    this.emit({
      eventType: "DeliveryAcknowledged",
      entityId: delivery.id,
      actorId: this.participantForSession(input.sessionId).id,
      conversationId: delivery.conversationId,
      traceId: message?.traceId,
      causalParentIds: message ? [message.id] : [],
      payload: {
        messageId: delivery.messageId,
        recipientSessionId: delivery.recipientSessionId,
        proofLevel: "agent_ack",
      },
    });
    return structuredClone(receipt);
  }

  /** Rooms the session is currently an active member of. */
  activeRoomsForSession(sessionId: string): Conversation[] {
    const participant = this.participantForSession(sessionId);
    return this.memberships
      .filter((m) => m.participantId === participant.id && !m.leftAt)
      .map((m) => this.conversations.get(m.conversationId))
      .filter((c): c is Conversation => Boolean(c && c.kind === "room"));
  }

  // ── scheduling ────────────────────────────────────────────────────────

  /**
   * Release held deliveries whose reason is in `releasable`, then flush matching queued
   * deliveries in acceptance order. flushDeliveries re-checks every gate, so a still-blocked
   * delivery simply returns to held with its current reason.
   */
  private async reevaluate(
    match: (delivery: Delivery) => boolean,
    releasable: HoldReason[],
  ): Promise<Delivery[]> {
    const pending = this.deliveries.filter(
      (d) => match(d) && (d.state === "queued" || d.state === "held"),
    );
    for (const delivery of pending) {
      if (delivery.state === "held" && delivery.reason && releasable.includes(delivery.reason)) {
        this.transition(delivery, { type: "release" });
      }
    }
    await this.flushDeliveries(pending.map((d) => d.id));
    return pending.map((d) => structuredClone(this.deliveryById.get(d.id)!));
  }

  private async flushDeliveries(deliveryIds: string[]) {
    const dispatches: Promise<void>[] = [];
    for (const id of deliveryIds) {
      const delivery = this.deliveryById.get(id);
      if (!delivery || delivery.state !== "queued") continue;
      const message = this.messageById.get(delivery.messageId);
      if (!message) continue;

      const session = this.requireSession(delivery.recipientSessionId);
      const runtime = this.requireRuntime(delivery.recipientSessionId);
      const room = this.requireRoomState(delivery.conversationId);
      const membershipLeft = this.isSessionLeftRoom(
        delivery.conversationId,
        delivery.recipientSessionId,
      );

      if ((delivery.bindingEpoch ?? 1) !== (session.bindingEpoch ?? 1)) {
        this.transition(delivery, { type: "hold", reason: "identity_changed" });
        continue;
      }

      const decision = shouldHoldForConditions({
        communicationEnabled: session.communicationEnabled,
        writable: runtime.writable,
        roomPaused: room.paused,
        leftRoom: membershipLeft,
        execution: runtime.execution,
        roundBudgetExceeded: delivery.reason === "round_budget",
        rateLimited: delivery.reason === "budget",
      });

      if (decision.action === "hold" && decision.reason) {
        this.transition(delivery, { type: "hold", reason: decision.reason });
        continue;
      }
      const seatsFull =
        message.source !== "user" &&
        this.conversations.get(delivery.conversationId)?.kind === "room" &&
        this.runningSeats(delivery.conversationId, delivery.recipientSessionId) >=
          this.requirePolicy(delivery.conversationId).maxConcurrent;
      if (this.inputLocks.has(session.id) && decision.action === "dispatch" && !seatsFull) {
        push(this.lockWaiters, session.id, delivery.id);
        continue;
      }
      const queueReason = decision.action === "queue" ? decision.reason : seatsFull ? "seats" : undefined;
      if (queueReason) {
        this.markQueued(delivery, queueReason);
        continue;
      }

      const snapshot = this.compileFor(delivery.conversationId, delivery.recipientSessionId, message);
      if (snapshot.overflow) {
        this.transition(delivery, { type: "hold", reason: "context_too_large" });
        continue;
      }

      // Taken before the first await, so later deliveries to this session wait their turn (in order)
      // while deliveries to other sessions dispatch concurrently.
      this.inputLocks.add(session.id);
      dispatches.push(this.dispatch(delivery, session, message, snapshot));
    }
    await Promise.all(dispatches);
  }

  /** Readiness, lease and inject for one delivery whose session input lock the caller holds. */
  private async dispatch(delivery: Delivery, session: Session, message: Message, snapshot: ContextSnapshot) {
    try {
      if (this.readinessHook) {
        const readiness = await this.readinessHook(session);
        if (delivery.state !== "queued") return;
        if (!readiness.ready) {
          if (readiness.reason === "busy") this.markQueued(delivery, "busy");
          else this.transition(delivery, { type: "hold", reason: readiness.reason, detail: readiness.detail });
          return;
        }
      }
      if (!this.transition(delivery, { type: "lease" })) return;
      delivery.messageRevision = message.revision;
      delivery.compiledContextHash = snapshot.hash;
      this.contextSnapshots.set(delivery.id, snapshot);

      if (!this.injectHook) {
        this.recordSubmitted(delivery, { adapterId: "memory", proof: "submitted" });
        return;
      }

      let result: Awaited<ReturnType<InjectHook>>;
      try {
        result = await this.injectHook({ session, message, delivery, compiledQuery: snapshot.query, snapshot });
      } catch (error) {
        // The adapter failed mid-submit; the text may or may not have reached the native side.
        result = { ok: false, uncertain: true, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        if (result.running) this.setSessionExecution(session.id, "running");
        this.recordSubmitted(delivery, {
          adapterId: result.adapterId ?? "hook",
          proof: result.proof ?? "submitted",
          nativeMessageId: result.nativeMessageId,
        });
      } else if (result.uncertain) {
        this.transition(delivery, { type: "uncertain" });
      } else if (result.retryable) {
        this.transition(delivery, { type: "retry" });
      } else {
        this.transition(delivery, { type: "fail", reason: result.error });
      }
    } finally {
      this.inputLocks.delete(session.id);
      const waiting = this.lockWaiters.get(session.id);
      if (waiting) {
        this.lockWaiters.delete(session.id);
        await this.flushDeliveries(waiting);
      }
    }
  }

  /** Keep a delivery queued (in order) and say why, emitting only when the reason changes. */
  private markQueued(delivery: Delivery, reason: HoldReason) {
    if (delivery.reason === reason) return;
    delivery.reason = reason;
    this.emitDelivery(delivery);
  }

  private recordSubmitted(
    delivery: Delivery,
    proof: { adapterId: string; proof: ProofLevel; nativeMessageId?: string },
  ) {
    this.addReceipt({
      deliveryId: delivery.id,
      proofLevel: proof.proof,
      adapterId: proof.adapterId,
      bindingEpoch: delivery.bindingEpoch ?? 1,
      nativeMessageId: proof.nativeMessageId,
      observedAt: this.now(),
    });
    this.transition(delivery, { type: "submitted" });
  }

  private compileFor(conversationId: string, recipientSessionId: string | undefined, message: Message) {
    const conversation = this.requireConversation(conversationId);
    const policy = this.requirePolicy(conversationId);
    const recipient = recipientSessionId ? this.sessions.get(recipientSessionId) : undefined;
    const recipientParticipant = recipientSessionId
      ? [...this.participants.values()].find((p) => p.sessionId === recipientSessionId)
      : undefined;
    const isRoom = conversation.kind === "room";
    const isCoordinator =
      isRoom &&
      policy.wakeMode === "coordinator" &&
      policy.coordinatorParticipantId === recipientParticipant?.id;
    const roomDoc =
      isRoom && conversation.policyDocumentId
        ? this.getPolicyDocument("room", conversation.policyDocumentId)
        : undefined;
    const artifacts = message.parts
      .filter((p): p is Extract<ContentPart, { kind: "artifact_ref" }> => p.kind === "artifact_ref")
      .map((p) => this.artifacts.get(p.artifactId))
      .filter((a): a is Artifact => Boolean(a));
    return compileContext({
      global: this.getPolicyDocument("global", "PORTAGE"),
      workspace: this.getPolicyDocument("workspace", this.workspaceId),
      room: roomDoc,
      policy: isRoom ? policy : null,
      message,
      artifacts,
      recipientLabel: recipient
        ? `${recipient.displayName} · ${recipient.provider}/${recipient.host}${isCoordinator ? " · current lead (routing)" : ""}`
        : "room member",
      sourceLabel: `${this.senderLabel(message.senderId)} → ${isRoom ? conversation.title : "direct message"} · scope=${conversation.id}`,
      replyThroughPortage: isRoom,
      maxContextBytes: policy.maxContextBytes,
    });
  }

  private transition(delivery: Delivery, transition: DeliveryTransition): boolean {
    const next = applyDeliveryTransition(delivery, transition);
    if (!next.ok) return false;
    const changed =
      next.delivery.state !== delivery.state || next.delivery.reason !== delivery.reason || next.delivery.detail !== delivery.detail;
    delete delivery.detail;
    Object.assign(delivery, next.delivery);
    if (changed) this.emitDelivery(delivery);
    return true;
  }

  private emitDelivery(delivery: Delivery) {
    this.dirtyDeliveries.add(delivery.id);
    const eventType = DELIVERY_EVENT[delivery.state];
    if (!eventType) return;
    const message = this.messageById.get(delivery.messageId);
    this.emit({
      eventType,
      entityId: delivery.id,
      actorId: message?.senderId,
      conversationId: delivery.conversationId,
      traceId: message?.traceId,
      causalParentIds: message ? [message.id] : [],
      payload: {
        messageId: delivery.messageId,
        recipientSessionId: delivery.recipientSessionId,
        state: delivery.state,
        reason: delivery.reason ?? null,
        detail: delivery.detail ?? null,
        compiledContextHash: delivery.compiledContextHash ?? null,
      },
    });
  }

  private recordTraceRounds(room: RoomState, traceId: string, rounds: number) {
    delete room.traceRounds[traceId];
    room.traceRounds[traceId] = rounds;
    const traces = Object.keys(room.traceRounds);
    for (const stale of traces.slice(0, Math.max(0, traces.length - TRACE_ROUNDS_KEPT))) {
      delete room.traceRounds[stale];
    }
    room.activeTraceId = traceId;
    room.rounds = rounds;
  }

  /** Deliveries caused by agent messages on one trace, in acceptance order. */
  private agentWakeupsFor(conversationId: string, traceId: string): Delivery[] {
    return (this.messagesByTrace.get(traceId) ?? [])
      .filter((m) => m.conversationId === conversationId && m.source !== "user")
      .flatMap((m) => this.deliveriesByMessage.get(m.id) ?? []);
  }

  private agentWakeupsOnTrace(conversationId: string, traceId: string): number {
    return this.agentWakeupsFor(conversationId, traceId).length;
  }

  /** Agent message times in the conversation's current rate window, newest first. */
  private agentMessageTimesInWindow(conversationId: string): number[] {
    const since = Date.parse(this.now()) - RATE_WINDOW_MS;
    const list = this.messagesByConversation.get(conversationId) ?? [];
    const times: number[] = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const at = Date.parse(list[i]!.createdAt);
      if (at < since) break;
      if (list[i]!.source !== "user") times.push(at);
    }
    return times;
  }

  /** When the oldest agent message in the current rate window ages out. */
  private rateWindowReopensAt(conversationId: string): string {
    const times = this.agentMessageTimesInWindow(conversationId);
    const oldest = times.length ? Math.min(...times) : Date.parse(this.now());
    return new Date(oldest + RATE_WINDOW_MS).toISOString();
  }

  /** Room members (other than `exceptSessionId`) whose host reports an active turn. */
  private runningSeats(conversationId: string, exceptSessionId: string): number {
    return this.activeMemberIds(conversationId)
      .map((id) => this.participants.get(id)?.sessionId)
      .filter((id): id is string => Boolean(id) && id !== exceptSessionId)
      .filter((id) => this.runtime.get(id)?.execution === "running" || this.inputLocks.has(id)).length;
  }

  /** Active member matching a participant id, session id or alias. */
  private resolveMember(conversationId: string, ref: string): string | undefined {
    const needle = ref.replace(/^@/, "");
    return this.activeMemberIds(conversationId).find((id) => {
      const sessionId = this.participants.get(id)?.sessionId;
      return id === needle || sessionId === needle || (sessionId && this.sessions.get(sessionId)?.alias === needle);
    });
  }

  /** 1-based position of this delivery among agent-caused wakeups on its trace. */
  private wakeupRank(delivery: Delivery): number {
    const traceId = this.messageById.get(delivery.messageId)?.traceId;
    if (!traceId) return 0;
    return this.agentWakeupsFor(delivery.conversationId, traceId).findIndex((d) => d.id === delivery.id) + 1;
  }

  private roundsForDelivery(delivery: Delivery): number {
    const traceId = this.messageById.get(delivery.messageId)?.traceId;
    const room = this.roomState.get(delivery.conversationId);
    return (traceId && room?.traceRounds[traceId]) || 0;
  }

  private agentMessagesInWindow(conversationId: string): number {
    return this.agentMessageTimesInWindow(conversationId).length;
  }

  private senderLabel(senderId: string) {
    if (senderId === "user") return "user";
    const sessionId = this.participants.get(senderId)?.sessionId;
    return (sessionId && this.sessions.get(sessionId)?.displayName) || senderId;
  }

  private activeMemberIds(conversationId: string): string[] {
    return this.memberships
      .filter((m) => m.conversationId === conversationId && !m.leftAt)
      .map((m) => m.participantId);
  }

  private isSessionLeftRoom(conversationId: string, sessionId: string): boolean {
    const participant = [...this.participants.values()].find((p) => p.sessionId === sessionId);
    if (!participant) return true;
    const membership = this.memberships.find(
      (m) => m.conversationId === conversationId && m.participantId === participant.id,
    );
    return !membership || Boolean(membership.leftAt);
  }

  private bumpPolicyRevision(conversationId: string) {
    const room = this.requireRoomState(conversationId);
    room.policyRevision = String(Number(room.policyRevision) + 1);
  }

  private participantForSession(sessionId: string): Participant {
    const participant = [...this.participants.values()].find((p) => p.sessionId === sessionId);
    if (!participant) throw new Error(`participant not found for session: ${sessionId}`);
    return participant;
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  private requireParticipant(id: string): Participant {
    const participant = this.participants.get(id);
    if (!participant) throw new Error(`participant not found: ${id}`);
    return participant;
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error(`conversation not found: ${id}`);
    return conversation;
  }

  private requirePolicy(id: string): RoomPolicy {
    const policy = this.policies.get(id);
    if (!policy) throw new Error(`policy not found: ${id}`);
    return policy;
  }

  private requireRoomState(id: string): RoomState {
    const state = this.roomState.get(id);
    if (!state) throw new Error(`room state not found: ${id}`);
    return state;
  }

  private requireRuntime(sessionId: string): SessionRuntime {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) throw new Error(`runtime not found: ${sessionId}`);
    return runtime;
  }
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (match(items[i]!)) return items[i];
  return undefined;
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function defaultPolicy(
  conversationId: string,
  input: { wakeMode: WakeMode; coordinatorParticipantId?: string },
): RoomPolicy {
  return {
    conversationId,
    wakeMode: input.wakeMode,
    coordinatorParticipantId: input.coordinatorParticipantId,
    batchWindowMs: 750,
    maxConcurrent: 2,
    agentMessagesPerMinute: 12,
    maxAutoRounds: 4,
    maxWakeupsPerTrace: 20,
    maxContextBytes: 32768,
  };
}
