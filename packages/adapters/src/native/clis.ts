import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { appServerCall } from "./app-server.js";
import { lastLine } from "./transcript-adapter.js";
import type { TurnCli } from "./native-turn-adapter.js";

const toml = (value: string) => JSON.stringify(value);

/** `codex exec … resume <id> -`: one turn on an existing thread, prompt on stdin, JSONL on stdout. */
export const codexCli: TurnCli = {
  binary: () => resolveBinary("codex", process.env.PORTAGE_CODEX_BIN, codexBundles),
  args: ({ nativeSessionId, mcp, policy }) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(policy.sandbox ? ["-c", `sandbox_mode=${toml(policy.sandbox)}`] : []),
    ...(policy.networkAccess ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
    "-c",
    `mcp_servers.portage.command=${toml(mcp.command)}`,
    "-c",
    `mcp_servers.portage.args=[${mcp.args.map(toml).join(",")}]`,
    "resume",
    nativeSessionId,
    "-",
  ],
  signal: (line) => {
    if (line.type === "turn.started") return { started: true };
    if (line.type === "turn.completed") return { done: true };
    if (line.type === "turn.failed") return { failed: String(line.error?.message ?? "turn failed") };
    // top-level `error` records are fatal; item-level errors are warnings the CLI prints and continues
    if (line.type === "error") return { failed: String(line.message ?? "error") };
    return undefined;
  },
  // The app server is how Codex's own apps rename a thread: it updates the session index and the
  // thread database they list from.
  rename: ({ binary, nativeSessionId, title }) =>
    appServerCall(binary, "thread/name/set", { threadId: nativeSessionId, name: title }).then(() => undefined),
  // When VS Code / the desktop app holds the writer (even idle), queue into that holder — do not
  // ask the user to close the session. The holder runs the turn on the same thread.
  queue: ({ binary, nativeSessionId, message, cwd }) => queueCodexMessage(binary, nativeSessionId, message, cwd),
};

/** `codex queue --thread <id> --message <text>`: enqueue for the client that already has the writer. */
function queueCodexMessage(binary: string, threadId: string, message: string, cwd?: string) {
  return new Promise<{ ok: true; queueId?: string } | { ok: false; error: string }>((resolve) => {
    const child = spawn(binary, ["queue", "--thread", threadId, "--message", message], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      const text = `${stdout}\n${stderr}`;
      const match = /Queued message\s+(\S+)\s+for thread/i.exec(text);
      if (code === 0 && match) return resolve({ ok: true, queueId: match[1] });
      if (code === 0 && /Queued message/i.test(text)) return resolve({ ok: true });
      resolve({ ok: false, error: lastLine(stderr) || lastLine(stdout) || `codex queue exited with ${code}` });
    });
  });
}

/**
 * `agy -p= --conversation <id> --input-format stream-json --output-format stream-json`:
 * one headless turn on an existing Antigravity conversation. The prompt is one NDJSON user event on
 * stdin; MCP is mounted for the turn via the workspace `.agents/mcp_config.json` (Antigravity has
 * no per-invocation `--mcp-config` flag).
 */
export const antigravityCli: TurnCli = {
  binary: () => resolveBinary("agy", process.env.PORTAGE_AGY_BIN, agyBundles),
  args: ({ nativeSessionId }) => [
    "-p=",
    "--conversation",
    nativeSessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ],
  encodeInput: (query) => `${JSON.stringify({ event: "user", message: { content: query } })}\n`,
  signal: (line) => {
    if (line.event === "init") return { started: true };
    if (line.event === "result") {
      const result = line.result ?? {};
      if (String(result.status ?? "").toUpperCase() === "ERROR" || result.error)
        return { failed: String(result.error ?? result.response ?? "turn failed") };
      return { done: true };
    }
    return undefined;
  },
  // Antigravity's `/rename` is TUI-only; titles still come from its conversation summaries DB.
  rename: async () => undefined,
  async prepareTurn({ workdir, mcp }) {
    if (!workdir) return undefined;
    const agents = join(workdir, ".agents");
    const configPath = join(agents, "mcp_config.json");
    await mkdir(agents, { recursive: true });
    let previous: string | undefined;
    let parsed: { mcpServers?: Record<string, unknown> } = {};
    try {
      previous = await readFile(configPath, "utf8");
      parsed = JSON.parse(previous) as { mcpServers?: Record<string, unknown> };
    } catch {
      previous = undefined;
      parsed = {};
    }
    const servers = { ...(parsed.mcpServers ?? {}) };
    servers.portage = {
      command: mcp.command,
      args: mcp.args,
      timeoutSeconds: 30,
    };
    await writeFile(configPath, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`);
    return async () => {
      if (previous !== undefined) {
        await writeFile(configPath, previous).catch(() => undefined);
        return;
      }
      const now = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (now.mcpServers) delete now.mcpServers.portage;
      if (!now.mcpServers || Object.keys(now.mcpServers).length === 0) {
        await writeFile(configPath, "{}\n").catch(() => undefined);
      } else {
        await writeFile(configPath, `${JSON.stringify(now, null, 2)}\n`).catch(() => undefined);
      }
    };
  },
};

/** `claude -p --resume <id>`: one turn on an existing session, prompt on stdin, stream-json on stdout. */
export const claudeCli: TurnCli = {
  binary: () => resolveBinary("claude", process.env.PORTAGE_CLAUDE_BIN, claudeBundles),
  args: ({ nativeSessionId, mcp, policy }) => [
    "-p",
    "--resume",
    nativeSessionId,
    ...(policy.permissionMode ? ["--permission-mode", policy.permissionMode] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    JSON.stringify({ mcpServers: { portage: { command: mcp.command, args: mcp.args } } }),
    "--allowedTools",
    "mcp__portage",
  ],
  signal: (line) => {
    if (line.type === "system" && line.subtype === "init") return { started: true };
    if (line.type === "result") return line.is_error ? { failed: String(line.result ?? line.subtype ?? "turn failed") } : { done: true };
    return undefined;
  },
  // `/rename` appends exactly this record; Claude's session list and resume picker read the newest one.
  rename: ({ nativeSessionId, transcript, title }) =>
    appendFile(transcript, `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: nativeSessionId })}\n`),
};

/** Explicit override, then PATH, then where vendor apps bundle the CLI. */
async function resolveBinary(name: string, override: string | undefined, bundles: () => Promise<string[]>) {
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
    ...(await bundles()),
  ];
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/** Codex ships inside the ChatGPT editor extension (VS Code / Cursor) and the ChatGPT desktop app. */
async function codexBundles(): Promise<string[]> {
  const platform = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const out: string[] = [];
  for (const editor of [".vscode", ".cursor", ".vscode-insiders"]) {
    const root = join(homedir(), editor, "extensions");
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.startsWith("openai.chatgpt-")).sort().reverse())
      out.push(join(root, name, "bin", platform, "codex"));
  }
  out.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  return out;
}

async function claudeBundles(): Promise<string[]> {
  return [join(homedir(), ".claude", "local", "claude")];
}

async function agyBundles(): Promise<string[]> {
  return [
    join(homedir(), ".gemini", "bin", "agy"),
    join(homedir(), ".antigravity", "antigravity", "bin", "agy"),
    "/Applications/Antigravity.app/Contents/Resources/bin/agy",
  ];
}
