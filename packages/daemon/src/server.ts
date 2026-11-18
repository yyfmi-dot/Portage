import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { BusEvent, Message } from "@portage/core";
import {
  createRuntime,
  seedDualProviderRoom,
  snapshotForUi,
  type DaemonRuntime,
} from "./runtime.js";

const DEFAULT_PORT = 8787;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

type Body = Record<string, any>;
type Handler = (ctx: {
  runtime: DaemonRuntime;
  params: string[];
  body: Body;
  req: IncomingMessage;
  res: ServerResponse;
}) => Promise<unknown> | unknown;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const routes: Array<{ method: string; pattern: RegExp; mutates: boolean; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler, mutates = method === "POST") {
  const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
  routes.push({ method, pattern, mutates, handler });
}

route("GET", "/api/health", () => ({ ok: true, service: "portage-daemon" }));
route("GET", "/api/snapshot", ({ runtime }) => snapshotForUi(runtime.bus));
route("GET", "/api/discover", async ({ runtime }) => {
  const endpoints = await runtime.refreshDiscovery();
  const bound = new Set([...runtime.bus.sessions.values()].map((s) => `${s.provider}:${s.nativeIdentity}`));
  return {
    endpoints: endpoints.map((e) => ({ ...e, registered: bound.has(`${e.provider}:${e.nativeSessionId}`) })),
  };
});

// sessions
route("POST", "/api/sessions", ({ runtime, body }) => {
  const provider = requireString(body.provider, "provider");
  const nativeIdentity = requireString(body.nativeIdentity, "nativeIdentity");
  const existing = [...runtime.bus.sessions.values()].find(
    (s) => s.provider === provider && s.nativeIdentity === nativeIdentity,
  );
  if (existing) throw new HttpError(409, "session already registered");
  const id = `s_${provider}_${nativeIdentity.replace(/[^\w-]/g, "")}`.slice(0, 48);
  const alias = uniqueAlias(runtime, String(body.alias ?? nativeIdentity).replace(/[^\w-]/g, "").slice(0, 24) || "session");
  const { session } = runtime.bus.registerSession({
    session: {
      id,
      provider,
      harness: String(body.harness ?? "cli"),
      host: String(body.host ?? "terminal"),
      nativeIdentity,
      displayName: String(body.displayName ?? `${provider} · ${nativeIdentity}`),
      alias,
      communicationEnabled: true,
    },
    participantId: `p_${id.slice(2)}`,
  });
  return session;
});
route("POST", "/api/sessions/:id", ({ runtime, params, body }) =>
  runtime.bus.updateSession({
    sessionId: params[0]!,
    displayName: body.displayName,
    alias: body.alias,
    archived: body.archived,
  }),
);
route("POST", "/api/sessions/:id/communication", async ({ runtime, params, body }) => ({
  deliveries: await runtime.bus.setCommunicationEnabled(params[0]!, Boolean(body.enabled)),
}));
route("POST", "/api/sessions/:id/ready", async ({ runtime, params }) => ({
  deliveries: await runtime.bus.markSessionReady(params[0]!),
}));
route("POST", "/api/sessions/:id/direct", ({ runtime, params }) =>
  runtime.bus.ensureDirectConversation(params[0]!),
);

