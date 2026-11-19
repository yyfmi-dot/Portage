import type { Artifact } from "@portage/core";
import { api } from "../api.js";
import { $, model } from "../state.js";
import { escapeHtml, formatBytes, senderName, setHtml, timeLabel, toast } from "../format.js";
import { codeLang, jsonRecords, kindBadge, type ViewerKind } from "./kind.js";
import { copyText } from "./copy.js";
import type { DataTable } from "./data.js";

type Tab = { id: string; label: string };
type Sheet = { name: string; table: DataTable };
type Loaded = { artifact: Artifact; kind: ViewerKind; text?: string; json?: unknown; sheets?: Sheet[]; sheet: number; tab: string };

const SOURCE: Tab = { id: "source", label: "Source" };
const TABS: Partial<Record<ViewerKind, Tab[]>> = {
  markdown: [{ id: "preview", label: "Preview" }, SOURCE],
  html: [{ id: "preview", label: "Preview" }, SOURCE],
  svg: [{ id: "preview", label: "Preview" }, SOURCE],
  mermaid: [{ id: "preview", label: "Diagram" }, SOURCE],
  csv: [{ id: "table", label: "Table" }, { id: "chart", label: "Chart" }, SOURCE],
  tsv: [{ id: "table", label: "Table" }, { id: "chart", label: "Chart" }, SOURCE],
  xlsx: [{ id: "table", label: "Table" }, { id: "chart", label: "Chart" }],
  json: [{ id: "tree", label: "Tree" }, { id: "table", label: "Table" }, { id: "chart", label: "Chart" }, SOURCE],
};
const TEXT_KINDS = new Set<ViewerKind>(["markdown", "html", "svg", "mermaid", "csv", "tsv", "json", "code", "text"]);
const HIGHLIGHT_LIMIT = 200_000;

let token = 0;
let current: Loaded | null = null;
let bound = false;

const dialog = () => $("fileDialog") as HTMLDialogElement;

