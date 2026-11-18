import { $, stateLabels, ui, model, room } from "./state.js";
import { escapeHtml, statusFor, initial, modeLabel } from "./format.js";
import { render } from "./render.js";
import { selectRoom, selectSession, previewQuery, demoCollaboration } from "./actions.js";
import { showRules, showDiscover } from "./dialogs.js";

export type Command = { group: string; label: string; hint?: string; glyph: string; keywords?: string; run: () => void };
let paletteIndex = 0;
let paletteItems: Command[] = [];

export function commands(): Command[] {
  const current = room();
  const viewNames = { room: "房间", chat: "对话", flow: "信息流" } as const;
  return [
    ...model().rooms.map((r) => ({
      group: "房间",
      label: r.name,
      hint: `${r.members.length} 位成员 · ${modeLabel(r.mode)}`,
      glyph: "⌘",
      run: () => selectRoom(r.id),
    })),
    ...model().sessions.map((s) => ({
      group: "会话",
      label: s.name,
      hint: `@${s.alias} · ${s.provider} / ${s.host} · ${stateLabels[statusFor(s)]}`,
      glyph: initial(s),
      keywords: `${s.alias} ${s.nativeIdentity}`,
      run: () => selectSession(s.id),
    })),
    ...(Object.keys(viewNames) as Array<keyof typeof viewNames>).map((view, i) => ({
      group: "视图",
      label: `切换到${viewNames[view]}`,
      hint: String(i + 1),
      glyph: "◫",
      run: () => {
        if (ui.selection.kind === "session") ui.selection = { kind: "room", id: ui.roomId };
        ui.view = view;
        render();
      },
    })),
    { group: "操作", label: "演示一次协作", hint: "经由真实 Bus", glyph: "▷", run: () => void demoCollaboration() },
    {
      group: "操作",
      label: current.paused ? "恢复房间自动通信" : "暂停房间自动通信",
      hint: current.name,
      glyph: current.paused ? "▷" : "Ⅱ",
      run: () => $("pauseRoom").click(),
    },
    { group: "操作", label: "编辑 collaboration.md", hint: `v${current.revision}`, glyph: "md", keywords: "rules 规则 预算 策略", run: () => showRules("room") },
    { group: "操作", label: "编辑全局 PORTAGE.md", hint: `v${model().globalRevision}`, glyph: "md", keywords: "global rules", run: () => showRules("global") },
    { group: "操作", label: "预览下一条 query", glyph: "{}", keywords: "preview context", run: () => void previewQuery() },
    { group: "操作", label: "登记本机会话", hint: "扫描 Codex / Claude CLI", glyph: "＋", keywords: "discover register", run: () => void showDiscover() },
    { group: "操作", label: "添加房间成员", glyph: "＋", keywords: "member join", run: () => $("addMember").click() },
    { group: "操作", label: "新建房间", glyph: "＋", keywords: "create room", run: () => $("createRoom").click() },
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
  if (!query) paletteItems.sort((a, b) => ["房间", "会话", "操作", "视图"].indexOf(a.group) - ["房间", "会话", "操作", "视图"].indexOf(b.group));
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
    : '<p class="palette-empty">没有匹配的房间、会话或操作</p>';
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
