import type {
  DiscoveredEndpoint,
  InjectResult,
  Session,
  SessionAdapter,
  Endpoint,
  Message,
  AdapterCapabilityFlags,
} from "@portage/core";

/**
 * Stub CLI adapter for contract and Bus wiring tests.
 * Real Codex/Claude discovery + PTY inject replaces the in-memory log later.
 */
export class StubCliAdapter implements SessionAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilityFlags = {
    discover: true,
    read: true,
    write: true,
    idleSignal: true,
    tail: true,
    createSession: false,
  };

  readonly injected: Array<{
    sessionId: string;
    messageId: string;
    query: string;
    at: string;
  }> = [];

  private surfaces: DiscoveredEndpoint[];

  constructor(input: { id: string; surfaces?: DiscoveredEndpoint[] }) {
    this.id = input.id;
    this.surfaces = input.surfaces ?? [];
  }

  setSurfaces(surfaces: DiscoveredEndpoint[]) {
    this.surfaces = surfaces;
  }

  async discover(): Promise<DiscoveredEndpoint[]> {
    return structuredClone(this.surfaces);
  }

  async inject(
    session: Session,
    _endpoint: Endpoint,
    message: Message,
    compiledQuery: string,
  ): Promise<InjectResult> {
    this.injected.push({
      sessionId: session.id,
      messageId: message.id,
      query: compiledQuery,
      at: new Date().toISOString(),
    });
    return { ok: true, proof: "submitted", nativeMessageId: `stub_${message.id}` };
  }
}

export function demoCodexSurface(nativeSessionId = "codex-demo-1"): DiscoveredEndpoint {
  return {
    suggestedSessionKey: `codex:${nativeSessionId}`,
    provider: "codex",
    harness: "cli",
    host: "terminal",
    nativeSessionId,
    displayName: `Codex ${nativeSessionId}`,
    capabilities: {
      discover: true,
      read: true,
      write: true,
      idleSignal: true,
      tail: true,
      createSession: false,
    },
  };
}

export function demoClaudeSurface(nativeSessionId = "claude-demo-1"): DiscoveredEndpoint {
  return {
    suggestedSessionKey: `claude:${nativeSessionId}`,
    provider: "claude",
    harness: "cli",
    host: "terminal",
    nativeSessionId,
    displayName: `Claude ${nativeSessionId}`,
    capabilities: {
      discover: true,
      read: true,
      write: true,
      idleSignal: true,
      tail: true,
      createSession: false,
    },
  };
}
