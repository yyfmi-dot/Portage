import "./prototype.css";
import "./portage.css";
import type { Artifact, BusEvent, ContextSnapshot, Delivery, DeliveryReceipt } from "@portage/core";
import { api, openEventStream, type DiscoveredEndpoint, type Snapshot } from "./api.js";

// ── constants ─────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const stationPositions: Array<[number, number]> = [
  [43, 25],
  [76, 25],
  [43, 72],
  [76, 72],
  [24, 51],
  [58, 51],
];
const graphPositions: Array<[number, number]> = [
  [48, 25],
  [78, 52],
  [49, 77],
  [20, 52],
  [78, 80],
  [20, 80],
];
const palette = ["#739181", "#7b96a3", "#c28c71", "#9c91aa", "#a9a48c", "#adab9d", "#8aa39a"];
const stateLabels: Record<string, string> = {
  running: "工作中",
  idle: "就绪",
  dormant: "未唤醒",
  waiting_human: "待用户",
  disabled: "通信关闭",
  offline: "离线",
  unknown: "状态未知",
};
const reasonLabels: Record<string, string> = {
  busy: "等待原生 session 就绪",
  disabled: "接收方通信关闭",
  room_paused: "房间自动通信已暂停",
  budget: "达到每分钟消息预算",
  round_budget: "达到自动轮次上限",
  readonly: "当前入口为只读连接",
  offline: "原生 session 离线",
  left_room: "已退出房间 · 停止自动投递",
};
const deliveryStateLabels: Record<string, string> = {
  queued: "排队",
  held: "暂缓",
  dispatching: "提交中",
  submitted: "已提交",
  uncertain: "待核对",
  failed: "失败",
  cancelled: "已取消",
};
const DORMANT_AFTER_MS = 10 * 60_000;
const PACKET_MS = 2400;

// ── view model ────────────────────────────────────────────────────────────

