import { $, stateLabels, ui, model, session, room } from "./state.js";
import { escapeHtml, statusFor, queueFor } from "./format.js";
import { renderOffice } from "./office.js";
import { renderChat, renderComposer } from "./chat.js";
import { renderInspector } from "./inspector.js";
import { renderActivity, renderGraph } from "./flow.js";
import { renderMemberOptions } from "./dialogs.js";
import { wakeCanvas } from "./canvas.js";

export function render() {
  if (!ui.model) return;
  $("offline").hidden = true;
  renderConnection();
  renderSidebar();
  renderHeader();
  renderOffice();
  renderChat();
  renderActivity();
  renderComposer();
  renderInspector();
  renderGraph();
  if (($("membersDialog") as HTMLDialogElement).open) renderMemberOptions();
  ui.freshMessages.clear();
  ui.renderedView = ui.view;
  wakeCanvas();
}

export function renderConnection() {
  const ok = ui.connected && ui.streamOpen;
  $("connectionDot").classList.toggle("offline", !ui.connected);
  $("connectionDot").classList.toggle("syncing", ui.connected && !ui.streamOpen);
  $("workspaceDot").classList.toggle("offline", !ui.connected);
  $("connectionLabel").textContent = !ui.connected ? "Daemon 未连接" : ok ? "Daemon 实时同步" : "Daemon 已连接 · 重连事件流";
  if (ui.model) {
    $("daemonLabel").textContent = `本地 Daemon · ${ui.model.sessions.length} sessions`;
  }
}

export function renderSidebar() {
  $("roomList").innerHTML = model()
    .rooms.map(
      (item) =>
        `<button class="room-nav ${ui.selection.kind === "room" && item.id === ui.roomId ? "active" : ""}" data-room="${item.id}" data-drop-room="${item.id}"><span class="room-symbol">⌘</span><span>${escapeHtml(item.name)}</span><small>${item.paused ? "Ⅱ" : item.members.length}</small></button>`,
    )
    .join("");
  const query = ($("sessionSearch") as HTMLInputElement).value.trim().toLowerCase();
  const providers = [...new Set(["Codex", "Claude", ...model().sessions.map((x) => x.provider)])];
  $("sessionTree").innerHTML = providers
    .map((provider) => {
      const items = model().sessions.filter(
        (item) =>
          item.provider === provider &&
          `${item.name} ${item.host} ${item.alias} ${item.nativeIdentity}`.toLowerCase().includes(query),
      );
      if (!items.length) return "";
      const hosts = [...new Set(["App", "VS Code CLI", "Terminal", "Headless", ...items.map((x) => x.host)])];
      const groups = hosts
        .map((host) => {
          const members = items.filter((item) => item.host === host);
          if (!members.length) return "";
          return `<div class="source-group"><div class="source-label">${host}</div>${members
            .map((item) => {
              const count = queueFor(item.id).length;
              return `<button draggable="true" data-session="${item.id}" class="session-row ${ui.selection.kind === "session" && ui.selection.id === item.id ? "active" : ""} ${item.enabled ? "" : "is-disabled"}" title="${escapeHtml(item.name)} · ${stateLabels[statusFor(item)]} · ${escapeHtml(item.nativeIdentity)}"><span class="session-dot ${statusFor(item)}"></span><span class="session-name">${escapeHtml(item.name)}</span>${count ? `<span class="queue-count">${count}</span>` : ""}</button>`;
            })
            .join("")}</div>`;
        })
        .join("");
      return `<div class="provider-title ${provider.toLowerCase()}"><span class="provider-logo">${provider === "Codex" ? "C›" : "✳"}</span>${escapeHtml(provider)}</div>${groups}`;
    })
    .join("");
}

export function renderHeader() {
  const direct = ui.selection.kind === "session";
  const target = direct ? session(ui.selection.id) : undefined;
  const current = room();
  $("currentLocation").textContent = target?.name ?? current.name;
  $("roomEyebrow").textContent = target ? `${target.provider.toUpperCase()} / ${target.host.toUpperCase()}` : "TEAM ROOM";
  $("viewTitle").textContent = target?.name ?? current.name;
  $("viewSubtitle").textContent = target
    ? `${target.writable ? "可写连接" : "只读连接"} · 原生身份 ${target.nativeIdentity} · @${target.alias}`
    : "不同来源的会话，在同一个空间协作。";
  $("roomRulesLabel").textContent = `collaboration.md v${current.revision}`;
  $("addMember").hidden = direct;
  $("roomRules").hidden = direct;
  ($("wakeMode") as HTMLSelectElement).value = current.mode;
  ($("wakeMode") as HTMLSelectElement).disabled = direct;
  $("pauseRoom").hidden = direct;
  $("pauseRoom").textContent = current.paused ? "▷ 恢复通信" : "Ⅱ 暂停通信";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.setAttribute("aria-selected", String(button.dataset.view === ui.view));
    button.disabled = direct && button.dataset.view !== "chat";
  }
  $("roomView").hidden = ui.view !== "room";
  $("chatView").hidden = ui.view !== "chat";
  $("flowView").hidden = ui.view !== "flow";
  $("activityPanel").hidden = ui.view === "chat";
}
