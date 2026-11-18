import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
