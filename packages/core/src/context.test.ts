import { describe, expect, it } from "vitest";
import { compileContext } from "./context.js";
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
      recipientLabel: "Lead · 统筹路由",
      maxContextBytes: 32768,
    });
    expect(snap.layers).toContain("房间 collaboration.md");
    expect(snap.layers).toContain("原始消息");
    expect(snap.query).toContain("不改写原生身份");
    expect(snap.query).toContain("请审查适配器");
    expect(snap.revisions.room).toBe(3);
    expect(snap.dropped).toEqual([]);
    expect(snap.overflow).toBe(false);
  });

  it("drops outer layers first to fit, and never cuts the message", () => {
    const global: PolicyDocument = { ...room, id: "PORTAGE", scope: "global", markdown: "全局 ".repeat(3000), publishedRevision: 1 };
    const snap = compileContext({
      global,
      room,
      message,
      recipientLabel: "Builder",
      maxContextBytes: 600,
    });
    expect(snap.dropped).toEqual(["全局 PORTAGE.md"]);
    expect(snap.layers).toContain("房间 collaboration.md");
    expect(snap.revisions.global).toBeUndefined();
    expect(snap.query).toContain("请审查适配器");
    expect(snap.overflow).toBe(false);
    expect(snap.byteSize).toBeLessThanOrEqual(600);
  });

  it("flags overflow when the message alone does not fit instead of cutting it", () => {
    const long = { ...message, parts: [{ kind: "text" as const, text: "长".repeat(400) }] };
    const snap = compileContext({ room, message: long, recipientLabel: "Builder", maxContextBytes: 300 });
    expect(snap.overflow).toBe(true);
    expect(snap.dropped).toEqual(["房间 collaboration.md"]);
    expect(snap.query).toContain("长".repeat(400));
  });

  it("tells room recipients how to answer through Portage, quoting the message id", () => {
    const snap = compileContext({ message, recipientLabel: "Builder", replyThroughPortage: true, maxContextBytes: 32768 });
    expect(snap.layers.at(-1)).toBe("回复方式");
    expect(snap.query).toContain("replyToMessageId=m1");
    const direct = compileContext({ message, recipientLabel: "Builder", maxContextBytes: 32768 });
    expect(direct.layers).not.toContain("回复方式");
  });
});
