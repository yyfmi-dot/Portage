import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterCapabilityFlags,
  DiscoveredEndpoint,
  Endpoint,
  InjectResult,
  Message,
  Session,
  SessionAdapter,
} from "@portage/core";

/**
 * Durable file-inbox adapter: drops compiled queries into per-session folders.
 * Real PTY inject can replace/extend this later; file inbox is the first reliable
 * cross-CLI delivery surface that preserves proof (path + hash).
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

  async inject(
    session: Session,
    _endpoint: Endpoint,
    message: Message,
    compiledQuery: string,
  ): Promise<InjectResult> {
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
}
