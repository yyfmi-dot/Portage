import type { AdapterCapabilityFlags, Endpoint, Message, Session } from "./types.js";

/**
 * Pluggable edge for a native host family.
 * Core never branches on vendor names; it reads capabilities.
 */
export type InjectResult =
  | { ok: true; proof: "written" | "submitted"; nativeMessageId?: string }
  | { ok: false; error: string; retryable?: boolean; uncertain?: boolean };

export type DiscoveredEndpoint = {
  suggestedSessionKey: string;
  provider: string;
  harness: string;
  host: string;
  nativeSessionId: string;
  displayName: string;
  capabilities: AdapterCapabilityFlags;
};

export interface SessionAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilityFlags;

  discover(): Promise<DiscoveredEndpoint[]>;

  inject?(
    session: Session,
    endpoint: Endpoint,
    message: Message,
    compiledQuery: string,
  ): Promise<InjectResult>;

  onReady?(
    session: Session,
    endpoint: Endpoint,
    cb: () => void,
  ): Promise<() => void> | (() => void);

  tail?(
    session: Session,
    endpoint: Endpoint,
    cb: (event: { nativeEventId: string; text: string; at: string }) => void,
  ): Promise<() => void> | (() => void);
}
