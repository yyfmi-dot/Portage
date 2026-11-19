import { $, stationPositions, stateLabels, reasonShort, type VSession, ui, model, session, room } from "./state.js";
import { isUnread } from "./model.js";
import { escapeHtml, memberBadge, statusFor, queueFor, sparkline, setHtml } from "./format.js";

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
      return `<button class="workstation ${status} ${placement} ${selected ? "selected" : ""} ${receiving ? "receiving" : ""} ${justRead ? "just-read" : ""} ${unread ? "has-unread" : ""} ${speech ? "speaking" : ""}" data-inspect-session="${id}" style="left:${position[0]}%;top:${position[1]}%;--agent-color:${item.color};--i:${index}" aria-label="${escapeHtml(item.name)}${badge ? `，${badge}` : ""}，${stateLabels[status]}${count ? `，${count} 条排队` : ""}"><span class="station-label"><b>${escapeHtml(item.name)}${badge ? `<span class="station-role">${badge}</span>` : ""}</b><small>${item.provider} / ${item.host}</small></span><span class="floor-glow"></span><span class="desk"></span><span class="lamp"><i></i></span><span class="monitor"><i class="screen-lines"></i></span>${stack}<span class="agent-figure"><i class="agent-head"></i><i class="agent-body"></i></span>${status === "dormant" ? '<span class="sleep-symbol">z z</span>' : ""}${status === "waiting_human" ? '<span class="attention-ring"></span><span class="raise-hand" aria-hidden="true">!</span>' : ""}<span class="delivered-tag">已送达 ↓</span><span class="read-tag">已读 ✓</span>${unread ? `<span class="unread-dot" title="${unread} 条已送达，它还没读"></span>` : ""}${speech}${item.detail && status !== "running" ? `<span class="host-note" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail.length > 22 ? `${item.detail.slice(0, 22)}…` : item.detail)}</span>` : ""}<span class="station-state"><span class="state-pill">${stateLabels[status]}</span>${count ? `<span class="queue-tag">${count} 条待送</span>` : ""}${unread ? `<span class="unread-tag">${unread} 未读</span>` : ""}</span></button>`;
    })
    .join("");
  const userSpeech = speechMarkup("user", now, "i");
  const door = document.querySelector(".office-door")!;
  door.classList.toggle("speaking", Boolean(userSpeech));
  door.innerHTML = `<span>你</span>${userSpeech}`;
  const members = current.members.map((id) => session(id)!);
  const active = members.filter((item) => item.execution === "running" && item.enabled).length;
  const dormant = members.filter((item) => item.execution === "dormant" && item.enabled).length;
  const queued = model().deliveries.filter(
    (item) => item.roomId === current.id && (item.state === "queued" || item.state === "held"),
  ).length;
  const unread = model().deliveries.filter((item) => item.roomId === current.id && isUnread(item)).length;
  const bridged = current.members.filter((id) => model().deliveries.some((d) => d.recipient === id && d.tracksRead)).length;
  $("roomStatus").textContent = current.paused
    ? "自动通信已暂停，消息照常记录"
    : !members.length
      ? "还没有成员"
      : active
        ? `${members.length} 位成员，${active} 位正在工作`
        : `${members.length} 位成员，都在待命`;
  $("roomSignName").textContent = current.name;
  $("roomPulse").innerHTML = sparkline(current.pulse);
  const seatsFull = current.runningSeats >= current.maxConcurrent;
  $("roomSummary").hidden = !members.length;
  $("roomSummary").innerHTML = `<span><b>${active}</b>工作中</span><span><b>${dormant}</b>未唤醒</span><span><b>${queued}</b>待送达</span><span title="${bridged ? "已送达、它还没读的消息（只统计接入了 MCP、会回执已读的成员）" : "还没有成员回执过已读，暂时无法统计未读"}"><b>${bridged ? unread : "—"}</b>未读</span>${seatsFull ? `<span class="over" title="同时工作的成员已满，AI 之间的唤醒会排队；你的消息不受影响"><b>${current.runningSeats}/${current.maxConcurrent}</b>同时工作已满</span>` : ""}${current.rounds >= current.roundBudget ? `<span class="over" title="自动讨论到了轮次上限，等你决定是否继续"><b>${current.rounds}/${current.roundBudget}</b>轮次已用完</span>` : ""}`;
  renderAttention(members);
  $("dispatchLegend").hidden = !(current.mode === "coordinator" && current.coordinator && members.length > 1);
  $("roomDropZone").hidden = !members.length || members.length >= 6;
  document.querySelector<HTMLElement>(".office-legend")!.hidden = !members.length;
  renderEmptyRoom(members.length);
  $("demoCollaboration").hidden = members.length < 2;
  ($("demoCollaboration") as HTMLButtonElement).disabled = ui.demoRunning;
}

/** An empty room explains itself once, with the next step that actually applies. */
function renderEmptyRoom(memberCount: number) {
  const box = $("roomEmpty");
  box.hidden = memberCount > 0;
  if (memberCount) return;
  const known = model().sessions.length;
  setHtml(
    box,
    `<span class="mascot" aria-hidden="true"><i class="agent-head"></i><i class="agent-body"></i></span><b>这个房间还空着</b><p>${
      known
        ? "把左侧的会话拖进来，或者从已登记的会话里挑几位。它们会带着原来的记忆加入。"
        : "先登记一个你在本机用过的 Codex 或 Claude 会话，再把它请进房间。"
    }</p><div class="actions">${
      known
        ? '<button class="button primary" data-empty-action="members">添加成员</button><button class="button secondary" data-empty-action="discover">登记本机会话</button>'
        : '<button class="button primary" data-empty-action="discover">登记本机会话</button>'
    }</div>`,
  );
}

/** Members that stopped to ask the user something — the one thing in the room that needs you. */
export function renderAttention(members: VSession[]) {
  const waiting = members.filter((m) => m.enabled && m.execution === "waiting_human");
  const bar = $("attentionBar");
  bar.hidden = !waiting.length;
  if (!waiting.length) return;
  const first = waiting[0]!;
  bar.innerHTML = `<span class="attention-icon">!</span><span><b>${escapeHtml(waiting.map((m) => m.name).join("、"))}</b> 在等你 · 它停在了一个需要你确认的地方</span><button data-inspect-session="${first.id}">看看</button><button data-direct-session="${first.id}">去回复 ↗</button>`;
}
