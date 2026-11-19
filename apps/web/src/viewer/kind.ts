import type { Artifact } from "@portage/core";

export type ViewerKind =
  | "image"
  | "svg"
  | "pdf"
  | "markdown"
  | "html"
  | "csv"
  | "tsv"
  | "json"
  | "xlsx"
  | "mermaid"
  | "code"
  | "text"
  | "binary";

/** Extension → shiki language id. */
const CODE_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  sql: "sql", css: "css", scss: "scss", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", diff: "diff", patch: "diff", dockerfile: "dockerfile", graphql: "graphql", lua: "lua",
  r: "r", jsonl: "json", vue: "vue", svelte: "svelte",
};

const ext = (name: string) => {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  return lower.includes(".") ? lower.split(".").pop()! : "";
};

export function viewerKind(a: Pick<Artifact, "originalName" | "mime" | "byteSize">): ViewerKind {
  const e = ext(a.originalName);
  const mime = a.mime === "application/octet-stream" ? "" : a.mime;
  if (e === "svg" || mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(e)) return "image";
  if (e === "pdf" || mime === "application/pdf") return "pdf";
  if (/^(md|markdown|mdx)$/.test(e) || mime === "text/markdown") return "markdown";
  if (/^html?$/.test(e) || mime === "text/html") return "html";
  if (e === "csv" || mime === "text/csv") return "csv";
  if (e === "tsv" || mime === "text/tab-separated-values") return "tsv";
  if (e === "json" || mime === "application/json") return "json";
  if (/^xlsx$/.test(e)) return "xlsx";
  if (/^(mmd|mermaid)$/.test(e)) return "mermaid";
  if (CODE_LANGS[e]) return "code";
  if (/^(txt|log|text|env|gitignore|lock)$/.test(e) || mime.startsWith("text/")) return "text";
  return a.byteSize <= 512 * 1024 ? "text" : "binary";
}

export const codeLang = (name: string) => CODE_LANGS[ext(name)] ?? "text";

/** The records a JSON value holds: itself if it is a list of objects, else its first such property. */
export function jsonRecords(value: unknown): Record<string, unknown>[] | null {
  const isRecords = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
  if (isRecords(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.values(value).find(isRecords) ?? null;
  return null;
}

/** Short badge for cards and the viewer header. */
export function kindBadge(a: Pick<Artifact, "originalName" | "mime" | "byteSize">) {
  const kind = viewerKind(a);
  const label =
    kind === "image" || kind === "svg" ? "IMG"
    : kind === "code" || kind === "text" || kind === "binary" ? (ext(a.originalName).slice(0, 4) || "FILE").toUpperCase()
    : kind === "mermaid" ? "DIAG"
    : kind === "markdown" ? "MD"
    : kind.toUpperCase();
  return { kind, label };
}
