import { api } from "./api.js";
import { $, deliveryStateLabels, ui, session, room } from "./state.js";
import { toast, senderName, queueFor, plural } from "./format.js";
import { act, refresh } from "./data.js";
import { render } from "./render.js";
import { renderOffice } from "./office.js";
import { mentionsIn } from "./chat.js";
import { showSnapshot, showNameDialog } from "./dialogs.js";

export function renameRoom(id = ui.roomId) {
  const current = room(id);
  showNameDialog("Rename room", "Room name", current.name, "Only the name changes. Members, history and rules stay as they are.", (name) =>
    act(() => api.renameRoom(id, name), "Room renamed"),
  );
}

export function selectRoom(id: string) {
  ui.roomId = id;
  ui.selection = { kind: "room", id };
  ui.inspector = null;
  ui.traceFilter = "all";
  ($("sendTarget") as HTMLSelectElement).value = "room";
  render();
}

export function selectSession(id: string) {
  ui.selection = { kind: "session", id };
  ui.inspector = { kind: "session", id };
  ui.view = "chat";
  render();
}

export async function readBase64(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function uploadAttachment(conversationId: string) {
  if (!ui.attachment) return [];
  const artifact = await api.uploadArtifact({
    name: ui.attachment.name,
    mime: ui.attachment.type,
    contentBase64: await readBase64(ui.attachment),
    conversationId,
  });
  return [artifact.id];
}

export async function sendFromComposer() {
  const input = $("messageInput") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (($("sendButton") as HTMLButtonElement).disabled) return;
  if (!text && !ui.attachment) return toast("Write a message or pick an attachment");
  const body = text || "Sharing an attachment";
  const target = ($("sendTarget") as HTMLSelectElement).value;
  const sendButton = $("sendButton");
  sendButton.classList.remove("launch");
  void sendButton.offsetWidth;
  sendButton.classList.add("launch");
  await act(async () => {
    let result;
    if (ui.selection.kind === "session") {
      const targetSession = session(ui.selection.id)!;
      const dm = await api.directConversation(targetSession.id);
      result = await api.send(dm.id, {
        text: body,
        target: { kind: "participant", id: targetSession.participantId },
        artifactIds: await uploadAttachment(dm.id),
      });
    } else if (target === "room") {
      result = await api.send(ui.roomId, {
        text: body,
        mentionParticipantIds: mentionsIn(body),
        artifactIds: await uploadAttachment(ui.roomId),
      });
    } else {
      const targetSession = session(target)!;
      result = await api.send(ui.roomId, {
        text: body,
        target: { kind: "participant", id: targetSession.participantId },
        artifactIds: await uploadAttachment(ui.roomId),
      });
    }
    input.value = "";
    ui.attachment = null;
    ($("fileInput") as HTMLInputElement).value = "";
    const states = result.deliveries.map((d) => deliveryStateLabels[d.state] ?? d.state);
    toast(result.deliveries.length ? `Sent · ${plural(result.deliveries.length, "delivery", "deliveries")} (${[...new Set(states)].join(" / ")})` : "Logged in the room · this mode woke nobody");
  });
}

export async function previewQuery() {
  const target = ($("sendTarget") as HTMLSelectElement).value;
  const text = ($("messageInput") as HTMLTextAreaElement).value || "(nothing typed yet)";
  await act(async () => {
    let conversationId = ui.roomId;
    let recipientSessionId = target === "room" ? undefined : target;
    if (ui.selection.kind === "session") {
      conversationId = (await api.directConversation(ui.selection.id)).id;
      recipientSessionId = ui.selection.id;
    }
    const result = await api.preview(conversationId, { text, recipientSessionId });
    showSnapshot(
      result.snapshot,
      "What they receive",
      `If you send now, ${senderName(result.recipientSessionId ?? "")} receives exactly this: the rules, your message and how to reply.`,
    );
  });
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function demoCollaboration() {
  const current = room();
  if (current.paused) return toast("The room is paused; resume auto-messaging first");
  if (current.mode === "coordinator" && !current.coordinator) return toast("Coordinator mode needs a lead");
  const lead = session(current.coordinator ?? current.members[0] ?? "");
  const worker = current.members.map((id) => session(id)!).find((s) => s.id !== lead?.id && s.enabled && s.writable);
  if (!lead?.enabled || !worker) return toast("Turn on receiving for the lead and at least one writable member");
  ui.demoRunning = true;
  renderOffice();
  toast("Demo started: every step is a real delivery");
  const stamp = Date.now().toString(36);
  try {
    const start = await api.send(current.id, {
      text: "Please review the adapter contract and come back with changes we can ship.",
      idempotencyKey: `demo_${stamp}_1`,
    });
    await wait(1800);
    if (queueFor(worker.id).length || worker.execution === "running") await api.markReady(worker.id);
    await api.send(current.id, {
      senderId: lead.participantId,
      source: "agent",
      text: `@${worker.alias} please check native session binding, input submission and retry boundaries, and attach your notes.`,
      mentionParticipantIds: [worker.participantId],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_2`,
    });
    await wait(2600);
    const review = new File(
      ["# Delivery review\n\n- When a submission's outcome is unclear, record it as uncertain and confirm by reading the native record back.\n- Check the binding epoch before any retry.\n"],
      "delivery-review.md",
      { type: "text/markdown" },
    );
    const artifact = await api.uploadArtifact({
      name: review.name,
      mime: review.type,
      contentBase64: await readBase64(review),
      conversationId: current.id,
      createdBy: worker.participantId,
    });
    await api.send(current.id, {
      senderId: worker.participantId,
      source: "agent",
      text: "Done. Unclear submissions should be recorded as uncertain and confirmed from the native record. Notes attached.",
      artifactIds: [artifact.id],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_3`,
    });
    toast("Demo finished. Open Flow to see the whole thread");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    ui.demoRunning = false;
    await refresh();
  }
}
