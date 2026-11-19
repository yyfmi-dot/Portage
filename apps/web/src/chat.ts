import type { Artifact, NativeEvent } from "@portage/core";
import { $, stateLabels, reasonShort, deliveryStateLabels, type VMessage, ui, model, session, room } from "./state.js";
import { isUnread } from "./model.js";
import { hasOlder } from "./data.js";
import { escapeHtml, senderName, statusFor, timeLabel, initial, modeLabel, richText, formatBytes, setHtml, plural } from "./format.js";

/**
 * Who this draft will wake if sent now — the same routing the Bus applies, previewed before
 * sending so the room mode is never a surprise.
 */
export function predictWake(text: string, target: string): { names: string[]; note: string } {
  if (ui.selection.kind === "session") {
    const s = session(ui.selection.id);
    return { names: s ? [s.name] : [], note: "direct message, delivered straight to it" };
  }
  const current = room();
  if (target !== "room") return { names: [session(target)?.name ?? ""], note: "sent only to it" };
  const mentioned = mentionsIn(text)
    .map((pid) => model().sessions.find((s) => s.participantId === pid)?.name)
    .filter((n): n is string => Boolean(n));
  if (current.mode === "manual") return { names: [], note: "manual mode: logged, nobody is woken" };
  if (current.paused) return { names: [], note: "room paused: delivers after you resume" };
  if (mentioned.length) return { names: mentioned, note: "@-mentioned members receive it directly" };
  if (current.mode === "coordinator") {
    const lead = current.coordinator ? session(current.coordinator)?.name : undefined;
    return lead ? { names: [lead], note: "goes to the lead first, who hands it out" } : { names: [], note: "no lead picked yet" };
  }
  return { names: [], note: "no @-mention, so it is only logged in the room" };
}

export function visibleMessages() {
  const all = model().messages.filter((item) => !ui.hidden.has(item.id));
  if (ui.selection.kind === "session") {
    const id = ui.selection.id;
    return all.filter((item) => item.sender === id || item.recipients.includes(id));
  }
  return all.filter((item) => item.conversationId === ui.roomId);
}

export function deliveriesFor(messageId: string) {
  return model().deliveries.filter((d) => d.messageId === messageId);
}

/** One chip per recipient: who got it and how far the proof goes (queued → submitted → read). */
export function receiptChips(message: VMessage) {
  const deliveries = deliveriesFor(message.id);
  if (!deliveries.length)
    return `<button class="receipt-row" data-message="${message.id}"><span class="rcpt quiet">Logged in the room, nobody woken</span></button>`;
  return `<button class="receipt-row" data-message="${message.id}">${deliveries
    .map((d) => {
      const tone = d.ack ? "read" : d.state === "submitted" ? "submitted" : d.state === "failed" ? "failed" : "waiting";
      const label = d.ack
        ? "Read"
        : d.state === "submitted"
          ? isUnread(d) ? "Delivered · unread" : "Delivered"
          : reasonShort[d.reason] ?? deliveryStateLabels[d.state] ?? d.state;
      return `<span class="rcpt ${tone}"><i></i>${escapeHtml(senderName(d.recipient))}<em>${escapeHtml(label)}</em></span>`;
    })
    .join("")}<span class="rcpt-more">Details ↗</span></button>`;
}

export function emptyChat(direct: boolean) {
  if (direct) return `<div class="empty-state chat-empty"><b>Start a direct chat</b><span>Messages go straight to it. It stays itself, with its own memory and the work it has in hand.</span></div>`;
  const current = room();
  const lead = current.coordinator ? session(current.coordinator) : undefined;
  const other = current.members.map((id) => session(id)!).find((s) => s.id !== lead?.id);
  const suggestions = [
    lead ? `Please drive this: list the adapter changes we ship this week and hand them to the right people.` : "",
    other ? `@${other.alias} could you check recent deliveries for any with an unclear outcome?` : "",
    "Everyone, share where you are and what is blocking you.",
  ].filter(Boolean);
  return `<div class="empty-state chat-empty"><b>No messages yet</b><span>${escapeHtml(modeLabel(current.mode))}. Try an opener below, or watch the demo first.</span><div class="suggestions">${suggestions
    .map((s) => `<button data-suggest="${escapeHtml(s)}">${richText(s).replace(/<button[^>]*>|<\/button>/g, "")}</button>`)
    .join("")}</div></div>`;
}

