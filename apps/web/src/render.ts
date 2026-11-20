import { $, stateLabels, ui, model, session, room, type VSession } from "./state.js";
import { escapeHtml, statusFor, queueFor, plural, setHtml, sinceLabel } from "./format.js";
import { renderOffice } from "./office.js";
import { hostLabel } from "./model.js";
import { renderChat, renderComposer } from "./chat.js";
import { renderInspector } from "./inspector.js";
import { renderActivity, renderGraph } from "./flow.js";
import { renderMemberOptions } from "./dialogs.js";
import { wakeCanvas } from "./canvas.js";

/** @-mention token shown in the header; always the real stored alias. */
function mentionAlias(target: VSession) {
  return target.alias;
}

export function render() {
  if (!ui.model) return;
  const offline = $("offline");
  offline.hidden = true;
  offline.setAttribute("aria-hidden", "true");
  offline.toggleAttribute("inert", true);
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
  $("connectionLabel").textContent = !ui.connected ? "Local service offline" : ok ? "Local service · live" : "Connected · reconnecting live updates";
  if (ui.model) {
    $("daemonLabel").textContent = `Local service · ${plural(ui.model.sessions.length, "session")}`;
  }
}

function sessionRow(item: VSession) {
  const count = queueFor(item.id).length;
  return `<button draggable="true" data-session="${item.id}" class="session-row ${ui.selection.kind === "session" && ui.selection.id === item.id ? "active" : ""} ${item.enabled ? "" : "is-disabled"} ${item.demo ? "is-demo" : ""}" title="${escapeHtml(item.name)} · ${stateLabels[statusFor(item)]} · ${escapeHtml(item.nativeIdentity)}${item.demo ? " · studio demo" : ""}"><span class="session-dot ${statusFor(item)}"></span><span class="session-name">${escapeHtml(item.name)}${item.demo ? `<small class="demo-tag">Demo</small>` : ""}</span>${count ? `<span class="queue-count">${count}</span>` : ""}</button>`;
}

function providerTree(items: VSession[]) {
  const providers = [...new Set(["Codex", "Claude", ...items.map((x) => x.provider)])];
  return providers
    .map((provider) => {
      const group = items.filter((item) => item.provider === provider);
      if (!group.length) return "";
      const hosts = [...new Set([...["app", "vscode_cli", "terminal", "headless"].map(hostLabel), ...group.map((x) => x.host)])];
      const blocks = hosts
        .map((host) => {
          const members = group.filter((item) => item.host === host);
          if (!members.length) return "";
          return `<div class="source-group"><div class="source-label">${host}</div>${members.map(sessionRow).join("")}</div>`;
        })
        .join("");
      return `<div class="provider-title ${provider.toLowerCase()}"><span class="provider-logo">${provider === "Codex" ? "C›" : "✳"}</span>${escapeHtml(provider)}</div>${blocks}`;
    })
    .join("");
}

export function renderSidebar() {
  $("roomList").innerHTML = model()
    .rooms.map((item) => {
      const demoOnly = item.members.length > 0 && item.members.every((id) => session(id)?.demo);
      return `<button class="room-nav ${ui.selection.kind === "room" && item.id === ui.roomId ? "active" : ""}" data-room="${item.id}" data-drop-room="${item.id}"><span class="room-symbol">${escapeHtml([...item.name][0] ?? "R")}</span><span>${escapeHtml(item.name)}${demoOnly ? `<small class="demo-tag">Demo</small>` : ""}</span><small>${item.paused ? "Paused" : item.members.length}</small></button>`;
    })
    .join("");
  const query = ($("sessionSearch") as HTMLInputElement).value.trim().toLowerCase();
  const matches = (item: VSession) =>
    `${item.name} ${item.host} ${item.alias} ${item.nativeIdentity}`.toLowerCase().includes(query);
  const live = model().sessions.filter((item) => !item.demo && matches(item));
  const demos = model().sessions.filter((item) => item.demo && matches(item));
  const demoBlock = demos.length
    ? `<details class="demo-sessions" ${query || demos.some((d) => ui.selection.kind === "session" && ui.selection.id === d.id) ? "open" : ""}><summary><span>Studio demo</span><small>${demos.length}</small></summary><div class="demo-session-list">${providerTree(demos)}</div></details>`
    : "";
  $("sessionTree").innerHTML = `${providerTree(live)}${demoBlock}`;
  renderArchived(query);
}

function renderArchived(query: string) {
  const all = model().archived;
  const items = all.filter((x) => `${x.name} ${x.provider} ${x.host}`.toLowerCase().includes(query));
  const box = $("archivedSessions") as HTMLDetailsElement;
  box.hidden = !items.length;
  if (query && items.length) box.open = true;
  $("archivedCount").textContent = String(items.length);
  setHtml(
    $("archivedList"),
    items
      .map(
        (x) =>
          `<div class="archived-row" title="${escapeHtml(x.name)} · ${x.provider} · ${x.host}"><span class="session-name">${escapeHtml(x.name)}<small>${x.provider} · ${x.host} · ${sinceLabel(x.archivedAt)}</small></span><button data-restore-session="${x.id}" aria-label="Restore ${escapeHtml(x.name)}">Restore</button></div>`,
      )
      .join(""),
  );
}

export function renderHeader() {
  const direct = ui.selection.kind === "session";
  const target = direct ? session(ui.selection.id) : undefined;
  const current = room();
  $("currentLocation").textContent = target?.name ?? current.name;
  $("roomEyebrow").textContent = target ? `${target.provider} · ${target.host}` : "Room";
  $("viewTitle").textContent = target?.name ?? current.name;
  $("viewSubtitle").textContent = target
    ? `${target.demo ? "Studio demo · file inbox" : target.writable ? "Message it directly" : "Read-only: you can view its record"} · in a room, @${mentionAlias(target)}`
    : current.members.length && current.members.every((id) => session(id)?.demo)
      ? "Studio demo room — add real Codex or Claude sessions when you are ready."
      : "Sessions from different tools, working in one room.";
  $("viewSubtitle").title = target
    ? `${$("viewSubtitle").textContent ?? ""} · alias @${target.alias}`
    : ($("viewSubtitle").textContent ?? "");
  $("roomRulesLabel").textContent = `Room rules v${current.revision}`;
  $("addMember").hidden = direct;
  $("roomRules").hidden = direct;
  ($("wakeMode") as HTMLSelectElement).value = current.mode;
  ($("wakeMode") as HTMLSelectElement).disabled = direct;
  document.querySelector<HTMLElement>(".wake-control")!.hidden = direct;
  $("pauseRoom").hidden = direct;
  $("pauseRoom").textContent = current.paused ? "Resume auto-messaging" : "Pause auto-messaging";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.setAttribute("aria-selected", String(button.dataset.view === ui.view));
    button.disabled = direct && button.dataset.view !== "chat";
  }
  $("roomView").hidden = ui.view !== "room";
  $("chatView").hidden = ui.view !== "chat";
  $("flowView").hidden = ui.view !== "flow";
  $("activityPanel").hidden = ui.view !== "room";
}
