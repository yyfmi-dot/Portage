// Performance check against docs/ARCHITECTURE.md §10 targets. Run: npx tsx scripts/bench.ts [history=100000]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBus } from "@portage/core";
import { SqliteSnapshotStore } from "@portage/core/node";
import { snapshotForUi } from "../packages/daemon/src/runtime.js";
import { startServer } from "../packages/daemon/src/server.js";

const HISTORY = Number(process.argv[2] ?? 100_000);
const SESSIONS = 50;
const ROOMS = 10;
const BODY = "x".repeat(2048);

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!;
const stats = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} · p95 ${pct(xs, 95).toFixed(1)} · p99 ${pct(xs, 99).toFixed(1)} ms`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const row = (name: string, value: string, target = "") => console.log(`${name.padEnd(34)} ${value.padEnd(44)} ${target}`);

const home = mkdtempSync(join(tmpdir(), "portage-bench-"));
const db = join(home, "portage.db");

function seed(bus: MemoryBus) {
  for (let i = 0; i < SESSIONS; i += 1) {
    bus.registerSession({
      session: { id: `s${i}`, provider: i % 2 ? "claude" : "codex", harness: "cli", host: "terminal", nativeIdentity: `n${i}`, displayName: `S${i}`, alias: `a${i}`, communicationEnabled: true },
      participantId: `p${i}`,
    });
  }
  for (let r = 0; r < ROOMS; r += 1) {
    bus.createRoom({ id: `r${r}`, title: `Room ${r}`, createdBy: "user", wakeMode: "swarm" });
  }
}

async function join10(bus: MemoryBus) {
  for (let r = 0; r < ROOMS; r += 1)
    for (let k = 0; k < 11; k += 1) await bus.joinRoom({ conversationId: `r${r}`, participantId: `p${(r * 5 + k) % SESSIONS}` });
  for (let r = 0; r < ROOMS; r += 1) await bus.updateRoomPolicy({ conversationId: `r${r}`, agentMessagesPerMinute: 1000, maxAutoRounds: 100, maxConcurrent: 20 });
}

const mentions = (r: number) => Array.from({ length: 10 }, (_, k) => `p${(r * 5 + k + 1) % SESSIONS}`);

console.log(`Portage bench · history ${HISTORY} · ${SESSIONS} sessions · ${ROOMS} rooms · node ${process.version}\n`);

// ── build history through the real send path, persisting in batches ──
let bus = new MemoryBus();
seed(bus);
await join10(bus);
let store = new SqliteSnapshotStore(db);
let t = performance.now();
for (let i = 0; i < HISTORY; i += 1) {
  const r = i % ROOMS;
  await bus.send({ conversationId: `r${r}`, senderId: "user", target: { kind: "room", id: `r${r}` }, text: `h${i}`, mentionParticipantIds: i % 10 === 0 ? mentions(r).slice(0, 3) : [], idempotencyKey: `h${i}`, source: "user" });
  if (i % 5000 === 4999) store.save(bus);
}
store.save(bus);
row("build history", `${((HISTORY / (performance.now() - t)) * 1000).toFixed(0)} msg/s · ${bus.deliveries.length} deliveries`);
row("daemon heap after build", mb(process.memoryUsage().heapUsed), "< 300 MB");

// ── steady: 2 KiB × 10 recipients, accept + persist per message ──
const accept: number[] = [];
for (let i = 0; i < 400; i += 1) {
  const r = i % ROOMS;
  const s = performance.now();
  await bus.send({ conversationId: `r${r}`, senderId: "user", target: { kind: "room", id: `r${r}` }, text: BODY, mentionParticipantIds: mentions(r), idempotencyKey: `st${i}`, source: "user" });
  store.save(bus);
  accept.push(performance.now() - s);
}
row("accept + persist (2 KiB × 10)", stats(accept), "p95 < 50 ms");

// ── burst: 2000 messages as fast as they come ──
t = performance.now();
for (let i = 0; i < 2000; i += 1) {
  const r = i % ROOMS;
  await bus.send({ conversationId: `r${r}`, senderId: "user", target: { kind: "room", id: `r${r}` }, text: BODY, mentionParticipantIds: mentions(r).slice(0, 2), idempotencyKey: `b${i}`, source: "user" });
  if (i % 200 === 199) store.save(bus);
}
store.save(bus);
const burstMs = performance.now() - t;
row("burst 2000 (≙ 200/s × 10 s)", `${burstMs.toFixed(0)} ms total · ${((2000 / burstMs) * 1000).toFixed(0)} msg/s`, "keeps up with 200/s");

// ── page / snapshot ──
const page: number[] = [];
for (let i = 0; i < 200; i += 1) {
  const s = performance.now();
  (await bus.listMessages(`r${i % ROOMS}`)).slice(-100);
  page.push(performance.now() - s);
}
row("latest 100 of a room", stats(page), "p95 < 100 ms");
t = performance.now();
const snapBytes = JSON.stringify(snapshotForUi(bus)).length;
row("UI snapshot", `${(snapBytes / 1024).toFixed(0)} KB JSON · ${(performance.now() - t).toFixed(0)} ms`, "bounded by window, not history");
store.close();

// ── restart ──
bus = undefined as unknown as MemoryBus;
global.gc?.();
t = performance.now();
store = new SqliteSnapshotStore(db);
bus = store.load(new MemoryBus());
row("restart load", `${(performance.now() - t).toFixed(0)} ms · ${bus.messages.length} messages`);
global.gc?.();
row("heap after load (gc)", mb(process.memoryUsage().heapUsed), "< 300 MB");
const sizeOf = (xs: unknown[]) => xs.reduce<number>((n, x) => n + JSON.stringify(x).length, 0);
row("  of which messages / deliveries", `${mb(sizeOf(bus.messages))} / ${mb(sizeOf(bus.deliveries))} (JSON)`);
row("  of which compiled contexts", `${mb(sizeOf([...bus.contextSnapshots.values()]))} (JSON)`);
store.close();

// ── over HTTP: accept latency and event → SSE latency on the loaded workspace ──
process.env.PORTAGE_HOME = home;
const port = 8796;
const { server } = await startServer(port);
const base = `http://127.0.0.1:${port}`;
const sentAt = new Map<string, number>();
const toUi: number[] = [];
const ctrl = new AbortController();
const stream = await fetch(`${base}/api/events/stream?since=${Number.MAX_SAFE_INTEGER}`, { signal: ctrl.signal });
const reader = stream.body!.getReader();
void (async () => {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) return;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      const at = event.eventType === "MessageAccepted" ? sentAt.get(event.entityId) : undefined;
      if (at) toUi.push(performance.now() - at);
    }
  }
})();
const http: number[] = [];
for (let i = 0; i < 300; i += 1) {
  const r = i % ROOMS;
  const s = performance.now();
  sentAt.set(`msg_http${i}`, s);
  await fetch(`${base}/api/conversations/r${r}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: BODY, mentionParticipantIds: mentions(r), idempotencyKey: `http${i}` }),
  }).then((res) => res.json());
  http.push(performance.now() - s);
}
await new Promise((r) => setTimeout(r, 300));
row("HTTP send (accept + persist)", stats(http), "p95 < 50 ms");
row("event → SSE client", toUi.length ? stats(toUi) : "no events", "p95 < 200 ms");
t = performance.now();
const snapRes = await fetch(`${base}/api/snapshot`).then((res) => res.text());
row("GET /api/snapshot", `${(snapRes.length / 1024).toFixed(0)} KB · ${(performance.now() - t).toFixed(0)} ms`);
ctrl.abort();
server.closeAllConnections();
server.close();
rmSync(home, { recursive: true, force: true });
