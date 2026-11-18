#!/usr/bin/env node
// Run every package's tests even when an earlier one fails, then report all failures together.
import { spawnSync } from "node:child_process";

const packages = ["@portage/core", "@portage/adapters", "@portage/daemon", "@portage/mcp"];
const failed = [];
for (const name of packages) {
  console.log(`\n── ${name} ──`);
  const result = spawnSync("npm", ["test", "-w", name], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) failed.push(name);
}
console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : `\nAll ${packages.length} packages passed.`);
process.exit(failed.length ? 1 : 0);
