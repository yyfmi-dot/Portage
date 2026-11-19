import { policyDocumentBody } from "@portage/core";
import { $, stateLabels, deliveryStateLabels, type VSession, type VMessage, type VDelivery, ui, model, session, room } from "./state.js";
import { escapeHtml, memberBadge, senderName, statusFor, queueFor, timeLabel, initial, modeLabel, waitMarkup, formatBytes } from "./format.js";
import { deliveriesFor, artifactMarkup } from "./chat.js";

export function renderInspector() {
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
  const open = new Set([...inspector.querySelectorAll<HTMLDetailsElement>("details[data-key][open]")].map((d) => d.dataset.key));
  // The entrance plays once per switch. The class must not linger: any later refresh rebuilds the
  // children, and a lingering class would replay the animation from opacity 0 (a blank flash).
  inspector.classList.remove("enter");
  inspector.innerHTML = content;
  if (!switched) for (const d of inspector.querySelectorAll<HTMLDetailsElement>("details[data-key]")) d.open = open.has(d.dataset.key);
  inspector.scrollTop = scroll;
  if (switched) {
    void inspector.offsetWidth; // restart the animation on the freshly built children
    inspector.classList.add("enter");
    window.setTimeout(() => inspector.classList.remove("enter"), 360);
  }
}

/** Raw identifiers for debugging, folded away; `key` keeps it open across live refreshes. */
function techDetails(key: string, rows: Array<[string, unknown]>) {
  const items = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!items.length) return "";
  return `<details class="tech-details" data-key="${key}"><summary>技术细节</summary><dl>${items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl></details>`;
}

const meter = (label: string, used: number, max: number, title = "") =>
  `<div class="detail-row" title="${escapeHtml(title)}"><span>${label}</span><strong>${used} / ${max}</strong></div><div class="budget-bar ${used >= max ? "over" : ""}"><i style="width:${Math.min(100, (used / Math.max(1, max)) * 100)}%"></i></div>`;

export function roomInspector() {
  const current = room();
  const artifacts = model().artifacts.filter((a) => a.conversationId === current.id);
  const excerpt =
    policyDocumentBody(current.document).split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ") ||
    "写下这个房间的协作方式：谁负责什么、怎么交接。它会随每条消息一起送给成员，不会改写它们原来的身份。";
  const members = current.members
    .map((id) => {
      const item = session(id)!;
      const badge = memberBadge(item);
      return `<button class="inspector-member" data-inspect-session="${id}"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small>${badge ? `${badge} · ` : ""}${item.provider} · ${item.host}</small></span><span class="member-state">${stateLabels[statusFor(item)]}</span></button>`;
    })
    .join("");
  return `<div class="inspector-heading"><h2>房间概览</h2><span class="live-tag"><i class="live-dot"></i>实时</span></div><div class="inspector-title">${escapeHtml(current.name)}</div><p class="inspector-caption">${escapeHtml(modeLabel(current.mode))}</p><section class="inspector-section"><h3>成员 <span class="muted">${current.members.length}</span></h3>${members || '<p class="inspector-caption">还没有成员。把左侧的会话拖进房间，或点「添加成员」。</p>'}</section><section class="inspector-section"><h3>自动协作额度</h3>${meter("自动讨论轮次", current.rounds, current.roundBudget, "AI 之间来回接力的轮次；到上限后停下来等你")}${meter("近 1 分钟 AI 消息", current.autoMessages, current.messageBudget)}<div class="detail-row" title="同时在工作的成员 / 上限；满了以后 AI 之间的唤醒会排队，你的消息不受影响"><span>同时工作</span><strong>${current.runningSeats} / ${current.maxConcurrent}</strong></div><div class="seat-row">${Array.from({ length: current.maxConcurrent }, (_, i) => `<i class="${i < current.runningSeats ? "on" : ""}"></i>`).join("")}</div>${meter("这条链路的唤醒", current.traceWakeups, current.maxWakeups)}</section><div class="policy-card" style="margin-top:12px"><span>协作约定<b>v${current.revision}</b></span><p>${escapeHtml(excerpt)}</p><button data-open-rules="room">编辑约定</button></div><section class="inspector-section"><h3>共享文件 <span class="muted">${artifacts.length}</span></h3>${artifacts.map(artifactMarkup).join("") || '<p class="inspector-caption">消息里附带的文件会收在这里。</p>'}</section>`;
}

