#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PortageClient } from "./client.js";
import { printConfig } from "./config.js";
import { createPortageServer } from "./server.js";

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const daemon = arg("daemon") ?? process.env.PORTAGE_DAEMON ?? "http://127.0.0.1:8787";

  if (process.argv.includes("--print-config")) {
    // Not a protocol session, so stdout is free for humans here.
    const launcher = fileURLToPath(new URL("../bin/portage-mcp.mjs", import.meta.url));
    console.log(printConfig({ nodePath: process.execPath, launcherPath: launcher, daemon }));
    return;
  }

  const sessionId = arg("session") ?? process.env.PORTAGE_SESSION;
  const client = new PortageClient(daemon, { sessionId });
  await createPortageServer(client).connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr only.
  console.error(`portage-mcp ready · daemon ${daemon}${sessionId ? ` · session ${sessionId}` : " · session resolved from ancestor pid"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
