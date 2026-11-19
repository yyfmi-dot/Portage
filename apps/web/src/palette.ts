import { $, stateLabels, ui, model, room } from "./state.js";
import { escapeHtml, statusFor, initial, modeLabel, plural } from "./format.js";
import { render } from "./render.js";
import { selectRoom, selectSession, previewQuery, demoCollaboration } from "./actions.js";
import { showRules, showDiscover } from "./dialogs.js";

export type Command = { group: string; label: string; hint?: string; glyph: string; keywords?: string; run: () => void };
const groupOrder = ["Rooms", "Sessions", "Actions", "Views"];
let paletteIndex = 0;
let paletteItems: Command[] = [];

export function commands(): Command[] {
  const current = room();
  const viewNames = { room: "Room", chat: "Chat", flow: "Flow" } as const;
  return [
    ...model().rooms.map((r) => ({
      group: "Rooms",
      label: r.name,
      hint: `${plural(r.members.length, "member")} · ${modeLabel(r.mode)}`,
      glyph: [...r.name][0] ?? "R",
      run: () => selectRoom(r.id),
    })),
    ...model().sessions.map((s) => ({
      group: "Sessions",
      label: s.name,
      hint: `@${s.alias} · ${s.provider} · ${s.host} · ${stateLabels[statusFor(s)]}`,
      glyph: initial(s),
      keywords: `${s.alias} ${s.nativeIdentity}`,
      run: () => selectSession(s.id),
    })),
    ...(Object.keys(viewNames) as Array<keyof typeof viewNames>).map((view, i) => ({
      group: "Views",
      label: `Go to ${viewNames[view]}`,
      hint: String(i + 1),
      glyph: "◫",
      run: () => {
        if (ui.selection.kind === "session") ui.selection = { kind: "room", id: ui.roomId };
        ui.view = view;
        render();
      },
    })),
    { group: "Actions", label: "Watch a demo", hint: "every step is a real delivery", glyph: "▷", run: () => void demoCollaboration() },
    {
      group: "Actions",
      label: current.paused ? "Resume auto-messaging" : "Pause auto-messaging",
      hint: current.name,
      glyph: current.paused ? "▷" : "Ⅱ",
      run: () => $("pauseRoom").click(),
    },
    { group: "Actions", label: "Edit room rules", hint: `v${current.revision}`, glyph: "✎", keywords: "rules limits budget policy collaboration", run: () => showRules("room") },
    { group: "Actions", label: "Edit global rules", hint: `v${model().globalRevision}`, glyph: "✎", keywords: "global rules", run: () => showRules("global") },
    { group: "Actions", label: "Preview what they receive", glyph: "{}", keywords: "preview context", run: () => void previewQuery() },
    { group: "Actions", label: "Find local sessions", hint: "Codex and Claude sessions on this computer", glyph: "＋", keywords: "discover register", run: () => void showDiscover() },
    { group: "Actions", label: "Add members", glyph: "＋", keywords: "member join", run: () => $("addMember").click() },
    { group: "Actions", label: "New room", glyph: "＋", keywords: "create room", run: () => $("createRoom").click() },
  ];
}

export function fuzzyScore(query: string, text: string) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 100 - at;
  let i = 0;
  for (const c of t) if (c === q[i]) i += 1;
  return i === q.length ? 10 : 0;
}

export function renderPalette() {
  const query = ($("paletteInput") as HTMLInputElement).value.trim();
  paletteItems = commands()
    .map((c) => ({ c, score: fuzzyScore(query, `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""} ${c.group}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
    .slice(0, 12);
  // one heading per group: with a query, groups rank by their best match
  const rank = query ? [...new Set(paletteItems.map((c) => c.group))] : groupOrder;
  paletteItems.sort((a, b) => rank.indexOf(a.group) - rank.indexOf(b.group));
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  let group = "";
  $("paletteList").innerHTML = paletteItems.length
    ? paletteItems
        .map((c, i) => {
          const heading = c.group !== group ? `<div class="palette-group">${c.group}</div>` : "";
          group = c.group;
          return `${heading}<button type="button" role="option" aria-selected="${i === paletteIndex}" class="${i === paletteIndex ? "active" : ""}" data-palette="${i}"><span class="palette-item-glyph">${escapeHtml(c.glyph)}</span><b>${escapeHtml(c.label)}</b>${c.hint ? `<small>${escapeHtml(c.hint)}</small>` : ""}</button>`;
        })
        .join("")
    : '<p class="palette-empty">No matching rooms, sessions or actions</p>';
  $("paletteList").querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

export function openPalette() {
  if (!ui.model) return;
  const dialog = $("palette") as HTMLDialogElement;
  ($("paletteInput") as HTMLInputElement).value = "";
  paletteIndex = 0;
  renderPalette();
  if (!dialog.open) dialog.showModal();
  $("paletteInput").focus();
}

export function runPalette(index: number) {
  const command = paletteItems[index];
  if (!command) return;
  ($("palette") as HTMLDialogElement).close();
  command.run();
}

export function bindPalette() {
  $("paletteInput").addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette();
  });
  $("paletteInput").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = paletteItems.length || 1;
      paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderPalette();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPalette(paletteIndex);
    }
  });
  $("paletteList").addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-palette]");
    if (item) runPalette(Number(item.dataset.palette));
  });
  $("palette").addEventListener("click", (event) => {
    if (event.target === $("palette")) ($("palette") as HTMLDialogElement).close();
  });
}