/** The proof ladder the user can trust: handed over → its own record shows it → it read it. Only proven rungs are lit. */
export function proofSteps(item: VDelivery) {
  const native = Boolean(session(item.recipient)?.adapterId);
  const steps = [
    { label: "已送进会话", on: item.state === "submitted" && Boolean(item.receipt), at: item.receipt?.observedAt },
    ...(native ? [{ label: "记录里确认", on: Boolean(item.confirmed), at: item.confirmed?.observedAt }] : []),
    ...(item.tracksRead || item.ack ? [{ label: "已读", on: Boolean(item.ack), at: item.ack?.observedAt }] : []),
  ];
  return `<div class="proof-steps">${steps
    .map(
      (s) =>
        `<span class="${s.on ? "on" : ""}" title="${s.at ? new Date(s.at).toLocaleTimeString("zh-CN") : "还没有凭据"}"><i></i>${s.label}</span>`,
    )
    .join("")}</div>`;
}

export const cancellable = (d: VDelivery) => d.state === "queued" || d.state === "held";

/** One sentence on how far this delivery provably got. */
function proofSentence(item: VDelivery) {
  if (item.state !== "submitted") return waitMarkup(item);
  const at = (r?: { observedAt: string }) => (r ? timeLabel(Date.parse(r.observedAt)) : "");
  const parts = [`${at(item.receipt)} 送进了它的会话`];
  if (item.confirmed) parts.push(`${at(item.confirmed)} 它的会话记录里确认收到`);
  if (item.ack) parts.push(`${at(item.ack)} 它读过了`);
  else if (item.tracksRead) parts.push("它还没读");
  else if (!item.confirmed) parts.push("它没接入 MCP，无法回执已读");
  return parts.join("，");
}

export function proofMarkup(item: VDelivery) {
  const snap = item.context;
  const tech = techDetails(`proof:${item.id}`, [
    ["凭据级别", [item.receipt?.proofLevel, item.confirmed && "native_confirmed", item.ack && "agent_ack"].filter(Boolean).join(" → ")],
    ["适配器", item.receipt?.adapterId],
    ["绑定代数 epoch", item.receipt?.bindingEpoch],
    ["用的约定", `房间 v${item.revision ?? room().revision} · 消息 v${item.messageRevision}`],
    ["投递内容", snap ? `${snap.hash} · ${formatBytes(snap.byteSize)}` : ""],
    ["原生记录位置", item.receipt?.nativeMessageId],
    ["投递 ID", item.id],
  ]);
  return `<div class="proof-card"><div class="proof-head"><b>${escapeHtml(senderName(item.recipient))}</b><span class="proof-state ${item.ack ? "read" : item.state}">${item.ack ? "已读" : deliveryStateLabels[item.state] ?? item.state}</span></div>${item.state === "submitted" ? proofSteps(item) : ""}<p class="proof-sentence">${proofSentence(item)}</p>${snap ? `<button class="wide-button" data-show-snapshot="${item.id}">看它实际收到的完整内容</button>` : ""}${cancellable(item) ? `<button class="wide-button leave-button" data-cancel-delivery="${item.id}">取消这次送达</button>` : ""}${tech}</div>`;
}

