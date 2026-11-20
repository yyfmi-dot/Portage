import type {

  Artifact,
  BusEvent,
  ContextSnapshot,
  Conversation,
  Delivery,
  DeliveryReceipt,
  DiscoveredEndpoint as AdapterEndpoint,
  Membership,
  Message,
  NativeEvent,
  NativeSyncCheckpoint,
  Participant,
  PolicyDocument,
  RoomPolicy,
  Session,
  SessionRuntime,
} from "@portage/core";

export type ConversationView = Conversation & {
  policy?: RoomPolicy;
  state?: {
    paused: boolean;
    rounds: number;
    policyRevision: string;
    activeTraceId?: string;
    traceRounds?: Record<string, number>;
  };
  document: PolicyDocument | null;
};

export type Snapshot = {
  workspaceId: string;
  conversations: ConversationView[];
  globalDocument: PolicyDocument | null;
  sessions: Session[];
  participants: Participant[];
  memberships: Membership[];
  runtimes: Record<string, SessionRuntime>;
  /** Per conversation: where the loaded window starts and whether older messages exist before it. */
  history: Record<string, { hasMore: boolean; fromSeq?: number }>;
  artifacts: Artifact[];
  nativeCheckpoints: Record<string, NativeSyncCheckpoint>;
  events: BusEvent[];
  lastEventSeq: number;
} & HistorySlice;

/** Messages with their deliveries, receipts and context metadata (the compiled text is fetched on demand). */
export type HistorySlice = {
  messages: Message[];
  deliveries: Delivery[];
  receipts: DeliveryReceipt[];
  contexts: Record<string, ContextMeta>;
};

export type ContextMeta = Omit<ContextSnapshot, "query">;

export type DiscoveredEndpoint = AdapterEndpoint & { registered: boolean };

// Same-origin in Vite dev (proxy); override for a remote daemon.
export const API_BASE: string = import.meta.env.VITE_PORTAGE_API ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(json.error ?? `${response.status} ${path}`);
  return json as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  snapshot: () => request<Snapshot>("/api/snapshot"),
  discover: () => request<{ endpoints: DiscoveredEndpoint[] }>("/api/discover"),

  registerSession: (input: {
    provider: string;
    host: string;
    harness: string;
    nativeIdentity: string;
    displayName: string;
    adapterId?: string;
    workdir?: string;
  }) => post<Session>("/api/sessions", input),
  confirmBinding: (id: string) => post<{ deliveries: Delivery[] }>(`/api/sessions/${id}/confirm-binding`),
  interrupt: (id: string) => post<{ interrupted: boolean }>(`/api/sessions/${id}/interrupt`),
  native: (id: string, limit = 200) =>
    request<{ events: NativeEvent[]; checkpoint: NativeSyncCheckpoint | null }>(`/api/sessions/${id}/native?limit=${limit}`),
  context: (deliveryId: string) => request<ContextSnapshot>(`/api/deliveries/${deliveryId}/context`),
  cancelDelivery: (deliveryId: string) => post<Delivery>(`/api/deliveries/${deliveryId}/cancel`),
  history: (conversationId: string, beforeSeq: number, limit = 50) =>
    request<HistorySlice & { hasMore: boolean }>(
      `/api/conversations/${conversationId}/messages?beforeSeq=${beforeSeq}&limit=${limit}`,
    ),
  updateSession: (id: string, input: { displayName?: string; archived?: boolean }) =>
    post<Session & { nativeRenameError?: string }>(`/api/sessions/${id}`, input),
  setCommunication: (id: string, enabled: boolean) =>
    post<{ deliveries: Delivery[] }>(`/api/sessions/${id}/communication`, { enabled }),
  markReady: (id: string) => post<{ deliveries: Delivery[] }>(`/api/sessions/${id}/ready`),
  directConversation: (id: string) => post<Conversation>(`/api/sessions/${id}/direct`),

  /** Load the optional studio cast used by “Watch a demo” (not present on a normal serve). */
  ensureStudioDemo: () => post<{ ok: boolean; roomId: string }>("/api/studio-demo/ensure"),
  createRoom: (title: string) => post<Conversation>("/api/rooms", { title }),
  renameRoom: (roomId: string, title: string) => post<Conversation>(`/api/rooms/${roomId}`, { title }),
  setWakeMode: (roomId: string, mode: string, coordinatorParticipantId?: string) =>
    post<RoomPolicy>(`/api/rooms/${roomId}/wake-mode`, { mode, coordinatorParticipantId }),
  setPaused: (roomId: string, paused: boolean) =>
    post<{ paused: boolean; deliveries: Delivery[] }>(`/api/rooms/${roomId}/pause`, { paused }),
  publishRoomPolicy: (
    roomId: string,
    input: {
      markdown: string;
      maxAutoRounds?: number;
      agentMessagesPerMinute?: number;
      maxConcurrent?: number;
      maxWakeupsPerTrace?: number;
    },
  ) => post<{ document: PolicyDocument; policy: RoomPolicy }>(`/api/rooms/${roomId}/policy`, input),
  publishGlobalPolicy: (markdown: string) => post<PolicyDocument>("/api/policy/global", { markdown }),
  joinRoom: (roomId: string, participantId: string) =>
    post<Membership>(`/api/rooms/${roomId}/members`, { participantId }),
  leaveRoom: (roomId: string, participantId: string) =>
    post<Membership>(`/api/rooms/${roomId}/members/${participantId}/leave`),

  send: (
    conversationId: string,
    input: {
      text: string;
      senderId?: string;
      source?: "user" | "agent";
      target?: { kind: "room" | "participant"; id: string };
      mentionParticipantIds?: string[];
      artifactIds?: string[];
      traceId?: string;
      causalParentIds?: string[];
      isManualWake?: boolean;
      idempotencyKey?: string;
    },
  ) => post<{ message: Message; deliveries: Delivery[] }>(`/api/conversations/${conversationId}/send`, input),
  preview: (conversationId: string, input: { text: string; recipientSessionId?: string; artifactIds?: string[] }) =>
    post<{ recipientSessionId?: string; snapshot: ContextSnapshot }>(
      `/api/conversations/${conversationId}/preview`,
      input,
    ),
  revise: (messageId: string, text: string) => post<Message>(`/api/messages/${messageId}/revise`, { text }),
  uploadArtifact: (input: { name: string; mime: string; contentBase64: string; conversationId?: string; createdBy?: string }) =>
    post<Artifact>("/api/artifacts", input),
  artifactUrl: (id: string) => `${API_BASE}/api/artifacts/${encodeURIComponent(id)}/content`,
  artifactText: async (id: string) => {
    const response = await fetch(api.artifactUrl(id));
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${response.status}`);
    return response.text();
  },
};

export function openEventStream(since: number, onEvent: (event: BusEvent) => void, onState: (open: boolean) => void) {
  const source = new EventSource(`${API_BASE}/api/events/stream?since=${since}`);
  source.addEventListener("bus", (raw) => onEvent(JSON.parse((raw as MessageEvent).data) as BusEvent));
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  return () => source.close();
}
