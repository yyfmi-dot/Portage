import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { TUNABLE_BUDGETS, policyDocumentBody, type BusEvent, type Message } from "@portage/core";
import { createRuntime, historyPage, seedDemoRoom, snapshotForUi, type DaemonRuntime, type RuntimeOptions } from "./runtime.js";

const DEFAULT_PORT = 8787;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const TICK_MS = 5000;

type Body = Record<string, any>;
type Handler = (ctx: {
  runtime: DaemonRuntime;
  params: string[];
  body: Body;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
}) => Promise<unknown> | unknown;

/** A non-JSON response body (file content). */
class RawBody {
  constructor(
    readonly content: Buffer,
    readonly contentType: string,
    readonly filename: string,
  ) {}
}

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
route("POST", "/api/sessions", async ({ runtime, body }) => {
  const provider = requireString(body.provider, "provider");
  const nativeIdentity = requireString(body.nativeIdentity, "nativeIdentity");
  const existing = [...runtime.bus.sessions.values()].find(
    (s) => s.provider === provider && s.nativeIdentity === nativeIdentity,
  );
  if (existing) throw new HttpError(409, "session already registered");
  const adapterId = body.adapterId ? knownAdapter(runtime, String(body.adapterId)) : undefined;
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
      adapterId,
      workdir: body.workdir ? String(body.workdir) : undefined,
    },
    participantId: `p_${id.slice(2)}`,
  });
  await runtime.syncNative(session.id);
  return session;
});
route("POST", "/api/sessions/:id/rebind", ({ runtime, params, body }) =>
  runtime.bus.rebindSession({
    sessionId: params[0]!,
    nativeIdentity: body.nativeIdentity ? String(body.nativeIdentity) : undefined,
    adapterId: body.adapterId ? knownAdapter(runtime, String(body.adapterId)) : undefined,
    workdir: body.workdir ? String(body.workdir) : undefined,
  }),
);
route("POST", "/api/sessions/:id/confirm-binding", async ({ runtime, params }) => ({
  deliveries: await runtime.bus.confirmBinding(params[0]!),
}));
route("POST", "/api/sessions/:id/interrupt", ({ runtime, params }) => ({ interrupted: runtime.interrupt(params[0]!) }));
route("GET", "/api/sessions/:id/native", ({ runtime, params, url }) => ({
  events: runtime.bus.listNativeEvents(params[0]!, Math.min(Number(url.searchParams.get("limit") ?? 200), 1000)),
  checkpoint: runtime.bus.nativeCheckpoints.get(params[0]!) ?? null,
}));
route("GET", "/api/deliveries/:id/context", ({ runtime, params }) => {
  const snapshot = runtime.bus.contextSnapshots.get(params[0]!);
  if (!snapshot) throw new HttpError(404, `no compiled context for delivery ${params[0]}`);
  return snapshot;
});
route("GET", "/api/conversations/:id/messages", ({ runtime, params, url }) => {
  if (!runtime.bus.conversations.has(params[0]!)) throw new HttpError(404, `conversation not found: ${params[0]}`);
  const before = Number(url.searchParams.get("beforeSeq") ?? Number.POSITIVE_INFINITY);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  return historyPage(runtime.bus, params[0]!, before, limit);
});
route("POST", "/api/deliveries/:id/cancel", ({ runtime, params }) =>
  runtime.bus.cancelDelivery({ deliveryId: params[0]!, actorId: "user" }),
);
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
  const budgets = Object.fromEntries(
    TUNABLE_BUDGETS.filter((key) => body[key] !== undefined).map((key) => [key, optionalInt(body[key])]),
  );
  if (Object.keys(budgets).length) await runtime.bus.updateRoomPolicy({ conversationId, ...budgets });
  if (typeof body.markdown === "string" && body.markdown.trim()) {
    return runtime.bus.publishRoomPolicy({ conversationId, markdown: body.markdown, updatedBy: "user" });
  }
  return {
    document: runtime.bus.getPolicyDocument("room", conversationId),
    policy: await runtime.bus.getRoomPolicy(conversationId),
  };
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
route("POST", "/api/messages/:id/revise", ({ runtime, params, body }): Promise<Message> =>
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
    mime: String(body.mime || guessMime(name)),
    byteSize: content.byteLength,
    hash,
    storageKey,
    createdBy: String(body.createdBy ?? "user"),
    conversationId: body.conversationId ? String(body.conversationId) : undefined,
  });
});
route("GET", "/api/artifacts/:id/content", ({ runtime, params }) => {
  const artifact = runtime.bus.artifacts.get(params[0]!);
  if (!artifact) throw new HttpError(404, `artifact not found: ${params[0]}`);
  const path = resolve(artifact.storageKey);
  if (!path.startsWith(resolve(runtime.paths.artifacts) + sep)) throw new HttpError(403, "artifact is outside the store");
  if (!existsSync(path)) throw new HttpError(410, `artifact content is gone: ${artifact.originalName}`);
  const mime = artifact.mime === "application/octet-stream" ? guessMime(artifact.originalName) : artifact.mime;
  return new RawBody(readFileSync(path), mime, artifact.originalName);
});

