import type { Artifact, BusEvent, Delivery, DeliveryReceipt } from "@portage/core";
import type { HistorySlice, Snapshot } from "./api.js";
import { palette, stateLabels, reasonLabels, DORMANT_AFTER_MS, type VSession, type VRoom, type VMessage, type VDelivery, type VEvent, type Model } from "./state.js";
import { modeLabel } from "./format.js";

export function hashIndex(value: string, size: number) {
  let h = 0;
  for (const c of value) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % size;
}

export const providerLabel = (p: string) =>
  p === "codex" ? "Codex" : p === "claude" ? "Claude" : p === "antigravity" ? "Antigravity" : p;
export const hostLabel = (h: string) =>
  ({ terminal: "Terminal", vscode_cli: "VS Code", app: "Desktop app", headless: "No window" })[h] ?? h;

/**
 * A session counts as "reading" once any of its deliveries was ever acknowledged by its agent.
 * Only then does "unread" mean something; for a session with no MCP bridge, claiming "unread"
 * would pin a meaningless red dot on it forever, so the UI says "delivered" and nothing more.
 */
export function readingSessions(s: Snapshot) {
  const deliveryOwner = new Map(s.deliveries.map((d) => [d.id, d.recipientSessionId]));
  const reading = new Set<string>();
  for (const r of s.receipts) {
    if (r.proofLevel !== "agent_ack") continue;
    const owner = deliveryOwner.get(r.deliveryId);
    if (owner) reading.add(owner);
  }
  return reading;
}

/** "Unread" is only claimed where it is knowable: delivered, not acknowledged, and the agent reads via the bridge. */
export const isUnread = (d: VDelivery) => d.state === "submitted" && !d.ack && d.tracksRead;

export function traceWakeups(s: Snapshot, conversationId: string, traceId?: string) {
  if (!traceId) return 0;
  const agentMessages = new Set(
    s.messages
      .filter((m) => m.conversationId === conversationId && m.traceId === traceId && m.source !== "user")
      .map((m) => m.id),
  );
  return s.deliveries.filter((d) => agentMessages.has(d.messageId)).length;
}

export const PULSE_BUCKETS = 24;
export const PULSE_SPAN_MS = 30_000;
export function activityPulse(s: Snapshot, conversationId: string, now: number) {
  const buckets = new Array<number>(PULSE_BUCKETS).fill(0);
  const start = now - PULSE_BUCKETS * PULSE_SPAN_MS;
  for (const e of s.events) {
    if (e.conversationId !== conversationId) continue;
    const at = Date.parse(e.serverTime);
    if (at < start) continue;
    buckets[Math.min(PULSE_BUCKETS - 1, Math.floor((at - start) / PULSE_SPAN_MS))]! += 1;
  }
  return buckets;
}

/** The snapshot window plus any older pages the user loaded; the snapshot's copy of a record wins. */
export function withHistory(s: Snapshot, older: Iterable<{ slice: HistorySlice }>): Snapshot {
  const pages = [...older].map((o) => o.slice);
  if (!pages.length) return s;
  const merge = <T>(pick: (x: HistorySlice) => T[], key: (item: T) => string) => {
    const byKey = new Map<string, T>();
    for (const page of pages) for (const item of pick(page)) byKey.set(key(item), item);
    for (const item of pick(s)) byKey.set(key(item), item);
    return [...byKey.values()];
  };
  return {
    ...s,
    messages: merge((x) => x.messages, (m) => m.id).sort((a, b) => a.seq - b.seq),
    deliveries: merge((x) => x.deliveries, (d) => d.id),
    receipts: merge((x) => x.receipts, (r) => `${r.deliveryId}:${r.proofLevel}`),
    contexts: Object.assign({}, ...pages.map((p) => p.contexts), s.contexts),
  };
}

