import { ancestorPids } from "@portage/adapters";

/** Thin HTTP client for the Daemon's agent surface. The MCP server holds no state of its own. */
export class PortageClient {
  private sessionId: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly options: { sessionId?: string; pids?: () => Promise<number[]> } = {},
  ) {
    this.sessionId = options.sessionId;
  }

  private async http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (error) {
      throw new Error(
        `Portage daemon is not reachable at ${this.baseUrl} (${error instanceof Error ? error.message : error}). Start it with: npm run daemon:serve`,
      );
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(json.error ?? `${response.status} ${path}`);
    return json as T;
  }

  /** Explicit session id, otherwise the nearest ancestor process registered as a Portage session. */
  async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const pids = await (this.options.pids ?? (() => ancestorPids(process.pid)))();
    try {
      const found = await this.http<{ sessionId: string }>("POST", "/api/agent/resolve", { pids });
      this.sessionId = found.sessionId;
      return found.sessionId;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}. This CLI is not registered in Portage yet — register it in the Portage UI (Find local sessions), or start this MCP server with --session <id>.`,
      );
    }
  }

  async room() {
    return this.http<RoomView>("GET", `/api/agent/${await this.session()}/room`);
  }
  async inbox(limit?: number) {
    return this.http<InboxView>("POST", `/api/agent/${await this.session()}/inbox`, { limit });
  }
  async send(input: { text: string; to?: string[]; roomId?: string; replyToMessageId?: string }) {
    return this.http<SendView>("POST", `/api/agent/${await this.session()}/send`, input);
  }
  async status(execution: "idle" | "running" | "waiting_human") {
    return this.http<{ execution: string; deliveries: Array<{ state: string }> }>(
      "POST",
      `/api/agent/${await this.session()}/status`,
      { execution },
    );
  }
}

export type RoomView = {
  you: { alias: string; name: string };
  rooms: Array<{
    roomId: string;
    title: string;
    wakeMode: string;
    coordinator: string | null;
    youAreCoordinator: boolean;
    paused: boolean;
    rounds: string;
    members: Array<{
      alias: string;
      name: string;
      provider: string;
      host: string;
      execution: string;
      communicationEnabled: boolean;
      isYou: boolean;
    }>;
    collaboration: string;
  }>;
};

export type InboxView = {
  items: Array<{
    deliveryId: string;
    messageId: string;
    traceId: string;
    conversationId: string;
    from: string;
    receivedAt: string;
    content: string;
  }>;
  remaining: number;
};

export type SendView = {
  message: { id: string; traceId: string };
  deliveries: Array<{ recipientSessionId: string; state: string; reason?: string }>;
};
