/**
 * Portage v1.0 domain types — aligned with docs/DOMAIN.md.
 * No room job roles. Coordinator is routing only.
 */

export type Provider = "codex" | "claude" | string;
export type Harness = "cli" | "app" | "ide" | string;
export type HostKind = "terminal" | "vscode_cli" | "app" | string;

export type WakeMode = "coordinator" | "swarm" | "mentions" | "manual";

export type DeliveryState =
  | "queued"
  | "held"
  | "dispatching"
  | "submitted"
  | "failed"
  | "uncertain"
  | "cancelled";

export type ProofLevel = "written" | "submitted" | "native_confirmed" | "agent_ack";

export type HoldReason =
  | "busy"
  | "disabled"
  | "room_paused"
  | "budget"
  | "round_budget"
  | "offline"
  | "readonly"
  | "left_room"
  | "permission_changed"
  | "identity_changed"
  | string;

export type Session = {
  id: string;
  workspaceId: string;
  provider: Provider;
  harness: Harness;
  host: HostKind;
  nativeIdentity: string;
  displayName: string;
  alias: string;
  communicationEnabled: boolean;
  archivedAt?: string;
};

export type Endpoint = {
  id: string;
  deviceId: string;
  kind: HostKind;
  host: string;
  adapterId: string;
  capabilities: AdapterCapabilityFlags;
};

export type AdapterCapabilityFlags = {
  discover: boolean;
  read: boolean;
  write: boolean;
  idleSignal: boolean;
  tail: boolean;
  createSession: boolean;
};

export type NativeBinding = {
  id: string;
  sessionId: string;
  endpointId: string;
  nativeSessionId: string;
  epoch: number;
  state: "live" | "rebind" | "retired";
  activeForDelivery: boolean;
};

export type Participant = {
  id: string;
  workspaceId: string;
  kind: "user" | "agent";
  sessionId?: string;
  userId?: string;
};

export type Conversation = {
  id: string;
  workspaceId: string;
  kind: "direct" | "room";
  title: string;
  createdBy: string;
  policyDocumentId?: string;
};

export type Membership = {
  conversationId: string;
  participantId: string;
  permissions: string[];
  historyScope: "full" | "since_join" | "none";
  joinedAt: string;
  leftAt?: string;
};

/** Room wake + budget. Coordinator is routing, not a job title. */
export type RoomPolicy = {
  conversationId: string;
  wakeMode: WakeMode;
  coordinatorParticipantId?: string;
  batchWindowMs: number;
  maxConcurrent: number;
  agentMessagesPerMinute: number;
  maxAutoRounds: number;
  maxContextBytes: number;
};

export type ContentPart =
  | { kind: "text" | "markdown"; text: string }
  | { kind: "json"; value: unknown; schema?: string }
  | { kind: "artifact_ref"; artifactId: string; version: number };

export type Message = {
  id: string;
  workspaceId: string;
  conversationId: string;
  threadId?: string;
  seq: number;
  senderId: string;
  target: { kind: "participant" | "room"; id: string };
  mentions: string[];
  parts: ContentPart[];
  replyToMessageId?: string;
  causalParentIds: string[];
  traceId: string;
  source: "user" | "agent" | "gateway";
  idempotencyKey: string;
  acceptedPolicyRevision: string;
  revision: number;
  createdAt: string;
};

export type Delivery = {
  id: string;
  messageId: string;
  messageRevision: number;
  recipientSessionId: string;
  conversationId: string;
  bindingEpoch?: number;
  state: DeliveryState;
  reason?: HoldReason;
  attemptCount: number;
  nextAttemptAt?: string;
  dispatchPolicyRevision: string;
  compiledContextHash?: string;
};

export type DeliveryReceipt = {
  deliveryId: string;
  proofLevel: ProofLevel;
  adapterId: string;
  bindingEpoch: number;
  nativeMessageId?: string;
  observedAt: string;
};

export type PolicyDocument = {
  id: string;
  scope: "global" | "workspace" | "room";
  markdown: string;
  publishedRevision: number;
  hash: string;
  updatedBy: string;
  publishedAt: string;
};

export type Artifact = {
  id: string;
  workspaceId: string;
  conversationId?: string;
  hash: string;
  mime: string;
  byteSize: number;
  originalName: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  version: number;
  storageKey: string;
  createdBy: string;
  createdAt: string;
};

export type BusEventType =
  | "SessionRegistered"
  | "SessionUpdated"
  | "SessionCommunicationChanged"
  | "SessionExecutionChanged"
  | "RoomCreated"
  | "RoomPolicyChanged"
  | "RoomPaused"
  | "MembershipChanged"
  | "PolicyPublished"
  | "MessageAccepted"
  | "MessageRevised"
  | "WakeSuppressed"
  | "DeliveryQueued"
  | "DeliveryHeld"
  | "DeliveryDispatching"
  | "DeliverySubmitted"
  | "DeliveryAcknowledged"
  | "DeliveryUncertain"
  | "DeliveryFailed"
  | "DeliveryCancelled"
  | "ArtifactCreated";

export type BusEvent = {
  id: string;
  workspaceId: string;
  conversationId?: string;
  seq: number;
  eventType: BusEventType;
  entityId: string;
  actorId: string;
  traceId?: string;
  causalParentIds: string[];
  serverTime: string;
  payloadVersion: 1;
  payload: Record<string, string | number | boolean | null | undefined>;
};
