import type { Artifact, NativeEvent } from "@portage/core";
import { $, stateLabels, reasonShort, deliveryStateLabels, type VMessage, ui, model, session, room } from "./state.js";
import { isUnread } from "./model.js";
import { hasOlder } from "./data.js";
import { escapeHtml, senderName, statusFor, timeLabel, initial, modeLabel, richText, formatBytes, setHtml } from "./format.js";

/**
 * Who this draft will wake if sent now — the same routing the Bus applies, previewed before
 * sending so the room mode is never a surprise.
 */
export function predictWake(text: string, target: string): { names: string[]; note: string } {
  if (ui.selection.kind === "session") {
    const s = session(ui.selection.id);
    return { names: s ? [s.name] : [], note: "私聊 · 直接投递" };
  }
  const current = room();
  if (target !== "room") return { names: [session(target)?.name ?? ""], note: "指定成员 · 直接唤醒" };
  const mentioned = mentionsIn(text)
    .map((pid) => model().sessions.find((s) => s.participantId === pid)?.name)
    .filter((n): n is string => Boolean(n));
  if (current.mode === "manual") return { names: [], note: "手动模式 · 只写入历史，不自动唤醒" };
  if (current.paused) return { names: [], note: "房间已暂停 · 写入历史，恢复后投递" };
  if (mentioned.length) return { names: mentioned, note: "@ 优先 · 直接唤醒被提及的成员" };
  if (current.mode === "coordinator") {
    const lead = current.coordinator ? session(current.coordinator)?.name : undefined;
    return lead ? { names: [lead], note: "统筹模式 · 先到统筹者，由其派发" } : { names: [], note: "统筹模式 · 尚未指定统筹者" };
  }
  return { names: [], note: `${current.mode === "swarm" ? "Swarm" : "仅 @"} · 未 @ 任何成员，只写入历史` };
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
    return `<button class="receipt-row" data-message="${message.id}"><span class="rcpt quiet">写入历史 · 未唤醒成员</span></button>`;
  return `<button class="receipt-row" data-message="${message.id}">${deliveries
    .map((d) => {
      const tone = d.ack ? "read" : d.state === "submitted" ? "submitted" : d.state === "failed" ? "failed" : "waiting";
      const label = d.ack
        ? "已读"
        : d.state === "submitted"
          ? isUnread(d) ? "已投递 · 未读" : "已投递"
          : reasonShort[d.reason] ?? deliveryStateLabels[d.state] ?? d.state;
      return `<span class="rcpt ${tone}"><i></i>${escapeHtml(senderName(d.recipient))}<em>${escapeHtml(label)}</em></span>`;
    })
    .join("")}<span class="rcpt-more">链路 ↗</span></button>`;
}

export function emptyChat(direct: boolean) {
  if (direct) return `<div class="empty-state chat-empty"><b>从这里开始一段私聊</b><span>消息直接投递到这个原生 session 的收件箱，保留它原有的身份与工作。</span></div>`;
  const current = room();
  const lead = current.coordinator ? session(current.coordinator) : undefined;
  const other = current.members.map((id) => session(id)!).find((s) => s.id !== lead?.id);
  const suggestions = [
    lead ? `请统筹推进：梳理本周要交付的适配器改动，并分派给合适的成员。` : "",
    other ? `@${other.alias} 请检查一下最近的投递记录，看看有没有结果不明的。` : "",
    "大家各自同步一下进度和阻塞点。",
  ].filter(Boolean);
  return `<div class="empty-state chat-empty"><b>房间还没有消息</b><span>${escapeHtml(modeLabel(current.mode))}。试试下面的开场，或点「演示协作」看一条完整链路。</span><div class="suggestions">${suggestions
    .map((s) => `<button data-suggest="${escapeHtml(s)}">${richText(s).replace(/<button[^>]*>|<\/button>/g, "")}</button>`)
    .join("")}</div></div>`;
}

