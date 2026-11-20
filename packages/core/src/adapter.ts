import type { AdapterCapabilityFlags, Delivery, HoldReason, Message, NativeEvent, Session } from "./types.js";

/**
 * Pluggable edge for a native host family.
 * Core never branches on vendor names; it reads capabilities.
 */
export type InjectResult =
  | { ok: true; proof: "written" | "submitted"; nativeMessageId?: string }
  | { ok: false; error: string; retryable?: boolean; uncertain?: boolean; hold?: HoldReason; detail?: string };

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

  /**
   * Start a brand-new native session in `workdir`, bound to the Portage session id it will be
   * registered under. Its first input arrives as an ordinary delivery.
   */
  createSession?(input: { workdir: string; sessionId: string; title?: string }): Promise<{ nativeSessionId: string; host: string }>;

  /** Answer an approval or question the native session is waiting on; false if it is no longer pending. */
  answer?(requestId: string, answer: ApprovalAnswer): boolean;
}

/** One step of a running turn, as the native host reports it. */
export type LiveStep = {
  id: string;
  kind: "command" | "edit" | "message" | "tool" | "search" | "plan" | "other";
  title: string;
  /** Output tail, diff or text, bounded. */
  detail?: string;
  status: "running" | "done" | "failed" | "declined";
  startedAt?: number;
  endedAt?: number;
};

/** What a session is doing in its current (or last) turn, streamed while it runs. Not persisted. */
export type LiveTurn = {
  sessionId: string;
  turnId: string;
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: number;
  endedAt?: number;
  steps: LiveStep[];
  /** The turn's aggregated diff across all file changes, bounded. */
  diff?: string;
  plan?: Array<{ step: string; status: string }>;
  error?: string;
};

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** Something a running turn needs the user to approve or answer before it continues. */
export type ApprovalRequest = {
  id: string;
  sessionId: string;
  kind: "command" | "fileChange" | "permissions" | "question";
  requestedAt: string;
  title: string;
  command?: string;
  cwd?: string;
  reason?: string;
  changes?: Array<{ path: string; kind: string; diff: string }>;
  questions?: Array<{ id: string; header: string; question: string; options: string[]; secret: boolean }>;
  decisions: ApprovalDecision[];
};

export type ApprovalAnswer = { decision: ApprovalDecision; answers?: Record<string, string[]> };