export function buildModel(s: Snapshot): Model {
  const now = Date.now();
  const reading = readingSessions(s);
  const sessionByParticipant = new Map<string, string>();
  for (const p of s.participants) if (p.sessionId) sessionByParticipant.set(p.id, p.sessionId);
  const participantBySession = new Map([...sessionByParticipant].map(([p, sid]) => [sid, p]));
  const deliveryById = new Map(s.deliveries.map((d) => [d.id, d]));
  const lastSubmitted = new Map<string, number>();
  for (const r of s.receipts) {
    const d = deliveryById.get(r.deliveryId);
    if (!d) continue;
    const at = Date.parse(r.observedAt);
    if (at > (lastSubmitted.get(d.recipientSessionId) ?? 0)) lastSubmitted.set(d.recipientSessionId, at);
  }

  const sessions: VSession[] = s.sessions
    .filter((x) => !x.archivedAt)
    .map((x) => {
      const runtime = s.runtimes[x.id] ?? { execution: "unknown", writable: false };
      let execution: string = runtime.execution;
      if (execution === "idle" && now - (lastSubmitted.get(x.id) ?? 0) > DORMANT_AFTER_MS) execution = "dormant";
      return {
        id: x.id,
        participantId: participantBySession.get(x.id) ?? "",
        provider: providerLabel(x.provider),
        host: hostLabel(x.host),
        name: x.displayName,
        alias: x.alias,
        execution,
        enabled: x.communicationEnabled,
        writable: runtime.writable,
        color: palette[hashIndex(x.id, palette.length)]!,
        nativeIdentity: x.nativeIdentity,
        adapterId: x.adapterId,
        workdir: x.workdir,
        bindingEpoch: x.bindingEpoch ?? 1,
        demo: x.nativeIdentity.startsWith("demo-"),
        detail: runtime.detail,
        checkpoint: s.nativeCheckpoints[x.id],
      };
    });
  const live = new Set(sessions.map((x) => x.id));

  const rooms: VRoom[] = s.conversations
    .filter((c) => c.kind === "room")
    .map((c) => {
      const members = s.memberships
        .filter((m) => m.conversationId === c.id && !m.leftAt)
        .map((m) => sessionByParticipant.get(m.participantId))
        .filter((id): id is string => Boolean(id && live.has(id)));
      const coordinatorPid = c.policy?.wakeMode === "coordinator" ? c.policy.coordinatorParticipantId : undefined;
      return {
        id: c.id,
        name: c.title,
        members,
        mode: c.policy?.wakeMode ?? "swarm",
        coordinator: coordinatorPid ? sessionByParticipant.get(coordinatorPid) ?? null : null,
        paused: Boolean(c.state?.paused),
        revision: c.document?.publishedRevision ?? 0,
        document: c.document?.markdown ?? "",
        roundBudget: c.policy?.maxAutoRounds ?? 4,
        messageBudget: c.policy?.agentMessagesPerMinute ?? 12,
        // a wake past the limit is held and counted one over internally; the user sees the limit reached
        rounds: Math.min(c.state?.rounds ?? 0, c.policy?.maxAutoRounds ?? 4),
        autoMessages: s.messages.filter(
          (m) => m.conversationId === c.id && m.source !== "user" && now - Date.parse(m.createdAt) < 60_000,
        ).length,
        maxConcurrent: c.policy?.maxConcurrent ?? 2,
        maxWakeups: c.policy?.maxWakeupsPerTrace ?? 20,
        runningSeats: members.filter((id) => s.runtimes[id]?.execution === "running").length,
        traceWakeups: traceWakeups(s, c.id, c.state?.activeTraceId),
        pulse: activityPulse(s, c.id, now),
      };
    })
    // Empty Portage Studio after serve retires the demo cast — hide until Watch a demo.
    .filter((r) => r.members.length > 0 || r.id !== "room_dev");

  const artifactsById = new Map(s.artifacts.map((a) => [a.id, a]));
  const directIds = new Set(s.conversations.filter((c) => c.kind === "direct").map((c) => c.id));
  const messages: VMessage[] = s.messages
    .map((m) => {
      const text = m.parts.find((p) => p.kind === "text");
      return {
        id: m.id,
        sender: m.senderId === "user" ? "user" : sessionByParticipant.get(m.senderId) ?? m.senderId,
        text: text && "text" in text ? text.text : "",
        artifacts: m.parts
          .filter((p) => p.kind === "artifact_ref")
          .map((p) => artifactsById.get((p as { artifactId: string }).artifactId))
          .filter((a): a is Artifact => Boolean(a)),
        recipients: s.deliveries.filter((d) => d.messageId === m.id).map((d) => d.recipientSessionId),
        conversationId: m.conversationId,
        direct: directIds.has(m.conversationId),
        traceId: m.traceId,
        parentId: m.causalParentIds[0] ?? null,
        revision: m.revision,
        at: Date.parse(m.createdAt),
        demo: m.idempotencyKey.startsWith("demo_"),
      };
    })
    .sort((a, b) => a.at - b.at);

  // Receipts stack: submitted (adapter) → native_confirmed (transcript) → agent_ack (MCP). Keep each
  // level; never let one hide another.
  const receiptByDelivery = new Map<string, DeliveryReceipt>();
  const confirmedByDelivery = new Map<string, DeliveryReceipt>();
  const ackByDelivery = new Map<string, DeliveryReceipt>();
  for (const r of s.receipts) {
    if (r.proofLevel === "agent_ack") ackByDelivery.set(r.deliveryId, r);
    else if (r.proofLevel === "native_confirmed") confirmedByDelivery.set(r.deliveryId, r);
    else receiptByDelivery.set(r.deliveryId, r);
  }
  const deliveries: VDelivery[] = s.deliveries.map((d: Delivery) => ({
    id: d.id,
    messageId: d.messageId,
    recipient: d.recipientSessionId,
    roomId: d.conversationId,
    state: d.state,
    reason: d.reason ?? "",
    messageRevision: d.messageRevision,
    revision: s.contexts[d.id]?.revisions.room,
    nextAttemptAt: d.nextAttemptAt ? Date.parse(d.nextAttemptAt) : undefined,
    detail: d.detail,
    context: s.contexts[d.id],
    receipt: receiptByDelivery.get(d.id),
    confirmed: confirmedByDelivery.get(d.id),
    ack: ackByDelivery.get(d.id),
    tracksRead: reading.has(d.recipientSessionId),
  }));

  const archived = s.sessions
    .filter((x) => x.archivedAt)
    .map((x) => ({ id: x.id, name: x.displayName, provider: providerLabel(x.provider), host: hostLabel(x.host), archivedAt: Date.parse(x.archivedAt!) }))
    .sort((a, b) => b.archivedAt - a.archivedAt);

  const model: Model = {
    sessions,
    archived,
    rooms,
    messages,
    deliveries,
    events: [],
    artifacts: s.artifacts,
    globalRevision: s.globalDocument?.publishedRevision ?? 0,
    globalDocument: s.globalDocument?.markdown ?? "",
    sessionByParticipant,
  };
  model.events = s.events.map((e) => describeEvent(e, model, s)).filter((e): e is VEvent => Boolean(e));
  return model;
}