/** Browsers upload many source files with an empty type; without a guess "open" turns into a download. */
function guessMime(name: string) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", json: "application/json",
  };
  if (known[ext]) return known[ext];
  return /^(md|markdown|txt|log|csv|tsv|ya?ml|toml|ini|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|diff|patch)$/.test(ext)
    ? "text/plain"
    : "application/octet-stream";
}

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
      collaboration: policyDocumentBody(runtime.bus.getPolicyDocument("room", room.id)?.markdown ?? ""),
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
        ? "you (the user)"
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

  const replyTo = body.replyToMessageId ? runtime.bus.getMessage(String(body.replyToMessageId)) : undefined;
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
  const deliveries = await runtime.bus.reportExecution(session.id, execution as "idle" | "running" | "waiting_human");
  return { deliveries, execution };
});

export async function startServer(port = DEFAULT_PORT, options: Pick<RuntimeOptions, "native"> = {}) {
  const runtime = createRuntime({ hydrate: true, daemonUrl: `http://127.0.0.1:${port}`, ...options });
  await seedDemoRoom(runtime);
  runtime.persist();

  const server = createServer((req, res) => {
    void handle(req, res, runtime);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  // Time-driven recovery (rate windows reopening, unconfirmed submissions) runs outside requests.
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (await runtime.tick()) runtime.persist();
    } catch (error) {
      console.error("[portage] background tick failed:", error);
    } finally {
      ticking = false;
    }
  }, TICK_MS);
  timer.unref();
  server.on("close", () => clearInterval(timer));

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
    const result = await match.r.handler({ runtime, params, body, url, req, res });
    if (match.r.mutates) runtime.persist();
    if (result instanceof RawBody) return sendRaw(res, result);
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

function knownAdapter(runtime: DaemonRuntime, adapterId: string) {
  const known = [runtime.inbox.id, ...runtime.native.map((a) => a.id)];
  if (!known.includes(adapterId)) throw new HttpError(400, `unknown adapterId ${adapterId}; known: ${known.join(", ")}`);
  return adapterId;
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

/**
 * Shared files are untrusted: a sandbox CSP keeps HTML/SVG opened in a tab from running script on
 * this origin. PDFs are exempt because Chrome refuses to render them in a sandboxed document.
 */
function sendRaw(res: ServerResponse, raw: RawBody) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": /^text\/[^;]+$/.test(raw.contentType) ? `${raw.contentType}; charset=utf-8` : raw.contentType,
    "Content-Length": raw.content.byteLength,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(raw.filename)}`,
    ...(raw.contentType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox" }),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(raw.content);
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
