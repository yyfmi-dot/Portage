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

export function roomInspector() {
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
    .join("") || '<p class="inspector-caption">还没有成员，可拖入或添加。</p>'}</section><section class="inspector-section"><h3>通信预算</h3><div class="detail-row"><span>自动讨论轮次</span><strong>${current.rounds} / ${current.roundBudget}</strong></div><div class="budget-bar ${progress >= 100 ? "over" : ""}"><i style="width:${progress}%"></i></div><div class="detail-row"><span>近 1 分钟 agent 消息</span><strong>${current.autoMessages} / ${current.messageBudget}</strong></div><div class="budget-bar ${rate >= 100 ? "over" : ""}"><i style="width:${rate}%"></i></div><div class="detail-row"><span>活跃席位</span><strong>${current.runningSeats} / ${current.maxConcurrent}</strong></div><div class="seat-row">${Array.from({ length: current.maxConcurrent }, (_, i) => `<i class="${i < current.runningSeats ? "on" : ""}"></i>`).join("")}</div><div class="detail-row"><span>当前链路唤醒</span><strong>${current.traceWakeups} / ${current.maxWakeups}</strong></div><div class="budget-bar ${current.traceWakeups >= current.maxWakeups ? "over" : ""}"><i style="width:${Math.min(100, (current.traceWakeups / current.maxWakeups) * 100)}%"></i></div><div class="detail-row"><span>房间模式</span><strong>${modeLabel(current.mode)}</strong></div></section><section class="inspector-section"><div class="policy-card"><span>collaboration.md <b>v${current.revision}</b></span><p>${escapeHtml(policyDocumentBody(current.document).split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ") || "约束与指导：通信约定、可见范围与预算。不改写各 session 原有身份。")}</p><button data-open-rules="room">编辑规则 ↗</button></div></section><section class="inspector-section"><h3>共享产物 <span class="muted">${artifacts.length}</span></h3>${artifacts.map(artifactMarkup).join("") || '<p class="inspector-caption">消息附件会出现在这里。</p>'}</section>`;
}

/** The proof ladder the user can trust: written → submitted → agent read. Only proven rungs are lit. */
export function proofSteps(item: VDelivery) {
  const native = Boolean(session(item.recipient)?.adapterId);
  const steps = [
    { label: "已提交", on: item.state === "submitted" && Boolean(item.receipt), at: item.receipt?.observedAt },
    ...(native ? [{ label: "原生记录已确认", on: Boolean(item.confirmed), at: item.confirmed?.observedAt }] : []),
    ...(item.tracksRead || item.ack ? [{ label: "agent 已读", on: Boolean(item.ack), at: item.ack?.observedAt }] : []),
  ];
  return `<div class="proof-steps">${steps
    .map(
      (s) =>
        `<span class="${s.on ? "on" : ""}" title="${s.at ? new Date(s.at).toLocaleTimeString("zh-CN") : "尚无凭据"}"><i></i>${s.label}</span>`,
    )
    .join("")}</div>`;
}

export const cancellable = (d: VDelivery) => d.state === "queued" || d.state === "held";

export function proofMarkup(item: VDelivery) {
  const snap = item.context;
  const detail =
    item.state === "submitted"
      ? `${escapeHtml(item.receipt?.proofLevel ?? "submitted")} · ${escapeHtml(item.receipt?.adapterId ?? "")} · epoch ${item.receipt?.bindingEpoch ?? 1}${item.ack ? ` · agent_ack ${timeLabel(Date.parse(item.ack.observedAt))}` : item.tracksRead ? " · 尚未被 agent 读取" : item.confirmed ? "" : " · 该会话未接入 MCP，无读取凭据"}`
      : waitMarkup(item);
  return `<div class="proof-card"><div class="proof-head"><b>${escapeHtml(senderName(item.recipient))}</b><span class="proof-state ${item.ack ? "read" : item.state}">${item.ack ? "已读" : deliveryStateLabels[item.state] ?? item.state}</span></div>${item.state === "submitted" ? proofSteps(item) : ""}<small>${detail}<br>规则 v${item.revision ?? room().revision} · 消息 v${item.messageRevision}${snap ? ` · ${snap.hash} · ${formatBytes(snap.byteSize)}` : ""}</small>${item.receipt?.nativeMessageId ? `<code title="${escapeHtml(item.receipt.nativeMessageId)}">${escapeHtml(item.receipt.nativeMessageId.split(/[\\/]/).slice(-3).join("/"))}</code>` : ""}${snap ? `<button class="wide-button" data-show-snapshot="${item.id}">查看实际投递 query</button>` : ""}${cancellable(item) ? `<button class="wide-button leave-button" data-cancel-delivery="${item.id}">取消这份投递</button>` : ""}</div>`;
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
  const rows = [
    `<div class="detail-row"><span>信息传递</span><button class="toggle" role="switch" aria-label="${escapeHtml(item.name)}信息传递" aria-checked="${item.enabled}" data-toggle-session="${item.id}"></button></div>`,
    `<div class="detail-row"><span>原生执行</span><strong>${stateLabels[item.execution]}</strong></div>`,
    item.detail ? `<p class="host-detail">${escapeHtml(item.detail)}</p>` : "",
    `<div class="detail-row"><span>输入方式</span><strong>${!item.writable ? "只读" : item.adapterId ? `原生回合 · ${escapeHtml(item.adapterId)}` : "文件收件箱"}</strong></div>`,
    item.workdir ? `<div class="detail-row"><span>工作目录</span><strong class="mono" title="${escapeHtml(item.workdir)}">${escapeHtml(item.workdir.split("/").slice(-2).join("/"))}</strong></div>` : "",
    item.adapterId
      ? `<div class="detail-row"><span>原生回读</span><strong class="${cp?.error ? "warn" : ""}" title="${escapeHtml(cp?.error ?? cp?.source ?? "")}">${!cp ? "尚未同步" : cp.error ? "回读缺口" : `已同步 · ${cp.lastSuccessAt ? timeLabel(Date.parse(cp.lastSuccessAt)) : "—"}`}</strong></div>`
      : "",
    `<div class="detail-row"><span>读取凭据</span><strong title="${lastAck ? "该会话的 agent 通过 MCP 读取过消息" : "该会话还没有通过 MCP 读取过消息"}">${lastAck ? `MCP 已接入 · ${timeLabel(Date.parse(lastAck.observedAt))}` : "未接入 MCP"}</strong></div>`,
    `<div class="detail-row"><span>规则版本</span><strong>已注入 v${last?.revision ?? "—"} / 已发布 v${current.revision}</strong></div>`,
    `<div class="detail-row"><span>房间路由</span><strong>${isCoordinator ? "当前统筹者" : inRoom ? "普通成员" : "非本房成员"}</strong></div>`,
  ].join("");
  const queue = pending.length
    ? pending
        .map(
          (d) =>
            `<div class="delivery-item"><b>${escapeHtml(model().messages.find((m) => m.id === d.messageId)?.text.slice(0, 45) ?? "消息")}</b><small>${waitMarkup(d)}</small><button class="text-button" data-cancel-delivery="${d.id}">取消</button></div>`,
        )
        .join("")
    : '<p class="inspector-caption">当前收件箱为空。</p>';
  const actions = [
    rebound ? `<button class="wide-button primary-action" data-confirm-binding="${item.id}">确认新绑定 · 放行 ${rebound} 条</button>` : "",
    item.adapterId && item.execution === "running" ? `<button class="wide-button" data-interrupt-session="${item.id}">中断当前原生回合</button>` : "",
    `<button class="wide-button" data-ready-session="${item.id}">标记原生就绪</button>`,
    inRoom ? `<button class="wide-button" data-wake-session="${item.id}">唤醒一次</button>` : "",
    inRoom && current.mode === "coordinator" && !isCoordinator ? `<button class="wide-button" data-make-coordinator="${item.id}">设为统筹者</button>` : "",
    last ? `<button class="wide-button" data-show-snapshot="${last.id}">查看最近投递 query</button>` : "",
  ].join("");
  return `<div class="inspector-heading"><h2>会话详情</h2><span>SESSION</span></div><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><div class="inspector-title">${escapeHtml(item.name)}</div><div class="inspector-caption">${item.provider} / ${item.host} · @${escapeHtml(item.alias)}<br><span class="mono">${escapeHtml(item.nativeIdentity)} · epoch ${item.bindingEpoch}</span></div><section class="inspector-section">${rows}</section><section class="inspector-section"><h3>收件箱 · ${pending.length} 排队</h3><p class="inspector-caption">每位成员独立队列；忙或预算不足时暂缓，就绪后按序投递。不设工种角色。</p>${queue}${actions}</section><section class="inspector-section"><h3>会话管理</h3><button class="wide-button" data-direct-session="${item.id}">与这个 session 对话</button>${item.adapterId ? `<button class="wide-button" data-native-session="${item.id}">查看原生记录</button>` : ""}${inRoom ? `<button class="wide-button leave-button" data-leave-session="${item.id}">退出当前房间</button>` : `<button class="wide-button" data-add-session="${item.id}">加入当前房间</button>`}<button class="wide-button" data-rename-session="${item.id}">重命名本地显示</button><button class="wide-button" data-archive-session="${item.id}">归档本地关联</button><p class="inspector-caption">退出房间不影响原生 session；仅停止本房间自动唤醒。原生身份与正在干的活由宿主决定。</p></section>`;
}

export function messageInspector(message?: VMessage) {
  if (!message) return roomInspector();
  const deliveries = deliveriesFor(message.id);
  return `<div class="inspector-heading"><h2>消息与链路</h2><span>TRACE</span></div><div class="inspector-title">${escapeHtml(senderName(message.sender))}</div><p class="inspector-caption mono">${message.id}<br>${message.traceId}<br>${message.parentId ? `上游 ${message.parentId}` : "链路起点"}</p><section class="inspector-section"><p class="inspector-message-body">${escapeHtml(message.text)}</p>${message.artifacts.map(artifactMarkup).join("")}</section><section class="inspector-section"><h3>逐接收方投递</h3>${deliveries.length ? deliveries.map(proofMarkup).join("") : '<p class="inspector-caption">写入房间历史，成员可读。本条未触发自动唤醒。</p>'}</section><section class="inspector-section"><h3>原始内容与上下文</h3><p class="inspector-caption">规则按接收方编译一次，消息来源与实际投递版本独立保留。</p><button class="wide-button" data-focus-trace="${message.traceId}">在信息流中定位</button></section>`;
}
