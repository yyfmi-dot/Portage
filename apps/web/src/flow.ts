import { $, graphPositions, userGraphPosition, stateLabels, type VSession, ui, model, session, room } from "./state.js";
import { escapeHtml, memberBadge, senderName, statusFor, timeLabel, modeLabel, waitMarkup, plural, deliveryChipLabel } from "./format.js";

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
  $("eventCounter").textContent = `${events.length}`;
  const fresh = new Set(events.filter((e) => e.seq > ui.flashedSeq && ui.flashedSeq > 0).map((e) => e.id));
  ui.flashedSeq = Math.max(ui.flashedSeq, ...events.map((e) => e.seq), 1);
  $("activityList").innerHTML = events.length
    ? events
        .map(
          (item) =>
            `<button class="activity-row ${fresh.has(item.id) ? "fresh" : ""}" ${item.messageId ? `data-message="${item.messageId}"` : `data-event-info="${escapeHtml(item.description)}"`}><time>${timeLabel(item.at)}</time><span class="event-description">${escapeHtml(item.description)}</span><span class="event-status ${item.wait ? "wait" : ""}">${escapeHtml(item.status)}</span><span class="muted">↗</span></button>`,
        )
        .join("")
    : '<p class="empty-state">No activity yet</p>';
}

export function renderGraph() {
  const all = model().messages.filter((m) => m.conversationId === ui.roomId);
  const traces = [...new Set(all.map((m) => m.traceId))];
  const filter = $("traceFilter") as HTMLSelectElement;
  filter.innerHTML =
    '<option value="all">All threads</option>' +
    traces
      .map((id) => {
        const first = all.find((m) => m.traceId === id)!;
        const text = first.text.replace(/\s+/g, " ");
        return `<option value="${id}">${escapeHtml(text.length > 36 ? `${text.slice(0, 36)}…` : text || "(attachment)")}</option>`;
      })
      .join("");
  if (ui.traceFilter !== "all" && !traces.includes(ui.traceFilter)) ui.traceFilter = "all";
  filter.value = ui.traceFilter;
  $("flowCount").textContent = `${plural(all.length, "message")} · ${modeLabel(room().mode)}`;
  const nodes = [
    { id: "user", name: "You", provider: "YOU", color: "", position: userGraphPosition },
    ...room().members.map((id, index) => ({ ...session(id)!, position: graphPositions[index % graphPositions.length]! })),
  ];
  $("graphNodes").innerHTML = nodes
    .map((item) => {
      const s = item.id === "user" ? null : (item as VSession);
      return `<button class="graph-node ${s ? "" : "user"} ${ui.inspector?.id === item.id ? "selected" : ""} ${(ui.receiving.get(item.id) ?? 0) > performance.now() ? "receiving" : ""}" ${s ? `data-inspect-session="${item.id}"` : 'data-event-info="You: your messages enter the room here"'} style="left:${item.position[0]}%;top:${item.position[1]}%${s ? `;--agent-color:${s.color}` : ""}"><span class="orb">${item.provider === "YOU" ? "You" : item.provider === "Codex" ? "C›" : "✳"}</span><b>${escapeHtml(item.name)}</b><small>${s ? `${memberBadge(s) ? `${memberBadge(s)} · ` : ""}${stateLabels[statusFor(s)]}` : "Messages start here"}</small></button>`;
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
          return `<button class="flow-event ${selected ? "selected" : ""}" ${item.messageId ? `data-message="${item.messageId}"` : `data-event-info="${escapeHtml(item.description)}"`}><time>${timeLabel(item.at)}</time><span><b>${escapeHtml(item.description)}</b><small>${escapeHtml(item.status)}</small><span class="chip ${item.wait ? "wait" : ""}">${item.messageId ? "Message" : "Status"}</span></span></button>`;
        })
        .join("")
    : '<p class="empty-state">Nothing has happened yet</p>';
  const roomDeliveries = model().deliveries.filter((d) => d.roomId === ui.roomId);
  const count = (state: string) => roomDeliveries.filter((d) => d.state === state).length;
  const open = roomDeliveries.filter((d) => d.state === "queued" || d.state === "held" || d.state === "uncertain");
  const uncertain = count("uncertain");
  $("deliveryBoard").innerHTML = `<div class="board-stat-row"><div class="board-stat"><b>${count("queued")}</b><span>Queued</span></div><div class="board-stat"><b>${count("held")}</b><span>Held</span></div><div class="board-stat"><b>${count("submitted")}</b><span>Delivered</span></div>${uncertain ? `<div class="board-stat warn"><b>${uncertain}</b><span>Checking</span></div>` : ""}</div>${
    open.length
      ? open
          .map((d) => {
            const message = model().messages.find((m) => m.id === d.messageId);
            return `<button class="board-item ${d.state}" data-message="${d.messageId}"><b>${escapeHtml(senderName(d.recipient))} · ${escapeHtml(deliveryChipLabel(d))}</b><small>${escapeHtml(message?.text.slice(0, 80) ?? d.messageId)}<br>${waitMarkup(d)}</small></button>`;
          })
          .join("")
      : '<p class="board-note">Every inbox is clear.</p>'
  }<p class="board-note">Auto discussion: ${room().rounds}/${room().roundBudget} rounds. It stops and waits for you at the limit.</p>`;
  $("pauseAnimation").textContent = ui.animationPaused ? "Resume motion" : "Pause motion";
}
