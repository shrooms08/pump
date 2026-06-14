/**
 * Wire-protocol types (PUMP_ARCHITECTURE.md §4), shared by client and server so
 * both ends agree on the exact message shapes.
 *
 * WIRE RULE (§4, CLAUDE.md #1): a `tap` carries only intent (`seq`) — never a
 * score. All scoring is computed server-side. There is deliberately no field on
 * any client→server message that could let the client assert an outcome.
 */

// ── Shared enums / scalars ─────────────────────────────────────────────────

export type TradeSide = "long" | "short";

export type RunStatus = "pending" | "active" | "dead" | "settled" | "void";

/** Kinds of scoring event the server can announce. */
export type EventKind = "coin" | "hazard" | "nearmiss";

/** Opaque run identifier (UUID string from Postgres). */
export type RunId = string;

// ── WebSocket: client → server ─────────────────────────────────────────────

/** First message on the socket: bind this connection to a run. */
export interface JoinMessage {
  t: "join";
  runId: RunId;
  sessionKeyPubkey: string;
}

/** A flap/dodge input. `seq` is a monotonic client input counter (intent only). */
export interface TapMessage {
  t: "tap";
  seq: number;
}

/** Voluntary exit at the current PnL. */
export interface CashoutMessage {
  t: "cashout";
}

export type ClientMessage = JoinMessage | TapMessage | CashoutMessage;

// ── WebSocket: server → client ─────────────────────────────────────────────

/** ~20–30 Hz altitude update derived from the live price. */
export interface TickMessage {
  t: "tick";
  /** Live underlying price. */
  price: number;
  /** Authoritative bird altitude (up-positive; FLOOR = liquidation). */
  birdY: number;
  /** Unrealized PnL in basis points of stake. */
  pnlBps: number;
  /**
   * Authoritative world-scroll position. The client draws hazards/coins from
   * the shared RNG at this scroll so its render stays pixel-aligned with where
   * the server detects collisions. Still intent-only — carries no score.
   */
  scrollX: number;
}

/** A scoring event occurred (coin grabbed, hazard hit, near miss). */
export interface EventMessage {
  t: "event";
  kind: EventKind;
  score: number;
  multiplierBps: number;
}

/** Authoritative snapshot the client reconciles its prediction against. */
export interface StateMessage {
  t: "state";
  score: number;
  multiplierBps: number;
  lives: number;
}

/** The run ended; settlement is now in flight. */
export interface DeadMessage {
  t: "dead";
  finalScore: number;
  /** Realized PnL from closing the FlashTrade position (signed lamports). */
  realizedPnl: number;
  settle: "pending";
}

/** Settlement finished; payout has been paid from the escrow pot. */
export interface SettledMessage {
  t: "settled";
  payoutLamports: number;
  txSig: string;
}

export type ServerMessage =
  | TickMessage
  | EventMessage
  | StateMessage
  | DeadMessage
  | SettledMessage;

// ── REST DTOs (§4) ─────────────────────────────────────────────────────────

/** POST /api/runs request body. */
export interface CreateRunRequest {
  wallet: string;
  side: TradeSide;
  stakeLamports: number;
}

/** POST /api/runs 200 response. Note `seed` is a decimal string (u64). */
export interface CreateRunResponse {
  runId: RunId;
  seed: string;
  wsUrl: string;
  pool: string;
}

/** GET /api/runs/:id response. */
export interface RunStateResponse {
  id: RunId;
  status: RunStatus;
  score: number;
  multiplierBps: number;
  positionPubkey: string | null;
  payoutLamports: number | null;
}

/** A single leaderboard row. */
export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  handle: string | null;
  score: number;
  payoutLamports: number;
}

/** GET /api/leaderboard response. */
export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

/** GET /api/users/:wallet response. */
export interface UserResponse {
  wallet: string;
  handle: string | null;
  runs: RunStateResponse[];
  best: RunStateResponse | null;
}
