import { $, graphPositions, stateLabels, reasonShort, deliveryStateLabels, type VSession, ui, model, session, room } from "./state.js";
import { escapeHtml, memberBadge, senderName, statusFor, timeLabel, modeLabel, waitMarkup } from "./format.js";

export function roomEvents(roomId: string) {
  const current = room(roomId);
  return model().events.filter(
    (e) =>
      e.roomId === roomId ||
      (e.roomId === null && (e.sessionId ? current.members.includes(e.sessionId) : true)),
  );
}

export function renderActivity() {
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

export function renderGraph() {
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
  const uncertain = count("uncertain");
  $("deliveryBoard").innerHTML = `<div class="board-stat-row"><div class="board-stat"><b>${count("queued")}</b><span>排队</span></div><div class="board-stat"><b>${count("held")}</b><span>暂缓</span></div><div class="board-stat"><b>${count("submitted")}</b><span>已提交</span></div>${uncertain ? `<div class="board-stat warn"><b>${uncertain}</b><span>结果不明</span></div>` : ""}</div>${
    open.length
      ? open
          .map((d) => {
            const message = model().messages.find((m) => m.id === d.messageId);
            return `<button class="board-item ${d.state}" data-message="${d.messageId}"><b>${escapeHtml(senderName(d.recipient))} · ${deliveryStateLabels[d.state] ?? d.state}${d.reason ? `<span class="reason-chip">${escapeHtml(reasonShort[d.reason] ?? d.reason)}</span>` : ""}</b><small>${escapeHtml(message?.text.slice(0, 48) ?? d.messageId)}<br>${waitMarkup(d)} · 规则 v${d.revision ?? room().revision}</small></button>`;
          })
          .join("")
      : '<p class="inspector-caption" style="color:#7f9186;padding:8px 2px">收件箱空闲。每位成员有独立队列。</p>'
  }<p class="inspector-caption" style="color:#7f9186;padding-top:12px">自动轮次 ${room().rounds}/${room().roundBudget} · 达上限后自动唤醒停止</p>`;
  $("pauseAnimation").textContent = ui.animationPaused ? "恢复动画" : "暂停动画";
}
