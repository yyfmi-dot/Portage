import "./prototype.css";
import "./portage.css";
import "./stage.css";
import "./viewer/viewer.css";
import { api, type DiscoveredEndpoint } from "./api.js";
import { $, ui, model, session, room } from "./state.js";
import { toast, senderName, modeLabel, countdownText } from "./format.js";
import { act, loadNative, loadOlder, refresh, scheduleRefresh } from "./data.js";
import { render, renderSidebar } from "./render.js";
import { renderOffice } from "./office.js";
import { renderChat, renderComposer, renderWakePreview, renderMentionMenu, insertMention } from "./chat.js";
import { renderInspector } from "./inspector.js";
import { renderGraph } from "./flow.js";
import { bindCanvas, wakeCanvas } from "./canvas.js";
import { selectRoom, selectSession, sendFromComposer, previewQuery, demoCollaboration } from "./actions.js";
import { showArtifact, showSnapshot, BUDGET_INPUTS, showRules, validateRules, insertFrontmatter, publishRules, renderMemberOptions, showDiscover, renderDiscover, showNameDialog } from "./dialogs.js";
import { bindPalette, openPalette } from "./palette.js";

bindPalette();

function setChatSource(source: typeof ui.chatSource) {
  ui.chatSource = source;
  renderChat();
  if (source === "native" && ui.selection.kind === "session") {
    const id = ui.selection.id;
    void loadNative(id)
      .then(() => ui.selection.id === id && renderChat())
      .catch((error) => toast(error instanceof Error ? error.message : String(error), "error"));
  }
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button || button.disabled || !ui.model) return;
  const data = button.dataset;
  const current = room();
  if (data.room) selectRoom(data.room);
  else if (data.session) selectSession(data.session);
  else if (data.inspectSession) {
    ui.inspector = { kind: "session", id: data.inspectSession };
    $("inspector").classList.add("open");
    renderOffice();
    renderInspector();
    renderGraph();
  } else if (data.message) {
    ui.inspector = { kind: "message", id: data.message };
    renderInspector();
    $("inspector").classList.add("open");
  } else if (data.view) {
    ui.view = data.view as typeof ui.view;
    render();
  } else if (data.openRules) showRules(data.openRules as "room" | "global");
  else if (data.scope) showRules(data.scope as "room" | "global");
  else if (data.toggleSession) {
    const s = session(data.toggleSession)!;
    void act(() => api.setCommunication(s.id, !s.enabled), `${s.name} · receiving ${s.enabled ? "off" : "on"}`);
  } else if (data.addSession) {
    const s = session(data.addSession)!;
    if (current.members.length >= 6) return toast("A room shows at most 6 members");
    void act(async () => {
      await api.joinRoom(current.id, s.participantId);
    }, "Added. It can read the history and wakes by the room's rules");
  } else if (data.leaveSession) {
    const s = session(data.leaveSession)!;
    void act(async () => {
      await api.leaveRoom(current.id, s.participantId);
      if (ui.inspector?.id === s.id) ui.inspector = null;
    }, "Removed from the room. Its session is untouched");
  } else if (data.makeCoordinator) {
    const s = session(data.makeCoordinator)!;
    void act(() => api.setWakeMode(current.id, "coordinator", s.participantId), "New lead set: messages now go to it first");
  } else if (data.readySession) {
    void act(() => api.markReady(data.readySession!), "Marked ready; queued messages go out in order");
  } else if (data.wakeSession) {
    const s = session(data.wakeSession)!;
    if (!s.enabled || !s.writable) return toast("It has receiving turned off, or is read-only");
    void act(
      () =>
        api.send(current.id, {
          text: `(Manual wake-up) Please check the latest messages in “${current.name}” and carry on.`,
          target: { kind: "participant", id: s.participantId },
          isManualWake: true,
        }),
      `Woke ${s.name} · doesn't count toward auto rounds`,
    );
  } else if (data.directSession) selectSession(data.directSession);
  else if (data.renameSession) {
    const s = session(data.renameSession)!;
    showNameDialog("Rename session", "Display name", s.name, "Only changes the name shown in Portage, not the session itself.", (name) =>
      act(() => api.updateSession(s.id, { displayName: name }), "Renamed"),
    );
  } else if (data.archiveSession) {
    const s = session(data.archiveSession)!;
    void act(async () => {
      await api.updateSession(s.id, { archived: true });
      ui.selection = { kind: "room", id: ui.roomId };
      ui.inspector = null;
      ui.view = "room";
      toast(`Archived ${s.name} · restore it any time from Archived in the sidebar`, "", {
        label: "Undo",
        run: () => void act(() => api.updateSession(s.id, { archived: false }), `${s.name} is back`),
      });
    });
  } else if (data.editMessage) {
    const message = model().messages.find((m) => m.id === data.editMessage)!;
    showNameDialog(
      "Edit message",
      "New text",
      message.text,
      "Keeps the message ID and adds a version. Delivered copies keep the old text; queued ones use the new one.",
      (text) => act(() => api.revise(message.id, text), "Edit saved"),
      4000,
    );
  } else if (data.hideMessage) {
    ui.hidden.add(data.hideMessage);
    localStorage.setItem("portage.hidden", JSON.stringify([...ui.hidden]));
    renderChat();
    toast("Hidden here; the history still has it");
  } else if (data.focusTrace) {
    ui.traceFilter = data.focusTrace;
    ui.view = "flow";
    if (ui.selection.kind === "session") ui.selection = { kind: "room", id: ui.roomId };
    render();
  } else if (data.showSnapshot) {
    const d = model().deliveries.find((x) => x.id === data.showSnapshot);
    if (d?.context)
      void act(async () =>
        showSnapshot(
          await api.context(d.id),
          "What it actually received",
          `Everything ${senderName(d.recipient)} received · ${d.receipt?.nativeMessageId ?? "not delivered yet"}`,
        ),
      );
  } else if (data.cancelDelivery) {
    void act(() => api.cancelDelivery(data.cancelDelivery!), "Delivery cancelled · the message stays in the history");
  } else if (data.confirmBinding) {
    void act(() => api.confirmBinding(data.confirmBinding!), "New identity confirmed · held messages go to it now");
  } else if (data.interruptSession) {
    void act(async () => {
      const { interrupted } = await api.interrupt(data.interruptSession!);
      toast(interrupted ? "Stopped its current turn" : "No turn is running");
    });
  } else if (data.nativeSession) {
    selectSession(data.nativeSession);
    setChatSource("native");
  } else if (data.chatSource) {
    setChatSource(data.chatSource as typeof ui.chatSource);
  } else if (data.loadOlder) {
    void loadOlder(data.loadOlder).then(renderChat);
    renderChat();
  } else if (data.artifact) void showArtifact(data.artifact);
  else if (data.fileVersion) void showArtifact(data.fileVersion);
  else if (data.restoreSession) {
    const s = model().archived.find((x) => x.id === data.restoreSession)!;
    void act(() => api.updateSession(s.id, { archived: false }), `${s.name} is back, with its rooms`);
  } else if (data.register) {
    const e = JSON.parse(data.register) as DiscoveredEndpoint;
    void act(async () => {
      await api.registerSession({
        provider: e.provider,
        host: e.host,
        harness: e.harness,
        nativeIdentity: e.nativeSessionId,
        displayName: e.displayName,
        adapterId: e.adapterId,
        workdir: e.workdir,
      });
      renderDiscover((await api.discover()).endpoints);
    }, "Added. Drag it into a room or chat with it directly");
  } else if (data.mention) insertMention(data.mention);
  else if (data.eventInfo) toast(data.eventInfo);
});

