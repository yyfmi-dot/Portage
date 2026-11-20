import type { BusEvent } from "@portage/core";
import { api, openEventStream, type HistorySlice, type Snapshot } from "./api.js";
import { $, PACKET_MS, ui, session, SPEECH_MS, SPEECH_YIELD_MS, speechEnd } from "./state.js";
import { buildModel, withHistory } from "./model.js";
import { toast } from "./format.js";
import { render, renderConnection } from "./render.js";
import { wakeCanvas } from "./canvas.js";

export async function act(task: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await task();
    if (success) toast(success);
    await refresh();
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
    return false;
  }
}

let refreshTimer = 0;
let retryTimer = 0;

/** The native transcript is shown only in a session's sync view; fetch it only while that view is open. */
const nativeViewOpen = () => ui.selection.kind === "session" && ui.view === "chat" && ui.chatSource === "native";

export async function refresh() {
  try {
    const [snapshot] = await Promise.all([api.snapshot(), nativeViewOpen() ? loadNative(ui.selection.id) : undefined]);
    await fillHistoryGaps(snapshot);
    ui.snapshot = snapshot;
    ui.model = buildModel(withHistory(snapshot, ui.older.values()));
    if (!ui.connected) {
      ui.connected = true;
      ui.seenSeq = Math.max(ui.seenSeq, snapshot.lastEventSeq);
      connectStream();
    }
    for (const id of ui.freshMessages) {
      const message = ui.model.messages.find((m) => m.id === id);
      if (!message?.text) continue;
      const now = performance.now();
      // one voice at a time: facing bubbles share the gap between stations, so the new one waits for the old to leave
      let startAt = now;
      for (const [speaker, speech] of ui.speaking)
        if (speaker !== message.sender && speech.roomId === message.conversationId && speechEnd(speech) > now) {
          speech.leaveAt = Math.min(speech.leaveAt ?? Infinity, now + SPEECH_YIELD_MS);
          startAt = Math.max(startAt, speech.leaveAt);
        }
      ui.speaking.set(message.sender, { text: message.text, startAt, until: startAt + SPEECH_MS, roomId: message.conversationId });
    }
    if (!ui.model.rooms.some((r) => r.id === ui.roomId) && ui.model.rooms[0]) ui.roomId = ui.model.rooms[0].id;
    if (ui.selection.kind === "session" && !session(ui.selection.id)) ui.selection = { kind: "room", id: ui.roomId };
    render();
  } catch (error) {
    setOffline(error instanceof Error ? error.message : String(error));
  }
}

export function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 90);
}

export function setOffline(detail: string) {
  ui.connected = false;
  ui.closeStream?.();
  ui.closeStream = null;
  $("offline").hidden = false;
  $("offlineDetail").textContent = `${detail} · retrying every 2 seconds`;
  renderConnection();
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void refresh(), 2000);
}

export function connectStream() {
  ui.closeStream?.();
  ui.closeStream = openEventStream(
    ui.seenSeq,
    (event) => {
      if (event.seq <= ui.seenSeq) return;
      ui.seenSeq = event.seq;
      onBusEvent(event);
      scheduleRefresh();
    },
    (open) => {
      ui.streamOpen = open;
      renderConnection();
      if (!open) scheduleRefresh();
    },
  );
}

export function onBusEvent(event: BusEvent) {
  if (event.eventType === "MessageAccepted") ui.freshMessages.add(event.entityId);
  if (event.eventType === "DeliveryAcknowledged") {
    ui.read.set(String(event.payload.recipientSessionId), performance.now() + 2200);
    return;
  }
  if (event.eventType !== "DeliverySubmitted" || !ui.model) return;
  const to = String(event.payload.recipientSessionId);
  const from = event.actorId === "user" ? "user" : ui.model.sessionByParticipant.get(event.actorId) ?? "user";
  const message = ui.snapshot?.messages.find((m) => m.id === event.payload.messageId);
  ui.packets.push({
    from,
    to,
    roomId: event.conversationId ?? "",
    startedAt: performance.now(),
    artifact: Boolean(message?.parts.some((p) => p.kind === "artifact_ref")),
  });
  ui.receiving.set(to, performance.now() + PACKET_MS);
  wakeCanvas();
}

// ── history paging ────────────────────────────────────────────────────────

const PAGE = 50;

function appendPage(slice: HistorySlice, page: HistorySlice) {
  slice.messages.push(...page.messages);
  slice.deliveries.push(...page.deliveries);
  slice.receipts.push(...page.receipts);
  Object.assign(slice.contexts, page.contexts);
}

export function hasOlder(conversationId: string) {
  return ui.older.get(conversationId)?.hasMore ?? ui.snapshot?.history[conversationId]?.hasMore ?? false;
}

export async function loadOlder(conversationId: string) {
  if (ui.loadingOlder || !ui.snapshot || !hasOlder(conversationId)) return;
  const loaded = ui.older.get(conversationId);
  const windowStart = ui.snapshot.history[conversationId]?.fromSeq;
  const before = loaded ? Math.min(...loaded.slice.messages.map((m) => m.seq)) : windowStart;
  if (before === undefined) return;
  ui.loadingOlder = true;
  try {
    const { hasMore, ...page } = await api.history(conversationId, before, PAGE);
    if (loaded) {
      appendPage(loaded.slice, page);
      loaded.hasMore = hasMore;
    } else ui.older.set(conversationId, { slice: page, hasMore, bound: windowStart! });
    ui.model = buildModel(withHistory(ui.snapshot, ui.older.values()));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    ui.loadingOlder = false;
  }
}

/**
 * Loaded pages cover history below `bound`. If a burst moved the snapshot window past it, fetch the
 * messages in between so the scroll-back stays contiguous.
 */
async function fillHistoryGaps(snapshot: Snapshot) {
  for (const [conversationId, loaded] of ui.older) {
    const windowStart = snapshot.history[conversationId]?.fromSeq;
    if (windowStart === undefined || windowStart <= loaded.bound) continue;
    let before = windowStart;
    for (;;) {
      const { hasMore, ...page } = await api.history(conversationId, before, 500);
      appendPage(loaded.slice, page);
      const oldest = page.messages[0]?.seq;
      if (!hasMore || oldest === undefined || oldest <= loaded.bound) break;
      before = oldest;
    }
    loaded.bound = windowStart;
  }
}

// ── native transcript ─────────────────────────────────────────────────────

export async function loadNative(sessionId: string) {
  ui.native.set(sessionId, await api.native(sessionId));
}
