import { policyDocumentBody, type Artifact } from "@portage/core";
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
  return `<details class="tech-details" data-key="${key}"><summary>Technical details</summary><dl>${items
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl></details>`;
}

const meter = (label: string, used: number, max: number, title = "") =>
  `<div class="detail-row" title="${escapeHtml(title)}"><span>${label}</span><strong>${used} / ${max}</strong></div><div class="budget-bar ${used >= max ? "over" : ""}"><i style="width:${Math.min(100, (used / Math.max(1, max)) * 100)}%"></i></div>`;

export function roomInspector() {
  const current = room();
  const files = new Map<string, { latest: Artifact; versions: number }>();
  for (const a of model().artifacts.filter((a) => a.conversationId === current.id)) {
    const file = files.get(a.originalName);
    if (!file) files.set(a.originalName, { latest: a, versions: 1 });
    else {
      file.versions += 1;
      if (a.version > file.latest.version) file.latest = a;
    }
  }
  const artifacts = [...files.values()].sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
  const excerpt =
    policyDocumentBody(current.document).split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ") ||
    "Write down how this room works: who owns what and how work is handed off. It travels with every message and never rewrites who the members are.";
  const members = current.members
    .map((id) => {
      const item = session(id)!;
      const badge = memberBadge(item);
      return `<button class="inspector-member" data-inspect-session="${id}" draggable="true" data-drag-member="${id}"><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><span class="member-info"><b>${escapeHtml(item.name)}</b><small>${badge ? `${badge} · ` : ""}${item.provider} · ${item.host}</small></span><span class="member-state">${stateLabels[statusFor(item)]}</span></button>`;
    })
    .join("");
  return `<div class="inspector-heading"><h2>Room overview</h2><span class="live-tag"><i class="live-dot"></i>Live</span></div><div class="inspector-title-row"><div class="inspector-title">${escapeHtml(current.name)}</div><button class="text-button rename-room" data-rename-room title="Rename room (or double-click the title)">Rename</button></div><p class="inspector-caption">${escapeHtml(modeLabel(current.mode))}</p><section class="inspector-section"><h3>Members <span class="muted">${current.members.length}</span></h3>${members || '<p class="inspector-caption">No members yet. Drag a session in from the left, or click “Add member”.</p>'}</section><section class="inspector-section"><h3>Auto-collaboration limits</h3>${meter("Discussion rounds", current.rounds, current.roundBudget, "Back-and-forth rounds between AIs; at the limit it stops and waits for you")}${meter("AI messages, last minute", current.autoMessages, current.messageBudget)}<div class="detail-row" title="Members working right now / limit. When full, AI-to-AI wake-ups wait; your messages don't"><span>Working at once</span><strong>${current.runningSeats} / ${current.maxConcurrent}</strong></div><div class="seat-row">${Array.from({ length: current.maxConcurrent }, (_, i) => `<i class="${i < current.runningSeats ? "on" : ""}"></i>`).join("")}</div>${meter("Wake-ups in this thread", current.traceWakeups, current.maxWakeups)}</section><div class="policy-card" style="margin-top:12px"><span>Room rules<b>v${current.revision}</b></span><p>${escapeHtml(excerpt)}</p><button data-open-rules="room">Edit rules</button></div><section class="inspector-section"><h3>Shared files <span class="muted">${artifacts.length}</span></h3>${artifacts.map((f) => artifactMarkup(f.latest, f.versions)).join("") || '<p class="inspector-caption">Files attached to messages are collected here.</p>'}</section>`;
}

/** The proof ladder the user can trust: handed over → its own record shows it → it read it. Only proven rungs are lit. */
export function proofSteps(item: VDelivery) {
  const native = Boolean(session(item.recipient)?.adapterId);
  const steps = [
    { label: "Delivered", on: item.state === "submitted" && Boolean(item.receipt), at: item.receipt?.observedAt },
    ...(native ? [{ label: "In its record", on: Boolean(item.confirmed), at: item.confirmed?.observedAt }] : []),
    ...(item.tracksRead || item.ack ? [{ label: "Read", on: Boolean(item.ack), at: item.ack?.observedAt }] : []),
  ];
  return `<div class="proof-steps">${steps
    .map(
      (s) =>
        `<span class="${s.on ? "on" : ""}" title="${s.at ? new Date(s.at).toLocaleTimeString("en-GB") : "No proof yet"}"><i></i>${s.label}</span>`,
    )
    .join("")}</div>`;
}

export const cancellable = (d: VDelivery) => d.state === "queued" || d.state === "held";

