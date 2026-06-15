// Trade entry: open a (simulated) FlashTrade SOL position and register the run
// it will be ridden as. No on-chain trade yet.
import type { CreateRunResponse, RunSessionAuth, TradeSide } from "@pump/shared";
import { Transaction, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { GAME_HTTP } from "./backend";

type SignTx = <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;

export type StakeToken = "USDC" | "SOL";

export interface Position {
  // run wiring
  runId: string;
  seed: string;
  wsUrl: string;
  // trade terms
  market: "SOL";
  side: TradeSide;
  leverage: number;
  stake: number;
  stakeToken: StakeToken;
  /** Fill price — simulated (live feed) or, in real mode, the on-chain entry. */
  entryPrice: number;
  /** Liquidation price (leverage-based). */
  liquidationPrice: number;
  /** true = a real Flash V2 mainnet position is open; false = devnet-simulated. */
  real: boolean;
  /** Owner wallet (base58) — present in real mode so the position can be closed. */
  owner?: string;
}

/** Real-position liquidation: the price that wipes the margin at this leverage. */
export function tradeLiquidationPrice(side: TradeSide, entry: number, leverage: number): number {
  const frac = 1 / leverage;
  return side === "long" ? entry * (1 - frac) : entry * (1 + frac);
}

export interface Pnl {
  pct: number; // PnL as % of margin
  usd: number; // PnL in USD
  marginUsd: number; // collateral value in USD
  notionalUsd: number; // position size in USD
  up: boolean;
}

/** Live (or realized) PnL of a position at a given mark price. Used by the
 *  positions panel (live) and the simulated close (realized). */
export function computePnl(position: Position, mark: number): Pnl {
  const ret = position.entryPrice > 0 ? (mark - position.entryPrice) / position.entryPrice : 0;
  const signed = position.side === "long" ? ret : -ret;
  const frac = signed * position.leverage; // PnL as fraction of margin
  const marginUsd = position.stakeToken === "USDC" ? position.stake : position.stake * position.entryPrice;
  return { pct: frac * 100, usd: marginUsd * frac, marginUsd, notionalUsd: marginUsd * position.leverage, up: frac >= 0 };
}

/** Live SOL price from the game server (same feed the bird rides). */
async function liveSolPrice(): Promise<number> {
  const res = await fetch(`${GAME_HTTP}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`game server ${res.status}`);
  const { price } = (await res.json()) as { price: number };
  if (!Number.isFinite(price) || price <= 0) throw new Error("no live price yet");
  return price;
}

export interface OpenParams {
  side: TradeSide;
  stake: number;
  stakeToken: StakeToken;
  leverage: number;
}

/** Register the run the position is ridden as (server locks the entry price).
 *  `owner` (the connected wallet) attributes the run on-chain via a session key. */
export async function registerRun(side: TradeSide, entryPrice: number, owner?: string): Promise<CreateRunResponse> {
  const res = await fetch(`${GAME_HTTP}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side, entryPrice, owner }),
  });
  if (!res.ok) throw new Error(`could not open run (${res.status})`);
  return (await res.json()) as CreateRunResponse;
}

/**
 * Open a SOL position and return the live position context plus any session-key
 * authorization the server prepared (Phase B1). `owner` is the connected wallet.
 *
 * TODO(6c): real FlashTrade devnet position — replace the simulated fill with
 * FlashV2Client.openPosition (collateral = stake, fixed leverage) on devnet and
 * use the actual fill price + on-chain position account here.
 */
export async function openPosition(
  p: OpenParams,
  owner?: string,
): Promise<{ position: Position; session?: RunSessionAuth | null }> {
  // Simulated fill at the live SOL price.
  const entryPrice = await liveSolPrice();

  // Register the run the position is ridden as (server locks this entry).
  const run = await registerRun(p.side, entryPrice, owner);

  return {
    position: {
      runId: run.runId,
      seed: run.seed,
      wsUrl: run.wsUrl,
      market: "SOL",
      side: p.side,
      leverage: p.leverage,
      stake: p.stake,
      stakeToken: p.stakeToken,
      entryPrice,
      liquidationPrice: tradeLiquidationPrice(p.side, entryPrice, p.leverage),
      real: false,
    },
    session: run.session,
  };
}

/**
 * Authorize the per-run session key (Phase B1): the player wallet signs the
 * server-prepared `createSessionV2` tx ONCE, we submit it to devnet, then tell
 * the server it's ready. Best-effort — any failure leaves the run on the
 * server-signed fallback rather than breaking it. Returns true on success.
 */
export async function authorizeSession(
  runId: string,
  session: RunSessionAuth,
  signTransaction: SignTx,
  connection: Connection,
): Promise<boolean> {
  try {
    const tx = Transaction.from(Buffer.from(session.txB64, "base64"));
    const signed = await signTransaction(tx); // ONE wallet prompt, blockhash untouched
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    const res = await fetch(`${GAME_HTTP}/runs/${encodeURIComponent(runId)}/session-ready`, { method: "POST" });
    const ok = res.ok && ((await res.json()) as { ready?: boolean }).ready === true;
    if (!ok) console.warn("[session] server did not confirm ready — run will fall back to server-signed");
    return ok;
  } catch (e) {
    console.warn("[session] authorize failed — falling back to server-signed:", (e as Error).message);
    return false;
  }
}