export function describeEvent(e: BusEvent, m: Model, s: Snapshot): VEvent | null {
  const p = e.payload;
  const nameOf = (sessionId?: string | null) =>
    sessionId ? m.sessions.find((x) => x.id === sessionId)?.name ?? s.sessions.find((x) => x.id === sessionId)?.displayName ?? sessionId : "Unknown session";
  const actorSession = e.actorId === "user" ? "user" : m.sessionByParticipant.get(e.actorId) ?? null;
  const actorName = actorSession === "user" ? "You" : nameOf(actorSession);
  const base = {
    id: e.id,
    seq: e.seq,
    at: Date.parse(e.serverTime),
    roomId: e.conversationId ?? null,
    sessionId: null as string | null,
    messageId: null as string | null,
    traceId: e.traceId,
    wait: false,
  };
  const recipient = typeof p.recipientSessionId === "string" ? p.recipientSessionId : null;
  switch (e.eventType) {
    case "MessageAccepted": {
      const msg = m.messages.find((x) => x.id === e.entityId);
      const target =
        p.targetKind === "room"
          ? m.rooms.find((r) => r.id === p.targetId)?.name ?? "room"
          : nameOf(m.sessionByParticipant.get(String(p.targetId)));
      return {
        ...base,
        messageId: e.entityId,
        description: `${actorName} → ${target} · ${(msg?.text ?? "").slice(0, 90)}`,
        status: Number(p.recipients) ? "In inboxes" : "Logged, nobody woken",
      };
    }
    case "DeliverySubmitted":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${actorName} → ${nameOf(recipient)}`,
        status: "Delivered to its session",
      };
    case "DeliveryAcknowledged":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${nameOf(recipient)} read the message`,
        status: "Read",
      };
    case "DeliveryQueued":
      if (!p.reason) return null;
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `Queued for ${nameOf(recipient)} · ${reasonLabels[String(p.reason)] ?? p.reason}`,
        status: p.reason === "seats" ? "Delivers when a seat frees up" : "Waiting until ready",
        wait: true,
      };
    case "DeliveryHeld":
      return {
        ...base,
        sessionId: recipient,
        messageId: String(p.messageId),
        description: `${actorName} → ${nameOf(recipient)} · ${reasonLabels[String(p.reason)] ?? p.reason}${p.detail ? `（${p.detail}）` : ""}`,
        status: p.reason === "budget" ? "Resumes when the limit resets" : "Held",
        wait: true,
      };
    case "DeliveryUncertain":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · unsure whether it landed`, status: "Checking its record", wait: true };
    case "DeliveryFailed":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · delivery failed ${p.reason ?? ""}`, status: "Failed", wait: true };
    case "DeliveryCancelled":
      return { ...base, sessionId: recipient, messageId: String(p.messageId), description: `${nameOf(recipient)} · delivery cancelled`, status: "Cancelled" };
    case "MembershipChanged": {
      const sid = m.sessionByParticipant.get(e.entityId) ?? null;
      return { ...base, sessionId: sid, description: `${nameOf(sid)} ${p.action === "joined" ? "joined" : "left"} the room`, status: "Members changed" };
    }
    case "RoomPolicyChanged": {
      if (p.wakeMode) {
        const lead = p.coordinatorParticipantId ? nameOf(m.sessionByParticipant.get(String(p.coordinatorParticipantId))) : null;
        const text =
          p.reason === "coordinator_left"
            ? lead ? `${lead} is now the lead` : "No lead anymore; switched to open floor"
            : `Room mode · ${modeLabel(String(p.wakeMode))}${p.wakeMode === "coordinator" && lead ? ` · ${lead}` : ""}`;
        return { ...base, description: text, status: "Routing updated" };
      }
      const parts = [
        `${p.maxAutoRounds} rounds`,
        `${p.agentMessagesPerMinute} msgs/min`,
        p.maxConcurrent ? `${p.maxConcurrent} at once` : "",
        p.maxWakeupsPerTrace ? `${p.maxWakeupsPerTrace} wake-ups/thread` : "",
      ].filter(Boolean);
      return { ...base, description: `Limits updated · ${parts.join(" · ")}`, status: "Applies now" };
    }
    case "RoomPaused":
      return { ...base, description: `Auto-messaging ${p.paused ? "paused" : "resumed"}`, status: p.paused ? "Messages still logged" : "Delivering again", wait: Boolean(p.paused) };
    case "PolicyPublished":
      return {
        ...base,
        description: p.scope === "global" ? `Global rules v${p.revision} published` : `Room rules v${p.revision} published`,
        status: "Applies from the next delivery",
      };
    case "SessionCommunicationChanged":
      return { ...base, sessionId: e.entityId, description: `${nameOf(e.entityId)} · receiving ${p.enabled ? "on" : "off"}`, status: "Logged" };
    case "SessionExecutionChanged":
      return {
        ...base,
        sessionId: e.entityId,
        description: `${nameOf(e.entityId)} · ${stateLabels[String(p.execution)] ?? p.execution}${p.detail ? ` · ${p.detail}` : ""}`,
        status: "Status changed",
        wait: Boolean(p.detail),
      };
    case "SessionBindingChanged":
      return { ...base, sessionId: e.entityId, description: `${nameOf(e.entityId)} · session identity changed`, status: "Waiting for you to confirm", wait: true };
    case "NativeEventObserved": {
      // Only what proves or breaks the link is worth a feed line; outputs live in the session's sync view.
      const sid = String(p.sessionId);
      if (p.kind === "input" && p.correlation !== "unknown")
        return { ...base, sessionId: sid, messageId: e.causalParentIds[0] ?? null, description: `The message shows up in ${nameOf(sid)}'s own record`, status: p.correlation === "exact" ? "Confirmed" : "Inferred" };
      if (p.kind === "turn_failed") return { ...base, sessionId: sid, description: `${nameOf(sid)}'s turn did not finish`, status: "See details", wait: true };
      return null;
    }
    case "ArtifactCreated":
      return { ...base, description: `${actorName} shared ${p.name}`, status: `File v${p.version}` };
    case "SessionRegistered":
      return { ...base, sessionId: e.entityId, description: `Added ${nameOf(e.entityId)} · ${providerLabel(String(p.provider))} / ${hostLabel(String(p.host))}`, status: "Added" };
    case "SessionUpdated":
      return {
        ...base,
        sessionId: e.entityId,
        description: p.source === "native" ? `Renamed in its own app to “${p.displayName}”` : `${nameOf(e.entityId)} · name or settings updated`,
        status: "Logged",
      };
    case "RoomCreated":
      return { ...base, description: `New room “${p.title}”`, status: "Logged" };
    case "RoomRenamed":
      return { ...base, description: `Room renamed from “${p.previous}” to “${p.title}”`, status: "Logged" };
    case "MessageRevised":
      return { ...base, messageId: e.entityId, description: `Message edited to v${p.revision}`, status: "Undelivered copies use the new version" };
    default:
      return null;
  }
}
