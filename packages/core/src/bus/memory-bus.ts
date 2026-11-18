import { compileContext, fnv1a, type ContextSnapshot } from "../context.js";
import { applyDeliveryTransition, shouldHoldForConditions, type DeliveryTransition } from "../delivery.js";
import { acceptMessage } from "../messaging.js";
import type { PortageBusApi } from "../api.js";
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
};

export type InjectHook = (input: {
  session: Session;
  message: Message;
  delivery: Delivery;
  compiledQuery: string;
  snapshot: ContextSnapshot;
}) => Promise<
  | { ok: true; nativeMessageId?: string; adapterId?: string; proof?: ProofLevel }
  | { ok: false; retryable?: boolean; uncertain?: boolean; error: string }
>;

export type MemoryBusOptions = {
  workspaceId?: string;
  inject?: InjectHook;
  now?: () => string;
};

type RoomState = {
  paused: boolean;
  rounds: number;
  policyRevision: string;
};

type EventInput = {
  eventType: BusEventType;
  entityId: string;
  actorId?: string;
  conversationId?: string;
  traceId?: string;
  causalParentIds?: string[];
  payload?: BusEvent["payload"];
};

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
  events: BusEvent[] = [];
  private eventSeq = 0;
  private listeners = new Set<(event: BusEvent) => void>();
  private idempotency = new Map<string, { message: Message; deliveries: Delivery[] }>();
  private seqByConversation = new Map<string, number>();

  constructor(options: MemoryBusOptions = {}) {
    this.workspaceId = options.workspaceId ?? "ws_local";
    this.now = options.now ?? (() => new Date().toISOString());
    this.injectHook = options.inject;
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
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener failures must not break bus transitions
      }
    }
  }

  /** Rebuild derived indexes after hydrating maps from persistent storage. */
  restoreIndexes() {
    this.seqByConversation.clear();
    for (const message of this.messages) {
      const current = this.seqByConversation.get(message.conversationId) ?? 0;
      if (message.seq > current) this.seqByConversation.set(message.conversationId, message.seq);
    }
    this.idempotency.clear();
    for (const message of this.messages) {
      this.idempotency.set(message.idempotencyKey, {
        message,
        deliveries: this.deliveries.filter((d) => d.messageId === message.id),
      });
    }
    this.eventSeq = this.events.reduce((max, e) => Math.max(max, e.seq), 0);
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

  /** Publish a new revision of a policy document; revision and hash are owned by the bus. */
  publishPolicy(input: {
    scope: PolicyDocument["scope"];
    id: string;
    markdown: string;
    updatedBy: string;
  }): PolicyDocument {
    const markdown = input.markdown.trim();
    if (!markdown) throw new Error("markdown required");
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

  setInjectHook(hook: InjectHook | undefined) {
    this.injectHook = hook;
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

  setSessionExecution(sessionId: string, execution: SessionRuntime["execution"]) {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.execution === execution) return;
    runtime.execution = execution;
    this.emit({
      eventType: "SessionExecutionChanged",
      entityId: sessionId,
      payload: { execution },
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
  async markSessionReady(sessionId: string): Promise<Delivery[]> {
    this.setSessionExecution(sessionId, "idle");
    return this.reevaluate((d) => d.recipientSessionId === sessionId, ["busy", "offline"]);
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
        "# 通信约定\n\n约束与指导，不改写各 session 原有身份。\n需要他人处理时明确 @ 对方；完成后附产物引用。",
      publishedRevision: 1,
      hash: "seed",
      updatedBy: input.createdBy,
      publishedAt: this.now(),
    });
    this.policies.set(conversation.id, defaultPolicy(conversation.id, {
      wakeMode: input.wakeMode ?? "swarm",
      coordinatorParticipantId: input.coordinatorParticipantId,
    }));
    this.roomState.set(conversation.id, { paused: false, rounds: 0, policyRevision: "1" });
    this.emit({
      eventType: "RoomCreated",
      entityId: conversation.id,
      actorId: input.createdBy,
      conversationId: conversation.id,
      payload: { title, wakeMode: input.wakeMode ?? "swarm" },
    });
    return conversation;
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
    this.roomState.set(id, { paused: false, rounds: 0, policyRevision: "1" });
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

  async updateRoomPolicy(input: {
    conversationId: string;
    maxAutoRounds?: number;
    agentMessagesPerMinute?: number;
  }): Promise<RoomPolicy> {
    const policy = this.requirePolicy(input.conversationId);
    if (input.maxAutoRounds !== undefined) {
      if (!Number.isInteger(input.maxAutoRounds) || input.maxAutoRounds < 1 || input.maxAutoRounds > 100)
        throw new Error("maxAutoRounds must be an integer 1-100");
      policy.maxAutoRounds = input.maxAutoRounds;
    }
    if (input.agentMessagesPerMinute !== undefined) {
      const value = input.agentMessagesPerMinute;
      if (!Number.isInteger(value) || value < 1 || value > 1000)
        throw new Error("agentMessagesPerMinute must be an integer 1-1000");
      policy.agentMessagesPerMinute = value;
    }
    this.bumpPolicyRevision(input.conversationId);
    this.emit({
      eventType: "RoomPolicyChanged",
      entityId: input.conversationId,
      actorId: "user",
      conversationId: input.conversationId,
      payload: {
        maxAutoRounds: policy.maxAutoRounds,
        agentMessagesPerMinute: policy.agentMessagesPerMinute,
      },
    });
    const room = this.requireRoomState(input.conversationId);
    const releasable: HoldReason[] = [];
    if (room.rounds <= policy.maxAutoRounds) releasable.push("round_budget");
    if (this.agentMessagesInWindow(input.conversationId) <= policy.agentMessagesPerMinute)
      releasable.push("budget");
    await this.reevaluate((d) => d.conversationId === input.conversationId, releasable);
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
      actorId: "user",
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
        deliveries: this.deliveries.filter((d) => d.messageId === cached.message.id),
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
      traceId: input.traceId,
      causalParentIds: input.causalParentIds,
      source: input.source,
      seq,
      currentRounds: room.rounds,
      sessionGate,
    });

    room.rounds = result.rounds;
    result.message.createdAt = this.now();
    this.messages.push(result.message);
    this.deliveries.push(...result.deliveries);
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

    await this.flushDeliveries(result.deliveries.map((d) => d.id));

    return structuredClone({
      message: result.message,
      deliveries: this.deliveries.filter((d) => d.messageId === result.message.id),
    });
  }

  /** Revise a user message: keeps id, bumps revision; pending deliveries pick up the new version. */
  reviseMessage(input: { messageId: string; text: string; actorId: string }): Message {
    const message = this.messages.find((m) => m.id === input.messageId);
    if (!message) throw new Error(`message not found: ${input.messageId}`);
    if (message.senderId !== input.actorId) throw new Error("only the sender can revise");
    const text = input.text.trim();
    if (!text) throw new Error("text required");
    message.parts = [{ kind: "text", text }, ...message.parts.filter((p) => p.kind !== "text")];
    message.revision += 1;
    for (const delivery of this.deliveries) {
      if (
        delivery.messageId === message.id &&
        (delivery.state === "queued" || delivery.state === "held")
      ) {
        delivery.messageRevision = message.revision;
      }
    }
    this.emit({
      eventType: "MessageRevised",
      entityId: message.id,
      actorId: input.actorId,
      conversationId: message.conversationId,
      traceId: message.traceId,
      payload: { revision: message.revision },
    });
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
    return this.messages.filter((m) => m.conversationId === conversationId);
  }

  async listInbox(sessionId: string): Promise<Delivery[]> {
    return this.deliveries.filter(
      (d) =>
        d.recipientSessionId === sessionId &&
        (d.state === "queued" || d.state === "held" || d.state === "dispatching"),
    );
  }

  async getReceipts(deliveryId: string): Promise<DeliveryReceipt[]> {
    return this.receipts.filter((r) => r.deliveryId === deliveryId);
  }

  /**
   * Submitted deliveries the session's agent has not read yet, oldest first.
   * `submitted` only proves the text reached the native inbox; `agent_ack` proves the agent read it.
   */
  unreadDeliveries(sessionId: string): Array<{ delivery: Delivery; message: Message; snapshot?: ContextSnapshot }> {
    const acked = new Set(
      this.receipts.filter((r) => r.proofLevel === "agent_ack").map((r) => r.deliveryId),
    );
    return this.deliveries
      .filter((d) => d.recipientSessionId === sessionId && d.state === "submitted" && !acked.has(d.id))
      .map((delivery) => ({
        delivery,
        message: this.messages.find((m) => m.id === delivery.messageId)!,
        snapshot: this.contextSnapshots.get(delivery.id),
      }))
      .filter((item) => item.message)
      .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.message.seq - b.message.seq);
  }

  /** Record that the agent behind `sessionId` read a delivery. Idempotent per delivery. */
  acknowledgeDelivery(input: { deliveryId: string; sessionId: string }): DeliveryReceipt {
    const delivery = this.deliveries.find((d) => d.id === input.deliveryId);
    if (!delivery) throw new Error(`delivery not found: ${input.deliveryId}`);
    if (delivery.recipientSessionId !== input.sessionId) throw new Error("delivery belongs to another session");
    if (delivery.state !== "submitted") throw new Error(`delivery is ${delivery.state}, not submitted`);
    const existing = this.receipts.find((r) => r.deliveryId === delivery.id && r.proofLevel === "agent_ack");
    if (existing) return structuredClone(existing);
    const receipt: DeliveryReceipt = {
      deliveryId: delivery.id,
      proofLevel: "agent_ack",
      adapterId: "mcp",
      bindingEpoch: delivery.bindingEpoch ?? 1,
      observedAt: this.now(),
    };
    this.receipts.push(receipt);
    const message = this.messages.find((m) => m.id === delivery.messageId);
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
    return pending.map((d) => structuredClone(this.deliveries.find((x) => x.id === d.id)!));
  }

  private async flushDeliveries(deliveryIds: string[]) {
    for (const id of deliveryIds) {
      const delivery = this.deliveries.find((d) => d.id === id);
      if (!delivery || delivery.state !== "queued") continue;
      const message = this.messages.find((m) => m.id === delivery.messageId);
      if (!message) continue;

      const session = this.requireSession(delivery.recipientSessionId);
      const runtime = this.requireRuntime(delivery.recipientSessionId);
      const room = this.requireRoomState(delivery.conversationId);
      const membershipLeft = this.isSessionLeftRoom(
        delivery.conversationId,
        delivery.recipientSessionId,
      );

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
      if (decision.action === "queue") {
        if (delivery.reason !== decision.reason) {
          delivery.reason = decision.reason;
          this.emitDelivery(delivery);
        }
        continue;
      }

      if (!this.transition(delivery, { type: "lease" })) continue;
      delivery.messageRevision = message.revision;
      const snapshot = this.compileFor(delivery.conversationId, delivery.recipientSessionId, message);
      delivery.compiledContextHash = snapshot.hash;
      this.contextSnapshots.set(delivery.id, snapshot);

      if (!this.injectHook) {
        this.recordSubmitted(delivery, { adapterId: "memory", proof: "submitted" });
        continue;
      }

      const result = await this.injectHook({
        session,
        message,
        delivery,
        compiledQuery: snapshot.query,
        snapshot,
      });
      if (result.ok) {
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
    }
  }

  private recordSubmitted(
    delivery: Delivery,
    proof: { adapterId: string; proof: ProofLevel; nativeMessageId?: string },
  ) {
    this.receipts.push({
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
        ? `${recipient.displayName} · ${recipient.provider}/${recipient.host}${isCoordinator ? " · 当前统筹者（路由）" : ""}`
        : "房间成员",
      sourceLabel: `${this.senderLabel(message.senderId)} → ${isRoom ? conversation.title : "私聊"} · scope=${conversation.id}`,
      maxContextBytes: policy.maxContextBytes,
    });
  }

  private transition(delivery: Delivery, transition: DeliveryTransition): boolean {
    const next = applyDeliveryTransition(delivery, transition);
    if (!next.ok) return false;
    const changed = next.delivery.state !== delivery.state || next.delivery.reason !== delivery.reason;
    Object.assign(delivery, next.delivery);
    if (changed) this.emitDelivery(delivery);
    return true;
  }

  private emitDelivery(delivery: Delivery) {
    const eventType = DELIVERY_EVENT[delivery.state];
    if (!eventType) return;
    const message = this.messages.find((m) => m.id === delivery.messageId);
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
        compiledContextHash: delivery.compiledContextHash ?? null,
      },
    });
  }

  private agentMessagesInWindow(conversationId: string): number {
    const since = Date.parse(this.now()) - RATE_WINDOW_MS;
    return this.messages.filter(
      (m) =>
        m.conversationId === conversationId &&
        m.source !== "user" &&
        Date.parse(m.createdAt) >= since,
    ).length;
  }

  private senderLabel(senderId: string) {
    if (senderId === "user") return "用户";
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
    maxContextBytes: 32768,
  };
}
