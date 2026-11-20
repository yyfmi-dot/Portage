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
  /**
   * `direct`: lean envelope (marker + body [+ artifacts]) — the agent answers in its native session.
   * `room`: layered collaboration constraints + how to reply through Portage.
   */
  scope?: "direct" | "room";
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
 * Direct DMs stay lean (marker + body); rooms keep layered guidance without persona rewrite.
 */
export function compileContext(input: ContextCompileInput): ContextSnapshot {
  const scope = input.scope ?? (input.replyThroughPortage || input.room || input.policy ? "room" : "direct");
  const layers: Layer[] = [];

  if (scope === "room") {
    const pushDoc = (label: string, doc?: PolicyDocument | null) => {
      const text = doc ? policyDocumentBody(doc.markdown) : "";
      if (doc && text) layers.push({ label, droppable: true, text: `[${label} · v${doc.publishedRevision}]\n${text}` });
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
          `wake=${input.policy.wakeMode}`,
          `max_auto_rounds=${input.policy.maxAutoRounds}`,
          `msgs_per_min=${input.policy.agentMessagesPerMinute}`,
          input.policy.maxWakeupsPerTrace ? `max_wakeups_per_trace=${input.policy.maxWakeupsPerTrace}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  const textPart = input.message.parts.find((p) => p.kind === "text" || p.kind === "markdown");
  const body = textPart && "text" in textPart ? textPart.text : "";
  const marker = messageMarker(input.message);

  if (scope === "direct") {
    // Proof marker must stay verbatim for native_confirmed; everything else is noise in a DM.
    layers.push({
      label: L.message,
      droppable: false,
      text: input.sourceLabel ? `${marker}\nFrom: ${input.sourceLabel}\n${body}` : `${marker}\n${body}`,
    });
  } else {
    const header = [
      input.recipientLabel ? `To: ${input.recipientLabel}` : "",
      input.sourceLabel ? `From: ${input.sourceLabel}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    layers.push({
      label: L.message,
      droppable: false,
      text: header ? `${header}\n\n${marker}\n${body}` : `${marker}\n${body}`,
    });
  }

  if (input.artifacts?.length) {
    layers.push({
      label: L.artifacts,
      droppable: false,
      text: [
        `[${L.artifacts}]`,
        "Receipts only — call portage_artifact_get(artifactId) for bytes.",
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
      text: `[${L.reply}]\nportage_send(replyToMessageId=${input.message.id}). Attach work: portage_artifact_put → artifactIds. @alias to hand off. Skip if no reply needed; do not poll inbox.`,
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
