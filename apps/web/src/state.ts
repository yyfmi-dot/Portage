import type { Artifact, DeliveryReceipt, NativeEvent, NativeSyncCheckpoint } from "@portage/core";
import type { ContextMeta, HistorySlice, Snapshot } from "./api.js";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
export const stationPositions: Array<[number, number]> = [
  [43, 28],
  [76, 28],
  [43, 76],
  [76, 76],
  [24, 53],
  [58, 53],
];
export const graphPositions: Array<[number, number]> = [
  [48, 25],
  [78, 52],
  [49, 77],
  [20, 52],
  [78, 80],
  [20, 80],
];
export const palette = ["#739181", "#7b96a3", "#c28c71", "#9c91aa", "#a9a48c", "#adab9d", "#8aa39a"];
export const stateLabels: Record<string, string> = {
  running: "工作中",
  idle: "就绪",
  dormant: "未唤醒",
  waiting_human: "待你处理",
  disabled: "通信关闭",
  offline: "离线",
  unknown: "状态未知",
};
export const reasonLabels: Record<string, string> = {
  busy: "等待原生 session 就绪",
  disabled: "接收方通信关闭",
  room_paused: "房间自动通信已暂停",
  budget: "限速等待 · 每分钟消息预算已满",
  round_budget: "达到自动轮次上限 · 等你继续",
  wakeup_budget: "本链路唤醒次数已达上限",
  seats: "等待空闲席位 · 同时活跃已满",
  readonly: "当前入口为只读连接",
  offline: "原生 session 离线",
  left_room: "已退出房间 · 停止自动投递",
  attached: "原生会话正被交互式进程占用 · 释放后投递",
  identity_changed: "原生身份已变更 · 确认绑定后投递",
  permission_changed: "权限已变化 · 确认后投递",
  context_too_large: "原始消息超出上下文上限 · 修订消息或调高上限",
};
/** Short form for chips and the delivery board. */
export const reasonShort: Record<string, string> = {
  busy: "等就绪",
  disabled: "通信关闭",
  room_paused: "房间暂停",
  budget: "限速",
  round_budget: "轮次上限",
  wakeup_budget: "唤醒上限",
  seats: "等席位",
  readonly: "只读",
  offline: "离线",
  left_room: "已退出",
  attached: "被占用",
  identity_changed: "待确认身份",
  permission_changed: "权限变化",
  context_too_large: "超出上限",
};
export const deliveryStateLabels: Record<string, string> = {
  queued: "排队",
  held: "暂缓",
  dispatching: "提交中",
  submitted: "已提交",
  uncertain: "结果不明 · 回读中",
  failed: "失败",
  cancelled: "已取消",
};
export const DORMANT_AFTER_MS = 10 * 60_000;
export const PACKET_MS = 2400;
export const SPEECH_MS = 3600;

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
  speaking: new Map<string, { text: string; until: number; roomId: string }>(),
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