/** What the member is doing and how messages reach it, in one sentence. */
function statusSentence(item: VSession, inRoom: boolean) {
  const status = statusFor(item);
  const wakes = inRoom ? "有新消息会被自动唤醒" : "这个房间的消息不会叫醒它，私聊可以";
  return (
    {
      running: "正在工作，新消息会在它忙完后送达",
      idle: `就绪，${wakes}`,
      dormant: `有一阵没动静了，${wakes}`,
      waiting_human: "它停下来在等你确认，去私聊回复它",
      disabled: "关闭了接收消息，打开开关后才会送达",
      offline: "不在线，消息会等它回来",
      unknown: "暂时看不到它的状态",
    } as Record<string, string>
  )[status] ?? stateLabels[status];
}

export function sessionInspector(item: VSession) {
  const pending = queueFor(item.id);
  const current = room();
  const inRoom = current.members.includes(item.id);
  const isCoordinator = current.mode === "coordinator" && current.coordinator === item.id;
  const last = model()
    .deliveries.filter((d) => d.recipient === item.id && d.context)
    .at(-1);
  const lastAck = model()
    .deliveries.filter((d) => d.recipient === item.id && d.ack)
    .map((d) => d.ack!)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .at(-1);
  const rebound = pending.filter((d) => d.reason === "identity_changed").length;
  const cp = item.checkpoint;
  const status = statusFor(item);
  const ruleRow = !last
    ? "还没收到过"
    : (last.revision ?? 0) >= current.revision
      ? `最新 v${current.revision}`
      : `v${last.revision}，最新是 v${current.revision}`;
  const rows = [
    `<div class="detail-row"><span>接收消息</span><button class="toggle" role="switch" aria-label="${escapeHtml(item.name)}接收消息" aria-checked="${item.enabled}" data-toggle-session="${item.id}"></button></div>`,
    `<div class="detail-row"><span>消息怎么送达</span><strong title="${item.adapterId ? "Portage 以它自己的身份续上一轮对话" : "放进收件箱，它通过 MCP 来取"}">${!item.writable ? "只读，无法送入" : item.adapterId ? "直接续上它的对话" : "放进它的收件箱"}</strong></div>`,
    item.adapterId
      ? `<div class="detail-row"><span>读回它的记录</span><strong class="${cp?.error ? "warn" : ""}" title="${escapeHtml(cp?.error ?? "")}">${!cp ? "还没同步" : cp.error ? "读取中断" : `已同步 · ${cp.lastSuccessAt ? timeLabel(Date.parse(cp.lastSuccessAt)) : "—"}`}</strong></div>`
      : "",
    `<div class="detail-row"><span>已读回执</span><strong title="${lastAck ? "它通过 MCP 回执过已读" : "它还没有通过 MCP 回执过已读"}">${lastAck ? `有 · 最近 ${timeLabel(Date.parse(lastAck.observedAt))}` : "还没有"}</strong></div>`,
    `<div class="detail-row"><span>用的约定</span><strong>${ruleRow}</strong></div>`,
    `<div class="detail-row"><span>在房间里</span><strong>${isCoordinator ? "统筹者" : inRoom ? "成员" : "不在这个房间"}</strong></div>`,
  ].join("");
  const queue = pending.length
    ? pending
        .map(
          (d) =>
            `<div class="delivery-item"><b>${escapeHtml(model().messages.find((m) => m.id === d.messageId)?.text.slice(0, 45) ?? "消息")}</b><small>${waitMarkup(d)}</small><button class="text-button" data-cancel-delivery="${d.id}">取消</button></div>`,
        )
        .join("")
    : '<p class="inspector-caption">没有待送达的消息。</p>';
  const actions = [
    rebound ? `<button class="wide-button primary-action" data-confirm-binding="${item.id}">确认新身份，放行 ${rebound} 条</button>` : "",
    item.adapterId && item.execution === "running" ? `<button class="wide-button" data-interrupt-session="${item.id}">打断它这一轮</button>` : "",
    inRoom ? `<button class="wide-button" data-wake-session="${item.id}">叫醒它一次</button>` : "",
    inRoom && current.mode === "coordinator" && !isCoordinator ? `<button class="wide-button" data-make-coordinator="${item.id}">设为统筹者</button>` : "",
    `<button class="wide-button" data-ready-session="${item.id}">标记为就绪</button>`,
    last ? `<button class="wide-button" data-show-snapshot="${last.id}">看它最近收到的完整内容</button>` : "",
  ].join("");
  const tech = techDetails(`session:${item.id}`, [
    ["原生会话 ID", item.nativeIdentity],
    ["绑定代数 epoch", item.bindingEpoch],
    ["适配器", item.adapterId ?? "file-inbox"],
    ["工作目录", item.workdir],
    ["回读文件", cp ? `${cp.source} · 游标 ${cp.cursor}` : ""],
    ["宿主说明", item.detail],
    ["Portage ID", item.id],
  ]);
  return `<div class="inspector-heading"><h2>成员详情</h2><span>@${escapeHtml(item.alias)}</span></div><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><div class="inspector-title">${escapeHtml(item.name)}</div><p class="inspector-caption">${item.provider} · ${item.host}${item.workdir ? ` · ${escapeHtml(item.workdir.split("/").slice(-1)[0])}` : ""}</p><div class="status-hero ${status}"><i></i><span><b>${stateLabels[status]}</b>${statusSentence(item, inRoom)}</span></div>${item.detail && status !== "running" ? `<p class="host-detail">${escapeHtml(item.detail)}</p>` : ""}<section class="inspector-section">${rows}</section><section class="inspector-section"><h3>待送达 <span class="muted">${pending.length}</span></h3>${queue}${actions}</section><section class="inspector-section"><h3>管理</h3><button class="wide-button" data-direct-session="${item.id}">私聊</button>${item.adapterId ? `<button class="wide-button" data-native-session="${item.id}">看它自己的会话记录</button>` : ""}${inRoom ? `<button class="wide-button leave-button" data-leave-session="${item.id}">移出房间</button>` : `<button class="wide-button" data-add-session="${item.id}">加入这个房间</button>`}<button class="wide-button" data-rename-session="${item.id}">改个名字</button><button class="wide-button" data-archive-session="${item.id}">从 Portage 归档</button><p class="inspector-caption" style="margin-top:10px">移出或归档只影响 Portage，它原来的会话和记忆都不会动。</p></section>${tech}`;
}

