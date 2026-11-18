import { $, stationPositions, stateLabels, reasonShort, type VSession, ui, model, session, room } from "./state.js";
import { isUnread } from "./model.js";
import { escapeHtml, memberBadge, statusFor, queueFor, modeLabel, sparkline } from "./format.js";

export const poppedSpeech = new Set<string>();

export function speechMarkup(id: string, now: number, tag: "span" | "i") {
  const speech = ui.speaking.get(id);
  if (!speech || speech.until <= now || speech.roomId !== ui.roomId) return "";
  const key = `${id}:${speech.until}`;
  const pop = !poppedSpeech.has(key);
  poppedSpeech.add(key);
  const text = speech.text.length > 54 ? `${speech.text.slice(0, 54)}…` : speech.text;
  return `<${tag} class="speech ${pop ? "pop" : ""}">${escapeHtml(text)}</${tag}>`;
}

export function renderOffice() {
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
      const waiting = queueFor(id);
      const heldOnly = waiting.length > 0 && waiting.every((d) => d.state === "held");
      const stack = waiting.length
        ? `<span class="inbox-stack ${heldOnly ? "held" : ""}" title="${waiting.length} 条待投递 · ${escapeHtml(reasonShort[waiting[0]!.reason] ?? "排队")}">${"<i></i>".repeat(Math.min(3, waiting.length))}</span>`
        : "";
      // Top-row bubbles open sideways (toward the room's centre) so they never leave the stage.
      const placement = position[1] < 45 ? `row-top ${position[0] > 60 ? "col-right" : "col-left"}` : "";
      return `<button class="workstation ${status} ${placement} ${selected ? "selected" : ""} ${receiving ? "receiving" : ""} ${justRead ? "just-read" : ""} ${unread ? "has-unread" : ""} ${speech ? "speaking" : ""}" data-inspect-session="${id}" style="left:${position[0]}%;top:${position[1]}%;--agent-color:${item.color}" aria-label="${escapeHtml(item.name)}${badge ? `，${badge}` : ""}，${stateLabels[status]}${count ? `，${count} 条排队` : ""}"><span class="station-label"><b>${escapeHtml(item.name)}${badge ? `<span class="station-role">${badge}</span>` : ""}</b><small>${item.provider} / ${item.host}</small></span><span class="floor-glow"></span><span class="desk"></span><span class="lamp"><i></i></span><span class="monitor"><i class="screen-lines"></i></span>${stack}<span class="agent-figure"><i class="agent-head"></i><i class="agent-body"></i></span>${status === "dormant" ? '<span class="sleep-symbol">z z</span>' : ""}${status === "waiting_human" ? '<span class="attention-ring"></span><span class="raise-hand" aria-hidden="true">!</span>' : ""}<span class="delivered-tag">已投递 ↓</span><span class="read-tag">已读 ✓</span>${unread ? `<span class="unread-dot" title="${unread} 条已投递、agent 尚未读取"></span>` : ""}${speech}${item.detail && status !== "running" ? `<span class="host-note" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail.length > 22 ? `${item.detail.slice(0, 22)}…` : item.detail)}</span>` : ""}<span class="station-state"><span class="state-pill">${stateLabels[status]}</span>${count ? `<span class="queue-tag">＋${count} 等待</span>` : ""}${unread ? `<span class="unread-tag">${unread} 未读</span>` : ""}</span></button>`;
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
  $("roomPulse").innerHTML = `${sparkline(current.pulse)}<small>近 12 分钟</small>`;
  const seatsFull = current.runningSeats >= current.maxConcurrent;
  $("roomSummary").innerHTML = `<span><b>${active}</b>工作中</span><span><b>${dormant}</b>未唤醒</span><span><b>${queued}</b>收件箱排队</span><span title="${bridged ? "已投递到原生收件箱、agent 尚未读取（仅统计已接入 MCP 的成员）" : "还没有成员通过 MCP 读取过消息，无法统计未读"}"><b>${bridged ? unread : "—"}</b>未读</span><span title="同时处于工作中的成员 / 自动唤醒席位上限；满员时 agent 发起的唤醒排队等待，你的消息不受限" class="${seatsFull ? "over" : ""}"><b>${current.runningSeats}/${current.maxConcurrent}</b>活跃席位</span><span title="当前链路已用自动轮次 / 上限" class="${current.rounds >= current.roundBudget ? "over" : ""}"><b>${current.rounds}/${current.roundBudget}</b>自动轮次</span><span><b>${modeLabel(current.mode)}</b></span>`;
  renderAttention(members);
  $("dispatchLegend").hidden = !(current.mode === "coordinator" && current.coordinator && members.length > 1);
  $("roomDropZone").hidden = current.members.length >= 6;
  ($("demoCollaboration") as HTMLButtonElement).disabled = ui.demoRunning;
}

/** Members that stopped to ask the user something — the one thing in the room that needs you. */
export function renderAttention(members: VSession[]) {
  const waiting = members.filter((m) => m.enabled && m.execution === "waiting_human");
  const bar = $("attentionBar");
  bar.hidden = !waiting.length;
  if (!waiting.length) return;
  const first = waiting[0]!;
  bar.innerHTML = `<span class="attention-icon">!</span><span><b>${escapeHtml(waiting.map((m) => m.name).join("、"))}</b> 在等你处理 · 原生会话暂停在需要人确认的地方</span><button data-inspect-session="${first.id}">查看</button><button data-direct-session="${first.id}">去回复 ↗</button>`;
}