export async function openViewer(id: string) {
  const artifact = model().artifacts.find((x) => x.id === id);
  if (!artifact) return;
  bind();
  const mine = ++token;
  const { kind, label } = kindBadge(artifact);
  current = { artifact, kind, sheet: 0, tab: TABS[kind]?.[0]?.id ?? "view" };
  const badge = $("fileBadge");
  badge.textContent = label;
  badge.className = `kind-badge kind-${kind}`;
  $("fileTitle").textContent = artifact.originalName;
  renderMeta(artifact);
  renderVersions(artifact);
  const url = api.artifactUrl(artifact.id);
  ($("fileOpen") as HTMLAnchorElement).href = url;
  const download = $("fileDownload") as HTMLAnchorElement;
  download.href = url;
  download.download = artifact.originalName;
  $("fileCopy").hidden = !TEXT_KINDS.has(kind);
  renderTabs();
  const body = $("fileBody");
  body.className = `viewer-body kind-${kind}`;
  body.innerHTML = `<div class="viewer-loading"><i></i><i></i><i></i></div>`;
  if (!dialog().open) dialog().showModal();

  try {
    if (TEXT_KINDS.has(kind)) {
      current.text = await api.artifactText(artifact.id);
      if (kind === "text" && current.text.includes("\u0000")) current.kind = "binary";
      if (kind === "json") {
        try {
          current.json = JSON.parse(current.text);
        } catch {
          current.json = undefined;
        }
      }
    } else if (kind === "xlsx") {
      const buffer = await (await fetch(url)).arrayBuffer();
      const [{ default: readSheets }, { typedTable }] = await Promise.all([import("read-excel-file/browser"), import("./data.js")]);
      const sheets = await readSheets(buffer);
      current.sheets = sheets.map((s) => ({
        name: s.sheet,
        table: typedTable((s.data[0] ?? []).map((v) => String(v ?? "")), s.data.slice(1) as DataTable["rows"]),
      }));
    }
    if (mine !== token) return;
    renderTabs();
    await renderBody(mine);
  } catch (error) {
    if (mine !== token) return;
    body.innerHTML = `<p class="viewer-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function renderMeta(a: Artifact) {
  const by = a.createdBy === "user" ? "You" : senderName(model().sessionByParticipant.get(a.createdBy) ?? a.createdBy);
  setHtml(
    $("fileMeta"),
    [`v${a.version}`, formatBytes(a.byteSize), `by ${by}`, timeLabel(Date.parse(a.createdAt))]
      .map((x) => `<span>${escapeHtml(x)}</span>`)
      .join("") + `<button type="button" data-copy-path title="${escapeHtml(a.storageKey)}">Copy path</button>`,
  );
}

function renderVersions(a: Artifact) {
  const versions = model()
    .artifacts.filter((x) => x.originalName === a.originalName && x.conversationId === a.conversationId)
    .sort((x, y) => y.version - x.version);
  setHtml(
    $("fileVersions"),
    versions.length > 1
      ? versions
          .map((v) => `<button class="${v.id === a.id ? "selected" : ""}" data-file-version="${v.id}">v${v.version}<small>${timeLabel(Date.parse(v.createdAt))}</small></button>`)
          .join("")
      : "",
  );
}

function availableTabs(): Tab[] {
  if (!current) return [];
  const tabs = TABS[current.kind] ?? [];
  if (current.kind !== "json") return tabs;
  const records = current.json === undefined ? null : jsonRecords(current.json);
  const numeric = records?.some((r) => Object.values(r).some((v) => typeof v === "number")) ?? false;
  return tabs.filter((t) => (t.id === "table" ? records !== null : t.id === "chart" ? numeric : true));
}

function renderTabs() {
  const tabs = availableTabs();
  setHtml(
    $("fileTabs"),
    tabs.length > 1
      ? tabs.map((t) => `<button type="button" role="tab" aria-selected="${t.id === current!.tab}" data-viewer-tab="${t.id}">${t.label}</button>`).join("")
      : "",
  );
}

async function renderBody(mine: number) {
  const c = current!;
  const body = $("fileBody");
  const stage = document.createElement("div");
  stage.className = `viewer-stage tab-${c.tab}`;
  const url = api.artifactUrl(c.artifact.id);
  const text = c.text ?? "";

  if (c.tab === "source") await renderCode(stage, text, c.kind === "markdown" ? "markdown" : c.kind === "svg" ? "xml" : c.kind === "csv" || c.kind === "tsv" ? "text" : c.kind);
  else if (c.kind === "image") renderImage(stage, url, c.artifact.originalName);
  else if (c.kind === "svg") renderImage(stage, url, c.artifact.originalName);
  else if (c.kind === "pdf") stage.innerHTML = `<iframe class="viewer-frame" src="${url}" title="${escapeHtml(c.artifact.originalName)}"></iframe>`;
  else if (c.kind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "viewer-frame html";
    frame.title = c.artifact.originalName;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = text;
    stage.append(frame);
  } else if (c.kind === "markdown") await (await import("./markdown.js")).renderMarkdown(stage, text);
  else if (c.kind === "mermaid") {
    stage.classList.add("diagram-stage");
    await (await import("./diagram.js")).renderDiagram(stage, text);
  } else if (c.kind === "json" && c.tab === "tree") {
    if (c.json === undefined) {
      stage.innerHTML = `<p class="viewer-error">Not valid JSON; showing the source.</p>`;
      await renderCode(stage, text, "json", true);
    } else (await import("./json-tree.js")).renderJsonTree(stage, c.json);
  } else if (c.tab === "table" || c.tab === "chart") {
    const data = await import("./data.js");
    const table = await currentTable(data);
    if (c.sheets && c.sheets.length > 1) {
      const sheets = document.createElement("div");
      sheets.className = "sheet-tabs";
      sheets.innerHTML = c.sheets.map((s, i) => `<button type="button" class="${i === c.sheet ? "selected" : ""}" data-sheet="${i}">${escapeHtml(s.name)}</button>`).join("");
      stage.append(sheets);
    }
    const host = document.createElement("div");
    host.className = c.tab === "table" ? "data-view" : "chart-view";
    stage.append(host);
    if (!table) host.innerHTML = `<p class="viewer-note">This JSON isn't a list of records, so there is no table.</p>`;
    else if (c.tab === "table") data.renderTable(host, table);
    else if (!data.chartable(table)) host.innerHTML = `<p class="viewer-note">No numeric columns to chart.</p>`;
    else {
      if (mine !== token) return;
      body.replaceChildren(stage);
      data.renderChart(host, table);
      return;
    }
  } else if (c.kind === "binary") stage.innerHTML = `<p class="viewer-note">No inline preview for this type. Download it or open it in a new tab.</p>`;
  else await renderCode(stage, text, c.kind === "code" ? codeLang(c.artifact.originalName) : "text");

  if (mine !== token) return;
  body.replaceChildren(stage);
}

