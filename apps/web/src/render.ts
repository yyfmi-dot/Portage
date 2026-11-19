import { $, stateLabels, ui, model, session, room } from "./state.js";
import { escapeHtml, statusFor, queueFor } from "./format.js";
import { renderOffice } from "./office.js";
import { hostLabel } from "./model.js";
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
  $("connectionLabel").textContent = !ui.connected ? "本机服务未连接" : ok ? "本机服务 · 实时同步" : "已连接 · 正在恢复实时同步";
  if (ui.model) {
    $("daemonLabel").textContent = `本机服务 · ${ui.model.sessions.length} 个会话`;
  }
}

export function renderSidebar() {
  $("roomList").innerHTML = model()
    .rooms.map(
      (item) =>
        `<button class="room-nav ${ui.selection.kind === "room" && item.id === ui.roomId ? "active" : ""}" data-room="${item.id}" data-drop-room="${item.id}"><span class="room-symbol">${escapeHtml([...item.name][0] ?? "房")}</span><span>${escapeHtml(item.name)}</span><small>${item.paused ? "已暂停" : item.members.length}</small></button>`,
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
      const hosts = [...new Set([...["app", "vscode_cli", "terminal", "headless"].map(hostLabel), ...items.map((x) => x.host)])];
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
  $("roomEyebrow").textContent = target ? `${target.provider} · ${target.host}` : "协作房间";
  $("viewTitle").textContent = target?.name ?? current.name;
  $("viewSubtitle").textContent = target
    ? `${target.writable ? "可以直接发消息给它" : "只读，只能查看记录"} · 在房间里用 @${target.alias} 叫它`
    : "把不同来源的 AI 会话请进同一个房间，一起把事情做完。";
  $("roomRulesLabel").textContent = `协作约定 v${current.revision}`;
  $("addMember").hidden = direct;
  $("roomRules").hidden = direct;
  ($("wakeMode") as HTMLSelectElement).value = current.mode;
  ($("wakeMode") as HTMLSelectElement).disabled = direct;
  $("pauseRoom").hidden = direct;
  $("pauseRoom").textContent = current.paused ? "恢复自动通信" : "暂停自动通信";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.setAttribute("aria-selected", String(button.dataset.view === ui.view));
    button.disabled = direct && button.dataset.view !== "chat";
  }
  $("roomView").hidden = ui.view !== "room";
  $("chatView").hidden = ui.view !== "chat";
  $("flowView").hidden = ui.view !== "flow";
  $("activityPanel").hidden = ui.view === "chat";
}