// rooms
route("POST", "/api/rooms", ({ runtime, body }) => {
  const title = requireString(body.title, "title");
  const id = `room_${Date.now().toString(36)}`;
  return runtime.bus.createRoom({ id, title, createdBy: "user", wakeMode: "swarm" });
});
route("POST", "/api/rooms/:id/wake-mode", ({ runtime, params, body }) =>
  runtime.bus.setWakeMode({
    conversationId: params[0]!,
    mode: body.mode,
    coordinatorParticipantId: body.coordinatorParticipantId,
  }),
);
route("POST", "/api/rooms/:id/pause", async ({ runtime, params, body }) => ({
  paused: Boolean(body.paused),
  deliveries: await runtime.bus.setRoomPaused(params[0]!, Boolean(body.paused)),
}));
route("POST", "/api/rooms/:id/policy", async ({ runtime, params, body }) => {
  const conversationId = params[0]!;
  const document =
    typeof body.markdown === "string" && body.markdown.trim()
      ? runtime.bus.publishPolicy({
          scope: "room",
          id: conversationId,
          markdown: body.markdown,
          updatedBy: "user",
        })
      : runtime.bus.getPolicyDocument("room", conversationId);
  const policy =
    body.maxAutoRounds !== undefined || body.agentMessagesPerMinute !== undefined
      ? await runtime.bus.updateRoomPolicy({
          conversationId,
          maxAutoRounds: optionalInt(body.maxAutoRounds),
          agentMessagesPerMinute: optionalInt(body.agentMessagesPerMinute),
        })
      : await runtime.bus.getRoomPolicy(conversationId);
  return { document, policy };
});
route("POST", "/api/rooms/:id/members", ({ runtime, params, body }) =>
  runtime.bus.joinRoom({
    conversationId: params[0]!,
    participantId: requireString(body.participantId, "participantId"),
  }),
);
route("POST", "/api/rooms/:id/members/:participant/leave", ({ runtime, params }) =>
  runtime.bus.leaveRoom({ conversationId: params[0]!, participantId: params[1]! }),
);
route("POST", "/api/policy/global", ({ runtime, body }) =>
  runtime.bus.publishPolicy({
    scope: "global",
    id: "PORTAGE",
    markdown: requireString(body.markdown, "markdown"),
    updatedBy: "user",
  }),
);