($("sessionSearch") as HTMLInputElement).addEventListener("input", renderSidebar);
$("workspaceButton").addEventListener("click", () => toast("Personal workspace · data lives in ~/.portage on this computer"));
$("showInspector").addEventListener("click", () => $("inspector").classList.toggle("open"));
$("viewAllMessages").addEventListener("click", () => {
  ui.view = "chat";
  render();
});
$("reconnect").addEventListener("click", () => {
  ui.connected = false;
  void refresh();
});
$("addMember").addEventListener("click", () => {
  renderMemberOptions();
  ($("membersDialog") as HTMLDialogElement).showModal();
});
$("roomDropZone").addEventListener("click", () => $("addMember").click());
$("roomDropZone").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("addMember").click();
});
$("roomEmpty").addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-empty-action]")?.dataset.emptyAction;
  if (action === "members") $("addMember").click();
  else if (action === "discover") void showDiscover();
});
$("roomRules").addEventListener("click", () => showRules("room"));
$("globalRules").addEventListener("click", () => showRules("global"));
$("publishRules").addEventListener("click", () => void publishRules());
$("previewQuery").addEventListener("click", () => void previewQuery());
$("demoCollaboration").addEventListener("click", () => void demoCollaboration());
$("createSession").addEventListener("click", () => void showDiscover());
$("pauseRoom").addEventListener("click", () => {
  const current = room();
  void act(() => api.setPaused(current.id, !current.paused), current.paused ? "Auto-messaging resumed · held messages are rechecked" : "Auto-messaging paused · new deliveries are held");
});
$("wakeMode").addEventListener("change", (event) => {
  const mode = (event.target as HTMLSelectElement).value;
  const current = room();
  const lead = current.coordinator ? session(current.coordinator)?.participantId : undefined;
  void act(
    () => api.setWakeMode(current.id, mode, lead),
    mode === "coordinator"
      ? "Coordinator mode: your messages go to the lead first"
      : mode === "swarm"
        ? "Open floor: whoever is @-mentioned replies"
        : `Switched to ${modeLabel(mode)}`,
  );
});
$("traceFilter").addEventListener("change", (event) => {
  ui.traceFilter = (event.target as HTMLSelectElement).value;
  renderGraph();
});
$("pauseAnimation").addEventListener("click", () => {
  ui.animationPaused = !ui.animationPaused;
  renderGraph();
  wakeCanvas();
});
$("attachFile").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => {
  const file = ($("fileInput") as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("Attachments can be up to 8 MiB", "error");
  ui.attachment = file;
  renderComposer();
});
$("attachmentPreview").addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("#removeAttachment")) {
    ui.attachment = null;
    ($("fileInput") as HTMLInputElement).value = "";
    renderComposer();
  }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendFromComposer();
});
$("messageInput").addEventListener("input", () => {
  ui.mentionIndex = 0;
  renderMentionMenu();
  renderWakePreview();
});
$("messageInput").addEventListener("keydown", (event) => {
  const menu = $("mentionMenu");
  if (!menu.hidden) {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[data-mention]")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      ui.mentionIndex = (ui.mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderMentionMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(items[ui.mentionIndex]!.dataset.mention!);
      return;
    }
    if (event.key === "Escape") {
      menu.hidden = true;
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") ($("composer") as HTMLFormElement).requestSubmit();
});
$("messageInput").addEventListener("blur", () => setTimeout(() => ($("mentionMenu").hidden = true), 150));
$("createRoom").addEventListener("click", () =>
  showNameDialog("New room", "Room name", "", "Then drag sessions in from the left. New rooms start in open-floor mode.", async (name) => {
    try {
      const created = await api.createRoom(name);
      await refresh();
      selectRoom(created.id);
      toast("Room created");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }),
);
$("nameForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = ($("nameInput") as HTMLInputElement).value.trim();
  if (!value) return;
  ($("nameDialog") as HTMLDialogElement).close();
  void ui.nameAction?.(value);
});
$("closeName").addEventListener("click", () => ($("nameDialog") as HTMLDialogElement).close());document.addEventListener("dragstart", (event) => {
  const id = (event.target as HTMLElement).closest<HTMLElement>("[data-session]")?.dataset.session;
  if (id) event.dataTransfer?.setData("text/portage-session", id);
});
document.addEventListener("dragover", (event) => {
  const target = (event.target as HTMLElement).closest("#roomDropZone,[data-drop-room],#office");
  if (!target) return;
  event.preventDefault();
  target.classList.add("drag-over");
});
document.addEventListener("dragleave", (event) =>
  (event.target as HTMLElement).closest("#roomDropZone,[data-drop-room],#office")?.classList.remove("drag-over"),
);
document.addEventListener("drop", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("#roomDropZone,[data-drop-room],#office");
  if (!target || !ui.model) return;
  event.preventDefault();
  target.classList.remove("drag-over");
  const id = event.dataTransfer?.getData("text/portage-session");
  const s = id ? session(id) : undefined;
  if (!s) return;
  const roomId = target.dataset.dropRoom ?? ui.roomId;
  if (room(roomId).members.includes(s.id)) return toast("It is already in the room");
  void act(async () => {
    await api.joinRoom(roomId, s.participantId);
    ui.roomId = roomId;
    ui.selection = { kind: "room", id: roomId };
  }, `${s.name} joined ${room(roomId).name}`);
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  const typing = (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
  if (typing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
  const views = { "1": "room", "2": "chat", "3": "flow" } as const;
  if (event.key in views) {
    if (ui.selection.kind === "session") ui.selection = { kind: "room", id: ui.roomId };
    ui.view = views[event.key as keyof typeof views];
    render();
  } else if (event.key === "/") {
    event.preventDefault();
    $("messageInput").focus();
  } else if (event.key === "Escape" && ui.inspector) {
    ui.inspector = null;
    render();
  }
});
$("sessionSearch").addEventListener("focus", (event) => {
  if (!(event.target as HTMLInputElement).value) {
    (event.target as HTMLInputElement).blur();
    openPalette();
  }
});
document.addEventListener("click", (event) => {
  const suggestion = (event.target as HTMLElement).closest<HTMLElement>("[data-suggest]");
  if (!suggestion) return;
  const input = $("messageInput") as HTMLTextAreaElement;
  input.value = suggestion.dataset.suggest!;
  input.focus();
  renderWakePreview();
});
$("sendTarget").addEventListener("change", renderWakePreview);
$("rulesEditor").addEventListener("input", () => void validateRules());
for (const input of BUDGET_INPUTS) $(input.id).addEventListener("input", () => void validateRules());
$("insertFrontmatter").addEventListener("click", insertFrontmatter);
// Live countdowns for rate-limited holds; the tick that actually releases them runs in the daemon.
window.setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    el.textContent = countdownText(Number(el.dataset.countdown));
  }
}, 1000);
window.addEventListener("focus", () => {
  if (ui.connected) scheduleRefresh();
});

bindCanvas();
void refresh();
