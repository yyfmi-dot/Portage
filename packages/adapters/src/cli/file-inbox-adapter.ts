import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fnv1a,
  type AdapterCapabilityFlags,
  type DiscoveredEndpoint,
  type InjectResult,
  type Message,
  type Readiness,
  type Session,
  type SessionAdapter,
  type VerifyResult,
} from "@portage/core";

/**
 * Durable file-inbox adapter for sessions Portage cannot submit to natively (a CLI running in a
 * terminal it does not own): the compiled query lands in a per-session folder and the agent pulls
 * it through MCP (`portage_inbox`). Proof is the file path + hash.
 */
export class FileInboxAdapter implements SessionAdapter {
  readonly id = "cli-file-inbox";
  readonly capabilities: AdapterCapabilityFlags = {
    discover: false,
    read: true,
    write: true,
    idleSignal: false,
    tail: true,
    createSession: false,
  };

  constructor(private readonly rootDir: string) {}

  async discover(): Promise<DiscoveredEndpoint[]> {
    return [];
  }

  inboxDir(session: Session) {
    return join(this.rootDir, session.provider, session.nativeIdentity);
  }

  /** A process-bound session whose process exited has nobody left to read its inbox. */
  async readiness(session: Session): Promise<Readiness> {
    const pid = /^pid-(\d+)$/.exec(session.nativeIdentity)?.[1];
    if (!pid || isAlive(Number(pid))) return { ready: true };
    return { ready: false, reason: "offline", detail: `process ${pid} has exited` };
  }

  async inject(session: Session, message: Message, compiledQuery: string): Promise<InjectResult> {
    const dir = this.inboxDir(session);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${stamp}_${message.id}`;
    const txtPath = join(dir, `${base}.txt`);
    const metaPath = join(dir, `${base}.json`);
    await writeFile(txtPath, compiledQuery, "utf8");
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          messageId: message.id,
          traceId: message.traceId,
          sessionId: session.id,
          nativeIdentity: session.nativeIdentity,
          path: txtPath,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return { ok: true, proof: "submitted", nativeMessageId: txtPath };
  }

  /** The submission landed iff the inbox holds a file for this message whose text hashes to the compiled query. */
  async verify(session: Session, message: Message, compiledContextHash: string): Promise<VerifyResult> {
    const dir = this.inboxDir(session);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "absent" }
        : { status: "unknown", error: String(error) };
    }
    for (const name of names.filter((n) => n.endsWith(`_${message.id}.txt`)).sort().reverse()) {
      const path = join(dir, name);
      try {
        if (fnv1a(await readFile(path, "utf8")) === compiledContextHash) return { status: "present", nativeMessageId: path };
      } catch (error) {
        return { status: "unknown", error: String(error) };
      }
    }
    return { status: "absent" };
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