export function artifactMarkup(item: Artifact) {
  return `<button class="artifact-card" data-artifact="${item.id}"><span class="artifact-icon">FILE</span><span><b>${escapeHtml(item.originalName)}</b><small>v${item.version} · ${formatBytes(item.byteSize)} · ${escapeHtml(item.createdBy === "user" ? "你" : senderName(model().sessionByParticipant.get(item.createdBy) ?? item.createdBy))}</small></span></button>`;
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
  return `<button class="load-older" data-load-older="${id}" ${ui.loadingOlder ? "disabled" : ""}>${ui.loadingOlder ? "加载中…" : "加载更早的消息"}</button>`;
}

export function renderChat() {
  const target = ui.selection.kind === "session" ? session(ui.selection.id) : undefined;
  const nativeView = Boolean(target) && ui.chatSource === "native";
  $("chatSource").hidden = !target;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-chat-source]"))
    button.setAttribute("aria-selected", String(button.dataset.chatSource === (nativeView ? "native" : "portage")));
  $("chatContext").textContent = target
    ? nativeView
      ? `${target.name} 自己的原生记录 · 只读回读，Portage 不改写`
      : `与 ${target.name} 的往来 · 私聊与房间中涉及该会话的消息 · 投递到原生收件箱`
    : `${room().name} · ${room().members.length} 位成员可读 · ${modeLabel(room().mode)}`;
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
          const where = item.direct ? "私聊" : model().rooms.find((r) => r.id === item.conversationId)?.name ?? "";
          const parent = item.parentId ? byId.get(item.parentId) : undefined;
          const continued = previous?.sender === item.sender && previous.traceId === item.traceId && item.at - previous.at < 5 * 60_000 && !parent;
          const divider = previous && new Date(previous.at).toDateString() !== new Date(item.at).toDateString()
            ? `<div class="day-divider"><span>${new Date(item.at).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</span></div>`
            : "";
          previous = item;
          const quote = parent
            ? `<button class="reply-quote" data-message="${parent.id}"><b>${escapeHtml(senderName(parent.sender))}</b>${escapeHtml(parent.text.slice(0, 60))}${parent.text.length > 60 ? "…" : ""}</button>`
            : "";
          return `${divider}<article data-id="${item.id}" class="message ${ui.freshMessages.has(item.id) ? "fresh" : ""} ${continued ? "continued" : ""} ${item.sender === "user" ? "from-user" : ""}" style="--agent-color:${author?.color ?? "#d87243"}"><span class="avatar ${author?.provider === "Claude" ? "claude" : ""} ${item.sender === "user" ? "user" : ""}">${item.sender === "user" ? "你" : initial(author)}</span><div class="message-main"><div class="message-header"><b>${escapeHtml(senderName(item.sender))}</b><span class="message-source">${author ? `${author.provider} / ${author.host}` : "Portage"} · ${escapeHtml(where)}${item.demo ? " · 演示" : ""}</span><time>${timeLabel(item.at)}</time></div>${quote}<div class="message-body">${richText(item.text)}${item.revision > 1 ? ` <small>（修订 v${item.revision}）</small>` : ""}</div>${item.artifacts.map(artifactMarkup).join("")}${receiptChips(item)}<div class="message-actions"><button data-message="${item.id}">查看链路</button>${item.sender === "user" ? `<button data-edit-message="${item.id}">修订</button>` : ""}<button data-hide-message="${item.id}">隐藏记录</button></div></div></article>`;
        })
        .join("")
    : emptyChat(Boolean(target));
  if (switched || nearBottom || ui.freshMessages.size || ui.renderedView !== "chat") box.scrollTop = box.scrollHeight;
  else if (firstId && firstId !== messages[0]?.id) box.scrollTop = box.scrollHeight - anchorTop;
}

const correlationLabels: Record<NativeEvent["correlation"], string> = {
  exact: "Portage 投递 · 已确认",
  inferred: "推断来自 Portage",
  unknown: "宿主直接输入",
};

