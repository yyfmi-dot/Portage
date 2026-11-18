import { api } from "./api.js";
import { $, deliveryStateLabels, ui, session, room } from "./state.js";
import { toast, senderName, queueFor } from "./format.js";
import { act, refresh } from "./data.js";
import { render } from "./render.js";
import { renderOffice } from "./office.js";
import { mentionsIn } from "./chat.js";
import { showSnapshot } from "./dialogs.js";

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
  if (!text && !ui.attachment) return toast("写一条消息或选择一个附件");
  const body = text || "共享一个附件";
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
    toast(result.deliveries.length ? `已发送 · ${result.deliveries.length} 份投递（${[...new Set(states)].join(" / ")}）` : "已记录到房间历史 · 当前模式未唤醒成员");
  });
}

export async function previewQuery() {
  const target = ($("sendTarget") as HTMLSelectElement).value;
  const text = ($("messageInput") as HTMLTextAreaElement).value || "（输入区尚未填写消息）";
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
      "本次 query 预览",
      `由 Bus 按接收方 ${senderName(result.recipientSessionId ?? "")} 实际编译，与发送时的组装逻辑一致。原始消息单独保存。`,
    );
  });
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function demoCollaboration() {
  const current = room();
  if (current.paused) return toast("房间已暂停，可以先恢复自动通信");
  if (current.mode === "coordinator" && !current.coordinator) return toast("统筹模式需要指定一位统筹者");
  const lead = session(current.coordinator ?? current.members[0] ?? "");
  const worker = current.members.map((id) => session(id)!).find((s) => s.id !== lead?.id && s.enabled && s.writable);
  if (!lead?.enabled || !worker) return toast("请让统筹/发起者与至少一位可写成员开启通信");
  ui.demoRunning = true;
  renderOffice();
  toast("演示开始 · 每一步都经由真实 Bus 投递到原生收件箱");
  const stamp = Date.now().toString(36);
  try {
    const start = await api.send(current.id, {
      text: "请核对适配器契约，给出一份可实施的修改意见。",
      idempotencyKey: `demo_${stamp}_1`,
    });
    await wait(1800);
    if (queueFor(worker.id).length || worker.execution === "running") await api.markReady(worker.id);
    await api.send(current.id, {
      senderId: lead.participantId,
      source: "agent",
      text: `@${worker.alias} 请核对 native session 绑定、输入提交和重试边界，附上产物。`,
      mentionParticipantIds: [worker.participantId],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_2`,
    });
    await wait(2600);
    const review = new File(
      ["# Delivery review\n\n- 提交结果不明时记录为 uncertain，再通过原生记录回读确认。\n- 重试前核对 binding epoch。\n"],
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
      text: "核对完成。建议把提交结果不明单独记录为 uncertain，再通过原生记录确认。产物已附上。",
      artifactIds: [artifact.id],
      traceId: start.message.traceId,
      causalParentIds: [start.message.id],
      idempotencyKey: `demo_${stamp}_3`,
    });
    toast("演示完成 · 打开信息流查看完整 Trace");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    ui.demoRunning = false;
    await refresh();
  }
}