export function artifactMarkup(item: Artifact) {
  return `<button class="artifact-card" data-artifact="${item.id}"><span class="artifact-icon">▤</span><span><b>${escapeHtml(item.originalName)}</b><small>v${item.version} · ${formatBytes(item.byteSize)} · ${escapeHtml(item.createdBy === "user" ? "You" : senderName(model().sessionByParticipant.get(item.createdBy) ?? item.createdBy))}</small></span></button>`;
}

/** The direct conversation with a session, once one exists. */
export function directConversationId(sessionId: string) {
  const participant = session(sessionId)?.participantId;
  const s = ui.snapshot;
  if (!s || !participant) return undefined;
  const direct = new Set(s.conversations.filter((c) => c.kind === "direct").map((c) => c.id));
  return s.memberships.find((m) => direct.has(m.conversationId) && m.participantId === participant)?.conversationId;
}

/** The conversation whose older history the chat can page. */
export function pagedConversationId() {
  return ui.selection.kind === "session" ? directConversationId(ui.selection.id) : ui.roomId;
}

function olderMarkup() {
  const id = pagedConversationId();
  if (!id || !hasOlder(id)) return "";
  return `<button class="load-older" data-load-older="${id}" ${ui.loadingOlder ? "disabled" : ""}>${ui.loadingOlder ? "Loading…" : "Load earlier messages"}</button>`;
}

export function renderChat() {
  const target = ui.selection.kind === "session" ? session(ui.selection.id) : undefined;
  const nativeView = Boolean(target) && ui.chatSource === "native";
  $("chatSource").hidden = !target;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-chat-source]"))
    button.setAttribute("aria-selected", String(button.dataset.chatSource === (nativeView ? "native" : "portage")));
  $("chatContext").textContent = target
    ? nativeView
      ? `${target.name}'s own session record · Portage only reads it`
      : `You and ${target.name}, including room messages that involve it`
    : `Visible to ${plural(room().members.length, "member")} · ${modeLabel(room().mode)}`;
  const box = $("messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const switched = box.dataset.view !== `${ui.selection.kind}:${ui.selection.id}:${nativeView}`;
  box.dataset.view = `${ui.selection.kind}:${ui.selection.id}:${nativeView}`;
  if (nativeView) {
    setHtml(box, nativeMarkup(target!.id));
    if (switched || nearBottom) box.scrollTop = box.scrollHeight;
    return;
  }
  delete box.dataset.html;
  const messages = visibleMessages();
  const byId = new Map(messages.map((m) => [m.id, m]));
  // Prepending older history must not move what the reader is looking at.
  const firstId = box.querySelector<HTMLElement>("article[data-id]")?.dataset.id;
  const anchorTop = firstId ? box.scrollHeight - box.scrollTop : 0;
  let previous: VMessage | undefined;
  box.innerHTML = messages.length
    ? olderMarkup() +
      messages
        .map((item) => {
          const author = session(item.sender);
          const parent = item.parentId ? byId.get(item.parentId) : undefined;
          const continued = previous?.sender === item.sender && previous.traceId === item.traceId && item.at - previous.at < 5 * 60_000 && !parent;
          const divider = previous && new Date(previous.at).toDateString() !== new Date(item.at).toDateString()
            ? `<div class="day-divider"><span>${new Date(item.at).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</span></div>`
            : "";
          previous = item;
          const quote = parent
            ? `<button class="reply-quote" data-message="${parent.id}"><b>${escapeHtml(senderName(parent.sender))}</b>${escapeHtml(parent.text.slice(0, 60))}${parent.text.length > 60 ? "…" : ""}</button>`
            : "";
          return `${divider}<article data-id="${item.id}" class="message ${ui.freshMessages.has(item.id) ? "fresh" : ""} ${continued ? "continued" : ""} ${item.sender === "user" ? "from-user" : ""}" style="--agent-color:${author?.color ?? "#d87243"}"><span class="avatar ${author?.provider === "Claude" ? "claude" : ""} ${item.sender === "user" ? "user" : ""}">${item.sender === "user" ? "You" : initial(author)}</span><div class="message-main"><div class="message-header"><b>${escapeHtml(senderName(item.sender))}</b><span class="message-source">${author ? `${author.provider} · ${author.host}` : ""}${item.direct ? " · direct" : ""}${item.demo ? " · demo" : ""}</span><time>${timeLabel(item.at)}</time></div>${quote}<div class="message-body">${richText(item.text)}${item.revision > 1 ? ` <small>(edited, v${item.revision})</small>` : ""}</div>${item.artifacts.map(artifactMarkup).join("")}${receiptChips(item)}<div class="message-actions"><button data-message="${item.id}">Delivery</button>${item.sender === "user" ? `<button data-edit-message="${item.id}">Edit</button>` : ""}<button data-hide-message="${item.id}">Hide</button></div></div></article>`;
        })
        .join("")
    : emptyChat(Boolean(target));
  if (switched || nearBottom || ui.freshMessages.size || ui.renderedView !== "chat") box.scrollTop = box.scrollHeight;
  else if (firstId && firstId !== messages[0]?.id) box.scrollTop = box.scrollHeight - anchorTop;
}

