import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiscoveredEndpoint } from "@portage/core";

const execFileAsync = promisify(execFile);

export type DiscoveredProcess = {
  pid: number;
  name: string;
  provider: "codex" | "claude" | "unknown";
  commandLine?: string;
};

/**
 * Discover likely coding-agent CLI processes on Windows via PowerShell.
 * Returns candidates; Bus still requires explicit bind/join.
 */
export async function discoverCliProcesses(): Promise<DiscoveredProcess[]> {
  if (process.platform !== "win32") return [];

  const script = `
Get-CimInstance Win32_Process |
  Where-Object {
    $cmd = $_.CommandLine
    $n = $_.Name
    if (-not $cmd) { return $false }
    if ($cmd -match '(?i)crashpad-handler|portage.*discover|process-discovery') { return $false }
    if ($n -match '(?i)^(codex|claude)\\.exe$') { return $true }
    if ($cmd -match '(?i)[\\\\/](codex|claude)(\\.cmd|\\.exe)?(\\s|$)' -and $n -notmatch '(?i)^ChatGPT\\.exe$') { return $true }
    return $false
  } |
  Select-Object ProcessId, Name, CommandLine |
  ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as
      | { ProcessId: number; Name: string; CommandLine?: string }
      | Array<{ ProcessId: number; Name: string; CommandLine?: string }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const commandLine = row.CommandLine ?? "";
      const provider = inferProvider(row.Name, commandLine);
      return {
        pid: Number(row.ProcessId),
        name: row.Name,
        provider,
        commandLine,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Process ids from `pid` up to the root (nearest first, `pid` itself included).
 * An MCP server is a child of the CLI that launched it, so its ancestors contain the CLI's pid —
 * a verifiable native identity, no manual configuration.
 */
export async function ancestorPids(pid: number = process.pid, limit = 12): Promise<number[]> {
  if (process.platform !== "win32") return linuxAncestors(pid, limit);
  const script = `
$map = @{}
Get-CimInstance Win32_Process | ForEach-Object { $map[[int]$_.ProcessId] = [int]$_.ParentProcessId }
$chain = @()
$cur = ${Math.trunc(pid)}
while ($cur -and $map.ContainsKey($cur) -and $chain.Count -lt ${limit}) {
  $chain += $cur
  $next = $map[$cur]
  if ($next -eq $cur) { break }
  $cur = $next
}
$chain | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || "[]") as number | number[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
  } catch {
    return [pid];
  }
}

async function linuxAncestors(pid: number, limit: number): Promise<number[]> {
  const { readFile } = await import("node:fs/promises");
  const chain: number[] = [];
  let current = pid;
  while (current > 1 && chain.length < limit) {
    chain.push(current);
    try {
      const stat = await readFile(`/proc/${current}/stat`, "utf8");
      current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return chain;
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
      host: "terminal",
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
