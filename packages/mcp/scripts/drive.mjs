// Drives a real portage-mcp process the way a CLI would. Used for manual acceptance against a live daemon.
//   node --import tsx packages/mcp/scripts/drive.mjs <sessionId> <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [sessionId, tool, rawArgs = "{}"] = process.argv.slice(2);
if (!sessionId || !tool) {
  console.error("usage: drive.mjs <sessionId> <tool> '<json args>'");
  process.exit(2);
}
const launcher = fileURLToPath(new URL("../bin/portage-mcp.mjs", import.meta.url));
const client = new Client({ name: "acceptance-driver", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [launcher, "--session", sessionId, ...(process.env.PORTAGE_DAEMON ? ["--daemon", process.env.PORTAGE_DAEMON] : [])],
    env: process.env,
    stderr: "ignore",
  }),
);
const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
for (const part of result.content) if (part.type === "text") console.log(part.text);
await client.close();
process.exit(result.isError ? 1 : 0);
