// Trade entry: open a (simulated) FlashTrade SOL position and register the run
// it will be ridden as. No on-chain trade yet.
import type { CreateRunResponse, TradeSide } from "@pump/shared";

const GAME_HTTP = process.env.NEXT_PUBLIC_GAME_HTTP || "http://localhost:8787";

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

/** Register the run the position is ridden as (server locks the entry price). */
export async function registerRun(side: TradeSide, entryPrice: number): Promise<CreateRunResponse> {
  const res = await fetch(`${GAME_HTTP}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side, entryPrice }),
  });
  if (!res.ok) throw new Error(`could not open run (${res.status})`);
  return (await res.json()) as CreateRunResponse;
}

/**
 * Open a SOL position and return the live position context.
 *
 * TODO(6c): real FlashTrade devnet position — replace the simulated fill with
 * FlashV2Client.openPosition (collateral = stake, fixed leverage) on devnet and
 * use the actual fill price + on-chain position account here.
 */
export async function openPosition(p: OpenParams): Promise<Position> {
  // Simulated fill at the live SOL price.
  const entryPrice = await liveSolPrice();

  // Register the run the position is ridden as (server locks this entry).
  const res = await fetch(`${GAME_HTTP}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side: p.side, entryPrice }),
  });
  if (!res.ok) throw new Error(`could not open run (${res.status})`);
  const run = (await res.json()) as CreateRunResponse;

  return {
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
  };
}