const correlationLabels: Record<NativeEvent["correlation"], string> = {
  exact: "From Portage · confirmed",
  inferred: "Likely from Portage",
  unknown: "Typed in its own app",
};

function nativeEventMarkup(e: NativeEvent) {
  const at = timeLabel(Date.parse(e.nativeTime));
  if (e.kind === "turn_started" || e.kind === "turn_completed")
    return `<div class="native-turn"><span>${e.kind === "turn_started" ? "Turn started" : "Turn ended"} · ${at}</span></div>`;
  if (e.kind === "turn_failed")
    return `<div class="native-turn failed"><span>Turn failed · ${at}${e.text ? ` · ${escapeHtml(e.text.slice(0, 160))}` : ""}</span></div>`;
  const input = e.kind === "input";
  const headline = input ? inputHeadline(e) : e.text;
  const full = input && headline !== e.text
    ? `<details><summary>Everything it received, rules included · ${formatBytes(new TextEncoder().encode(e.text).length)}</summary><pre>${escapeHtml(e.text)}</pre></details>`
    : "";
  const body = headline.length > 600
    ? `<details><summary>${escapeHtml(headline.slice(0, 240))}…</summary><pre>${escapeHtml(headline)}</pre></details>`
    : `<p>${escapeHtml(headline)}</p>`;
  const link = e.correlatedMessageId ? `<button data-message="${e.correlatedMessageId}">Open thread</button>` : "";
  return `<article class="native-event ${e.kind} ${e.correlation}"><header><b>${input ? "Input" : "Output"}</b>${input ? `<span class="corr ${e.correlation}">${correlationLabels[e.correlation]}</span>` : ""}<time>${at}</time>${link}</header>${body}${full}</article>`;
}

/** What the input said in the user's words: the Portage message it carries, not the rule layers around it. */
function inputHeadline(e: NativeEvent) {
  const message = e.correlatedMessageId ? model().messages.find((m) => m.id === e.correlatedMessageId) : undefined;
  if (message) return message.text;
  const marker = /\[(?:Original message|原始消息) · v\d+ · [^\]\s]+\]\n/.exec(e.text);
  if (!marker) return e.text;
  return e.text.slice(marker.index + marker[0].length).split(/\n\n\[(?:Artifacts|How to reply|产物引用|回复方式)\]/)[0]!;
}