// conversations (room or direct)
route("POST", "/api/conversations/:id/send", ({ runtime, params, body }) =>
  runtime.bus.send({
    conversationId: params[0]!,
    senderId: String(body.senderId ?? "user"),
    target: body.target ?? { kind: "room", id: params[0]! },
    text: requireString(body.text, "text"),
    artifactIds: Array.isArray(body.artifactIds) ? body.artifactIds.map(String) : [],
    mentionParticipantIds: Array.isArray(body.mentionParticipantIds)
      ? body.mentionParticipantIds.map(String)
      : [],
    idempotencyKey: String(body.idempotencyKey ?? `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    traceId: body.traceId ? String(body.traceId) : undefined,
    causalParentIds: Array.isArray(body.causalParentIds) ? body.causalParentIds.map(String) : undefined,
    source: body.source === "agent" ? "agent" : "user",
    isManualWake: Boolean(body.isManualWake),
  }),
);
route("POST", "/api/conversations/:id/preview", ({ runtime, params, body }) =>
  runtime.bus.previewContext({
    conversationId: params[0]!,
    text: String(body.text ?? ""),
    recipientSessionId: body.recipientSessionId ? String(body.recipientSessionId) : undefined,
    artifactIds: Array.isArray(body.artifactIds) ? body.artifactIds.map(String) : [],
  }),
);
route("POST", "/api/messages/:id/revise", ({ runtime, params, body }): Message =>
  runtime.bus.reviseMessage({
    messageId: params[0]!,
    text: requireString(body.text, "text"),
    actorId: "user",
  }),
);
route("POST", "/api/artifacts", ({ runtime, body }) => {
  const name = requireString(body.name, "name").replace(/[\\/:*?"<>|]/g, "_");
  const content = Buffer.from(requireString(body.contentBase64, "contentBase64"), "base64");
  if (content.byteLength > MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact too large");
  const hash = `h${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  const storageKey = join(runtime.paths.artifacts, `${hash}_${name}`);
  writeFileSync(storageKey, content);
  return runtime.bus.createArtifact({
    originalName: name,
    mime: String(body.mime ?? ""),
    byteSize: content.byteLength,
    hash,
    storageKey,
    createdBy: String(body.createdBy ?? "user"),
    conversationId: body.conversationId ? String(body.conversationId) : undefined,
  });
});

// ── agent surface (used by @portage/mcp; the session is the caller, never a parameter of trust) ──

function sessionOrThrow(runtime: DaemonRuntime, id: string) {
  const session = runtime.bus.sessions.get(id);
  if (!session || session.archivedAt) throw new HttpError(404, `session not found: ${id}`);
  return session;
}

function participantOf(runtime: DaemonRuntime, sessionId: string) {
  const participant = [...runtime.bus.participants.values()].find((p) => p.sessionId === sessionId);
  if (!participant) throw new HttpError(404, `participant not found for session: ${sessionId}`);
  return participant;
}

/** Match a CLI's ancestor pids against registered native identities (nearest ancestor wins). */
route("POST", "/api/agent/resolve", ({ runtime, body }) => {
  const pids = Array.isArray(body.pids) ? body.pids.map(Number) : [];
  for (const pid of pids) {
    const session = [...runtime.bus.sessions.values()].find(
      (s) => !s.archivedAt && s.nativeIdentity === `pid-${pid}`,
    );
    if (session) return { sessionId: session.id, alias: session.alias, matchedPid: pid };
  }
  throw new HttpError(404, `no registered session matches pids ${pids.join(",") || "(none)"}`);
}, false);

route("GET", "/api/agent/:session/room", ({ runtime, params }) => {
  const session = sessionOrThrow(runtime, params[0]!);
  const rooms = runtime.bus.activeRoomsForSession(session.id).map((room) => {
    const policy = runtime.bus.policies.get(room.id)!;
    const state = runtime.bus.roomState.get(room.id)!;
    const members = runtime.bus.memberships
      .filter((m) => m.conversationId === room.id && !m.leftAt)
      .map((m) => runtime.bus.participants.get(m.participantId)?.sessionId)
      .map((id) => (id ? runtime.bus.sessions.get(id) : undefined))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const lead = policy.coordinatorParticipantId
      ? runtime.bus.participants.get(policy.coordinatorParticipantId)?.sessionId
      : undefined;
    return {
      roomId: room.id,
      title: room.title,
      wakeMode: policy.wakeMode,
      coordinator: lead ? runtime.bus.sessions.get(lead)?.alias ?? null : null,
      youAreCoordinator: lead === session.id,
      paused: state.paused,
      rounds: `${state.rounds}/${policy.maxAutoRounds}`,
      members: members.map((m) => ({
        alias: m.alias,
        name: m.displayName,
        provider: m.provider,
        host: m.host,
        execution: runtime.bus.runtime.get(m.id)?.execution ?? "unknown",
        communicationEnabled: m.communicationEnabled,
        isYou: m.id === session.id,
      })),
      collaboration: runtime.bus.getPolicyDocument("room", room.id)?.markdown ?? "",
    };
  });
  return { you: { alias: session.alias, name: session.displayName }, rooms };
}, false);

/** Unread deliveries with the exact compiled text; reading them is what records agent_ack. */
route("POST", "/api/agent/:session/inbox", ({ runtime, params, body }) => {
  const session = sessionOrThrow(runtime, params[0]!);
  const limit = Math.min(Math.max(Number(body.limit ?? 10), 1), 50);
  const unread = runtime.bus.unreadDeliveries(session.id);
  const items = unread.slice(0, limit).map(({ delivery, message, snapshot }) => {
    const sender =
      message.senderId === "user"
        ? "你（用户）"
        : runtime.bus.sessions.get(runtime.bus.participants.get(message.senderId)?.sessionId ?? "")?.alias ?? message.senderId;
    if (body.acknowledge !== false) runtime.bus.acknowledgeDelivery({ deliveryId: delivery.id, sessionId: session.id });
    return {
      deliveryId: delivery.id,
      messageId: message.id,
      traceId: message.traceId,
      conversationId: message.conversationId,
      from: sender,
      receivedAt: message.createdAt,
      content: snapshot?.query ?? "",
    };
  });
  // Reading proves receipt (agent_ack) only. Busy/idle is the host's signal, reported via /status —
  // conflating the two would leave a session "busy" forever when an agent never reports idle.
  return { items, remaining: unread.length - items.length };
});

route("POST", "/api/agent/:session/send", async ({ runtime, params, body }) => {
  const session = sessionOrThrow(runtime, params[0]!);
  const me = participantOf(runtime, session.id);
  const text = requireString(body.text, "text");

  const replyTo = body.replyToMessageId
    ? runtime.bus.messages.find((m) => m.id === String(body.replyToMessageId))
    : undefined;
  if (body.replyToMessageId && !replyTo) throw new HttpError(404, `message not found: ${body.replyToMessageId}`);

  const rooms = runtime.bus.activeRoomsForSession(session.id);
  const conversationId = String(body.roomId ?? replyTo?.conversationId ?? "");
  const room = conversationId
    ? rooms.find((r) => r.id === conversationId)
    : rooms.length === 1
      ? rooms[0]
      : undefined;
  if (!room) {
    throw new HttpError(
      400,
      rooms.length
        ? `you are in ${rooms.length} rooms; pass roomId (${rooms.map((r) => r.id).join(", ")})`
        : conversationId
          ? `you are not an active member of ${conversationId}`
          : "you are not in any room",
    );
  }

  const members = runtime.bus.memberships
    .filter((m) => m.conversationId === room.id && !m.leftAt)
    .map((m) => runtime.bus.participants.get(m.participantId))
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.sessionId));
  const byAlias = new Map(members.map((p) => [runtime.bus.sessions.get(p.sessionId!)!.alias, p.id]));
  const wanted = new Set<string>(Array.isArray(body.to) ? body.to.map((a: unknown) => String(a).replace(/^@/, "")) : []);
  for (const match of text.matchAll(/@([\w-]+)/g)) wanted.add(match[1]!);
  const unknown = [...wanted].filter((a) => !byAlias.has(a));
  if (unknown.length && Array.isArray(body.to) && body.to.length)
    throw new HttpError(400, `unknown or non-member alias: ${unknown.join(", ")}. members: ${[...byAlias.keys()].join(", ")}`);
  const mentionParticipantIds = [...wanted]
    .map((a) => byAlias.get(a))
    .filter((id): id is string => Boolean(id) && id !== me.id) as string[];

  return runtime.bus.send({
    conversationId: room.id,
    senderId: me.id,
    target: { kind: "room", id: room.id },
    text,
    artifactIds: Array.isArray(body.artifactIds) ? body.artifactIds.map(String) : [],
    mentionParticipantIds,
    traceId: replyTo?.traceId,
    causalParentIds: replyTo ? [replyTo.id] : [],
    source: "agent",
    idempotencyKey: String(body.idempotencyKey ?? `agent_${session.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
  });
});

route("POST", "/api/agent/:session/status", async ({ runtime, params, body }) => {
  const session = sessionOrThrow(runtime, params[0]!);
  const execution = String(body.execution ?? "");
  if (!["idle", "running", "waiting_human"].includes(execution))
    throw new HttpError(400, "execution must be idle | running | waiting_human");
  if (execution === "idle") return { deliveries: await runtime.bus.markSessionReady(session.id), execution };
  runtime.bus.setSessionExecution(session.id, execution as "running" | "waiting_human");
  return { deliveries: [], execution };
});

export async function startServer(port = DEFAULT_PORT) {
  const runtime = createRuntime({ hydrate: true });
  await seedDualProviderRoom(runtime);
  runtime.persist();

  const server = createServer((req, res) => {
    void handle(req, res, runtime);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return { server, runtime, port };
}

async function handle(req: IncomingMessage, res: ServerResponse, runtime: DaemonRuntime) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && url.pathname === "/api/events/stream") {
    const resumeFrom = Number(req.headers["last-event-id"] ?? 0);
    const since = Math.max(Number(url.searchParams.get("since") ?? 0), resumeFrom || 0);
    return streamEvents(req, res, runtime, since);
  }

  const match = routes
    .filter((r) => r.method === method)
    .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
    .find((x) => x.m);
  if (!match?.m) return send(res, 404, { error: `not found: ${method} ${url.pathname}` });

  try {
    const body = method === "POST" ? await readJson(req) : {};
    const params = match.m.slice(1).map(decodeURIComponent);
    const result = await match.r.handler({ runtime, params, body, req, res });
    if (match.r.mutates) runtime.persist();
    return send(res, 200, result ?? { ok: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return send(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Server-sent events: replay events after `since`, then push live bus events. */
function streamEvents(req: IncomingMessage, res: ServerResponse, runtime: DaemonRuntime, since: number) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  const write = (event: BusEvent) => res.write(`id: ${event.seq}\nevent: bus\ndata: ${JSON.stringify(event)}\n\n`);
  for (const event of runtime.bus.listEvents({ sinceSeq: since })) write(event);
  const unsubscribe = runtime.bus.onEvent(write);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function uniqueAlias(runtime: DaemonRuntime, base: string) {
  const taken = new Set([...runtime.bus.sessions.values()].map((s) => s.alias));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} required`);
  return value;
}

function optionalInt(value: unknown) {
  return value === undefined || value === null || value === "" ? undefined : Number(value);
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res: ServerResponse, status: number, payload: unknown) {
  cors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
