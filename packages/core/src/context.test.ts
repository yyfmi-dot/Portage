import { describe, expect, it } from "vitest";
import { compileContext, markedMessageIds } from "./context.js";
import type { Message, PolicyDocument } from "./types.js";

const message: Message = {
  id: "m1",
  workspaceId: "ws",
  conversationId: "r1",
  seq: 1,
  senderId: "user",
  target: { kind: "room", id: "r1" },
  mentions: [],
  parts: [{ kind: "text", text: "请审查适配器" }],
  causalParentIds: [],
  traceId: "t1",
  source: "user",
  idempotencyKey: "k1",
  acceptedPolicyRevision: "1",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const room: PolicyDocument = {
  id: "pd_room",
  scope: "room",
  markdown: "需要他人时 @ 对方。完成后附产物版本。",
  publishedRevision: 3,
  hash: "x",
  updatedBy: "user",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

describe("compileContext", () => {
  it("labels layers as constraints and keeps original message", () => {
    const snap = compileContext({
      room,
      message,
      scope: "room",
      recipientLabel: "Lead · 统筹路由",
      maxContextBytes: 32768,
    });
    expect(snap.layers).toContain("Room collaboration.md");
    expect(snap.layers).toContain("Original message");
    expect(snap.query).toContain("[Room collaboration.md · v3]");
    expect(snap.query).toContain("请审查适配器");
    expect(snap.revisions.room).toBe(3);
    expect(snap.dropped).toEqual([]);
    expect(snap.overflow).toBe(false);
  });

  it("direct DMs are marker + body only (no global MD wall)", () => {
    const snap = compileContext({
      global: { ...room, id: "PORTAGE", scope: "global", markdown: "Do not rewrite identity.\n".repeat(20), publishedRevision: 1 },
      message,
      scope: "direct",
      sourceLabel: "user",
      recipientLabel: "Codex · vscode_cli",
      maxContextBytes: 32768,
    });
    expect(snap.layers).toEqual(["Original message"]);
    expect(snap.query).toBe(`[Original message · v1 · m1]\nFrom: user\n请审查适配器`);
    expect(snap.query).not.toContain("Do not rewrite");
    expect(snap.query).not.toContain("Recipient");
  });

  it("drops outer layers first to fit, and never cuts the message", () => {
    const global: PolicyDocument = { ...room, id: "PORTAGE", scope: "global", markdown: "全局 ".repeat(3000), publishedRevision: 1 };
    const snap = compileContext({
      global,
      room,
      message,
      scope: "room",
      recipientLabel: "Builder",
      maxContextBytes: 600,
    });
    expect(snap.dropped).toEqual(["Global PORTAGE.md"]);
    expect(snap.layers).toContain("Room collaboration.md");
    expect(snap.revisions.global).toBeUndefined();
    expect(snap.query).toContain("请审查适配器");
    expect(snap.overflow).toBe(false);
    expect(snap.byteSize).toBeLessThanOrEqual(600);
  });

  it("flags overflow when the message alone does not fit instead of cutting it", () => {
    const long = { ...message, parts: [{ kind: "text" as const, text: "长".repeat(400) }] };
    const snap = compileContext({ room, message: long, scope: "room", recipientLabel: "Builder", maxContextBytes: 300 });
    expect(snap.overflow).toBe(true);
    expect(snap.dropped).toEqual(["Room collaboration.md"]);
    expect(snap.query).toContain("长".repeat(400));
  });

  it("tells room recipients how to answer through Portage, quoting the message id", () => {
    const snap = compileContext({
      message,
      scope: "room",
      recipientLabel: "Builder",
      replyThroughPortage: true,
      maxContextBytes: 32768,
    });
    expect(snap.layers.at(-1)).toBe("How to reply");
    expect(snap.query).toContain("replyToMessageId=m1");
    const direct = compileContext({ message, scope: "direct", recipientLabel: "Builder", maxContextBytes: 32768 });
    expect(direct.layers).not.toContain("How to reply");
    expect(direct.layers).toEqual(["Original message"]);
  });
});

describe("markedMessageIds", () => {
  it("finds the marker compileContext writes, and the pre-1.0 Chinese marker still in older transcripts", () => {
    const snap = compileContext({ message, recipientLabel: "Builder", maxContextBytes: 32768 });
    expect(markedMessageIds(snap.query)).toEqual(["m1"]);
    expect(markedMessageIds("[原始消息 · v2 · msg_old]\nhello")).toEqual(["msg_old"]);
  });
});