/** The session's own transcript as read back: what it really received and said, and how sure the link is. */
function nativeMarkup(sessionId: string) {
  const target = session(sessionId)!;
  const record = ui.native.get(sessionId);
  if (!target.adapterId)
    return `<div class="empty-state chat-empty"><b>No session record to read back</b><span>This session gets messages through an inbox and fetches them over MCP. Whether it read them shows under each message.</span></div>`;
  if (!record) return `<div class="empty-state chat-empty"><b>Reading its native record…</b></div>`;
  const cp = record.checkpoint;
  const sync = cp
    ? `<div class="native-sync ${cp.error ? "gap" : ""}"><span>${cp.error ? `Read interrupted · ${escapeHtml(cp.error)}` : `Synced at ${cp.lastSuccessAt ? timeLabel(Date.parse(cp.lastSuccessAt)) : "—"}`}</span><code title="${escapeHtml(cp.source)}">${escapeHtml(cp.source.split(/[\\/]/).slice(-2).join("/"))} · cursor ${cp.cursor}</code></div>`
    : "";
  return `${sync}${record.events.length ? record.events.map(nativeEventMarkup).join("") : `<div class="empty-state chat-empty"><b>Nothing recorded yet</b><span>Once you message it, what it received and how it replied show up here.</span></div>`}`;
}

export function renderComposer() {
  const select = $("sendTarget") as HTMLSelectElement;
  const previous = select.value;
  const send = $("sendButton") as HTMLButtonElement;
  if (ui.selection.kind === "session") {
    const target = session(ui.selection.id)!;
    select.innerHTML = `<option value="${target.id}">${escapeHtml(target.name)}</option>`;
    send.disabled = !target.enabled || !target.writable;
    $("composerHint").textContent = !target.enabled
      ? "Receiving is off; turn it on in details"
      : target.writable
        ? "Goes straight to it"
        : "Read-only here; you can view its record";
    $("contextRevision").textContent = `Global v${model().globalRevision} · direct`;
    ($("messageInput") as HTMLTextAreaElement).placeholder = `Message ${target.name}…`;
  } else {
    ($("messageInput") as HTMLTextAreaElement).placeholder = "Write a message, or @ a member…";
    select.innerHTML = `<option value="room">${escapeHtml(room().name)}</option>${room()
      .members.map((id) => `<option value="${id}">@${session(id)!.alias} · ${escapeHtml(session(id)!.name)}</option>`)
      .join("")}`;
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
    send.disabled = false;
    $("composerHint").textContent = `Everyone in the room sees this · ${modeLabel(room().mode)}`;
    $("contextRevision").textContent = `Global v${model().globalRevision} · room v${room().revision}`;
  }
  renderWakePreview();
  $("attachmentPreview").hidden = !ui.attachment;
  $("attachmentPreview").innerHTML = ui.attachment
    ? `▤ ${escapeHtml(ui.attachment.name)} · ${formatBytes(ui.attachment.size)} <button type="button" id="removeAttachment" aria-label="Remove attachment">×</button>`
    : "";
}

export function renderWakePreview() {
  const text = ($("messageInput") as HTMLTextAreaElement).value;
  const target = ($("sendTarget") as HTMLSelectElement).value || "room";
  const { names, note } = predictWake(text, target);
  const el = $("wakePreview");
  el.classList.toggle("silent", !names.length);
  setHtml(
    el,
    `<span class="wake-label">${names.length ? "Wakes" : "Wakes nobody"}</span>${names
      .map((n) => `<span class="wake-name">${escapeHtml(n)}</span>`)
      .join("")}<span class="wake-note">${escapeHtml(note)}</span>`,
  );
}

export function mentionsIn(text: string) {
  return room()
    .members.map((id) => session(id)!)
    .filter((s) => new RegExp(`@${s.alias}(?![\\w-])`).test(text))
    .map((s) => s.participantId);
}

export function mentionQuery() {
  const input = $("messageInput") as HTMLTextAreaElement;
  const before = input.value.slice(0, input.selectionStart);
  return /(^|\s)@([\w-]*)$/.exec(before)?.[2];
}

export function renderMentionMenu() {
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

export function insertMention(alias: string) {
  const input = $("messageInput") as HTMLTextAreaElement;
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret).replace(/@([\w-]*)$/, `@${alias} `);
  input.value = before + input.value.slice(caret);
  input.selectionStart = input.selectionEnd = before.length;
  input.focus();
  renderMentionMenu();
}