async function currentTable(data: typeof import("./data.js")) {
  const c = current!;
  if (c.sheets) return c.sheets[c.sheet]?.table ?? null;
  if (c.kind === "json") return data.tableFromJson(c.json);
  const Papa = (await import("papaparse")).default;
  const parsed = Papa.parse<string[]>(c.text ?? "", { delimiter: c.kind === "tsv" ? "\t" : "", skipEmptyLines: true });
  const [head = [], ...rows] = parsed.data;
  return data.typedTable(head, rows);
}

async function renderCode(el: HTMLElement, text: string, lang: string, append = false) {
  const view = document.createElement("div");
  view.className = "code-view";
  if (text.length > HIGHLIGHT_LIMIT) {
    const lines = text.split("\n");
    view.innerHTML = `<pre class="shiki plain"><code>${lines.map((l) => `<span class="line">${escapeHtml(l)}</span>`).join("\n")}</code></pre>`;
  } else view.innerHTML = await (await import("./highlight.js")).highlight(text.replace(/\n$/, ""), lang);
  if (!append) el.replaceChildren();
  el.append(view);
}

function renderImage(el: HTMLElement, url: string, name: string) {
  el.classList.add("image-stage");
  el.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}" draggable="false" />`;
  const img = el.querySelector("img")!;
  img.addEventListener("load", () => {
    if (!img.naturalWidth) return;
    const meta = $("fileMeta");
    meta.querySelector(".dims")?.remove();
    meta.querySelector("[data-copy-path]")!.insertAdjacentHTML("beforebegin", `<span class="dims">${img.naturalWidth} × ${img.naturalHeight}</span>`);
    el.classList.toggle("zoomable", img.naturalWidth > img.clientWidth + 2 || img.naturalHeight > img.clientHeight + 2);
  });
  img.addEventListener("click", () => {
    if (!el.classList.contains("zoomable")) return;
    el.classList.toggle("actual");
  });
}

function bind() {
  if (bound) return;
  bound = true;
  const d = dialog();
  d.addEventListener("click", (event) => {
    if (event.target === d) return d.close();
    const t = event.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-viewer-tab]")?.dataset.viewerTab;
    const sheet = t.closest<HTMLElement>("[data-sheet]")?.dataset.sheet;
    if (tab && current && tab !== current.tab) {
      current.tab = tab;
      renderTabs();
      void renderBody(token);
    } else if (sheet !== undefined && current) {
      current.sheet = Number(sheet);
      void renderBody(token);
    } else if (t.closest("[data-copy-path]") && current) {
      const path = current.artifact.storageKey;
      void navigator.clipboard?.writeText(path).then(() => toast("Path copied"), () => toast(path));
    } else if (t.closest("#fileCopy") && current?.text !== undefined) {
      copyText($("fileCopy"), current.text);
    } else if (t.closest("#fileClose")) d.close();
  });
  d.addEventListener("close", () => {
    token += 1;
    current = null;
    $("fileBody").replaceChildren();
  });
}
