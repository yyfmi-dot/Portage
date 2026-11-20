import { $, stationPosition, stateLabels, reasonShort, type VSession, ui, model, session, room, speechEnd, SPEECH_YIELD_MS } from "./state.js";
import { isUnread } from "./model.js";
import { escapeHtml, memberBadge, statusFor, queueFor, sparkline, setHtml, plural } from "./format.js";

export const poppedSpeech = new Set<string>();

export function speechMarkup(id: string, now: number, tag: "span" | "i") {
  const speech = ui.speaking.get(id);
  if (!speech || now < speech.startAt || speechEnd(speech) <= now || speech.roomId !== ui.roomId) return "";
  const key = `${id}:${speech.until}`;
  const pop = !poppedSpeech.has(key);
  poppedSpeech.add(key);
  const text = speech.text.length > 160 ? `${speech.text.slice(0, 160)}…` : speech.text;
  // re-renders rebuild the bubble, so resume the exit where it was instead of restarting it
  const leaving = speech.leaveAt
    ? ` leaving" style="animation-delay:${-Math.round(now - (speech.leaveAt - SPEECH_YIELD_MS))}ms`
    : "";
  return `<${tag} class="speech ${pop ? "pop" : ""}${leaving}"><span class="speech-text">${escapeHtml(text)}</span></${tag}>`;
}

export function renderOffice() {
  const current = room();
  const now = performance.now();
  $("workstations").innerHTML = current.members
    .map((id, index) => {
      const item = session(id)!;
      const position = stationPosition(index, current.members.length);
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
        ? `<span class="inbox-stack ${heldOnly ? "held" : ""}" title="${waiting.length} waiting · ${escapeHtml(reasonShort[waiting[0]!.reason] ?? "Queued")}">${"<i></i>".repeat(Math.min(3, waiting.length))}</span>`
        : "";
      // Top-row bubbles open sideways (toward the room's centre) so they never leave the stage.
      const placement = position[1] < 45 ? `row-top ${position[0] > 60 ? "col-right" : "col-left"}` : "";
      return `<button class="workstation ${status} ${placement} ${selected ? "selected" : ""} ${receiving ? "receiving" : ""} ${justRead ? "just-read" : ""} ${unread ? "has-unread" : ""} ${speech ? "speaking" : ""}" data-inspect-session="${id}" draggable="true" data-drag-member="${id}" style="left:${position[0]}%;top:${position[1]}%;--agent-color:${item.color};--i:${index}" aria-label="${escapeHtml(item.name)}${badge ? `, ${badge}` : ""}, ${stateLabels[status]}${count ? `, ${count} queued` : ""}"><span class="station-label" title="${escapeHtml(item.name)}"><b><span class="station-name">${escapeHtml(item.name)}</span>${badge ? `<span class="station-role">${badge}</span>` : ""}</b><small>${item.provider} / ${item.host}</small></span><span class="floor-glow"></span><span class="desk"></span><span class="lamp"><i></i></span><span class="monitor"><i class="screen-lines"></i></span>${stack}<span class="agent-figure"><i class="agent-head"></i><i class="agent-body"></i></span>${status === "dormant" ? '<span class="sleep-symbol">z z</span>' : ""}${status === "waiting_human" ? '<span class="attention-ring"></span><span class="raise-hand" aria-hidden="true">!</span>' : ""}<span class="delivered-tag">Delivered ↓</span><span class="read-tag">Read ✓</span>${unread ? `<span class="unread-dot" title="${plural(unread, "message")} delivered and not read yet"></span>` : ""}${speech}${item.detail && status !== "running" ? `<span class="host-note" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail.length > 22 ? `${item.detail.slice(0, 22)}…` : item.detail)}</span>` : ""}<span class="station-state"><span class="state-pill">${stateLabels[status]}</span>${count ? `<span class="queue-tag">${count} queued</span>` : ""}${unread ? `<span class="unread-tag">${unread} unread</span>` : ""}</span></button>`;
    })
    .join("");
  const userSpeech = speechMarkup("user", now, "i");
  const door = document.querySelector(".office-door")!;
  door.classList.toggle("speaking", Boolean(userSpeech));
  door.innerHTML = `<span>You</span>${userSpeech}`;
  if (userSpeech) placeDoorSpeech(door);
  const members = current.members.map((id) => session(id)!);
  const active = members.filter((item) => item.execution === "running" && item.enabled).length;
  const dormant = members.filter((item) => item.execution === "dormant" && item.enabled).length;
  const queued = model().deliveries.filter(
    (item) => item.roomId === current.id && (item.state === "queued" || item.state === "held"),
  ).length;
  const unread = model().deliveries.filter((item) => item.roomId === current.id && isUnread(item)).length;
  const bridged = current.members.filter((id) => model().deliveries.some((d) => d.recipient === id && d.tracksRead)).length;
  $("roomStatus").textContent = current.paused
    ? "Paused · still logging"
    : !members.length
      ? "No members yet"
      : active
        ? `${plural(members.length, "member")} · ${active} working`
        : `${plural(members.length, "member")} · all ready`;
  $("roomSignName").textContent = current.name;
  $("roomPulse").innerHTML = sparkline(current.pulse);
  const seatsFull = current.runningSeats >= current.maxConcurrent;
  $("roomSummary").hidden = !members.length;
  $("roomSummary").innerHTML = `<span><b>${active}</b>working</span><span><b>${dormant}</b>asleep</span><span><b>${queued}</b>queued</span><span title="${bridged ? "Delivered but not read yet (only members connected over MCP report reads)" : "No member has reported a read yet, so unread can't be counted"}"><b>${bridged ? unread : "—"}</b>unread</span>${seatsFull ? `<span class="over" title="Too many members are working at once; AI-to-AI wake-ups wait, your messages don't"><b>${current.runningSeats}/${current.maxConcurrent}</b>seats full</span>` : ""}${current.rounds >= current.roundBudget ? `<span class="over" title="The discussion hit its round limit and waits for you"><b>${current.rounds}/${current.roundBudget}</b>rounds used</span>` : ""}`;
  renderAttention(members);
  $("dispatchLegend").hidden = !(current.mode === "coordinator" && current.coordinator && members.length > 1);
  $("roomDropZone").hidden = !members.length || members.length >= 6;
  document.querySelector<HTMLElement>(".office-legend")!.hidden = !members.length;
  renderEmptyRoom(members.length);
  // Demo lives in Chat empty state and ⌘K — not beside Mode/Pause, where it competed with real controls.
  $("demoCollaboration").hidden = true;
}

