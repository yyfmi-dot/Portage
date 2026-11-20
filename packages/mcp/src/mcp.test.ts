import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The daemon is a sibling workspace package; the test drives it over real HTTP.
import { startServer } from "../../daemon/src/server.js";

type Started = Awaited<ReturnType<typeof startServer>>;
// Response bodies are asserted field by field; a loose type keeps the assertions readable.
type Json = any;
// The same entry a CLI would configure. cwd is deliberately unrelated to the repo (see connect()).
const launcherPath = fileURLToPath(new URL("../bin/portage-mcp.mjs", import.meta.url));
const PORT = 8793;
const base = `http://127.0.0.1:${PORT}`;

describe("MCP bridge over stdio (real MCP client → real portage-mcp process → real daemon)", () => {
  let home = "";
  let started: Started;
  const clients: Client[] = [];

  const post = async (path: string, body: unknown = {}) =>
    (await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json())) as Json;
  const snapshot = async () => (await fetch(`${base}/api/snapshot`).then((r) => r.json())) as Json;

  async function connect(args: string[] = [], daemon = base) {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [launcherPath, "--daemon", daemon, ...args],
        cwd: tmpdir(), // a real CLI spawns MCP servers from wherever it is running
        env: process.env as Record<string, string>,
        stderr: "ignore",
      }),
    );
    clients.push(client);
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: Boolean(result.isError), text: result.content.map((c) => c.text).join("\n") };
    } catch (error) {
      // Schema violations are rejected by the protocol layer itself.
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "portage-mcp-"));
    process.env.PORTAGE_HOME = home;
    started = await startServer(PORT);
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  it("advertises the four tools with usable descriptions and server instructions", async () => {
    const client = await connect(["--session", "s_lead"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "portage_artifact_get",
      "portage_artifact_put",
      "portage_inbox",
      "portage_room",
      "portage_send",
      "portage_status",
    ]);
    for (const tool of tools) expect((tool.description ?? "").length).toBeGreaterThan(80);
    // Headless turns run with approval "never": a tool not declared read-only or non-destructive is refused.
    for (const tool of tools) {
      const a = tool.annotations ?? {};
      expect(a.readOnlyHint === true || a.destructiveHint === false, tool.name).toBe(true);
    }
    expect(client.getInstructions()).toContain("portage_inbox");
    expect(tools.find((t) => t.name === "portage_send")!.inputSchema.required).toEqual(["text"]);
  });

  it("portage_room tells the agent who it is, who it can @, and how waking works", async () => {
    const lead = await connect(["--session", "s_lead"]);
    const room = await call(lead, "portage_room");
    expect(room.isError).toBe(false);
    expect(room.text).toContain("you are @lead");
    expect(room.text).toContain("that is you: route to members with @alias");
    expect(room.text).toContain("@builder");
    expect(room.text).toContain("@reviewer");
    expect(room.text).toContain("collaboration.md");

    const builder = await connect(["--session", "s_builder"]);
    expect((await call(builder, "portage_room")).text).toContain("messages from the user reach lead first");
  });

  it("full loop: user → lead reads (ack) → lead @builder (queued, busy) → builder idle → reads → replies on one trace", async () => {
    const lead = await connect(["--session", "s_lead"]);
    const builder = await connect(["--session", "s_builder"]);
    expect((await call(lead, "portage_inbox")).text).toContain("Inbox is empty");

    const user = await post("/api/conversations/room_dev/send", {
      text: "请统筹：核对适配器契约",
      idempotencyKey: "mcp_user_1",
    });
    expect(user.deliveries[0].state).toBe("submitted");

    // submitted ≠ read: the native inbox has it, but no agent_ack yet
    let snap = await snapshot();
    const proofs = (deliveryId: string) =>
      snap.receipts.filter((r: Json) => r.deliveryId === deliveryId).map((r: Json) => r.proofLevel);
    expect(proofs(user.deliveries[0].id)).toEqual(["submitted"]);

    const read = await call(lead, "portage_inbox");
    expect(read.isError).toBe(false);
    expect(read.text).toContain("from you (the user)");
    expect(read.text).toContain("请统筹：核对适配器契约");
    expect(read.text).toContain("[Room collaboration.md");
    expect(read.text).toContain(`messageId: ${user.message.id}`);

    snap = await snapshot();
    expect(proofs(user.deliveries[0].id)).toEqual(["submitted", "agent_ack"]);
    expect(
      snap.events.some((e: Json) => e.eventType === "DeliveryAcknowledged" && e.entityId === user.deliveries[0].id),
    ).toBe(true);
    expect((await call(lead, "portage_inbox")).text).toContain("Inbox is empty");
    // reading must not change busy/idle — that is the host's signal
    expect(snap.runtimes.s_lead.execution).toBe("idle");

    // Lead routes to builder while builder is mid-turn → queued as busy
    expect((await call(builder, "portage_status", { state: "running" })).isError).toBe(false);
    const routed = await call(lead, "portage_send", {
      text: "@builder 请核对 native session 绑定",
      replyToMessageId: user.message.id,
    });
    expect(routed.isError).toBe(false);
    expect(routed.text).toContain(`on ${user.message.traceId}`);
    expect(routed.text).toContain("s_builder: queued (busy)");
    expect((await call(builder, "portage_inbox")).text).toContain("Inbox is empty");

    // Builder reports idle → the queued message is flushed in
    const idle = await call(builder, "portage_status", { state: "idle" });
    expect(idle.text).toContain("1 queued message(s) were just delivered");
    const builderRead = await call(builder, "portage_inbox");
    expect(builderRead.text).toContain("from lead");
    expect(builderRead.text).toContain("请核对 native session 绑定");
    expect(builderRead.text).toContain("[Execution policy]");

    const toolMessageId = /messageId: (\S+)/.exec(builderRead.text)![1]!;
    const reply = await call(builder, "portage_send", {
      text: "@lead 契约已核对，见产物",
      replyToMessageId: toolMessageId,
    });
    expect(reply.text).toContain(`on ${user.message.traceId}`);
    expect(reply.text).toContain("s_lead: submitted");

    // The whole causal chain is on one trace, each message pointing at its parent.
    snap = await snapshot();
    const chain = snap.messages.filter((m: Json) => m.traceId === user.message.traceId);
    expect(chain).toHaveLength(3);
    expect(chain.map((m: Json) => m.causalParentIds[0] ?? null)).toEqual([null, user.message.id, toolMessageId]);
    expect(snap.conversations.find((c: Json) => c.id === "room_dev").state.rounds).toBe(2);
    expect((await call(lead, "portage_inbox")).text).toContain("契约已核对");
  });

  it("rejects bad aliases, unknown replies and oversized input with actionable messages", async () => {
    const lead = await connect(["--session", "s_lead"]);
    const badAlias = await call(lead, "portage_send", { text: "hi", to: ["ghost"] });
    expect(badAlias.isError).toBe(true);
    expect(badAlias.text).toContain("unknown or non-member alias: ghost");
    expect(badAlias.text).toContain("builder");
    const badReply = await call(lead, "portage_send", { text: "hi", replyToMessageId: "msg_nope" });
    expect(badReply.isError).toBe(true);
    expect(badReply.text).toContain("message not found");
    expect((await call(lead, "portage_send", { text: "x".repeat(20001) })).isError).toBe(true);
    expect((await call(lead, "portage_send", { text: "" })).isError).toBe(true);
  });

  it("a session that left the room can no longer send, and sees it is in no room", async () => {
    const reviewer = await connect(["--session", "s_reviewer"]);
    await post("/api/rooms/room_dev/members/p_reviewer/leave");
    const sent = await call(reviewer, "portage_send", { text: "still here?" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain("not in any room");
    expect((await call(reviewer, "portage_room")).text).toContain("not in any room");
    await post("/api/rooms/room_dev/members", { participantId: "p_reviewer" });
  });

  it("an agent that never reads cannot be mistaken for one that did (submitted stays unread)", async () => {
    const before = (await snapshot()).receipts.filter((r: Json) => r.proofLevel === "agent_ack").length;
    await post("/api/conversations/room_dev/send", { text: "没人读的消息", idempotencyKey: "mcp_unread" });
    const after = await snapshot();
    expect(after.receipts.filter((r: Json) => r.proofLevel === "agent_ack").length).toBe(before);
  });

  it("resolves the session from the ancestor pid when no id is configured", async () => {
    const registered = await post("/api/sessions", {
      provider: "codex",
      host: "terminal",
      nativeIdentity: `pid-${process.pid}`,
      displayName: "进程绑定会话",
      alias: "pidbound",
    });
    await post("/api/rooms/room_dev/members", { participantId: `p_${registered.id.slice(2)}` });
    const agent = await connect(); // no --session: the MCP process's parent is this test process
    const room = await call(agent, "portage_room");
    expect(room.isError).toBe(false);
    expect(room.text).toContain("you are @pidbound");

    // Archiving the registration makes the same CLI unknown again, with a way forward.
    const archived = await post(`/api/sessions/${registered.id}`, { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    const fresh = await connect();
    const result = await call(fresh, "portage_inbox");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not registered in Portage");
    expect(result.text).toContain("Find local sessions");
  });

  it("--print-config emits absolute, copy-pasteable connection snippets without side effects", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [launcherPath, "--print-config"], { cwd: tmpdir(), encoding: "utf8" });
    expect(out).toContain("[mcp_servers.portage]");
    expect(out).toContain("claude mcp add portage --");
    expect(out.replace(/\\/g, "/")).toContain(launcherPath.replace(/\\/g, "/"));
    expect(out).toContain(process.execPath.replace(/\\/g, "/"));
    expect(out).not.toContain("8787\"]"); // default daemon needs no env override
  });

  it("explains how to start the daemon when it is unreachable", async () => {
    const client = await connect(["--session", "s_lead"], "http://127.0.0.1:1");
    const result = await call(client, "portage_inbox");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("npm run daemon:serve");
  });
});