export function messageInspector(message?: VMessage) {
  if (!message) return roomInspector();
  const deliveries = deliveriesFor(message.id);
  const parent = message.parentId ? model().messages.find((m) => m.id === message.parentId) : undefined;
  const where = message.direct ? "私聊" : model().rooms.find((r) => r.id === message.conversationId)?.name ?? "";
  const tech = techDetails(`message:${message.id}`, [
    ["消息 ID", message.id],
    ["链路 ID", message.traceId],
    ["回应的消息", message.parentId],
    ["版本", `v${message.revision}`],
  ]);
  return `<div class="inspector-heading"><h2>消息详情</h2><span>${timeLabel(message.at)}</span></div><div class="inspector-title">${escapeHtml(senderName(message.sender))}</div><p class="inspector-caption">${escapeHtml(where)}${parent ? ` · 回应 ${escapeHtml(senderName(parent.sender))}` : " · 一条新话题"}</p><section class="inspector-section"><p class="inspector-message-body">${escapeHtml(message.text)}</p>${message.artifacts.map(artifactMarkup).join("")}</section><section class="inspector-section"><h3>送达情况 <span class="muted">${deliveries.length}</span></h3>${deliveries.length ? deliveries.map(proofMarkup).join("") : '<p class="inspector-caption">只记在房间里，成员都能看到，这条没有唤醒任何人。</p>'}<button class="wide-button" data-focus-trace="${message.traceId}">在信息流里看这条链路</button></section>${tech}`;
}
