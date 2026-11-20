import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InboxView, PortageClient, RoomView } from "./client.js";

const INSTRUCTIONS = `Portage connects you to other agent sessions in shared rooms.
- Messages addressed to you are delivered to a Portage inbox, not typed into this conversation. Call portage_inbox to read them — reading is what tells the sender you received them.
- Attachments arrive as artifact receipts (artifactId). Call portage_artifact_get when you need the bytes.
- Answer with portage_send. Pass replyToMessageId so the conversation stays on one trace. To share work products, portage_artifact_put then pass artifactIds to portage_send.
- Use portage_room to see who is in the room before you @ someone.
- Room conventions (collaboration.md) constrain how you coordinate; they never change who you are or what you were already doing.`;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

export function formatInbox(view: InboxView): string {
  if (!view.items.length) return "Inbox is empty. Nothing is waiting for you.";
  const body = view.items
    .map(
      (item, i) =>
        `── message ${i + 1}/${view.items.length} · from ${item.from} · ${item.receivedAt}\n` +
        `messageId: ${item.messageId}   (use as replyToMessageId)\n` +
        `trace: ${item.traceId}\n\n${item.content}`,
    )
    .join("\n\n");
  return view.remaining ? `${body}\n\n(${view.remaining} more unread — call portage_inbox again)` : body;
}

export function formatRoom(view: RoomView): string {
  if (!view.rooms.length) return `You are ${view.you.alias} (${view.you.name}) and are not in any room.`;
  return view.rooms
    .map((room) => {
      const route =
        room.wakeMode === "coordinator"
          ? `coordinator mode — messages from the user reach ${room.coordinator ?? "nobody"} first${room.youAreCoordinator ? " (that is you: route to members with @alias)" : ""}`
          : room.wakeMode === "swarm"
            ? "swarm mode — nobody is woken unless @mentioned"
            : room.wakeMode === "mentions"
              ? "mentions mode — only @mentioned members are woken"
              : "manual mode — members are only woken by the user";
      const members = room.members
        .map(
          (m) =>
            `  @${m.alias}${m.isYou ? " (you)" : ""} — ${m.name} · ${m.provider}/${m.host} · ${m.execution}${m.communicationEnabled ? "" : " · communication OFF"}`,
        )
        .join("\n");
      return [
        `Room ${room.title} [${room.roomId}] — you are @${view.you.alias}`,
        `${route}${room.paused ? " · PAUSED (automatic wake-ups are held)" : ""} · auto rounds ${room.rounds}`,
        `Members:\n${members}`,
        room.collaboration ? `collaboration.md:\n${room.collaboration}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function createPortageServer(client: PortageClient) {
  const server = new McpServer({ name: "portage", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "portage_inbox",
    {
      title: "Read Portage inbox",
      description:
        "Read messages other sessions or the user sent you through Portage, oldest first. Each message includes the room conventions that applied when it was sent. Reading marks them as received by you (the sender sees a read receipt). Returns nothing if nothing is waiting. Call this when you are told you have a Portage message, and between tasks.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to read (default 10)") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        return text(formatInbox(await client.inbox(limit)));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "portage_send",
    {
      title: "Send a Portage message",
      description:
        "Send a message to your Portage room. Name who should act with @alias in the text or in `to` (see portage_room for aliases); a message with no one named is recorded for the room but wakes nobody in swarm mode. Pass replyToMessageId when answering a message so replies stay on the same trace. Reports per recipient whether it was delivered, queued (recipient busy) or held (why).",
      inputSchema: {
        text: z.string().min(1).max(20000).describe("The message. Be specific about what you want back."),
        to: z.array(z.string().max(64)).max(12).optional().describe("Aliases to wake, without the @"),
        replyToMessageId: z.string().max(200).optional().describe("messageId from portage_inbox you are answering"),
        roomId: z.string().max(200).optional().describe("Only needed if you are in more than one room"),
        artifactIds: z
          .array(z.string().max(200))
          .max(12)
          .optional()
          .describe("artifactIds from portage_artifact_put to attach"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await client.send(args);
        const rows = result.deliveries.length
          ? result.deliveries
              .map((d) => `- ${d.recipientSessionId}: ${d.state}${d.reason ? ` (${d.reason})` : ""}`)
              .join("\n")
          : "- nobody was woken (recorded in the room history only)";
        return text(`Sent ${result.message.id} on ${result.message.traceId}\n${rows}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "portage_room",
    {
      title: "Show room and members",
      description:
        "Show the rooms you are in: members and their @aliases, who is working or idle, the wake mode (who gets woken by the user's messages), whether you are the coordinator, and the room's collaboration.md conventions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(formatRoom(await client.room()));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "portage_artifact_get",
    {
      title: "Fetch a Portage artifact",
      description:
        "Load an artifact listed in a Portage message (artifactId). Small files return contentBase64; larger ones (or when writeTo is set) are written under your workdir and return a relative path.",
      inputSchema: {
        artifactId: z.string().min(1).max(200).describe("artifactId from the Artifacts receipt"),
        writeTo: z
          .string()
          .max(1000)
          .optional()
          .describe("Optional relative path under your workdir to write the file"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await client.artifactGet(args);
        if (result.path) {
          return text(
            `artifactId=${result.artifactId}\nname=${result.name}\nbytes=${result.byteSize}\nhash=${result.hash}\npath=${result.path}`,
          );
        }
        return text(
          `artifactId=${result.artifactId}\nname=${result.name}\nbytes=${result.byteSize}\nhash=${result.hash}\nmime=${result.mime}\ncontentBase64=${result.contentBase64 ?? ""}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "portage_artifact_put",
    {
      title: "Upload a work product to Portage",
      description:
        "Store a file as a Portage artifact and return artifactId. Prefer a relative path under your workdir. Then pass artifactIds to portage_send so the user or peers can open it.",
      inputSchema: {
        path: z.string().max(1000).optional().describe("Relative path under your workdir"),
        name: z.string().max(500).optional().describe("Override filename when using contentBase64 or renaming"),
        contentBase64: z.string().max(12_000_000).optional().describe("Raw file bytes when you are not reading from disk"),
        mime: z.string().max(200).optional(),
        conversationId: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!args.path && !args.contentBase64) throw new Error("pass path or contentBase64");
        const result = await client.artifactPut(args);
        return text(
          `Stored artifactId=${result.artifactId} · ${result.name} · ${result.byteSize} bytes · v${result.version}. Pass this id in portage_send.artifactIds.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "portage_status",
    {
      title: "Report your state to Portage",
      description:
        "Tell Portage whether you are idle, working, or waiting for the human. Messages for you are queued while you are working and delivered in order when you report idle. Report idle when you finish a task so queued messages reach you.",
      inputSchema: {
        state: z.enum(["idle", "running", "waiting_human"]).describe("idle = ready for new messages"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ state }) => {
      try {
        const result = await client.status(state);
        const flushed = result.deliveries.filter((d) => d.state === "submitted").length;
        return text(
          state === "idle"
            ? `You are idle. ${flushed ? `${flushed} queued message(s) were just delivered — call portage_inbox.` : "Nothing was queued."}`
            : `State set to ${state}. New messages will queue until you report idle.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
