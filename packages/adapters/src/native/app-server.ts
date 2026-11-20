import { spawn, type ChildProcess } from "node:child_process";
import { lastLine } from "./transcript-adapter.js";

export type AppServerMessage = { method: string; params: any };
/** A request the server sends us (an approval, a question); the reply is its JSON-RPC result. */
export type AppServerRequest = AppServerMessage & { id: number | string };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string };

/**
 * One `codex app-server` process speaking newline-delimited JSON-RPC on stdio: requests we send,
 * notifications it streams, and requests it sends back (approvals) that we answer.
 */
export class AppServerConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffered = "";
  private stderr = "";
  private closedWith: Error | undefined;
  readonly closed: Promise<Error>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly handlers: {
      notification?: (message: AppServerMessage) => void;
      request?: (message: AppServerRequest) => Promise<unknown>;
    },
  ) {
    child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr!.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000)));
    child.stdin!.on("error", () => {
      // the server exited mid-write; reported through `close`
    });
    this.closed = new Promise((resolve) => {
      const close = (error: Error) => {
        if (this.closedWith) return;
        this.closedWith = error;
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        resolve(error);
      };
      child.on("error", close);
      child.on("close", (code) => close(new Error(lastLine(this.stderr) || `codex app-server exited with ${code}`)));
    });
  }

  /** Start the server in `cwd` and complete the initialize handshake. */
  static async open(
    binary: string,
    options: {
      cwd?: string;
      onNotification?: (message: AppServerMessage) => void;
      onRequest?: (message: AppServerRequest) => Promise<unknown>;
      timeoutMs?: number;
    } = {},
  ): Promise<AppServerConnection> {
    const child = spawn(binary, ["app-server"], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const connection = new AppServerConnection(child, { notification: options.onNotification, request: options.onRequest });
    try {
      await connection.request(
        "initialize",
        { clientInfo: { name: "portage", title: "Portage", version: "1.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } },
        options.timeoutMs ?? 30_000,
      );
      connection.notify("initialized");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get pid() {
    return this.child.pid;
  }

  get isClosed() {
    return this.closedWith !== undefined;
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server: ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  close() {
    this.child.stdin?.end();
    if (!this.closedWith) this.child.kill();
  }

  private write(message: unknown) {
    if (!this.closedWith) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer) {
    this.buffered += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffered.indexOf("\n")) >= 0) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method && message.id !== undefined) void this.answer(message as AppServerRequest);
      else if (message.method) this.handlers.notification?.(message as AppServerMessage);
      else if (typeof message.id === "number") this.settle(message);
    }
  }

  private settle(message: Record<string, any>) {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? `${waiter.method} failed`));
    else waiter.resolve(message.result);
  }

  private async answer(request: AppServerRequest) {
    if (!this.handlers.request) return this.write({ id: request.id, error: { code: -32601, message: `unsupported: ${request.method}` } });
    try {
      this.write({ id: request.id, result: await this.handlers.request(request) });
    } catch (error) {
      this.write({ id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

/** One request to a short-lived app server. */
export async function appServerCall<T = unknown>(binary: string, method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
  const connection = await AppServerConnection.open(binary, { timeoutMs });
  try {
    return await connection.request<T>(method, params, timeoutMs);
  } finally {
    connection.close();
  }
}
