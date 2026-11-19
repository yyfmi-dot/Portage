import { escapeHtml } from "../format.js";

const OPEN_DEPTH = 2;
const PAGE = 200;

function leaf(value: unknown) {
  if (value === null) return `<span class="j-null">null</span>`;
  if (typeof value === "string") return `<span class="j-string">"${escapeHtml(value)}"</span>`;
  if (typeof value === "number") return `<span class="j-number">${value}</span>`;
  if (typeof value === "boolean") return `<span class="j-bool">${value}</span>`;
  return `<span>${escapeHtml(String(value))}</span>`;
}

function node(key: string | null, value: unknown, depth: number): string {
  const label = key === null ? "" : `<span class="j-key">${escapeHtml(key)}</span><span class="j-colon">: </span>`;
  if (value === null || typeof value !== "object") return `<div class="j-row">${label}${leaf(value)}</div>`;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return `<div class="j-row">${label}<span class="j-punct">${open}${close}</span></div>`;
  const shown = entries.slice(0, PAGE).map(([k, v]) => node(k, v, depth + 1)).join("");
  const more = entries.length > PAGE ? `<div class="j-row j-more">… ${entries.length - PAGE} more</div>` : "";
  const count = Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`;
  return `<details class="j-node"${depth < OPEN_DEPTH ? " open" : ""}><summary>${label}<span class="j-punct">${open}</span><span class="j-count">${count}</span><span class="j-punct j-tail">${close}</span></summary><div class="j-children">${shown}${more}</div><div class="j-punct j-close">${close}</div></details>`;
}

export function renderJsonTree(el: HTMLElement, value: unknown) {
  el.innerHTML = `<div class="json-tree">${node(null, value, 0)}</div>`;
}
