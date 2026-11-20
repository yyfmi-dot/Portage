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

const L = {
  global: "Global PORTAGE.md",
  workspace: "Workspace",
  policy: "Execution policy",
  room: "Room collaboration.md",
  message: "Original message",
  artifacts: "Artifacts",
  reply: "How to reply",
} as const;

/** Outer layers are dropped first when the query does not fit; the message itself never is. */
const DROP_ORDER = [L.global, L.workspace, L.policy, L.room];

/**
 * Compile short collaboration constraints + original message.
 * Does not invent a new persona — layers are labeled as room conventions.
 */
export function compileContext(input: ContextCompileInput): ContextSnapshot {
  const layers: Layer[] = [];
  const pushDoc = (label: string, doc?: PolicyDocument | null) => {
    const text = doc ? policyDocumentBody(doc.markdown) : "";
    if (doc && text) layers.push({ label, droppable: true, text: `[${label} · v${doc.publishedRevision} · guidance only; it never rewrites your native identity]\n${text}` });
  };

  pushDoc(L.global, input.global);
  pushDoc(L.workspace, input.workspace);
  pushDoc(L.room, input.room);

  if (input.policy) {
    layers.push({
      label: L.policy,
      droppable: true,
      text: [
        `[${L.policy}]`,
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
    `[Recipient]\n${input.recipientLabel}\n(No role is injected; you keep your native session identity.)`,
    input.sourceLabel ? `[From]\n${input.sourceLabel}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  layers.push({
    label: L.message,
    droppable: false,
    text: `${header}\n\n${messageMarker(input.message)}\n${body}`,
  });

  if (input.artifacts?.length) {
    layers.push({
      label: L.artifacts,
      droppable: false,
      text: [
        `[${L.artifacts}]`,
        "These are Portage artifact receipts. Call portage_artifact_get with artifactId when you need the bytes.",
        ...input.artifacts.map(
          (a) =>
            `- artifactId=${a.id} · ${a.originalName} · v${a.version} · ${a.byteSize} bytes · ${a.mime} · hash=${a.hash}`,
        ),
      ].join("\n"),
    });
  }

  if (input.replyThroughPortage) {
    layers.push({
      label: L.reply,
      droppable: false,
      text: `[${L.reply}]\nReply with portage_send (replyToMessageId=${input.message.id}). To attach work products, call portage_artifact_put then pass the returned artifactIds to portage_send. To hand work to someone, @alias them in the text. If no reply is needed, you can skip it.\nYou can end your turn once it is sent: replies reach you from Portage as new messages, so there is no need to wait or poll your inbox.`,
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
      global: kept.some((l) => l.label === L.global) ? input.global?.publishedRevision : undefined,
      workspace: kept.some((l) => l.label === L.workspace) ? input.workspace?.publishedRevision : undefined,
      room: kept.some((l) => l.label === L.room) ? input.room?.publishedRevision : undefined,
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
  return `[${L.message} · v${message.revision} · ${message.id}]`;
}

/** Portage message ids named by markers in text read back from a native transcript (including the pre-1.0 Chinese marker). */
export function markedMessageIds(text: string): string[] {
  return [...text.matchAll(/\[(?:Original message|原始消息) · v\d+ · ([^\]\s]+)\]/g)].map((m) => m[1]!);
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
