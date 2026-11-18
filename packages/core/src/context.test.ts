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
    expect(snap.truncated).toBe(false);
  });

  it("truncates when over maxContextBytes", () => {
    const huge: PolicyDocument = {
      ...room,
      markdown: "约定 ".repeat(5000),
    };
    const snap = compileContext({
      room: huge,
      message,
      recipientLabel: "Builder",
      maxContextBytes: 200,
    });
    expect(snap.truncated).toBe(true);
    expect(snap.byteSize).toBeLessThanOrEqual(200);
  });
});