function nativeEventMarkup(e: NativeEvent) {
  const at = timeLabel(Date.parse(e.nativeTime));
  if (e.kind === "turn_started" || e.kind === "turn_completed")
    return `<div class="native-turn"><span>${e.kind === "turn_started" ? "回合开始" : "回合结束"} · ${at}</span></div>`;
  if (e.kind === "turn_failed")
    return `<div class="native-turn failed"><span>回合失败 · ${at}${e.text ? ` · ${escapeHtml(e.text.slice(0, 160))}` : ""}</span></div>`;
  const input = e.kind === "input";
  const headline = input ? inputHeadline(e) : e.text;
  const full = input && headline !== e.text
    ? `<details><summary>完整 query · 含规则层 · ${formatBytes(new TextEncoder().encode(e.text).length)}</summary><pre>${escapeHtml(e.text)}</pre></details>`
    : "";
  const body = headline.length > 600
    ? `<details><summary>${escapeHtml(headline.slice(0, 240))}…</summary><pre>${escapeHtml(headline)}</pre></details>`
    : `<p>${escapeHtml(headline)}</p>`;
  const link = e.correlatedMessageId ? `<button data-message="${e.correlatedMessageId}">查看链路</button>` : "";
  return `<article class="native-event ${e.kind} ${e.correlation}"><header><b>${input ? "输入" : "输出"}</b>${input ? `<span class="corr ${e.correlation}">${correlationLabels[e.correlation]}</span>` : ""}<time>${at}</time>${link}</header>${body}${full}</article>`;
}

/** What the input said in the user's words: the Portage message it carries, not the rule layers around it. */
function inputHeadline(e: NativeEvent) {
  const message = e.correlatedMessageId ? model().messages.find((m) => m.id === e.correlatedMessageId) : undefined;
  if (message) return message.text;
  const marker = /\[原始消息 · v\d+ · [^\]\s]+\]\n/.exec(e.text);
  if (!marker) return e.text;
  return e.text.slice(marker.index + marker[0].length).split(/\n\n\[(?:产物引用|回复方式)\]/)[0]!;
}

/** The session's own transcript as read back: what it really received and said, and how sure the link is. */
function nativeMarkup(sessionId: string) {
  const target = session(sessionId)!;
  const record = ui.native.get(sessionId);
  if (!target.adapterId)
    return `<div class="empty-state chat-empty"><b>没有可回读的原生记录</b><span>这个会话经文件收件箱投递，由 agent 通过 MCP 读取；读取凭据显示在每条消息的回执上。</span></div>`;
  if (!record) return `<div class="empty-state chat-empty"><b>正在读取原生记录…</b></div>`;
  const cp = record.checkpoint;
  const sync = cp
    ? `<div class="native-sync ${cp.error ? "gap" : ""}"><span>${cp.error ? `回读缺口 · ${escapeHtml(cp.error)}` : `已同步 · ${cp.lastSuccessAt ? timeLabel(Date.parse(cp.lastSuccessAt)) : "—"}`}</span><code title="${escapeHtml(cp.source)}">${escapeHtml(cp.source.split(/[\\/]/).slice(-2).join("/"))} · 游标 ${cp.cursor}</code></div>`
    : "";
  return `${sync}${record.events.length ? record.events.map(nativeEventMarkup).join("") : `<div class="empty-state chat-empty"><b>还没有原生记录</b><span>投递后，原生 session 的输入、输出与回合边界会出现在这里。</span></div>`}`;
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
  renderWakePreview();
  $("attachmentPreview").hidden = !ui.attachment;
  $("attachmentPreview").innerHTML = ui.attachment
    ? `▤ ${escapeHtml(ui.attachment.name)} · ${formatBytes(ui.attachment.size)} <button type="button" id="removeAttachment" aria-label="移除附件">×</button>`
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
    `<span class="wake-label">${names.length ? "将唤醒" : "不唤醒"}</span>${names
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
