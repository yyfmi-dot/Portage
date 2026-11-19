import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { escapeHtml } from "../format.js";
import { highlight } from "./highlight.js";
import { renderDiagram } from "./diagram.js";
import { copyText } from "./copy.js";

const marked = new Marked({ gfm: true }, markedKatex({ throwOnError: false }), {
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0]!.toLowerCase();
      if (language === "mermaid") return `<div class="md-diagram"><pre class="md-diagram-source">${escapeHtml(text)}</pre></div>`;
      return `<pre class="md-code" data-lang="${escapeHtml(language)}"><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && !node.getAttribute("href")?.startsWith("#")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const slug = (text: string) =>
  `md-${text.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section"}`;

/** Sanitized markdown into `el`, then code highlighting, diagrams and an outline when it helps. */
export async function renderMarkdown(el: HTMLElement, source: string) {
  const html = DOMPurify.sanitize(await marked.parse(source), { ADD_ATTR: ["target"] });
  const outline: Array<{ id: string; text: string; level: number }> = [];
  const doc = document.createElement("article");
  doc.className = "md-doc";
  doc.innerHTML = html;
  const used = new Map<string, number>();
  for (const h of doc.querySelectorAll<HTMLElement>("h1, h2, h3")) {
    const base = slug(h.textContent ?? "");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
    outline.push({ id: h.id, text: h.textContent ?? "", level: Number(h.tagName[1]) });
  }
  el.innerHTML = "";
  el.classList.toggle("with-outline", outline.length >= 3);
  el.append(doc);
  if (outline.length >= 3) {
    const nav = document.createElement("nav");
    nav.className = "md-outline";
    nav.innerHTML = `<b>On this page</b>${outline
      .map((o) => `<a href="#${o.id}" class="level-${o.level}">${escapeHtml(o.text)}</a>`)
      .join("")}`;
    nav.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest("a");
      if (!link) return;
      event.preventDefault();
      doc.querySelector(link.getAttribute("href")!)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.append(nav);
  }
  await Promise.all([
    ...[...doc.querySelectorAll<HTMLElement>("pre.md-code")].map(async (pre) => {
      const code = pre.textContent ?? "";
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      wrap.innerHTML = `<div class="code-block-bar"><span>${escapeHtml(pre.dataset.lang || "text")}</span><button type="button" class="copy-code">Copy</button></div>${await highlight(code, pre.dataset.lang || "text")}`;
      wrap.querySelector("button")!.addEventListener("click", (event) => copyText(event.currentTarget as HTMLElement, code));
      pre.replaceWith(wrap);
    }),
    ...[...doc.querySelectorAll<HTMLElement>(".md-diagram")].map((box) => renderDiagram(box, box.textContent ?? "")),
  ]);
}