import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NativeTurnAdapter } from "./native-turn-adapter.js";
import { antigravityCli } from "./clis.js";
import { antigravityDialect, unwrapAntigravityUserText } from "./transcripts.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));

function seedHome(home: string, id: string, opts?: { title?: string; workdir?: string; nesting?: number }) {
  const logs = join(home, "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, "transcript_full.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-23T01:00:00Z",
      content: "<USER_REQUEST>\nHello from fixture\n</USER_REQUEST>",
    })}\n${JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-23T01:00:01Z",
      content: "Hi there",
    })}\n`,
  );
  const db = new DatabaseSync(join(home, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    step_count INTEGER NOT NULL DEFAULT 0,
    last_modified_time TEXT NOT NULL,
    workspace_uris TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    nesting_depth INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare(
    `INSERT OR REPLACE INTO conversation_summaries
     (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, nesting_depth)
     VALUES (?, ?, ?, 2, ?, ?, 'CASCADE_RUN_STATUS_IDLE', ?)`,
  ).run(
    id,
    opts?.title ?? "Fixture session",
    "Hello from fixture",
    "2026-11-23 01:00:01.000000+00:00",
    JSON.stringify([`file://${opts?.workdir ?? "/tmp/agy-work"}`]),
    opts?.nesting ?? 0,
  );
  db.close();
  return transcript;
}

describe("antigravity dialect", () => {
  it("unwraps USER_REQUEST envelopes", () => {
    expect(unwrapAntigravityUserText("<USER_REQUEST>\nPing\n</USER_REQUEST>\n<meta>")).toBe("Ping");
  });

  it("discovers top-level conversations and skips nested agents", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-dialect-"));
    seedHome(home, "top-level", { title: "Top" });
    seedHome(home, "nested-child", { title: "Nested", nesting: 1 });
    const dialect = antigravityDialect(home);
    const recent = await dialect.recent(10);
    expect(recent.some((p) => p.includes("top-level"))).toBe(true);
    expect(recent.some((p) => p.includes("nested-child"))).toBe(false);
    const info = await dialect.describe(recent.find((p) => p.includes("top-level"))!);
    expect(info).toMatchObject({
      nativeSessionId: "top-level",
      title: "Top",
      workdir: "/tmp/agy-work",
      host: "app",
    });
    const observations = dialect.parse(
      {
        step_index: 7,
        type: "USER_INPUT",
        created_at: "2026-11-23T02:00:00Z",
        content: "<USER_REQUEST>\nDelivered?\n</USER_REQUEST>",
      },
      0,
    );
    expect(observations).toEqual([
      { nativeEventId: "7", nativeTime: "2026-11-23T02:00:00Z", kind: "input", text: "Delivered?" },
    ]);
  });
});

describe("antigravity native turn", () => {
  const homes: string[] = [];
  afterEach(() => {
    process.env.PORTAGE_AGY_BIN = undefined;
    process.env.FAKE_AGY_HOME = undefined;
    process.env.FAKE_AGY_MODE = undefined;
  });

  it("injects a headless turn and appends native transcript proof", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-turn-"));
    homes.push(home);
    const workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    seedHome(home, "conv-1", { workdir });
    process.env.PORTAGE_AGY_BIN = FAKE;
    process.env.FAKE_AGY_HOME = home;
    const ends: Array<{ sessionId: string; ok: boolean }> = [];
    const adapter = new NativeTurnAdapter({
      id: "antigravity-native",
      dialect: antigravityDialect(home),
      cli: {
        ...antigravityCli,
        binary: async () => FAKE,
      },
      mcp: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      onTurnEnd: (end) => ends.push(end),
      startTimeoutMs: 5_000,
    });
    const session = {
      id: "s_agy",
      provider: "antigravity",
      harness: "cli" as const,
      host: "terminal" as const,
      nativeIdentity: "conv-1",
      displayName: "Antigravity fixture",
      alias: "agy",
      communicationEnabled: true,
      workdir,
      adapterId: "antigravity-native",
    };
    const result = await adapter.inject(session as any, { id: "m1" } as any, "Portage wake ping");
    if (!result.ok) expect.fail(`inject failed: ${result.error}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proof).toBe("submitted");
    for (let i = 0; i < 50 && ends.length === 0; i += 1) await new Promise((r) => setTimeout(r, 40));
    expect(ends[0]).toMatchObject({ sessionId: "s_agy", ok: true });
    const read = await adapter.readNative(session as any, 0);
    const texts = read.observations.map((e) => e.text).join("\n");
    expect(texts).toContain("Portage wake ping");
    expect(texts).toMatch(/ACK/);
  });
});
