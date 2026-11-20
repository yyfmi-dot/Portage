import type { AdapterCapabilityFlags, Delivery, HoldReason, Message, NativeEvent, Session } from "./types.js";

/**
 * Pluggable edge for a native host family.
 * Core never branches on vendor names; it reads capabilities.
 */
export type InjectResult =
  | { ok: true; proof: "written" | "submitted"; nativeMessageId?: string }
  | { ok: false; error: string; retryable?: boolean; uncertain?: boolean };

/**
 * Read-back of one submission whose outcome is unknown.
 * `present`: the native side holds exactly this compiled query. `absent`: provably not submitted,
 * safe to retry. `unknown`: cannot tell yet — keep the delivery uncertain.
 */
export type VerifyResult =
  | { status: "present"; nativeMessageId?: string }
  | { status: "absent" }
  | { status: "unknown"; error?: string };

/**
 * Whether the native side can take input right now. `busy` keeps the delivery queued in order;
 * any other reason holds it until a later check passes.
 */
export type Readiness = { ready: true } | { ready: false; reason: HoldReason; detail?: string };

/** A transcript record as the adapter read it, before the bus correlates and stores it. */
export type NativeObservation = Pick<NativeEvent, "nativeEventId" | "nativeTime" | "kind" | "text">;

export type NativeReadResult = {
  observations: NativeObservation[];
  cursor: number;
  source: string;
  /** The session's own current title (renamed in its app or by its CLI), when the adapter can read it. */
  title?: string;
};

export type DiscoveredEndpoint = {
  suggestedSessionKey: string;
  provider: string;
  harness: string;
  host: string;
  nativeSessionId: string;
  displayName: string;
  capabilities: AdapterCapabilityFlags;
  /** Adapter that can submit to this endpoint; absent means the file inbox. */
  adapterId?: string;
  workdir?: string;
  updatedAt?: string;
  /** A live interactive process currently owns the native session. */
  attached?: boolean;
};

export interface SessionAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilityFlags;

  discover(): Promise<DiscoveredEndpoint[]>;

  readiness?(session: Session): Promise<Readiness>;

  inject?(session: Session, message: Message, compiledQuery: string, delivery: Delivery): Promise<InjectResult>;

  verify?(session: Session, message: Message, compiledContextHash: string): Promise<VerifyResult>;

  /** Read native transcript records after `cursor` (0 = adapter decides how much history to import). */
  readNative?(session: Session, cursor: number): Promise<NativeReadResult>;

  /** Give the native session this title, the way its own app or CLI renames it. */
  rename?(session: Session, title: string): Promise<void>;
}
