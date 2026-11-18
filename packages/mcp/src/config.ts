const toml = (value: string) => JSON.stringify(value.replace(/\\/g, "/"));

/**
 * Connection snippets for the CLIs Portage targets. Printed, never written: editing a user's CLI
 * configuration is their decision. Paths are absolute because a CLI spawns the server from any cwd.
 */
export function printConfig(input: { nodePath: string; launcherPath: string; daemon: string }): string {
  const node = input.nodePath;
  const launcher = input.launcherPath;
  const env = input.daemon === "http://127.0.0.1:8787" ? "" : `\nenv = { PORTAGE_DAEMON = ${toml(input.daemon)} }`;
  return [
    "Portage MCP — connect a CLI to the Portage daemon",
    "",
    "0. Start the daemon, then register the CLI's session in the Portage UI (＋ 登记本机会话).",
    "   The server identifies its CLI by process ancestry (pid-<cli pid>), so no session id is needed.",
    "",
    "Codex  (~/.codex/config.toml)",
    "[mcp_servers.portage]",
    `command = ${toml(node)}`,
    `args = [${toml(launcher)}]${env}`,
    "",
    "Claude Code  (run once)",
    `claude mcp add portage -- "${node}" "${launcher}"`,
    "",
    "Then tell the agent: “check portage_inbox”. Delivered messages show as 已读 in the Portage UI once it does.",
  ].join("\n");
}
