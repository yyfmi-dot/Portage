#!/usr/bin/env node
// A stand-in for `codex exec --json … resume <id> -` that writes a real-format rollout transcript.
// FAKE_CODEX_MODE: ok (default) | fail (turn.failed) | crash (exits before starting) | silent (never starts)
// FAKE_CODEX_ARGS_LOG: append argv as one JSON line per turn.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const id = argv[argv.indexOf("resume") + 1];
const root = join(process.env.CODEX_HOME, "sessions");
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const delay = Number(process.env.FAKE_CODEX_TURN_MS ?? 50);
if (process.env.FAKE_CODEX_ARGS_LOG) appendFileSync(process.env.FAKE_CODEX_ARGS_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);

const find = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      const hit = find(path);
      if (hit) return hit;
    } else if (name.name.endsWith(`-${id}.jsonl`)) return path;
  }
};
const rollout = find(root);
if (mode === "crash" || !rollout) {
  process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${id}\n`);
  process.exit(1);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  if (mode === "silent") return setTimeout(() => {}, 8_000);
  const now = () => new Date().toISOString();
  const write = (record) => appendFileSync(rollout, `${JSON.stringify({ timestamp: now(), ...record })}\n`);
  const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  emit({ type: "thread.started", thread_id: id });
  write({ type: "event_msg", payload: { type: "task_started" } });
  write({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: input }] } });
  emit({ type: "turn.started" });
  await new Promise((r) => setTimeout(r, delay));
  if (mode === "fail") {
    write({ type: "event_msg", payload: { type: "error", message: "model refused" } });
    emit({ type: "turn.failed", error: { message: "model refused" } });
    process.exit(1);
  }
  const ref = /· (msg_[\w-]+)\]/.exec(input)?.[1] ?? "none";
  const reply = await replyThroughPortage(ref);
  write({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply ?? `ACK ${ref}` }] } });
  write({ type: "event_msg", payload: { type: "task_complete" } });
  emit({ type: "turn.completed", usage: {} });
});

// FAKE_CODEX_REPLIES: {"<portage session id>": ["reply to turn 1", "reply to turn 2", …]} — answered the way
// the agent would through the mounted Portage MCP server (same daemon URL and session it was given).
async function replyThroughPortage(ref) {
  const script = JSON.parse(process.env.FAKE_CODEX_REPLIES ?? "{}");
  const mcpArgs = argv.find((a) => a.startsWith("mcp_servers.portage.args="));
  if (!mcpArgs) return undefined;
  const args = JSON.parse(mcpArgs.slice("mcp_servers.portage.args=".length));
  const daemon = args[args.indexOf("--daemon") + 1];
  const session = args[args.indexOf("--session") + 1];
  const replies = script[session];
  if (!replies) return undefined;
  const counter = join(process.env.CODEX_HOME, `turns-${session}`);
  let turn = 0;
  try {
    turn = Number(readFileSync(counter, "utf8"));
  } catch {}
  writeFileSync(counter, String(turn + 1));
  const text = replies[turn];
  if (!text) return undefined;
  const res = await fetch(`${daemon}/api/agent/${session}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, replyToMessageId: ref }),
  });
  if (!res.ok) process.stderr.write(`portage_send failed: ${await res.text()}\n`);
  return text;
}
