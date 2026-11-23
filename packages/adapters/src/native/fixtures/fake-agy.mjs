#!/usr/bin/env node
// Stand-in for `agy -p= --conversation <id> --input-format stream-json --output-format stream-json`.
// Writes Antigravity-shaped transcript lines under FAKE_AGY_HOME/brain/<id>/…/transcript_full.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE ?? "ok";
const home = process.env.FAKE_AGY_HOME;
const idIndex = argv.indexOf("--conversation");
const id = idIndex >= 0 ? argv[idIndex + 1] : "missing";
const delay = Number(process.env.FAKE_AGY_TURN_MS ?? 40);

if (!home || !id) {
  process.stderr.write("fake-agy: FAKE_AGY_HOME and --conversation required\n");
  process.exit(1);
}

const transcript = join(home, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
mkdirSync(dirname(transcript), { recursive: true });

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  if (mode === "silent") return setTimeout(() => {}, 8_000);
  if (mode === "crash") {
    process.stderr.write("fake-agy crashed before start\n");
    process.exit(1);
  }
  let prompt = input.trim();
  try {
    const framed = JSON.parse(prompt);
    prompt = framed?.message?.content ?? prompt;
  } catch {
    // raw text
  }
  const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const write = (record) => appendFileSync(transcript, `${JSON.stringify(record)}\n`);
  const now = new Date().toISOString();
  emit({ event: "init", conversation_id: id, init: { cwd: process.cwd(), tools: ["call_mcp_tool"] } });
  write({
    step_index: Date.now(),
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: now,
    content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`,
  });
  await new Promise((r) => setTimeout(r, delay));
  if (mode === "fail") {
    emit({ event: "result", result: { conversation_id: id, status: "ERROR", error: "model refused", response: "" } });
    process.exit(1);
  }
  const reply = `ACK ${String(prompt).slice(0, 80)}`;
  write({
    step_index: Date.now() + 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: new Date().toISOString(),
    content: reply,
  });
  emit({
    event: "result",
    result: { conversation_id: id, status: "SUCCESS", response: reply, error: "" },
  });
  // Keep a tiny summaries row so dialect.describe can find a title in tests that open the DB.
  writeFileSync(
    join(home, "conversation_summaries.db.marker"),
    JSON.stringify({ id, prompt: String(prompt).slice(0, 60) }),
  );
});
