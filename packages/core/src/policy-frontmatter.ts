import type { RoomPolicy } from "./types.js";

/**
 * Executable part of a room collaboration.md: a YAML frontmatter block restricted to a known schema.
 * Only the subset the schema needs is accepted (nested maps of scalars, `#` comments), and any
 * unknown key or out-of-range value rejects the whole document — a policy never half-applies.
 */
export type FrontmatterPolicy = {
  version?: number;
  wakeMode?: RoomPolicy["wakeMode"];
  /** Participant id, session id or alias; resolved against current members by the bus. */
  coordinator?: string;
  batchWindowMs?: number;
  maxConcurrent?: number;
  agentMessagesPerMinute?: number;
  maxWakeupsPerTrace?: number;
  maxAutoRounds?: number;
  maxContextBytes?: number;
};

export type ParsedPolicyDocument = { policy: FrontmatterPolicy; body: string; hasFrontmatter: boolean };

const WAKE_MODES = ["coordinator", "swarm", "mentions", "manual"] as const;

type Field = { path: string; key: keyof FrontmatterPolicy; kind: "int" | "string" | "mode"; min?: number; max?: number };

const FIELDS: Field[] = [
  { path: "version", key: "version", kind: "int", min: 1, max: 1 },
  { path: "wake.mode", key: "wakeMode", kind: "mode" },
  { path: "wake.coordinator", key: "coordinator", kind: "string" },
  { path: "wake.batch_window_ms", key: "batchWindowMs", kind: "int", min: 0, max: 60_000 },
  { path: "wake.max_concurrent", key: "maxConcurrent", kind: "int", min: 1, max: 20 },
  { path: "budget.agent_messages_per_minute", key: "agentMessagesPerMinute", kind: "int", min: 1, max: 1000 },
  { path: "budget.max_wakeups_per_trace", key: "maxWakeupsPerTrace", kind: "int", min: 1, max: 1000 },
  { path: "budget.max_auto_rounds", key: "maxAutoRounds", kind: "int", min: 1, max: 100 },
  { path: "budget.max_context_bytes", key: "maxContextBytes", kind: "int", min: 1024, max: 1_048_576 },
];
const SECTIONS = new Set(["wake", "budget"]);

export class PolicyFrontmatterError extends Error {
  constructor(readonly problems: string[]) {
    super(`collaboration.md frontmatter invalid: ${problems.join("; ")}`);
  }
}

export function parsePolicyDocument(markdown: string): ParsedPolicyDocument {
  const text = markdown.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { policy: {}, body: text.trim(), hasFrontmatter: false };

  const problems: string[] = [];
  const raw = new Map<string, string>();
  let section: string | undefined;
  match[1]!.split(/\r?\n/).forEach((line, index) => {
    const where = `line ${index + 2}`;
    const content = stripComment(line);
    if (!content.trim()) return;
    const indented = /^\s+/.test(content);
    const kv = /^\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(content);
    if (!kv) return problems.push(`${where}: expected "key: value"`);
    const [, key, value] = kv as unknown as [string, string, string];
    if (!indented) {
      section = undefined;
      if (value === "") {
        if (!SECTIONS.has(key)) problems.push(`${where}: unknown section "${key}"`);
        else section = key;
        return;
      }
      raw.set(key, value);
      return;
    }
    if (!section) return problems.push(`${where}: "${key}" is indented outside a section`);
    raw.set(`${section}.${key}`, value);
  });

  const policy: FrontmatterPolicy = {};
  for (const [path, value] of raw) {
    const field = FIELDS.find((f) => f.path === path);
    if (!field) {
      problems.push(`unknown key "${path}"`);
      continue;
    }
    const scalar = unquote(value);
    if (field.kind === "int") {
      const n = /^-?\d+$/.test(scalar) ? Number(scalar) : NaN;
      if (!Number.isInteger(n) || n < field.min! || n > field.max!)
        problems.push(`${path} must be an integer ${field.min}-${field.max}`);
      else (policy as Record<string, unknown>)[field.key] = n;
    } else if (field.kind === "mode") {
      if (!(WAKE_MODES as readonly string[]).includes(scalar))
        problems.push(`${path} must be one of ${WAKE_MODES.join(" | ")}`);
      else policy.wakeMode = scalar as RoomPolicy["wakeMode"];
    } else if (!scalar) {
      problems.push(`${path} must not be empty`);
    } else {
      policy.coordinator = scalar;
    }
  }
  if (policy.coordinator && policy.wakeMode && policy.wakeMode !== "coordinator")
    problems.push(`wake.coordinator only applies when wake.mode is coordinator`);
  if (problems.length) throw new PolicyFrontmatterError(problems);
  return { policy, body: text.slice(match[0].length).trim(), hasFrontmatter: true };
}

/** Body text that is compiled into queries — the executable header is server policy, not guidance. */
export function policyDocumentBody(markdown: string): string {
  try {
    return parsePolicyDocument(markdown).body;
  } catch {
    return markdown.trim();
  }
}

function stripComment(line: string) {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(value: string) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v;
}
