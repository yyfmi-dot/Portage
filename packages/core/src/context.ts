import type { Artifact, Message, PolicyDocument, RoomPolicy } from "./types.js";

export type ContextCompileInput = {
  global?: PolicyDocument | null;
  workspace?: PolicyDocument | null;
  room?: PolicyDocument | null;
  /** Execution policy summary for rooms (wake + budget), never a persona. */
  policy?: Pick<RoomPolicy, "wakeMode" | "maxAutoRounds" | "agentMessagesPerMinute"> | null;
  message: Message;
  artifacts?: Artifact[];
  recipientLabel: string;
  sourceLabel?: string;
  maxContextBytes: number;
};

export type ContextSnapshot = {
  query: string;
  revisions: {
    global?: number;
    workspace?: number;
    room?: number;
    message: number;
  };
  hash: string;
  byteSize: number;
  truncated: boolean;
  layers: string[];
};

/**
 * Compile short collaboration constraints + original message.
 * Does not invent a new persona — layers are labeled as room conventions.
 */
export function compileContext(input: ContextCompileInput): ContextSnapshot {
  const layers: string[] = [];
  const parts: string[] = [];

  const pushDoc = (label: string, doc?: PolicyDocument | null) => {
    if (!doc?.markdown?.trim()) return;
    layers.push(label);
    parts.push(`[${label} · v${doc.publishedRevision} · 约束与指导，不改写原生身份]\n${doc.markdown.trim()}`);
  };

  pushDoc("全局 PORTAGE.md", input.global);
  pushDoc("工作区", input.workspace);
  pushDoc("房间 collaboration.md", input.room);

  if (input.policy) {
    layers.push("执行策略");
    parts.push(
      `[执行策略]\nwake.mode: ${input.policy.wakeMode}\nbudget.max_auto_rounds: ${input.policy.maxAutoRounds}\nbudget.agent_messages_per_minute: ${input.policy.agentMessagesPerMinute}`,
    );
  }

  const textPart = input.message.parts.find((p) => p.kind === "text" || p.kind === "markdown");
  const body = textPart && "text" in textPart ? textPart.text : "";
  const header = [
    `[接收方]\n${input.recipientLabel}\n（不注入工种角色；保留原生 session 身份）`,
    input.sourceLabel ? `[来源]\n${input.sourceLabel}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  layers.push("原始消息");
  parts.push(
    `${header}\n\n[原始消息 · v${input.message.revision} · ${input.message.id}]\n${body}`,
  );

  if (input.artifacts?.length) {
    layers.push("产物引用");
    parts.push(
      `[产物引用]\n${input.artifacts
        .map((a) => `${a.originalName} · v${a.version} · ${a.byteSize} bytes · ${a.storageKey}`)
        .join("\n")}`,
    );
  }

  let query = parts.join("\n\n");
  let truncated = false;
  const encoder = new TextEncoder();
  if (encoder.encode(query).length > input.maxContextBytes) {
    truncated = true;
    // Keep room constraints + message; drop global/workspace first
    const lean: string[] = [];
    if (input.room?.markdown?.trim()) {
      lean.push(
        `[房间 collaboration.md · v${input.room.publishedRevision} · 约束与指导]\n${input.room.markdown.trim()}`,
      );
    }
    lean.push(`[接收方]\n${input.recipientLabel}\n\n[原始消息 · v${input.message.revision}]\n${body}`);
    query = lean.join("\n\n");
    while (encoder.encode(query).length > input.maxContextBytes && query.length > 64) {
      query = query.slice(0, Math.floor(query.length * 0.85));
      truncated = true;
    }
  }

  return {
    query,
    revisions: {
      global: input.global?.publishedRevision,
      workspace: input.workspace?.publishedRevision,
      room: input.room?.publishedRevision,
      message: input.message.revision,
    },
    hash: fnv1a(query),
    byteSize: encoder.encode(query).length,
    truncated,
    layers,
  };
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
