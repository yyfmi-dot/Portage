import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ancestorPids, discoverCliProcesses, isAgentCli, processesToEndpoints } from "./process-discovery.js";

describe("ancestorPids", () => {
  it("returns the process itself first, then its parent chain", async () => {
    const chain = await ancestorPids(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain).toContain(process.ppid);
    expect(new Set(chain).size).toBe(chain.length);
  }, 30000);

  it("resolves a child process's ancestors back to this test process", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
    try {
      const chain = await ancestorPids(child.pid!);
      expect(chain[0]).toBe(child.pid);
      expect(chain).toContain(process.pid);
    } finally {
      child.kill();
    }
  }, 30000);
});

describe("isAgentCli", () => {
  it.each([
    ["codex", "codex", true],
    ["codex", "/opt/homebrew/bin/codex --model gpt-5", true],
    ["claude", "claude --resume", true],
    ["node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
    ["node", "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", true],
    ["node", "node /Users/me/.npm/bin/codex", true],
    ["codex.exe", "C:\\tools\\codex.exe", true],
    ["codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server", false],
    ["codex", "codex -c features.code_mode_host=true app-server", false],
    ["codex-code-mode-host", "/x/codex-code-mode-host --listen grpc+stdio://", false],
    ["codex", "codex mcp-server", false],
    ["node", "node /tmp/codex-case-audit/relay.mjs", false],
    ["Codex (Aperitif)", "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Codex (Aperitif)", false],
  ])("%s · %s → %s", (name, commandLine, expected) => {
    expect(isAgentCli({ name, commandLine })).toBe(expected);
  });
});

describe("discoverCliProcesses", () => {
  it.skipIf(process.platform === "win32")("finds a live codex executable and maps it to a pid identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portage-disc-"));
    // A node symlink named codex: killable (a copied system binary loses its signature on macOS and
    // can get stuck uninterruptible).
    const fake = join(dir, "codex");
    symlinkSync(process.execPath, fake);
    const child = spawn(fake, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const found = await discoverCliProcesses();
      const hit = found.find((p) => p.pid === child.pid);
      expect(hit?.provider).toBe("codex");
      const [endpoint] = processesToEndpoints(hit ? [hit] : []);
      expect(endpoint?.nativeSessionId).toBe(`pid-${child.pid}`);
      expect(["terminal", "vscode_cli"]).toContain(endpoint?.host);
    } finally {
      child.kill();
    }
  }, 30000);
});

describe("processesToEndpoints", () => {
  it("keeps only codex/claude and uses pid-scoped native identities", () => {
    const endpoints = processesToEndpoints([
      { pid: 7, name: "codex.exe", provider: "codex" },
      { pid: 8, name: "node.exe", provider: "unknown" },
      { pid: 9, name: "claude.exe", provider: "claude", host: "vscode_cli" },
    ]);
    expect(endpoints.map((e) => [e.provider, e.nativeSessionId, e.host])).toEqual([
      ["codex", "pid-7", "terminal"],
      ["claude", "pid-9", "vscode_cli"],
    ]);
  });
});
