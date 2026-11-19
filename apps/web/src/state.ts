import type { Artifact, DeliveryReceipt, NativeEvent, NativeSyncCheckpoint } from "@portage/core";
import type { ContextMeta, HistorySlice, Snapshot } from "./api.js";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
export const stationPositions: Array<[number, number]> = [
  [43, 27],
  [76, 27],
  [43, 72],
  [76, 72],
  [24, 53],
  [58, 53],
];
/** Where "you" sit in the flow graph, as percentages like the member positions. */
export const userGraphPosition: [number, number] = [17, 16];
export const graphPositions: Array<[number, number]> = [
  [48, 22],
  [78, 47],
  [49, 70],
  [20, 47],
  [78, 72],
  [20, 72],
];
export const palette = ["#e2794f", "#5c9bd6", "#e0ab45", "#9079d0", "#4caa86", "#e06f8f", "#47a9bb"];
export const stateLabels: Record<string, string> = {
  running: "Working",
  idle: "Ready",
  dormant: "Asleep",
  waiting_human: "Needs you",
  disabled: "Muted",
  offline: "Offline",
  unknown: "Unknown",
};
export const reasonLabels: Record<string, string> = {
  busy: "Busy right now; delivers when it finishes",
  disabled: "It has stopped receiving messages",
  room_paused: "Auto-messaging is paused in this room",
  budget: "This minute's message limit is used up; continues automatically",
  round_budget: "The discussion hit its round limit; waiting for you to continue it",
  wakeup_budget: "This thread has used all its wake-ups",
  seats: "Too many members working at once; delivers when one frees up",
  readonly: "This session is read-only",
  offline: "The session is offline",
  left_room: "It left the room, so nothing more is delivered",
  attached: "It is open in an interactive window; delivers once that closes",
  identity_changed: "The session's identity changed; delivers after you confirm",
  permission_changed: "Permissions changed; delivers after you confirm",
  context_too_large: "Too long for its context limit: shorten it or raise the limit",
};
/** Short form for chips and the delivery board. */
export const reasonShort: Record<string, string> = {
  busy: "Busy",
  disabled: "Muted",
  room_paused: "Room paused",
  budget: "Rate limit",
  round_budget: "Round limit",
  wakeup_budget: "Wake-up limit",
  seats: "No free seat",
  readonly: "Read-only",
  offline: "Offline",
  left_room: "Left room",
  attached: "Window open",
  identity_changed: "Confirm identity",
  permission_changed: "Permissions",
  context_too_large: "Too long",
};
export const deliveryStateLabels: Record<string, string> = {
  queued: "Queued",
  held: "Held",
  dispatching: "Delivering",
  submitted: "Delivered",
  uncertain: "Checking",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const DORMANT_AFTER_MS = 10 * 60_000;
export const PACKET_MS = 2400;
export const SPEECH_MS = 3600;
/** How long an older bubble takes to step aside once someone else starts talking. */
export const SPEECH_YIELD_MS = 420;
export type Speech = { text: string; startAt: number; until: number; roomId: string; leaveAt?: number };
export const speechEnd = (s: Speech) => Math.min(s.until, s.leaveAt ?? Infinity);

export type VSession = {
  id: string;
  participantId: string;
  provider: string;
  host: string;
  name: string;
  alias: string;
  execution: string;
  enabled: boolean;
  writable: boolean;
  color: string;
  nativeIdentity: string;
  /** Adapter that submits turns natively; absent means the file inbox. */
  adapterId?: string;
  workdir?: string;
  bindingEpoch: number;
  /** What the host last said about the execution state, e.g. why a native turn failed. */
  detail?: string;
  checkpoint?: NativeSyncCheckpoint;
};
export type VRoom = {
  id: string;
  name: string;
  members: string[];
  mode: string;
  coordinator: string | null;
  paused: boolean;
  revision: number;
  document: string;
  roundBudget: number;
  messageBudget: number;
  rounds: number;
  autoMessages: number;
  maxConcurrent: number;
  maxWakeups: number;
  /** Members whose host reports an active turn — automatic wakeups beyond maxConcurrent wait. */
  runningSeats: number;
  /** Agent-caused wakeups spent on the room's active trace. */
  traceWakeups: number;
  /** Activity buckets (oldest → newest) for the sparkline. */
  pulse: number[];
};
export type VMessage = {
  id: string;
  sender: string;
  text: string;
  artifacts: Artifact[];
  recipients: string[];
  conversationId: string;
  direct: boolean;
  traceId: string;
  parentId: string | null;
  revision: number;
  at: number;
  demo: boolean;
};
export type VDelivery = {
  id: string;
  messageId: string;
  recipient: string;
  roomId: string;
  state: string;
  reason: string;
  messageRevision: number;
  revision?: number;
  /** When a rate-limited hold is expected to be released automatically. */
  nextAttemptAt?: number;
  /** Adapter detail for a hold, e.g. which process owns the native session. */
  detail?: string;
  /** Compiled-context metadata; the query text itself is fetched when opened. */
  context?: ContextMeta;
  /** Proof that the text reached the native inbox (adapter-level). */
  receipt?: DeliveryReceipt;
  /** Proof that the session's own transcript recorded the input. */
  confirmed?: DeliveryReceipt;
  /** Proof that the agent actually read it (MCP). Absent = delivered but unread. */
  ack?: DeliveryReceipt;
  /** True when the recipient's agent has ever read through the bridge, so "unread" is meaningful. */
  tracksRead: boolean;
};
export type VEvent = {
  id: string;
  seq: number;
  at: number;
  roomId: string | null;
  sessionId: string | null;
  messageId: string | null;
  traceId?: string;
  description: string;
  status: string;
  wait: boolean;
};
export type Model = {
  sessions: VSession[];
  rooms: VRoom[];
  messages: VMessage[];
  deliveries: VDelivery[];
  events: VEvent[];
  artifacts: Artifact[];
  globalRevision: number;
  globalDocument: string;
  sessionByParticipant: Map<string, string>;
};
export type Packet = { from: string; to: string; roomId: string; startedAt: number; artifact: boolean };

export const ui = {
  snapshot: null as Snapshot | null,
  model: null as Model | null,
  connected: false,
  streamOpen: false,
  view: "room" as "room" | "chat" | "flow",
  selection: { kind: "room", id: "room_dev" } as { kind: "room" | "session"; id: string },
  roomId: "room_dev",
  inspector: null as null | { kind: "session" | "message"; id: string },
  traceFilter: "all",
  packets: [] as Packet[],
  receiving: new Map<string, number>(),
  /** Sessions whose agent just read a delivery (agent_ack), until this timestamp. */
  read: new Map<string, number>(),
  speaking: new Map<string, Speech>(),
  freshMessages: new Set<string>(),
  renderedView: "",
  flashedSeq: 0,
  seenSeq: 0,
  animationPaused: motionPreference.matches,
  attachment: null as File | null,
  ruleScope: "room" as "room" | "global",
  hidden: new Set<string>(JSON.parse(localStorage.getItem("portage.hidden") ?? "[]") as string[]),
  nameAction: null as null | ((value: string) => Promise<void> | void),
  closeStream: null as null | (() => void),
  demoRunning: false,
  mentionIndex: 0,
  /** Older history pages per conversation, below `bound` (the seq the window started at when paged). */
  older: new Map<string, { slice: HistorySlice; hasMore: boolean; bound: number }>(),
  loadingOlder: false,
  /** Direct chat shows either Portage messages or the session's own native transcript. */
  chatSource: "portage" as "portage" | "native",
  native: new Map<string, { events: NativeEvent[]; checkpoint: NativeSyncCheckpoint | null }>(),
};

export const model = () => ui.model!;
export const session = (id: string) => model().sessions.find((x) => x.id === id);
export const room = (id = ui.roomId) => model().rooms.find((x) => x.id === id) ?? model().rooms[0]!;
