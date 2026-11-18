import { policyDocumentBody } from "./policy-frontmatter.js";
import type { Artifact, Message, PolicyDocument, RoomPolicy } from "./types.js";

export type ContextCompileInput = {
  global?: PolicyDocument | null;
  workspace?: PolicyDocument | null;
  room?: PolicyDocument | null;
  /** Execution policy summary for rooms (wake + budget), never a persona. */
  policy?: Pick<RoomPolicy, "wakeMode" | "maxAutoRounds" | "agentMessagesPerMinute"> &
    Partial<Pick<RoomPolicy, "maxWakeupsPerTrace">> | null;
  message: Message;
  artifacts?: Artifact[];
  recipientLabel: string;
  sourceLabel?: string;
  /** Room messages are answered through Portage; a direct chat is answered natively. */
  replyThroughPortage?: boolean;
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
  /** Layers left out to fit `maxContextBytes`, outermost first. */
  dropped: string[];
  /** Even the message alone exceeds `maxContextBytes`: it is not delivered rather than cut. */
  overflow: boolean;
  layers: string[];
};

type Layer = { label: string; text: string; droppable: boolean };

/** Outer layers are dropped first when the query does not fit; the message itself never is. */
const DROP_ORDER = ["全局 PORTAGE.md", "工作区", "执行策略", "房间 collaboration.md"];

/**
 * Compile short collaboration constraints + original message.
 * Does not invent a new persona — layers are labeled as room conventions.
 */
export function compileContext(input: ContextCompileInput): ContextSnapshot {
  const layers: Layer[] = [];
  const pushDoc = (label: string, doc?: PolicyDocument | null) => {
    const text = doc ? policyDocumentBody(doc.markdown) : "";
    if (doc && text) layers.push({ label, droppable: true, text: `[${label} · v${doc.publishedRevision} · 约束与指导，不改写原生身份]\n${text}` });
  };

  pushDoc("全局 PORTAGE.md", input.global);
  pushDoc("工作区", input.workspace);
  pushDoc("房间 collaboration.md", input.room);

  if (input.policy) {
    layers.push({
      label: "执行策略",
      droppable: true,
      text: [
        "[执行策略]",
        `wake.mode: ${input.policy.wakeMode}`,
        `budget.max_auto_rounds: ${input.policy.maxAutoRounds}`,
        `budget.agent_messages_per_minute: ${input.policy.agentMessagesPerMinute}`,
        input.policy.maxWakeupsPerTrace ? `budget.max_wakeups_per_trace: ${input.policy.maxWakeupsPerTrace}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const textPart = input.message.parts.find((p) => p.kind === "text" || p.kind === "markdown");
  const body = textPart && "text" in textPart ? textPart.text : "";
  const header = [
    `[接收方]\n${input.recipientLabel}\n（不注入工种角色；保留原生 session 身份）`,
    input.sourceLabel ? `[来源]\n${input.sourceLabel}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  layers.push({
    label: "原始消息",
    droppable: false,
    text: `${header}\n\n${messageMarker(input.message)}\n${body}`,
  });

  if (input.artifacts?.length) {
    layers.push({
      label: "产物引用",
      droppable: false,
      text: `[产物引用]\n${input.artifacts
        .map((a) => `${a.originalName} · v${a.version} · ${a.byteSize} bytes · ${a.storageKey}`)
        .join("\n")}`,
    });
  }

  if (input.replyThroughPortage) {
    layers.push({
      label: "回复方式",
      droppable: false,
      text: `[回复方式]\n用 portage_send 回复（replyToMessageId=${input.message.id}），需要别人处理时在正文 @别名；不需要回复时可以不发。\n发出后即可结束本回合：别人的回复会由 Portage 作为新消息送达你，不必在回合内等待或轮询收件箱。`,
    });
  }

  const encoder = new TextEncoder();
  const size = (kept: Layer[]) => encoder.encode(kept.map((l) => l.text).join("\n\n")).length;
  let kept = layers;
  const dropped: string[] = [];
  for (const label of DROP_ORDER) {
    if (size(kept) <= input.maxContextBytes) break;
    if (!kept.some((l) => l.label === label && l.droppable)) continue;
    kept = kept.filter((l) => l.label !== label);
    dropped.push(label);
  }
  const query = kept.map((l) => l.text).join("\n\n");
  const byteSize = encoder.encode(query).length;

  return {
    query,
    revisions: {
      global: kept.some((l) => l.label === "全局 PORTAGE.md") ? input.global?.publishedRevision : undefined,
      workspace: kept.some((l) => l.label === "工作区") ? input.workspace?.publishedRevision : undefined,
      room: kept.some((l) => l.label === "房间 collaboration.md") ? input.room?.publishedRevision : undefined,
      message: input.message.revision,
    },
    hash: fnv1a(query),
    byteSize,
    dropped,
    overflow: byteSize > input.maxContextBytes,
    layers: kept.map((l) => l.label),
  };
}

/** The line that names the Portage message inside compiled input; native transcripts carry it verbatim. */
function messageMarker(message: Pick<Message, "id" | "revision">) {
  return `[原始消息 · v${message.revision} · ${message.id}]`;
}

/** Portage message ids named by markers in text read back from a native transcript. */
export function markedMessageIds(text: string): string[] {
  return [...text.matchAll(/\[原始消息 · v\d+ · ([^\]\s]+)\]/g)].map((m) => m[1]!);
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