type VSession = {
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
};
type VRoom = {
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
};
type VMessage = {
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
type VDelivery = {
  id: string;
  messageId: string;
  recipient: string;
  roomId: string;
  state: string;
  reason: string;
  messageRevision: number;
  revision?: number;
  snapshot?: ContextSnapshot;
  /** Proof that the text reached the native inbox (adapter-level). */
  receipt?: DeliveryReceipt;
  /** Proof that the agent actually read it (MCP). Absent = delivered but unread. */
  ack?: DeliveryReceipt;
  /** True when the recipient's agent has ever read through the bridge, so "unread" is meaningful. */
  tracksRead: boolean;
};
type VEvent = {
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
type Model = {
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
type Packet = { from: string; to: string; roomId: string; startedAt: number; artifact: boolean };

const ui = {
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
};

function hashIndex(value: string, size: number) {
  let h = 0;
  for (const c of value) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % size;
}

const providerLabel = (p: string) => (p === "codex" ? "Codex" : p === "claude" ? "Claude" : p);
const hostLabel = (h: string) =>
  ({ terminal: "Terminal", vscode_cli: "VS Code CLI", app: "App" })[h] ?? h;

/**
 * A session counts as "reading" once any of its deliveries was ever acknowledged by its agent.
 * Only then does "unread" mean something; for a session with no MCP bridge, claiming "unread"
 * would pin a meaningless red dot on it forever, so the UI says "delivered" and nothing more.
 */
function readingSessions(s: Snapshot) {
  const deliveryOwner = new Map(s.deliveries.map((d) => [d.id, d.recipientSessionId]));
  const reading = new Set<string>();
  for (const r of s.receipts) {
    if (r.proofLevel !== "agent_ack") continue;
    const owner = deliveryOwner.get(r.deliveryId);
    if (owner) reading.add(owner);
  }
  return reading;
}

/** "Unread" is only claimed where it is knowable: delivered, not acknowledged, and the agent reads via the bridge. */
const isUnread = (d: VDelivery) => d.state === "submitted" && !d.ack && d.tracksRead;

function buildModel(s: Snapshot): Model {
  const now = Date.now();
  const reading = readingSessions(s);
  const sessionByParticipant = new Map<string, string>();
  for (const p of s.participants) if (p.sessionId) sessionByParticipant.set(p.id, p.sessionId);
  const participantBySession = new Map([...sessionByParticipant].map(([p, sid]) => [sid, p]));
  const deliveryById = new Map(s.deliveries.map((d) => [d.id, d]));
  const lastSubmitted = new Map<string, number>();
  for (const r of s.receipts) {
    const d = deliveryById.get(r.deliveryId);
    if (!d) continue;
    const at = Date.parse(r.observedAt);
    if (at > (lastSubmitted.get(d.recipientSessionId) ?? 0)) lastSubmitted.set(d.recipientSessionId, at);
  }

  const sessions: VSession[] = s.sessions
    .filter((x) => !x.archivedAt)
    .map((x) => {
      const runtime = s.runtimes[x.id] ?? { execution: "unknown", writable: false };
      let execution: string = runtime.execution;
      if (execution === "idle" && now - (lastSubmitted.get(x.id) ?? 0) > DORMANT_AFTER_MS) execution = "dormant";
      return {
        id: x.id,
        participantId: participantBySession.get(x.id) ?? "",
        provider: providerLabel(x.provider),
        host: hostLabel(x.host),
        name: x.displayName,
        alias: x.alias,
        execution,
        enabled: x.communicationEnabled,
        writable: runtime.writable,
        color: palette[hashIndex(x.id, palette.length)]!,
        nativeIdentity: x.nativeIdentity,
      };
    });
  const live = new Set(sessions.map((x) => x.id));

  const rooms: VRoom[] = s.conversations
    .filter((c) => c.kind === "room")
    .map((c) => {
      const members = s.memberships
        .filter((m) => m.conversationId === c.id && !m.leftAt)
        .map((m) => sessionByParticipant.get(m.participantId))
        .filter((id): id is string => Boolean(id && live.has(id)));
      const coordinatorPid = c.policy?.wakeMode === "coordinator" ? c.policy.coordinatorParticipantId : undefined;
      return {
        id: c.id,
        name: c.title,
        members,
        mode: c.policy?.wakeMode ?? "swarm",
        coordinator: coordinatorPid ? sessionByParticipant.get(coordinatorPid) ?? null : null,
        paused: Boolean(c.state?.paused),
        revision: c.document?.publishedRevision ?? 0,
        document: c.document?.markdown ?? "",
        roundBudget: c.policy?.maxAutoRounds ?? 4,
        messageBudget: c.policy?.agentMessagesPerMinute ?? 12,
        rounds: c.state?.rounds ?? 0,
        autoMessages: s.messages.filter(
          (m) => m.conversationId === c.id && m.source !== "user" && now - Date.parse(m.createdAt) < 60_000,
        ).length,
      };
    });

  const artifactsById = new Map(s.artifacts.map((a) => [a.id, a]));
  const directIds = new Set(s.conversations.filter((c) => c.kind === "direct").map((c) => c.id));
  const messages: VMessage[] = s.messages
    .map((m) => {
      const text = m.parts.find((p) => p.kind === "text");
      return {
        id: m.id,
        sender: m.senderId === "user" ? "user" : sessionByParticipant.get(m.senderId) ?? m.senderId,
        text: text && "text" in text ? text.text : "",
        artifacts: m.parts
          .filter((p) => p.kind === "artifact_ref")
          .map((p) => artifactsById.get((p as { artifactId: string }).artifactId))
          .filter((a): a is Artifact => Boolean(a)),
        recipients: s.deliveries.filter((d) => d.messageId === m.id).map((d) => d.recipientSessionId),
        conversationId: m.conversationId,
        direct: directIds.has(m.conversationId),
        traceId: m.traceId,
        parentId: m.causalParentIds[0] ?? null,
        revision: m.revision,
        at: Date.parse(m.createdAt),
        demo: m.idempotencyKey.startsWith("demo_"),
      };
    })
    .sort((a, b) => a.at - b.at);

  // Receipts stack: submitted (adapter) then agent_ack (MCP). Keep each level; never let one hide another.
  const receiptByDelivery = new Map<string, DeliveryReceipt>();
  const ackByDelivery = new Map<string, DeliveryReceipt>();
  for (const r of s.receipts) {
    if (r.proofLevel === "agent_ack") ackByDelivery.set(r.deliveryId, r);
    else receiptByDelivery.set(r.deliveryId, r);
  }
  const deliveries: VDelivery[] = s.deliveries.map((d: Delivery) => ({
    id: d.id,
    messageId: d.messageId,
    recipient: d.recipientSessionId,
    roomId: d.conversationId,
    state: d.state,
    reason: d.reason ?? "",
    messageRevision: d.messageRevision,
    revision: s.contextSnapshots[d.id]?.revisions.room,
    snapshot: s.contextSnapshots[d.id],
    receipt: receiptByDelivery.get(d.id),
    ack: ackByDelivery.get(d.id),
    tracksRead: reading.has(d.recipientSessionId),
  }));

  const model: Model = {
    sessions,
    rooms,
    messages,
    deliveries,
    events: [],
    artifacts: s.artifacts,
    globalRevision: s.globalDocument?.publishedRevision ?? 0,
    globalDocument: s.globalDocument?.markdown ?? "",
    sessionByParticipant,
  };
  model.events = s.events.map((e) => describeEvent(e, model, s)).filter((e): e is VEvent => Boolean(e));
  return model;
}

function describeEvent(e: BusEvent, m: Model, s: Snapshot): VEvent | null {
  const p = e.payload;
  const nameOf = (sessionId?: string | null) =>
    sessionId ? m.sessions.find((x) => x.id === sessionId)?.name ?? s.sessions.find((x) => x.id === sessionId)?.displayName ?? sessionId : "未知会话";
  const actorSession = e.actorId === "user" ? "user" : m.sessionByParticipant.get(e.actorId) ?? null;
  const actorName = actorSession === "user" ? "你" : nameOf(actorSession);
  const base = {
    id: e.id,
    seq: e.seq,
    at: Date.parse(e.serverTime),
    roomId: e.conversationId ?? null,
    sessionId: null as string | null,
    messageId: null as string | null,
    traceId: e.traceId,
    wait: false,
  };
  const recipient = typeof p.recipientSessionId === "string" ? p.recipientSessionId : null;
  switch (e.eventType) {
    case "MessageAccepted": {
      const msg = m.messages.find((x) => x.id === e.entityId);
      const target =
        p.targetKind === "room"
          ? m.rooms.find((r) => r.id === p.targetId)?.name ?? "房间"
          : nameOf(m.sessionByParticipant.get(String(p.targetId)));
      return {
        ...base,
        messageId: e.entityId,
        description: `${actorName} → ${target} · ${(msg?.text ?? "").slice(0, 34)}`,
        status: Number(p.recipients) ? "已进入收件箱" : "已记录 · 未唤醒",
      };
    }
    case "DeliverySubmitted":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${actorName} → ${nameOf(recipient)} · ${m.sessions.find((x) => x.id === recipient)?.host ?? ""}`,
        status: "已投递 · 原生收件箱",
      };
    case "DeliveryAcknowledged":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${nameOf(recipient)} 已读取消息`,
        status: "agent_ack · 已读",
      };
    case "DeliveryQueued":
      if (!p.reason) return null;
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${nameOf(recipient)} 收件箱排队 · ${reasonLabels[String(p.reason)] ?? p.reason}`,
        status: "等待就绪",
        wait: true,
      };
    case "DeliveryHeld":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${actorName} → ${nameOf(recipient)} · ${reasonLabels[String(p.reason)] ?? p.reason}`,
        status: "已暂缓",
        wait: true,
      };
    case "DeliveryUncertain":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · 提交结果不明`, status: "待回读核对", wait: true };
    case "DeliveryFailed":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · 投递失败 ${p.reason ?? ""}`, status: "失败", wait: true };
    case "DeliveryCancelled":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · 投递已取消`, status: "已取消" };
    case "MembershipChanged": {
      const sid = m.sessionByParticipant.get(e.entityId) ?? null;
      return { ...base, sessionId: sid, description: `${nameOf(sid)} ${p.action === "joined" ? "加入" : "退出"}房间`, status: "成员变更" };
    }
    case "RoomPolicyChanged": {
      if (p.wakeMode) {
        const lead = p.coordinatorParticipantId ? nameOf(m.sessionByParticipant.get(String(p.coordinatorParticipantId))) : null;
        const text =
          p.reason === "coordinator_left"
            ? lead ? `统筹路由转给 ${lead}` : "房间已无统筹者，切换为 Swarm"
            : `房间模式 · ${modeLabel(String(p.wakeMode))}${p.wakeMode === "coordinator" && lead ? ` · ${lead}` : ""}`;
        return { ...base, description: text, status: "路由已更新" };
      }
      return { ...base, description: `预算更新 · 轮次 ${p.maxAutoRounds} · 每分钟 ${p.agentMessagesPerMinute}`, status: "策略已更新" };
    }
    case "RoomPaused":
      return { ...base, description: `房间自动通信${p.paused ? "暂停" : "恢复"}`, status: p.paused ? "历史继续记录" : "检查收件箱", wait: Boolean(p.paused) };
    case "PolicyPublished":
      return {
        ...base,
        description: p.scope === "global" ? `全局 PORTAGE.md v${p.revision} 已发布` : `collaboration.md v${p.revision} 已发布`,
        status: "下一次 query 生效",
      };
    case "SessionCommunicationChanged":
      return { ...base, sessionId: e.entityId, description: `${nameOf(e.entityId)} · 信息传递${p.enabled ? "开启" : "关闭"}`, status: "已记录" };
    case "SessionExecutionChanged":
      return { ...base, sessionId: e.entityId, description: `${nameOf(e.entityId)} · ${stateLabels[String(p.execution)] ?? p.execution}`, status: "原生状态" };
    case "ArtifactCreated":
      return { ...base, description: `${actorName} 共享 ${p.name} · v${p.version}`, status: "产物已记录" };
    case "SessionRegistered":
      return { ...base, sessionId: e.entityId, description: `登记 ${nameOf(e.entityId)} · ${providerLabel(String(p.provider))} / ${hostLabel(String(p.host))}`, status: "来源已绑定" };
    case "SessionUpdated":
      return { ...base, sessionId: e.entityId, description: `${nameOf(e.entityId)} · 本地元数据更新`, status: "已记录" };
    case "RoomCreated":
      return { ...base, description: `房间创建 · ${p.title}`, status: "已记录" };
    case "MessageRevised":
      return { ...base, messageId: e.entityId, description: `消息修订 · v${p.revision}`, status: "待投递项使用新版本" };
    default:
      return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

const model = () => ui.model!;
const session = (id: string) => model().sessions.find((x) => x.id === id);
const room = (id = ui.roomId) => model().rooms.find((x) => x.id === id) ?? model().rooms[0]!;

function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function toast(message: string, tone: "" | "error" = "") {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", tone === "error");
  el.classList.add("visible");
  clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => el.classList.remove("visible"), 3500);
}

function memberBadge(item: VSession, roomId = ui.roomId) {
  const current = room(roomId);
  return current.mode === "coordinator" && current.coordinator === item.id ? "统筹" : "";
}
const senderName = (id: string) => (id === "user" ? "你" : session(id)?.name ?? "未知会话");
const statusFor = (item: VSession) => (item.enabled ? item.execution : "disabled");
const queueFor = (id: string) =>
  model().deliveries.filter((d) => d.recipient === id && (d.state === "queued" || d.state === "held"));
const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const initial = (item?: VSession) =>
  !item ? "P" : item.provider === "Codex" ? "C›" : item.provider === "Claude" ? "✳" : item.provider[0]!;
const SPEECH_MS = 3600;

function modeLabel(mode: string) {
  return (
    { mentions: "仅 @", coordinator: "统筹 · 派发连线", swarm: "Swarm · 无固定连线", manual: "手动唤醒" } as Record<string, string>
  )[mode] ?? mode;
}

function formatBytes(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

async function act(task: () => Promise<unknown>, success?: string) {
  try {
    await task();
    if (success) toast(success);
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

// ── data flow ─────────────────────────────────────────────────────────────

let refreshTimer = 0;
let retryTimer = 0;

async function refresh() {
  try {
    const snapshot = await api.snapshot();
    ui.snapshot = snapshot;
    ui.model = buildModel(snapshot);
    if (!ui.connected) {
      ui.connected = true;
      ui.seenSeq = Math.max(ui.seenSeq, snapshot.lastEventSeq);
      connectStream();
    }
    for (const id of ui.freshMessages) {
      const message = ui.model.messages.find((m) => m.id === id);
      if (message?.text)
        ui.speaking.set(message.sender, {
          text: message.text,
          until: performance.now() + SPEECH_MS,
          roomId: message.conversationId,
        });
    }
    if (!ui.model.rooms.some((r) => r.id === ui.roomId) && ui.model.rooms[0]) ui.roomId = ui.model.rooms[0].id;
    if (ui.selection.kind === "session" && !session(ui.selection.id)) ui.selection = { kind: "room", id: ui.roomId };
    render();
  } catch (error) {
    setOffline(error instanceof Error ? error.message : String(error));
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 90);
}

function setOffline(detail: string) {
  ui.connected = false;
  ui.closeStream?.();
  ui.closeStream = null;
  $("offline").hidden = false;
  $("offlineDetail").textContent = `${detail} · 每 2 秒自动重试`;
  renderConnection();
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void refresh(), 2000);
}

function connectStream() {
  ui.closeStream?.();
  ui.closeStream = openEventStream(
    ui.seenSeq,
    (event) => {
      if (event.seq <= ui.seenSeq) return;
      ui.seenSeq = event.seq;
      onBusEvent(event);
      scheduleRefresh();
    },
    (open) => {
      ui.streamOpen = open;
      renderConnection();
      if (!open) scheduleRefresh();
    },
  );
}

function onBusEvent(event: BusEvent) {
  if (event.eventType === "MessageAccepted") ui.freshMessages.add(event.entityId);
  if (event.eventType === "DeliveryAcknowledged") {
    ui.read.set(String(event.payload.recipientSessionId), performance.now() + 2200);
    return;
  }
  if (event.eventType !== "DeliverySubmitted" || !ui.model) return;
  const to = String(event.payload.recipientSessionId);
  const from = event.actorId === "user" ? "user" : ui.model.sessionByParticipant.get(event.actorId) ?? "user";
  const message = ui.snapshot?.messages.find((m) => m.id === event.payload.messageId);
  ui.packets.push({
    from,
    to,
    roomId: event.conversationId ?? "",
    startedAt: performance.now(),
    artifact: Boolean(message?.parts.some((p) => p.kind === "artifact_ref")),
  });
  ui.receiving.set(to, performance.now() + PACKET_MS);
}

// ── render ────────────────────────────────────────────────────────────────

function render() {
  if (!ui.model) return;
  $("offline").hidden = true;
  renderConnection();
  renderSidebar();
  renderHeader();
  renderOffice();
  renderChat();
  renderActivity();
  renderComposer();
  renderInspector();
  renderGraph();
  if (($("membersDialog") as HTMLDialogElement).open) renderMemberOptions();
  ui.freshMessages.clear();
  ui.renderedView = ui.view;
}

const poppedSpeech = new Set<string>();

function speechMarkup(id: string, now: number, tag: "span" | "i") {
  const speech = ui.speaking.get(id);
  if (!speech || speech.until <= now || speech.roomId !== ui.roomId) return "";
  const key = `${id}:${speech.until}`;
  const pop = !poppedSpeech.has(key);
  poppedSpeech.add(key);
  const text = speech.text.length > 54 ? `${speech.text.slice(0, 54)}…` : speech.text;
  return `<${tag} class="speech ${pop ? "pop" : ""}">${escapeHtml(text)}</${tag}>`;
}

function renderConnection() {
  const ok = ui.connected && ui.streamOpen;
  $("connectionDot").classList.toggle("offline", !ui.connected);
  $("connectionDot").classList.toggle("syncing", ui.connected && !ui.streamOpen);
  $("workspaceDot").classList.toggle("offline", !ui.connected);
  $("connectionLabel").textContent = !ui.connected ? "Daemon 未连接" : ok ? "Daemon 实时同步" : "Daemon 已连接 · 重连事件流";
  if (ui.model) {
    $("daemonLabel").textContent = `本地 Daemon · ${ui.model.sessions.length} sessions`;
  }
}

function renderSidebar() {
  $("roomList").innerHTML = model()
    .rooms.map(
      (item) =>
        `<button class="room-nav ${ui.selection.kind === "room" && item.id === ui.roomId ? "active" : ""}" data-room="${item.id}" data-drop-room="${item.id}"><span class="room-symbol">⌘</span><span>${escapeHtml(item.name)}</span><small>${item.paused ? "Ⅱ" : item.members.length}</small></button>`,
    )
    .join("");
  const query = ($("sessionSearch") as HTMLInputElement).value.trim().toLowerCase();
  const providers = [...new Set(["Codex", "Claude", ...model().sessions.map((x) => x.provider)])];
  $("sessionTree").innerHTML = providers
    .map((provider) => {
      const items = model().sessions.filter(
        (item) =>
          item.provider === provider &&
          `${item.name} ${item.host} ${item.alias} ${item.nativeIdentity}`.toLowerCase().includes(query),
      );
      if (!items.length) return "";
      const hosts = [...new Set(["App", "VS Code CLI", "Terminal", ...items.map((x) => x.host)])];
      const groups = hosts
        .map((host) => {
          const members = items.filter((item) => item.host === host);
          if (!members.length) return "";
          return `<div class="source-group"><div class="source-label">${host}</div>${members
            .map((item) => {
              const count = queueFor(item.id).length;
              return `<button draggable="true" data-session="${item.id}" class="session-row ${ui.selection.kind === "session" && ui.selection.id === item.id ? "active" : ""} ${item.enabled ? "" : "is-disabled"}" title="${escapeHtml(item.name)} · ${stateLabels[statusFor(item)]} · ${escapeHtml(item.nativeIdentity)}"><span class="session-dot ${statusFor(item)}"></span><span class="session-name">${escapeHtml(item.name)}</span>${count ? `<span class="queue-count">${count}</span>` : ""}</button>`;
            })
            .join("")}</div>`;
        })
        .join("");
      return `<div class="provider-title ${provider.toLowerCase()}"><span class="provider-logo">${provider === "Codex" ? "C›" : "✳"}</span>${escapeHtml(provider)}</div>${groups}`;
    })
    .join("");
}

function renderHeader() {
  const direct = ui.selection.kind === "session";
  const target = direct ? session(ui.selection.id) : undefined;
  const current = room();
  $("currentLocation").textContent = target?.name ?? current.name;
  $("roomEyebrow").textContent = target ? `${target.provider.toUpperCase()} / ${target.host.toUpperCase()}` : "TEAM ROOM";
  $("viewTitle").textContent = target?.name ?? current.name;
  $("viewSubtitle").textContent = target
    ? `${target.writable ? "可写连接" : "只读连接"} · 原生身份 ${target.nativeIdentity} · @${target.alias}`
    : "不同来源的会话，在同一个空间协作。";
  $("roomRulesLabel").textContent = `collaboration.md v${current.revision}`;
  $("addMember").hidden = direct;
  $("roomRules").hidden = direct;
  ($("wakeMode") as HTMLSelectElement).value = current.mode;
  ($("wakeMode") as HTMLSelectElement).disabled = direct;
  $("pauseRoom").hidden = direct;
  $("pauseRoom").textContent = current.paused ? "▷ 恢复通信" : "Ⅱ 暂停通信";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.setAttribute("aria-selected", String(button.dataset.view === ui.view));
    button.disabled = direct && button.dataset.view !== "chat";
  }
  $("roomView").hidden = ui.view !== "room";
  $("chatView").hidden = ui.view !== "chat";
  $("flowView").hidden = ui.view !== "flow";
  $("activityPanel").hidden = ui.view === "chat";
}

function renderOffice() {
  const current = room();
  const now = performance.now();
  $("workstations").innerHTML = current.members
    .map((id, index) => {
      const item = session(id)!;
      const position = stationPositions[index % stationPositions.length]!;
      const status = statusFor(item);
      const count = queueFor(id).length;
      const selected = ui.inspector?.kind === "session" && ui.inspector.id === id;
      const receiving = (ui.receiving.get(id) ?? 0) > now;
      const justRead = (ui.read.get(id) ?? 0) > now;
      const unread = model().deliveries.filter(
        (d) => d.recipient === id && d.roomId === current.id && isUnread(d),
      ).length;
      const speech = speechMarkup(id, now, "span");
      const badge = memberBadge(item);
      return `<button class="workstation ${status} ${selected ? "selected" : ""} ${receiving ? "receiving" : ""} ${justRead ? "just-read" : ""} ${unread ? "has-unread" : ""} ${speech ? "speaking" : ""}" data-inspect-session="${id}" style="left:${position[0]}%;top:${position[1]}%;--agent-color:${item.color}" aria-label="${escapeHtml(item.name)}${badge ? `，${badge}` : ""}，${stateLabels[status]}${count ? `，${count} 条排队` : ""}"><span class="station-label"><b>${escapeHtml(item.name)}${badge ? `<span class="station-role">${badge}</span>` : ""}</b><small>${item.provider} / ${item.host}</small></span><span class="desk"></span><span class="monitor"><i class="screen-lines"></i></span><span class="agent-figure"><i class="agent-head"></i><i class="agent-body"></i></span>${status === "dormant" ? '<span class="sleep-symbol">z z</span>' : ""}<span class="delivered-tag">已投递 ↓</span><span class="read-tag">已读 ✓</span>${unread ? `<span class="unread-dot" title="${unread} 条已投递、agent 尚未读取"></span>` : ""}${speech}<span class="station-state"><span class="state-pill">${stateLabels[status]}</span>${count ? `<span class="queue-tag">＋${count} 等待</span>` : ""}${unread ? `<span class="unread-tag">${unread} 未读</span>` : ""}</span></button>`;
    })
    .join("");
  const userSpeech = speechMarkup("user", now, "i");
  const door = document.querySelector(".office-door")!;
  door.classList.toggle("speaking", Boolean(userSpeech));
  door.innerHTML = `<span>YOU</span>${userSpeech}`;
  const members = current.members.map((id) => session(id)!);
  const active = members.filter((item) => item.execution === "running" && item.enabled).length;
  const dormant = members.filter((item) => item.execution === "dormant" && item.enabled).length;
  const queued = model().deliveries.filter(
    (item) => item.roomId === current.id && (item.state === "queued" || item.state === "held"),
  ).length;
  const unread = model().deliveries.filter((item) => item.roomId === current.id && isUnread(item)).length;
  const bridged = current.members.filter((id) => model().deliveries.some((d) => d.recipient === id && d.tracksRead)).length;
  $("roomStatus").textContent = current.paused
    ? "自动通信已暂停 · 历史继续记录"
    : `${current.members.length} 位成员 · ${active} 位工作中`;
  $("roomSummary").innerHTML = `<span><b>${active}</b>工作中</span><span><b>${dormant}</b>未唤醒</span><span><b>${queued}</b>收件箱排队</span><span title="${bridged ? "已投递到原生收件箱、agent 尚未读取（仅统计已接入 MCP 的成员）" : "还没有成员通过 MCP 读取过消息，无法统计未读"}"><b>${bridged ? unread : "—"}</b>未读</span><span title="已用自动轮次 / 上限" class="${current.rounds >= current.roundBudget ? "over" : ""}"><b>${current.rounds}/${current.roundBudget}</b>自动轮次</span><span><b>${modeLabel(current.mode)}</b></span>`;
  $("roomDropZone").hidden = current.members.length >= 6;
  ($("demoCollaboration") as HTMLButtonElement).disabled = ui.demoRunning;
}

function visibleMessages() {
  const all = model().messages.filter((item) => !ui.hidden.has(item.id));
  if (ui.selection.kind === "session") {
    const id = ui.selection.id;
    return all.filter((item) => item.sender === id || item.recipients.includes(id));
  }
  return all.filter((item) => item.conversationId === ui.roomId);
}

function deliveriesFor(messageId: string) {
  return model().deliveries.filter((d) => d.messageId === messageId);
}

function deliveryDescription(message: VMessage) {
  const deliveries = deliveriesFor(message.id);
  if (!deliveries.length) return "房间成员可读 · 未自动唤醒";
  return deliveries
    .map(
      (item) =>
        `${senderName(item.recipient)} · ${item.state === "submitted" ? (item.ack ? "已读" : isUnread(item) ? "已投递收件箱 · 未读" : "已投递收件箱") : reasonLabels[item.reason] ?? deliveryStateLabels[item.state] ?? item.state}`,
    )
    .join(" / ");
}

function artifactMarkup(item: Artifact) {
  return `<button class="artifact-card" data-artifact="${item.id}"><span class="artifact-icon">FILE</span><span><b>${escapeHtml(item.originalName)}</b><small>v${item.version} · ${formatBytes(item.byteSize)} · ${escapeHtml(item.createdBy === "user" ? "你" : senderName(model().sessionByParticipant.get(item.createdBy) ?? item.createdBy))}</small></span></button>`;
}

function renderChat() {
  const target = ui.selection.kind === "session" ? session(ui.selection.id) : undefined;
  $("chatContext").textContent = target
    ? `与 ${target.name} 的往来 · 私聊与房间中涉及该会话的消息 · 投递到原生收件箱`
    : `${room().name} · ${room().members.length} 位成员可读 · ${modeLabel(room().mode)}`;
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const messages = visibleMessages();
  box.innerHTML = messages.length
    ? messages
        .map((item) => {
          const author = session(item.sender);
          const where = item.direct ? "私聊" : model().rooms.find((r) => r.id === item.conversationId)?.name ?? "";
          return `<article class="message ${ui.freshMessages.has(item.id) ? "fresh" : ""}"><span class="avatar ${author?.provider === "Claude" ? "claude" : ""}">${item.sender === "user" ? "你" : initial(author)}</span><div class="message-main"><div class="message-header"><b>${escapeHtml(senderName(item.sender))}</b><span class="message-source">${author ? `${author.provider} / ${author.host}` : "Portage"} · ${escapeHtml(where)}${item.demo ? " · 演示" : ""}</span><time>${timeLabel(item.at)}</time></div><div class="message-body">${escapeHtml(item.text)}${item.revision > 1 ? ` <small>（修订 v${item.revision}）</small>` : ""}</div>${item.artifacts.map(artifactMarkup).join("")}<button class="message-receipt" data-message="${item.id}">${escapeHtml(deliveryDescription(item))} ↗</button><div class="message-actions"><button data-message="${item.id}">查看链路</button>${item.sender === "user" ? `<button data-edit-message="${item.id}">修订</button>` : ""}<button data-hide-message="${item.id}">隐藏记录</button></div></div></article>`;
        })
        .join("")
    : `<div class="empty-state">${target ? "从这里向这个会话发送第一条消息。" : "房间还没有消息。发送一条，或点「演示协作」。"}</div>`;
  if (nearBottom || ui.freshMessages.size || ui.renderedView !== "chat") box.scrollTop = box.scrollHeight;
}

function roomEvents(roomId: string) {
  const current = room(roomId);
  return model().events.filter(
    (e) =>
      e.roomId === roomId ||
      (e.roomId === null && (e.sessionId ? current.members.includes(e.sessionId) : true)),
  );
}

function renderActivity() {
  const events = roomEvents(ui.roomId).slice(-20).reverse();
  $("eventCounter").textContent = `${events.length} 条`;
  const fresh = new Set(events.filter((e) => e.seq > ui.flashedSeq && ui.flashedSeq > 0).map((e) => e.id));
  ui.flashedSeq = Math.max(ui.flashedSeq, ...events.map((e) => e.seq), 1);
  $("activityList").innerHTML = events.length
    ? events
        .map(
          (item) =>
            `<button class="activity-row ${fresh.has(item.id) ? "fresh" : ""}" ${item.messageId ? `data-message="${item.messageId}"` : `data-event-info="${escapeHtml(item.description)}"`}><time>${timeLabel(item.at)}</time><span class="event-description">${escapeHtml(item.description)}</span><span class="event-status ${item.wait ? "wait" : ""}">${escapeHtml(item.status)}</span><span class="muted">↗</span></button>`,
        )
        .join("")
    : '<p class="empty-state">暂无活动</p>';
}

function renderComposer() {
  const select = $("sendTarget") as HTMLSelectElement;
  const previous = select.value;
  const send = $("sendButton") as HTMLButtonElement;
  if (ui.selection.kind === "session") {
    const target = session(ui.selection.id)!;
    select.innerHTML = `<option value="${target.id}">${escapeHtml(target.name)}</option>`;
    send.disabled = !target.enabled || !target.writable;
    $("composerHint").textContent = !target.enabled
      ? "通信已关闭，可在详情中开启"
      : target.writable
        ? "提交到这个原生 session 的收件箱"
        : "当前入口只读，可查看记录";
    $("contextRevision").textContent = `全局 v${model().globalRevision} · 私聊`;
    ($("messageInput") as HTMLTextAreaElement).placeholder = `发给 ${target.name}…`;
  } else {
    ($("messageInput") as HTMLTextAreaElement).placeholder = "发一条消息，或 @ 一个成员…";
    select.innerHTML = `<option value="room">${escapeHtml(room().name)}</option>${room()
      .members.map((id) => `<option value="${id}">@${session(id)!.alias} · ${escapeHtml(session(id)!.name)}</option>`)
      .join("")}`;
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
    send.disabled = false;
    $("composerHint").textContent = `房间成员可读，${modeLabel(room().mode)}`;
    $("contextRevision").textContent = `全局 v${model().globalRevision} · 房间 v${room().revision}`;
  }
  $("attachmentPreview").hidden = !ui.attachment;
  $("attachmentPreview").innerHTML = ui.attachment
    ? `▤ ${escapeHtml(ui.attachment.name)} · ${formatBytes(ui.attachment.size)} <button type="button" id="removeAttachment" aria-label="移除附件">×</button>`
    : "";
}

function renderInspector() {
  const selected = ui.inspector;
  let content: string;
  if (selected?.kind === "session" && session(selected.id)) content = sessionInspector(session(selected.id)!);
  else if (selected?.kind === "message") content = messageInspector(model().messages.find((m) => m.id === selected.id));
  else content = roomInspector();
  const inspector = $("inspector");
  const key = selected ? `${selected.kind}:${selected.id}` : `room:${ui.roomId}`;
  const switched = inspector.dataset.key !== key;
  inspector.dataset.key = key;
  const scroll = inspector.scrollTop;
  // The entrance plays once per switch. The class must not linger: any later refresh rebuilds the
  // children, and a lingering class would replay the animation from opacity 0 (a blank flash).
  inspector.classList.remove("enter");
  inspector.innerHTML = content;
  inspector.scrollTop = scroll;
  if (switched) {
    void inspector.offsetWidth; // restart the animation on the freshly built children
    inspector.classList.add("enter");
    window.setTimeout(() => inspector.classList.remove("enter"), 360);
  }
}

function roomInspector() {
  const current = room();
  const progress = Math.min(100, (current.rounds / current.roundBudget) * 100);
  const rate = Math.min(100, (current.autoMessages / current.messageBudget) * 100);
  const artifacts = model().artifacts.filter((a) => a.conversationId === current.id);
  return `<div class="inspector-heading"><h2>房间概览</h2><span class="live-tag"><i class="live-dot"></i>LIVE</span></div><div class="inspector-title">${escapeHtml(current.name)}</div><p class="inspector-caption">房间成员可读，实际唤醒遵循当前模式。</p><section class="inspector-section"><h3>房间成员 <span class="muted">${current.members.length}</span></h3>${current.members
    .map((id) => {
      const item = session(id)!;
      const badge = memberBadge(item);
      return `<button class="inspector-member" data-inspect-session="${id}"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small>${badge ? `${badge} · ` : ""}${item.host}</small></span><span class="member-state">${stateLabels[statusFor(item)]}</span></button>`;
    })
    .join("") || '<p class="inspector-caption">还没有成员，可拖入或添加。</p>'}</section><section class="inspector-section"><h3>通信预算</h3><div class="detail-row"><span>自动讨论轮次</span><strong>${current.rounds} / ${current.roundBudget}</strong></div><div class="budget-bar ${progress >= 100 ? "over" : ""}"><i style="width:${progress}%"></i></div><div class="detail-row"><span>近 1 分钟 agent 消息</span><strong>${current.autoMessages} / ${current.messageBudget}</strong></div><div class="budget-bar ${rate >= 100 ? "over" : ""}"><i style="width:${rate}%"></i></div><div class="detail-row"><span>房间模式</span><strong>${modeLabel(current.mode)}</strong></div></section><section class="inspector-section"><div class="policy-card"><span>collaboration.md <b>v${current.revision}</b></span><p>${escapeHtml(current.document.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ") || "约束与指导：通信约定、可见范围与预算。不改写各 session 原有身份。")}</p><button data-open-rules="room">编辑规则 ↗</button></div></section><section class="inspector-section"><h3>共享产物 <span class="muted">${artifacts.length}</span></h3>${artifacts.map(artifactMarkup).join("") || '<p class="inspector-caption">消息附件会出现在这里。</p>'}</section>`;
}

/** The proof ladder the user can trust: written → submitted → agent read. Only proven rungs are lit. */
function proofSteps(item: VDelivery) {
  const steps = [
    { label: "已提交", on: item.state === "submitted" && Boolean(item.receipt), at: item.receipt?.observedAt },
    { label: "agent 已读", on: Boolean(item.ack), at: item.ack?.observedAt },
  ];
  return `<div class="proof-steps">${steps
    .map(
      (s) =>
        `<span class="${s.on ? "on" : ""}" title="${s.at ? new Date(s.at).toLocaleTimeString("zh-CN") : "尚无凭据"}"><i></i>${s.label}</span>`,
    )
    .join("")}</div>`;
}

function proofMarkup(item: VDelivery) {
  const snap = item.snapshot;
  const detail =
    item.state === "submitted"
      ? `${escapeHtml(item.receipt?.proofLevel ?? "submitted")} · ${escapeHtml(item.receipt?.adapterId ?? "")} · epoch ${item.receipt?.bindingEpoch ?? 1}${item.ack ? ` · agent_ack ${timeLabel(Date.parse(item.ack.observedAt))}` : item.tracksRead ? " · 尚未被 agent 读取" : " · 该会话未接入 MCP，无读取凭据"}`
      : escapeHtml(reasonLabels[item.reason] ?? "等待投递");
  return `<div class="proof-card"><div class="proof-head"><b>${escapeHtml(senderName(item.recipient))}</b><span class="proof-state ${item.ack ? "read" : item.state}">${item.ack ? "已读" : deliveryStateLabels[item.state] ?? item.state}</span></div>${item.state === "submitted" ? proofSteps(item) : ""}<small>${detail}<br>规则 v${item.revision ?? room().revision} · 消息 v${item.messageRevision}${snap ? ` · ${snap.hash} · ${formatBytes(snap.byteSize)}` : ""}</small>${item.receipt?.nativeMessageId ? `<code title="${escapeHtml(item.receipt.nativeMessageId)}">${escapeHtml(item.receipt.nativeMessageId.split(/[\\/]/).slice(-3).join("/"))}</code>` : ""}${snap ? `<button class="wide-button" data-show-snapshot="${item.id}">查看实际投递 query</button>` : ""}</div>`;
}

function sessionInspector(item: VSession) {
  const pending = queueFor(item.id);
  const current = room();
  const inRoom = current.members.includes(item.id);
  const isCoordinator = current.mode === "coordinator" && current.coordinator === item.id;
  const last = model()
    .deliveries.filter((d) => d.recipient === item.id && d.snapshot)
    .at(-1);
  const lastAck = model()
    .deliveries.filter((d) => d.recipient === item.id && d.ack)
    .map((d) => d.ack!)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .at(-1);
  return `<div class="inspector-heading"><h2>会话详情</h2><span>SESSION</span></div><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><div class="inspector-title">${escapeHtml(item.name)}</div><div class="inspector-caption">${item.provider} / ${item.host} · @${escapeHtml(item.alias)}<br><span class="mono">${escapeHtml(item.nativeIdentity)} · epoch 1</span></div><section class="inspector-section"><div class="detail-row"><span>信息传递</span><button class="toggle" role="switch" aria-label="${escapeHtml(item.name)}信息传递" aria-checked="${item.enabled}" data-toggle-session="${item.id}"></button></div><div class="detail-row"><span>原生执行</span><strong>${stateLabels[item.execution]}</strong></div><div class="detail-row"><span>输入能力</span><strong>${item.writable ? "可写 · FileInbox" : "只读"}</strong></div><div class="detail-row"><span>读取凭据</span><strong title="${lastAck ? "该会话的 agent 通过 MCP 读取过消息" : "该会话还没有通过 MCP 读取过消息"}">${lastAck ? `MCP 已接入 · ${timeLabel(Date.parse(lastAck.observedAt))}` : "未接入 MCP"}</strong></div><div class="detail-row"><span>规则版本</span><strong>已注入 v${last?.revision ?? "—"} / 已发布 v${current.revision}</strong></div><div class="detail-row"><span>房间路由</span><strong>${isCoordinator ? "当前统筹者" : inRoom ? "普通成员" : "非本房成员"}</strong></div></section><section class="inspector-section"><h3>收件箱 · ${pending.length} 排队</h3><p class="inspector-caption">每位成员独立队列；忙或预算不足时暂缓，就绪后按序投递。不设工种角色。</p>${pending.length ? pending.map((d) => `<div class="delivery-item"><b>${escapeHtml(model().messages.find((m) => m.id === d.messageId)?.text.slice(0, 45) ?? "消息")}</b><small>${escapeHtml(reasonLabels[d.reason] ?? "等待投递")}</small></div>`).join("") : '<p class="inspector-caption">当前收件箱为空。</p>'}<button class="wide-button" data-ready-session="${item.id}">标记原生就绪</button>${inRoom ? `<button class="wide-button" data-wake-session="${item.id}">唤醒一次</button>` : ""}${inRoom && current.mode === "coordinator" && !isCoordinator ? `<button class="wide-button" data-make-coordinator="${item.id}">设为统筹者</button>` : ""}${last ? `<button class="wide-button" data-show-snapshot="${last.id}">查看最近投递 query</button>` : ""}</section><section class="inspector-section"><h3>会话管理</h3><button class="wide-button" data-direct-session="${item.id}">与这个 session 对话</button>${inRoom ? `<button class="wide-button leave-button" data-leave-session="${item.id}">退出当前房间</button>` : `<button class="wide-button" data-add-session="${item.id}">加入当前房间</button>`}<button class="wide-button" data-rename-session="${item.id}">重命名本地显示</button><button class="wide-button" data-archive-session="${item.id}">归档本地关联</button><p class="inspector-caption">退出房间不影响原生 session；仅停止本房间自动唤醒。原生身份与正在干的活由宿主决定。</p></section>`;
}

function messageInspector(message?: VMessage) {
  if (!message) return roomInspector();
  const deliveries = deliveriesFor(message.id);
  return `<div class="inspector-heading"><h2>消息与链路</h2><span>TRACE</span></div><div class="inspector-title">${escapeHtml(senderName(message.sender))}</div><p class="inspector-caption mono">${message.id}<br>${message.traceId}<br>${message.parentId ? `上游 ${message.parentId}` : "链路起点"}</p><section class="inspector-section"><p class="inspector-message-body">${escapeHtml(message.text)}</p>${message.artifacts.map(artifactMarkup).join("")}</section><section class="inspector-section"><h3>逐接收方投递</h3>${deliveries.length ? deliveries.map(proofMarkup).join("") : '<p class="inspector-caption">写入房间历史，成员可读。本条未触发自动唤醒。</p>'}</section><section class="inspector-section"><h3>原始内容与上下文</h3><p class="inspector-caption">规则按接收方编译一次，消息来源与实际投递版本独立保留。</p><button class="wide-button" data-focus-trace="${message.traceId}">在信息流中定位</button></section>`;
}

function renderGraph() {
  const all = model().messages.filter((m) => m.conversationId === ui.roomId);
  const traces = [...new Set(all.map((m) => m.traceId))];
  const filter = $("traceFilter") as HTMLSelectElement;
  filter.innerHTML = '<option value="all">全部 Trace</option>' + traces.map((id) => `<option value="${id}">${id}</option>`).join("");
  if (ui.traceFilter !== "all" && !traces.includes(ui.traceFilter)) ui.traceFilter = "all";
  filter.value = ui.traceFilter;
  $("flowCount").textContent = `${all.length} 条消息 · ${modeLabel(room().mode)}`;
  const nodes = [
    { id: "user", name: "你", provider: "YOU", position: [18, 19] as [number, number] },
    ...room().members.map((id, index) => ({ ...session(id)!, position: graphPositions[index % graphPositions.length]! })),
  ];
  $("graphNodes").innerHTML = nodes
    .map((item) => {
      const s = item.id === "user" ? null : (item as VSession);
      return `<button class="graph-node ${ui.inspector?.id === item.id ? "selected" : ""} ${(ui.receiving.get(item.id) ?? 0) > performance.now() ? "receiving" : ""}" ${s ? `data-inspect-session="${item.id}"` : 'data-event-info="消息入口：你发送的消息从这里进入 Bus"'} style="left:${item.position[0]}%;top:${item.position[1]}%"><span class="orb">${item.provider === "YOU" ? "你" : item.provider === "Codex" ? "C›" : "✳"}</span><b>${escapeHtml(item.name)}</b><small>${s ? `${memberBadge(s) ? `${memberBadge(s)} · ` : ""}${stateLabels[statusFor(s)]}` : "消息入口"}</small></button>`;
    })
    .join("");
  const events = roomEvents(ui.roomId)
    .filter((e) => ui.traceFilter === "all" || e.traceId === ui.traceFilter)
    .slice(-40)
    .reverse();
  $("flowTimeline").innerHTML = events.length
    ? events
        .map((item) => {
          const selected = ui.inspector?.kind === "message" && ui.inspector.id === item.messageId;
          return `<button class="flow-event ${selected ? "selected" : ""}" ${item.messageId ? `data-message="${item.messageId}"` : `data-event-info="${escapeHtml(item.description)}"`}><time>${timeLabel(item.at)}</time><span><b>${escapeHtml(item.description)}</b><small>${escapeHtml(item.status)}</small><span class="chip ${item.wait ? "wait" : ""}">${item.messageId ? "MESSAGE" : "STATE"}</span></span></button>`;
        })
        .join("")
    : '<p class="empty-state" style="color:#7f9186">暂无事件</p>';
  const roomDeliveries = model().deliveries.filter((d) => d.roomId === ui.roomId);
  const count = (state: string) => roomDeliveries.filter((d) => d.state === state).length;
  const open = roomDeliveries.filter((d) => d.state === "queued" || d.state === "held" || d.state === "uncertain");
  $("deliveryBoard").innerHTML = `<div class="board-stat-row"><div class="board-stat"><b>${count("queued")}</b><span>排队</span></div><div class="board-stat"><b>${count("held")}</b><span>暂缓</span></div><div class="board-stat"><b>${count("submitted")}</b><span>已提交</span></div></div>${
    open.length
      ? open
          .map((d) => {
            const message = model().messages.find((m) => m.id === d.messageId);
            return `<button class="board-item" data-message="${d.messageId}"><b>${escapeHtml(senderName(d.recipient))} · ${deliveryStateLabels[d.state] ?? d.state}</b><small>${escapeHtml(message?.text.slice(0, 48) ?? d.messageId)}<br>${escapeHtml(reasonLabels[d.reason] ?? "等待投递")} · 规则 v${d.revision ?? room().revision}</small></button>`;
          })
          .join("")
      : '<p class="inspector-caption" style="color:#7f9186;padding:8px 2px">收件箱空闲。每位成员有独立队列。</p>'
  }<p class="inspector-caption" style="color:#7f9186;padding-top:12px">自动轮次 ${room().rounds}/${room().roundBudget} · 达上限后自动唤醒停止</p>`;
  $("pauseAnimation").textContent = ui.animationPaused ? "恢复动画" : "暂停动画";
}

// ── canvas ────────────────────────────────────────────────────────────────

function curve(from: [number, number], to: [number, number]) {
  return [(from[0] + to[0]) / 2 + 12, (from[1] + to[1]) / 2 - 20] as [number, number];
}

function pointOn(from: [number, number], ctrl: [number, number], to: [number, number], t: number) {
  const u = 1 - t;
  return [u * u * from[0] + 2 * u * t * ctrl[0] + t * t * to[0], u * u * from[1] + 2 * u * t * ctrl[1] + t * t * to[1]] as [number, number];
}

function drawCanvas(canvas: HTMLCanvasElement, kind: "room" | "flow", now: number) {
  if (canvas.closest("[hidden]") || !ui.model) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const current = room();
  const positions = new Map<string, [number, number]>();
  positions.set("user", kind === "flow" ? [rect.width * 0.18, rect.height * 0.19] : [rect.width * 0.5, rect.height - 14]);
  current.members.forEach((id, index) => {
    const percent = (kind === "flow" ? graphPositions : stationPositions)[index % 6]!;
    positions.set(id, [(rect.width * percent[0]) / 100, (rect.height * percent[1]) / 100 + (kind === "room" ? 35 : 0)]);
  });
  const edges = new Map<string, { from: string; to: string; dispatch?: boolean }>();
  if (kind === "room" && current.mode === "coordinator" && current.coordinator) {
    for (const memberId of current.members) {
      if (memberId !== current.coordinator) edges.set(`d-${memberId}`, { from: current.coordinator, to: memberId, dispatch: true });
    }
  } else if (kind === "flow") {
    for (const message of model().messages.filter((m) => m.conversationId === current.id && (ui.traceFilter === "all" || m.traceId === ui.traceFilter))) {
      for (const recipient of message.recipients) edges.set(`${message.sender}-${recipient}`, { from: message.sender, to: recipient });
    }
  }
  // Swarm / 仅@ / 手动：房间视图不画成员固定连线，只保留在途粒子
  context.lineWidth = 1.2;
  for (const edge of edges.values()) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const ctrl = curve(from, to);
    context.strokeStyle = edge.dispatch ? "#d9a07466" : "#77927d65";
    context.setLineDash(edge.dispatch ? [] : [4, 4]);
    context.beginPath();
    context.moveTo(...from);
    context.quadraticCurveTo(...ctrl, ...to);
    context.stroke();
    context.setLineDash([]);
    const [x, y] = pointOn(from, ctrl, to, 0.72);
    const [bx, by] = pointOn(from, ctrl, to, 0.68);
    const angle = Math.atan2(y - by, x - bx);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - 5 * Math.cos(angle - 0.5), y - 5 * Math.sin(angle - 0.5));
    context.moveTo(x, y);
    context.lineTo(x - 5 * Math.cos(angle + 0.5), y - 5 * Math.sin(angle + 0.5));
    context.stroke();
  }
  if (ui.animationPaused) return;
  for (const packet of ui.packets.filter((p) => p.roomId === current.id)) {
    const from = positions.get(packet.from);
    const to = positions.get(packet.to);
    if (!from || !to) continue;
    const ctrl = curve(from, to);
    const raw = Math.min(1, (now - packet.startedAt) / PACKET_MS);
    const progress = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
    const color = packet.artifact ? "#c98a4e" : "#dfa178";
    for (let i = 6; i >= 0; i -= 1) {
      const t = Math.max(0, progress - i * 0.025);
      const [x, y] = pointOn(from, ctrl, to, t);
      context.globalAlpha = i === 0 ? 1 : 0.32 * (1 - i / 7);
      context.fillStyle = color;
      context.shadowColor = "#d79c60";
      context.shadowBlur = i === 0 ? (kind === "flow" ? 14 : 8) : 0;
      context.beginPath();
      context.arc(x, y, (packet.artifact ? 4.2 : 3.2) * (i === 0 ? 1 : 0.8), 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    if (raw > 0.82) {
      const ring = (raw - 0.82) / 0.18;
      context.strokeStyle = `rgba(216, 160, 116, ${0.55 * (1 - ring)})`;
      context.lineWidth = 1.4;
      context.beginPath();
      context.arc(to[0], to[1], 8 + ring * 22, 0, Math.PI * 2);
      context.stroke();
    }
  }
}

let lastFrame = 0;
let officeStateKey = "";
function animate(now: number) {
  if (!document.hidden && now - lastFrame > 30) {
    ui.packets = ui.packets.filter((p) => now - p.startedAt < PACKET_MS);
    drawCanvas($("roomCanvas") as HTMLCanvasElement, "room", now);
    drawCanvas($("flowCanvas") as HTMLCanvasElement, "flow", now);
    const key = [...ui.receiving, ...ui.read, ...ui.speaking.entries()]
      .filter(([, v]) => (typeof v === "number" ? v : v.until) > now)
      .map(([id]) => id)
      .join(",");
    if (ui.model && key !== officeStateKey) {
      officeStateKey = key;
      renderOffice();
    }
    lastFrame = now;
  }
  requestAnimationFrame(animate);
}

// ── actions ───────────────────────────────────────────────────────────────

function selectRoom(id: string) {
  ui.roomId = id;
  ui.selection = { kind: "room", id };
  ui.inspector = null;
  ui.traceFilter = "all";
  ($("sendTarget") as HTMLSelectElement).value = "room";
  render();
}

function selectSession(id: string) {
  ui.selection = { kind: "session", id };
  ui.inspector = { kind: "session", id };
  ui.view = "chat";
  render();
}

function mentionsIn(text: string) {
  return room()
    .members.map((id) => session(id)!)
    .filter((s) => new RegExp(`@${s.alias}(?![\\w-])`).test(text))
    .map((s) => s.participantId);
}

async function readBase64(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function uploadAttachment(conversationId: string) {
  if (!ui.attachment) return [];
  const artifact = await api.uploadArtifact({
    name: ui.attachment.name,
    mime: ui.attachment.type,
    contentBase64: await readBase64(ui.attachment),
    conversationId,
  });
  return [artifact.id];
}

async function sendFromComposer() {
  const input = $("messageInput") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (($("sendButton") as HTMLButtonElement).disabled) return;
  if (!text && !ui.attachment) return toast("写一条消息或选择一个附件");
  const body = text || "共享一个附件";
  const target = ($("sendTarget") as HTMLSelectElement).value;
  await act(async () => {
    let result;
    if (ui.selection.kind === "session") {
      const targetSession = session(ui.selection.id)!;
      const dm = await api.directConversation(targetSession.id);
      result = await api.send(dm.id, {
        text: body,
        target: { kind: "participant", id: targetSession.participantId },
        artifactIds: await uploadAttachment(dm.id),
      });
    } else if (target === "room") {
      result = await api.send(ui.roomId, {
        text: body,
        mentionParticipantIds: mentionsIn(body),
        artifactIds: await uploadAttachment(ui.roomId),
      });
    } else {
      const targetSession = session(target)!;
      result = await api.send(ui.roomId, {
        text: body,
        target: { kind: "participant", id: targetSession.participantId },
        artifactIds: await uploadAttachment(ui.roomId),
      });
    }
    input.value = "";
    ui.attachment = null;
    ($("fileInput") as HTMLInputElement).value = "";
    const states = result.deliveries.map((d) => deliveryStateLabels[d.state] ?? d.state);
    toast(result.deliveries.length ? `已发送 · ${result.deliveries.length} 份投递（${[...new Set(states)].join(" / ")}）` : "已记录到房间历史 · 当前模式未唤醒成员");
  });
}

async function previewQuery() {
  const target = ($("sendTarget") as HTMLSelectElement).value;
  const text = ($("messageInput") as HTMLTextAreaElement).value || "（输入区尚未填写消息）";
  await act(async () => {
    let conversationId = ui.roomId;
    let recipientSessionId = target === "room" ? undefined : target;
    if (ui.selection.kind === "session") {
      conversationId = (await api.directConversation(ui.selection.id)).id;
      recipientSessionId = ui.selection.id;
    }
    const result = await api.preview(conversationId, { text, recipientSessionId });
    showSnapshot(
      result.snapshot,
      "本次 query 预览",
      `由 Bus 按接收方 ${senderName(result.recipientSessionId ?? "")} 实际编译，与发送时的组装逻辑一致。原始消息单独保存。`,
    );
  });
}

function showSnapshot(snapshot: ContextSnapshot, title: string, description: string) {
  $("queryTitle").textContent = title;
  $("queryDescription").textContent = description;
  $("queryMeta").innerHTML = [
    ...snapshot.layers.map((l) => `<span class="layer">${escapeHtml(l)}</span>`),
    `<span>${snapshot.hash}</span>`,
    `<span>${formatBytes(snapshot.byteSize)}</span>`,
    snapshot.truncated ? '<span class="warn">已截断</span>' : "",
  ].join("");
  $("queryPreview").textContent = snapshot.query;
  const dialog = $("queryDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

function showRules(scope: "room" | "global") {
  ui.ruleScope = scope;
  const current = room();
  ($("rulesEditor") as HTMLTextAreaElement).value = scope === "global" ? model().globalDocument : current.document;
  ($("roundBudget") as HTMLInputElement).value = String(current.roundBudget);
  ($("messageBudget") as HTMLInputElement).value = String(current.messageBudget);
  $("rulesDescription").textContent =
    scope === "global"
      ? `PORTAGE.md v${model().globalRevision} · 每次原生 query 带入这份最高层约定。`
      : `${current.name} · collaboration.md v${current.revision} · 作用于本房间的通信与成员。`;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scope]"))
    button.classList.toggle("selected", button.dataset.scope === scope);
  ($("roundBudget") as HTMLInputElement).disabled = scope === "global";
  ($("messageBudget") as HTMLInputElement).disabled = scope === "global";
  const dialog = $("rulesDialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

async function publishRules() {
  const text = ($("rulesEditor") as HTMLTextAreaElement).value.trim();
  const rounds = Number(($("roundBudget") as HTMLInputElement).value);
  const messages = Number(($("messageBudget") as HTMLInputElement).value);
  if (!text || !Number.isInteger(rounds) || rounds < 1 || rounds > 100 || !Number.isInteger(messages) || messages < 1 || messages > 1000)
    return toast("请填写规则，轮次为 1–100，消息预算为 1–1000", "error");
  await act(async () => {
    if (ui.ruleScope === "global") await api.publishGlobalPolicy(text);
    else await api.publishRoomPolicy(ui.roomId, { markdown: text, maxAutoRounds: rounds, agentMessagesPerMinute: messages });
    ($("rulesDialog") as HTMLDialogElement).close();
  }, "已发布 · 正文下一次 query 应用，预算立即生效并重新检查收件箱");
}

function renderMemberOptions() {
  $("memberOptions").innerHTML = model()
    .sessions.map((item) => {
      const joined = room().members.includes(item.id);
      return `<div class="member-option"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small>${item.provider} / ${item.host} · ${escapeHtml(item.nativeIdentity)}</small></span><button data-add-session="${item.id}" ${joined ? "disabled" : ""}>${joined ? "已加入" : "加入"}</button></div>`;
    })
    .join("");
}

async function showDiscover() {
  const dialog = $("discoverDialog") as HTMLDialogElement;
  $("discoverOptions").innerHTML = '<p class="dialog-description">正在扫描本机进程…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const { endpoints } = await api.discover();
    renderDiscover(endpoints);
  } catch (error) {
    $("discoverOptions").innerHTML = `<p class="dialog-description">${escapeHtml(error instanceof Error ? error.message : error)}</p>`;
  }
}

function renderDiscover(endpoints: DiscoveredEndpoint[]) {
  $("discoverOptions").innerHTML = endpoints.length
    ? endpoints
        .map(
          (e) =>
            `<div class="member-option"><span class="avatar ${e.provider === "claude" ? "claude" : ""}">${providerLabel(e.provider)[0]}</span><span class="member-info"><b>${escapeHtml(e.displayName)}</b><small>${providerLabel(e.provider)} / ${hostLabel(e.host)} · ${escapeHtml(e.nativeSessionId)}</small></span><button data-register='${escapeHtml(JSON.stringify(e))}' ${e.registered ? "disabled" : ""}>${e.registered ? "已登记" : "登记"}</button></div>`,
        )
        .join("")
    : '<p class="dialog-description">没有发现运行中的 Codex / Claude CLI。启动一个 CLI 后再次打开。</p>';
}

function showNameDialog(title: string, label: string, initialValue: string, description: string, callback: (value: string) => Promise<void> | void) {
  ui.nameAction = callback;
  $("nameDialogTitle").textContent = title;
  $("nameLabel").textContent = label;
  ($("nameInput") as HTMLInputElement).value = initialValue;
  ($("nameInput") as HTMLInputElement).maxLength = title.includes("修订") ? 4000 : 50;
  $("nameDescription").textContent = description;
  ($("nameDialog") as HTMLDialogElement).showModal();
  $("nameInput").focus();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function demoCollaboration() {
  const current = room();
  if (current.paused) return toast("房间已暂停，可以先恢复自动通信");
  if (current.mode === "coordinator" && !current.coordinator) return toast("统筹模式需要指定一位统筹者");
  const lead = session(current.coordinator ?? current.members[0] ?? "");
  const worker = current.members.map((id) => session(id)!).find((s) => s.id !== lead?.id && s.enabled && s.writable);
  if (!lead?.enabled || !worker) return toast("请让统筹/发起者与至少一位可写成员开启通信");
  ui.demoRunning = true;
  renderOffice();
  toast("演示开始 · 每一步都经由真实 Bus 投递到原生收件箱");
  const stamp = Date.now().toString(36);
  try {
    const start = await api.send(current.id, {
      text: "请核对适配器契约，给出一份可实施的修改意见。",
      idempotencyKey: `demo_${stamp}_1`,
    });
    await wait(1800);
    if (queueFor(worker.id).length || worker.execution === "running") await api.markReady(worker.id);
    await api.send(current.id, {
      senderId: lead.participantId,
      source: "agent",
      text: `@${worker.alias} 请核对 native session 绑定、输入提交和重试边界，附上产物。`,
      mentionParticipantIds: [worker.participantId],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_2`,
    });
    await wait(2600);
    const review = new File(
      ["# Delivery review\n\n- 提交结果不明时记录为 uncertain，再通过原生记录回读确认。\n- 重试前核对 binding epoch。\n"],
      "delivery-review.md",
      { type: "text/markdown" },
    );
    const artifact = await api.uploadArtifact({
      name: review.name,
      mime: review.type,
      contentBase64: await readBase64(review),
      conversationId: current.id,
      createdBy: worker.participantId,
    });
    await api.send(current.id, {
      senderId: worker.participantId,
      source: "agent",
      text: "核对完成。建议把提交结果不明单独记录为 uncertain，再通过原生记录确认。产物已附上。",
      artifactIds: [artifact.id],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_3`,
    });
    toast("演示完成 · 打开信息流查看完整 Trace");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    ui.demoRunning = false;
    await refresh();
  }
}

// ── mention menu ──────────────────────────────────────────────────────────

function mentionQuery() {
  const input = $("messageInput") as HTMLTextAreaElement;
  const before = input.value.slice(0, input.selectionStart);
  return /(^|\s)@([\w-]*)$/.exec(before)?.[2];
}

function renderMentionMenu() {
  const menu = $("mentionMenu");
  const query = ui.selection.kind === "room" ? mentionQuery() : undefined;
  const options =
    query === undefined
      ? []
      : room()
          .members.map((id) => session(id)!)
          .filter((s) => s.alias.toLowerCase().startsWith(query.toLowerCase()));
  menu.hidden = !options.length;
  ui.mentionIndex = Math.min(ui.mentionIndex, Math.max(0, options.length - 1));
  menu.innerHTML = options
    .map(
      (s, i) =>
        `<button type="button" class="${i === ui.mentionIndex ? "active" : ""}" data-mention="${s.alias}"><span class="avatar ${s.provider === "Claude" ? "claude" : ""}">${initial(s)}</span><b>@${escapeHtml(s.alias)}</b><small>${escapeHtml(s.name)} · ${stateLabels[statusFor(s)]}</small></button>`,
    )
    .join("");
}

function insertMention(alias: string) {
  const input = $("messageInput") as HTMLTextAreaElement;
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret).replace(/@([\w-]*)$/, `@${alias} `);
  input.value = before + input.value.slice(caret);
  input.selectionStart = input.selectionEnd = before.length;
  input.focus();
  renderMentionMenu();
}

// ── events ────────────────────────────────────────────────────────────────

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button || button.disabled || !ui.model) return;
  const data = button.dataset;
  const current = room();
  if (data.room) selectRoom(data.room);
  else if (data.session) selectSession(data.session);
  else if (data.inspectSession) {
    ui.inspector = { kind: "session", id: data.inspectSession };
    $("inspector").classList.add("open");
    renderOffice();
    renderInspector();
    renderGraph();
  } else if (data.message) {
    ui.inspector = { kind: "message", id: data.message };
    renderInspector();
    $("inspector").classList.add("open");
  } else if (data.view) {
    ui.view = data.view as typeof ui.view;
    render();
  } else if (data.openRules) showRules(data.openRules as "room" | "global");
  else if (data.scope) showRules(data.scope as "room" | "global");
  else if (data.toggleSession) {
    const s = session(data.toggleSession)!;
    void act(() => api.setCommunication(s.id, !s.enabled), `${s.name} · 信息传递${s.enabled ? "关闭" : "开启"}`);
  } else if (data.addSession) {
    const s = session(data.addSession)!;
    if (current.members.length >= 6) return toast("每个房间视图最多展示 6 位成员");
    void act(async () => {
      await api.joinRoom(current.id, s.participantId);
    }, "成员已加入，历史可读，唤醒按房间规则执行");
  } else if (data.leaveSession) {
    const s = session(data.leaveSession)!;
    void act(async () => {
      await api.leaveRoom(current.id, s.participantId);
      if (ui.inspector?.id === s.id) ui.inspector = null;
    }, "已退出房间；原生 session 仍在来源树中");
  } else if (data.makeCoordinator) {
    const s = session(data.makeCoordinator)!;
    void act(() => api.setWakeMode(current.id, "coordinator", s.participantId), "已更新统筹路由：派发连线与先唤醒对象已切换");
  } else if (data.readySession) {
    void act(() => api.markReady(data.readySession!), "已标记就绪，按序检查待投递消息");
  } else if (data.wakeSession) {
    const s = session(data.wakeSession)!;
    if (!s.enabled || !s.writable) return toast("该 session 当前通信关闭或只读");
    void act(
      () =>
        api.send(current.id, {
          text: `（手动唤醒）请查看「${current.name}」的最新消息并继续。`,
          target: { kind: "participant", id: s.participantId },
          isManualWake: true,
        }),
      `已唤醒 ${s.name} · 不计入自动轮次`,
    );
  } else if (data.directSession) selectSession(data.directSession);
  else if (data.renameSession) {
    const s = session(data.renameSession)!;
    showNameDialog("重命名会话", "本地显示名称", s.name, "修改 Portage 元数据，保留原生 session 身份。", (name) =>
      act(() => api.updateSession(s.id, { displayName: name }), "已重命名"),
    );
  } else if (data.archiveSession) {
    const s = session(data.archiveSession)!;
    void act(async () => {
      await api.updateSession(s.id, { archived: true });
      ui.selection = { kind: "room", id: ui.roomId };
      ui.inspector = null;
      ui.view = "room";
    }, "本地关联已归档，房间历史保留");
  } else if (data.editMessage) {
    const message = model().messages.find((m) => m.id === data.editMessage)!;
    showNameDialog("修订消息", "新的正文", message.text, "保留消息 ID 与修订版本。已提交的投递保留原版本，排队中的投递使用新版本。", (text) =>
      act(() => api.revise(message.id, text), "已保存修订"),
    );
  } else if (data.hideMessage) {
    ui.hidden.add(data.hideMessage);
    localStorage.setItem("portage.hidden", JSON.stringify([...ui.hidden]));
    renderChat();
    toast("记录已在本地视图隐藏，Bus 历史保留");
  } else if (data.focusTrace) {
    ui.traceFilter = data.focusTrace;
    ui.view = "flow";
    if (ui.selection.kind === "session") ui.selection = { kind: "room", id: ui.roomId };
    render();
  } else if (data.showSnapshot) {
    const d = model().deliveries.find((x) => x.id === data.showSnapshot);
    if (d?.snapshot)
      showSnapshot(
        d.snapshot,
        "实际投递 query",
        `${senderName(d.recipient)} 收到的完整内容 · ${d.receipt?.nativeMessageId ?? "尚未提交"}`,
      );
  } else if (data.artifact) {
    const a = model().artifacts.find((x) => x.id === data.artifact);
    if (a) {
      void navigator.clipboard?.writeText(a.storageKey).catch(() => undefined);
      toast(`${a.originalName} v${a.version} · 路径已复制：${a.storageKey}`);
    }
  } else if (data.register) {
    const e = JSON.parse(data.register) as DiscoveredEndpoint;
    void act(async () => {
      await api.registerSession({
        provider: e.provider,
        host: e.host,
        harness: e.harness,
        nativeIdentity: e.nativeSessionId,
        displayName: e.displayName,
      });
      renderDiscover((await api.discover()).endpoints);
    }, "已登记，可拖入房间或直接对话");
  } else if (data.mention) insertMention(data.mention);
  else if (data.eventInfo) toast(data.eventInfo);
});

($("sessionSearch") as HTMLInputElement).addEventListener("input", renderSidebar);
$("workspaceButton").addEventListener("click", () => toast("个人工作区 · 数据保存在本机 ~/.portage"));
$("showInspector").addEventListener("click", () => $("inspector").classList.toggle("open"));
$("viewAllMessages").addEventListener("click", () => {
  ui.view = "chat";
  render();
});
$("reconnect").addEventListener("click", () => {
  ui.connected = false;
  void refresh();
});
$("addMember").addEventListener("click", () => {
  renderMemberOptions();
  ($("membersDialog") as HTMLDialogElement).showModal();
});
$("roomDropZone").addEventListener("click", () => $("addMember").click());
$("roomDropZone").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("addMember").click();
});
$("roomRules").addEventListener("click", () => showRules("room"));
$("globalRules").addEventListener("click", () => showRules("global"));
$("publishRules").addEventListener("click", () => void publishRules());
$("previewQuery").addEventListener("click", () => void previewQuery());
$("demoCollaboration").addEventListener("click", () => void demoCollaboration());
$("createSession").addEventListener("click", () => void showDiscover());
$("pauseRoom").addEventListener("click", () => {
  const current = room();
  void act(() => api.setPaused(current.id, !current.paused), current.paused ? "已恢复自动通信 · 暂缓项重新检查" : "已暂停自动通信 · 新投递进入暂缓");
});
$("wakeMode").addEventListener("change", (event) => {
  const mode = (event.target as HTMLSelectElement).value;
  const current = room();
  const lead = current.coordinator ? session(current.coordinator)?.participantId : undefined;
  void act(
    () => api.setWakeMode(current.id, mode, lead),
    mode === "coordinator"
      ? "统筹模式：显示派发连线，用户消息先到统筹者"
      : mode === "swarm"
        ? "Swarm：无固定连线，默认按 @ 唤醒"
        : `已切换为 ${modeLabel(mode)}`,
  );
});
$("traceFilter").addEventListener("change", (event) => {
  ui.traceFilter = (event.target as HTMLSelectElement).value;
  renderGraph();
});
$("pauseAnimation").addEventListener("click", () => {
  ui.animationPaused = !ui.animationPaused;
  renderGraph();
});
$("attachFile").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => {
  const file = ($("fileInput") as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("附件最大 8 MiB", "error");
  ui.attachment = file;
  renderComposer();
});
$("attachmentPreview").addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("#removeAttachment")) {
    ui.attachment = null;
    ($("fileInput") as HTMLInputElement).value = "";
    renderComposer();
  }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendFromComposer();
});
$("messageInput").addEventListener("input", () => {
  ui.mentionIndex = 0;
  renderMentionMenu();
});
$("messageInput").addEventListener("keydown", (event) => {
  const menu = $("mentionMenu");
  if (!menu.hidden) {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[data-mention]")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      ui.mentionIndex = (ui.mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderMentionMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(items[ui.mentionIndex]!.dataset.mention!);
      return;
    }
    if (event.key === "Escape") {
      menu.hidden = true;
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") ($("composer") as HTMLFormElement).requestSubmit();
});
$("messageInput").addEventListener("blur", () => setTimeout(() => ($("mentionMenu").hidden = true), 150));
$("createRoom").addEventListener("click", () =>
  showNameDialog("新建房间", "房间名称", "", "创建后从来源树拖入成员，或使用添加成员。新房间默认 Swarm。", async (name) => {
    try {
      const created = await api.createRoom(name);
      await refresh();
      selectRoom(created.id);
      toast("房间已创建");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }),
);
$("nameForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = ($("nameInput") as HTMLInputElement).value.trim();
  if (!value) return;
  ($("nameDialog") as HTMLDialogElement).close();
  void ui.nameAction?.(value);
});
$("closeName").addEventListener("click", () => ($("nameDialog") as HTMLDialogElement).close());
document.addEventListener("dragstart", (event) => {
  const id = (event.target as HTMLElement).closest<HTMLElement>("[data-session]")?.dataset.session;
  if (id) event.dataTransfer?.setData("text/portage-session", id);
});
document.addEventListener("dragover", (event) => {
  const target = (event.target as HTMLElement).closest("#roomDropZone,[data-drop-room],#office");
  if (!target) return;
  event.preventDefault();
  target.classList.add("drag-over");
});
document.addEventListener("dragleave", (event) =>
  (event.target as HTMLElement).closest("#roomDropZone,[data-drop-room],#office")?.classList.remove("drag-over"),
);
document.addEventListener("drop", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("#roomDropZone,[data-drop-room],#office");
  if (!target || !ui.model) return;
  event.preventDefault();
  target.classList.remove("drag-over");
  const id = event.dataTransfer?.getData("text/portage-session");
  const s = id ? session(id) : undefined;
  if (!s) return;
  const roomId = target.dataset.dropRoom ?? ui.roomId;
  if (room(roomId).members.includes(s.id)) return toast("这个 session 已经在房间里");
  void act(async () => {
    await api.joinRoom(roomId, s.participantId);
    ui.roomId = roomId;
    ui.selection = { kind: "room", id: roomId };
  }, `${s.name} 已加入 ${room(roomId).name}`);
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("sessionSearch").focus();
  }
});
window.addEventListener("focus", () => {
  if (ui.connected) scheduleRefresh();
});

void refresh();
requestAnimationFrame(animate);