/** One sentence on how far this delivery provably got. */
function proofSentence(item: VDelivery) {
  if (item.state !== "submitted") return waitMarkup(item);
  const at = (r?: { observedAt: string }) => (r ? timeLabel(Date.parse(r.observedAt)) : "");
  const parts = [`Delivered to its session at ${at(item.receipt)}`];
  if (item.confirmed) parts.push(`its own record confirmed it at ${at(item.confirmed)}`);
  if (item.ack) parts.push(`it read it at ${at(item.ack)}`);
  else if (item.tracksRead) parts.push("it hasn't read it yet");
  else if (!item.confirmed) parts.push("it isn't connected over MCP, so it can't report reads");
  return `${parts.join("; ")}.`;
}

export function proofMarkup(item: VDelivery) {
  const snap = item.context;
  const tech = techDetails(`proof:${item.id}`, [
    ["Proof level", [item.receipt?.proofLevel, item.confirmed && "native_confirmed", item.ack && "agent_ack"].filter(Boolean).join(" → ")],
    ["Adapter", item.receipt?.adapterId],
    ["Binding epoch", item.receipt?.bindingEpoch],
    ["Rules used", `room v${item.revision ?? room().revision} · message v${item.messageRevision}`],
    ["Delivered content", snap ? `${snap.hash} · ${formatBytes(snap.byteSize)}` : ""],
    ["Native record ID", item.receipt?.nativeMessageId],
    ["Delivery ID", item.id],
  ]);
  return `<div class="proof-card"><div class="proof-head"><b>${escapeHtml(senderName(item.recipient))}</b><span class="proof-state ${item.ack ? "read" : item.state}">${item.ack ? "Read" : deliveryStateLabels[item.state] ?? item.state}</span></div>${item.state === "submitted" ? proofSteps(item) : ""}<p class="proof-sentence">${proofSentence(item)}</p>${snap ? `<button class="wide-button" data-show-snapshot="${item.id}">See exactly what it received</button>` : ""}${cancellable(item) ? `<button class="wide-button leave-button" data-cancel-delivery="${item.id}">Cancel this delivery</button>` : ""}${tech}</div>`;
}

/** What the member is doing and how messages reach it, in one sentence. */
function statusSentence(item: VSession, inRoom: boolean) {
  const status = statusFor(item);
  const wakes = inRoom ? "New messages wake it automatically" : "This room's messages won't wake it; a direct message will";
  return (
    {
      running: "New messages arrive when this turn finishes",
      idle: wakes,
      dormant: `Quiet for a while. ${wakes}`,
      waiting_human: "It stopped to wait for you. Reply to it directly",
      disabled: "Turn on “Receive messages” to deliver again",
      offline: "Messages wait until it is back",
      unknown: "Its status isn't visible right now",
    } as Record<string, string>
  )[status] ?? stateLabels[status];
}