/** Station spots depend on room size and stage shape, so the user's bubble picks the side of the door that covers the least. */
function placeDoorSpeech(door: Element) {
  const bubble = door.querySelector<HTMLElement>(".speech");
  if (!bubble) return;
  // what a member shows matters; the drop zone is only a hint and may sit under a passing bubble
  const blockers = [
    ...[...document.querySelectorAll<HTMLElement>("#workstations :is(.station-label, .monitor, .desk, .station-state)")].map((el) => ({ r: el.getBoundingClientRect(), weight: 1 })),
    ...[...document.querySelectorAll<HTMLElement>("#roomDropZone:not([hidden])")].map((el) => ({ r: el.getBoundingClientRect(), weight: 0.2 })),
  ];
  const covered = () => {
    const b = bubble.getBoundingClientRect();
    return blockers.reduce(
      (sum, { r, weight }) =>
        sum + weight * Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) * Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top)),
      0,
    );
  };
  const right = covered();
  if (!right) return;
  bubble.classList.add("flip");
  if (covered() >= right) bubble.classList.remove("flip");
}

/** An empty room explains itself once, with the next step that actually applies. */
function renderEmptyRoom(memberCount: number) {
  const box = $("roomEmpty");
  box.hidden = memberCount > 0;
  if (memberCount) return;
  const known = model().sessions.length;
  setHtml(
    box,
    `<span class="mascot" aria-hidden="true"><i class="agent-head"></i><i class="agent-body"></i></span><b>This room is empty</b><p>${
      known
        ? "Drag a session in from the left, or pick some of your registered sessions. They join with their memory intact."
        : "First add a Codex or Claude session you have used on this computer, then invite it in."
    }</p><div class="actions">${
      known
        ? '<button class="button primary" data-empty-action="members">Add members</button><button class="button secondary" data-empty-action="discover">Find local sessions</button>'
        : '<button class="button primary" data-empty-action="discover">Find local sessions</button>'
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
  bar.innerHTML = `<span class="attention-icon">!</span><span><b>${escapeHtml(waiting.map((m) => m.name).join(", "))}</b> ${waiting.length > 1 ? "are" : "is"} waiting for you · stopped at something only you can confirm</span><button data-inspect-session="${first.id}">View</button><button data-direct-session="${first.id}">Reply ↗</button>`;
}
