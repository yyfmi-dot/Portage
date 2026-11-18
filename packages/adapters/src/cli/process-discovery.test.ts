import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ancestorPids, processesToEndpoints } from "./process-discovery.js";

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

describe("processesToEndpoints", () => {
  it("keeps only codex/claude and uses pid-scoped native identities", () => {
    const endpoints = processesToEndpoints([
      { pid: 7, name: "codex.exe", provider: "codex" },
      { pid: 8, name: "node.exe", provider: "unknown" },
      { pid: 9, name: "claude.exe", provider: "claude" },
    ]);
    expect(endpoints.map((e) => [e.provider, e.nativeSessionId])).toEqual([
      ["codex", "pid-7"],
      ["claude", "pid-9"],
    ]);
  });
});