/** On a session's own page no room is selected, so list the rooms it is actually in. */
function roomsRow(item: VSession) {
  const rooms = model().rooms.filter((r) => r.members.includes(item.id));
  const names = rooms.map((r) => `${escapeHtml(r.name)}${r.mode === "coordinator" && r.coordinator === item.id ? " · Lead" : ""}`);
  return `<div class="detail-row"><span>Rooms</span><strong>${names.join("<br>") || "None yet"}</strong></div>`;
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
    ? "None received yet"
    : (last.revision ?? 0) >= current.revision
      ? `latest, v${current.revision}`
      : `v${last.revision}; latest is v${current.revision}`;
  const rows = [
    `<div class="detail-row"><span>Receive messages</span><button class="toggle" role="switch" aria-label="${escapeHtml(item.name)} receives messages" aria-checked="${item.enabled}" data-toggle-session="${item.id}"></button></div>`,
    `<div class="detail-row"><span>Arrives</span><strong title="${item.adapterId ? "Portage continues its own conversation as itself" : "Dropped in an inbox that it reads over MCP"}">${!item.writable ? "Read-only" : item.adapterId ? "Into its own conversation" : "Into its inbox"}</strong></div>`,
    item.adapterId
      ? `<div class="detail-row"><span>Its record</span><strong class="${cp?.error ? "warn" : ""}" title="${escapeHtml(cp?.error ?? "")}">${!cp ? "Not synced yet" : cp.error ? "Read interrupted" : `Synced · ${cp.lastSuccessAt ? timeLabel(Date.parse(cp.lastSuccessAt)) : "—"}`}</strong></div>`
      : "",
    `<div class="detail-row"><span>Read receipts</span><strong title="${lastAck ? "It has reported reads over MCP" : "It hasn't reported a read over MCP yet"}">${lastAck ? `Yes · last ${timeLabel(Date.parse(lastAck.observedAt))}` : "None yet"}</strong></div>`,
    `<div class="detail-row"><span>Rules</span><strong>${ruleRow}</strong></div>`,
    ui.selection.kind === "session" ? roomsRow(item) : `<div class="detail-row"><span>In this room</span><strong>${isCoordinator ? "Lead" : inRoom ? "Member" : "Not in this room"}</strong></div>`,
  ].join("");
  const queue = pending.length
    ? pending
        .map(
          (d) =>
            `<div class="delivery-item"><b>${escapeHtml(model().messages.find((m) => m.id === d.messageId)?.text.slice(0, 90) ?? "Message")}</b><small>${waitMarkup(d)}</small><button class="text-button" data-cancel-delivery="${d.id}">Cancel</button></div>`,
        )
        .join("")
    : '<p class="inspector-caption">Nothing waiting to be delivered.</p>';
  const actions = [
    rebound ? `<button class="wide-button primary-action" data-confirm-binding="${item.id}">Confirm new identity and release ${rebound}</button>` : "",
    item.adapterId && item.execution === "running" ? `<button class="wide-button" data-interrupt-session="${item.id}">Stop its current turn</button>` : "",
    inRoom ? `<button class="wide-button" data-wake-session="${item.id}">Wake it once</button>` : "",
    inRoom && current.mode === "coordinator" && !isCoordinator ? `<button class="wide-button" data-make-coordinator="${item.id}">Make lead</button>` : "",
    pending.length || status === "waiting_human" || status === "busy" || item.detail
      ? `<button class="wide-button" data-ready-session="${item.id}">Mark as ready</button>`
      : "",
    last ? `<button class="wide-button" data-show-snapshot="${last.id}">See the last thing it received</button>` : "",
  ].join("");
  const tech = techDetails(`session:${item.id}`, [
    ["Native session ID", item.nativeIdentity],
    ["Binding epoch", item.bindingEpoch],
    ["Adapter", item.adapterId ?? "file-inbox"],
    ["Working directory", item.workdir],
    ["Record file", cp ? `${cp.source} · cursor ${cp.cursor}` : ""],
    ["Host note", item.detail],
    ["Portage ID", item.id],
  ]);
  return `<div class="inspector-heading"><h2>Member</h2><span>@${escapeHtml(item.alias)}</span></div><span class="avatar ${item.provider === "Claude" ? "claude" : ""}">${initial(item)}</span><div class="inspector-title">${escapeHtml(item.name)}</div><p class="inspector-caption">${item.provider} · ${item.host}${item.workdir ? ` · ${escapeHtml(item.workdir.split("/").slice(-1)[0])}` : ""}</p><div class="status-hero ${status}"><i></i><span><b>${stateLabels[status]}</b>${statusSentence(item, inRoom)}</span></div>${item.detail && status !== "running" ? `<p class="host-detail">${escapeHtml(item.detail)}</p>` : ""}<section class="inspector-section">${rows}</section><section class="inspector-section"><h3>Waiting to deliver <span class="muted">${pending.length}</span></h3>${queue}${actions}</section><section class="inspector-section"><h3>Manage</h3><button class="wide-button" data-direct-session="${item.id}">Message directly</button>${item.adapterId ? `<button class="wide-button" data-native-session="${item.id}">Open its own record</button>` : ""}${inRoom ? `<button class="wide-button leave-button" data-leave-session="${item.id}">Remove from room</button>` : `<button class="wide-button" data-add-session="${item.id}">Add to this room</button>`}<button class="wide-button" data-rename-session="${item.id}">Rename</button><button class="wide-button" data-archive-session="${item.id}">Archive from Portage</button><p class="inspector-caption" style="margin-top:10px">Removing or archiving only affects Portage. Its own session and memory stay as they are.</p></section>${tech}`;
}

export function messageInspector(message?: VMessage) {
  if (!message) return roomInspector();
  const deliveries = deliveriesFor(message.id);
  const parent = message.parentId ? model().messages.find((m) => m.id === message.parentId) : undefined;
  const where = message.direct ? "Direct message" : model().rooms.find((r) => r.id === message.conversationId)?.name ?? "";
  const tech = techDetails(`message:${message.id}`, [
    ["Message ID", message.id],
    ["Thread ID", message.traceId],
    ["Replies to", message.parentId],
    ["Version", `v${message.revision}`],
  ]);
  return `<div class="inspector-heading"><h2>Message</h2><span>${timeLabel(message.at)}</span></div><div class="inspector-title">${escapeHtml(senderName(message.sender))}</div><p class="inspector-caption">${escapeHtml(where)}${parent ? ` · reply to ${escapeHtml(senderName(parent.sender))}` : " · new topic"}</p><section class="inspector-section"><p class="inspector-message-body">${escapeHtml(message.text)}</p>${message.artifacts.map((a) => artifactMarkup(a)).join("")}</section><section class="inspector-section"><h3>Deliveries <span class="muted">${deliveries.length}</span></h3>${deliveries.length ? deliveries.map(proofMarkup).join("") : '<p class="inspector-caption">Logged in the room for everyone to see; it woke nobody.</p>'}<button class="wide-button" data-focus-trace="${message.traceId}">Show this thread in Flow</button></section>${tech}`;
}
