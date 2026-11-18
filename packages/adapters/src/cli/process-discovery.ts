import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiscoveredEndpoint } from "@portage/core";

const execFileAsync = promisify(execFile);

export type DiscoveredProcess = {
  pid: number;
  name: string;
  provider: "codex" | "claude" | "unknown";
  commandLine?: string;
  /** Where the CLI runs, inferred from its ancestors (an editor's integrated terminal vs. a plain terminal). */
  host?: "terminal" | "vscode_cli";
};

type ProcessRow = { pid: number; ppid: number; name: string; commandLine: string; exiting?: boolean };

/**
 * Discover likely coding-agent CLI processes (Windows via PowerShell, macOS/Linux via ps).
 * Returns candidates; Bus still requires explicit bind/join.
 */
export async function discoverCliProcesses(): Promise<DiscoveredProcess[]> {
  const rows = await processTable();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows
    .filter((row) => !row.exiting && isAgentCli(row))
    .map((row) => ({
      pid: row.pid,
      name: row.name,
      provider: inferProvider(row.name, row.commandLine),
      commandLine: row.commandLine,
      host: inferHost(row, byPid),
    }));
}

/**
 * Process ids from `pid` up to the root (nearest first, `pid` itself included).
 * An MCP server is a child of the CLI that launched it, so its ancestors contain the CLI's pid —
 * a verifiable native identity, no manual configuration.
 */
export async function ancestorPids(pid: number = process.pid, limit = 12): Promise<number[]> {
  const byPid = new Map((await processTable()).map((row) => [row.pid, row]));
  if (!byPid.has(pid)) return [pid];
  const chain: number[] = [];
  let current: number | undefined = pid;
  while (current && byPid.has(current) && chain.length < limit && !chain.includes(current)) {
    chain.push(current);
    current = byPid.get(current)!.ppid;
  }
  return chain;
}

/** One consistent snapshot of pid → parent + command line for the whole machine. */
export async function processTable(): Promise<ProcessRow[]> {
  try {
    return process.platform === "win32" ? await windowsTable() : await posixTable();
  } catch {
    return [];
  }
}

async function posixTable(): Promise<ProcessRow[]> {
  // `comm=` is the executable path on macOS and the short name on Linux; `args=` is the full command line.
  // `stat=` marks zombies (Z) and processes stuck exiting (E): they hold a pid but are no session.
  const [names, args] = await Promise.all([
    execFileAsync("ps", ["-axo", "pid=,ppid=,stat=,comm="], { maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync("ps", ["-axo", "pid=,args="], { maxBuffer: 16 * 1024 * 1024 }),
  ]);
  const commandLines = new Map<number, string>();
  for (const line of args.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commandLines.set(Number(match[1]), match[2]!);
  }
  const rows: ProcessRow[] = [];
  for (const line of names.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const comm = match[4]!.trim();
    rows.push({
      pid,
      ppid: Number(match[2]),
      name: comm.split("/").pop() ?? comm,
      commandLine: commandLines.get(pid) ?? comm,
      exiting: /[ZE]/.test(match[3]!),
    });
  }
  return rows;
}

async function windowsTable(): Promise<ProcessRow[]> {
  const script = `
Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine |
  ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const raw = stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as WindowsRow | WindowsRow[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: row.Name ?? "",
    commandLine: row.CommandLine ?? "",
  }));
}

type WindowsRow = { ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string };

const NOT_A_SESSION =
  /crashpad|portage-mcp|process-discovery|app-server|code-mode-host|\s(mcp|mcp-server)(\s|$)|--print-config|\s--version(\s|$)|ChatGPT\.(exe|app)|Claude\.app|Codex Framework/i;

/** An interactive coding-agent CLI: the codex/claude executable itself, or a node shim launching it. */
export function isAgentCli(row: { name: string; commandLine: string }): boolean {
  if (!row.commandLine || NOT_A_SESSION.test(row.commandLine)) return false;
  if (/^(codex|claude)(\.exe)?$/i.test(row.name)) return true;
  if (!/^(node|bun|codex|claude)/i.test(row.name)) return false;
  const firstArgs = row.commandLine.split(/\s+/).slice(0, 2).join(" ");
  return (
    /(^|[\\/])(codex|claude)(\.cmd|\.exe|\.js|\.mjs)?(\s|$)/i.test(firstArgs) ||
    /[\\/]@(anthropic-ai[\\/]claude-code|openai[\\/]codex)[\\/]/i.test(firstArgs)
  );
}

const EDITOR = /Visual Studio Code|Code Helper|\bCode\.exe\b|Cursor( Helper)?|Cursor\.exe|VSCodium|Windsurf/i;

function inferHost(row: ProcessRow, byPid: Map<number, ProcessRow>): DiscoveredProcess["host"] {
  let current = byPid.get(row.ppid);
  for (let hops = 0; current && hops < 12; hops += 1) {
    if (EDITOR.test(current.commandLine) || EDITOR.test(current.name)) return "vscode_cli";
    current = current.ppid === current.pid ? undefined : byPid.get(current.ppid);
  }
  return "terminal";
}

export function processesToEndpoints(
  processes: DiscoveredProcess[],
): DiscoveredEndpoint[] {
  return processes
    .filter((p) => p.provider === "codex" || p.provider === "claude")
    .map((p) => ({
      suggestedSessionKey: `${p.provider}:pid:${p.pid}`,
      provider: p.provider,
      harness: "cli",
      host: p.host ?? "terminal",
      nativeSessionId: `pid-${p.pid}`,
      displayName: `${p.provider} · pid ${p.pid}`,
      capabilities: {
        discover: true,
        read: true,
        write: true,
        idleSignal: false,
        tail: false,
        createSession: false,
      },
    }));
}

function inferProvider(name: string, commandLine: string): DiscoveredProcess["provider"] {
  const hay = `${name} ${commandLine}`.toLowerCase();
  if (/\bcodex\b/.test(hay)) return "codex";
  if (/\bclaude\b/.test(hay)) return "claude";
  return "unknown";
}
