// ─────────────────────────────────────────────────────────────────────────────
// flash-real.ts — OPT-IN real-money mode. Opens/closes ONE real SOL perp on
// Flash V2 MAINNET, mirroring the cloned example's exact code path:
//   ../flashtrade-examples/examples-v2
//     • open:  components/app.tsx:217  flash.openPosition({...})         → /transaction-builder/open-position
//     • close: components/app.tsx:249  flash.closePosition({...})        → /transaction-builder/close-position
//     • sign+submit: packages/flash-v2/src/sign.ts  decode → sign → sendAndConfirm(network.erRpc, …, {skipPreflight:true})
//   request/response field names: packages/flash-v2/src/types.ts (Open/ClosePositionRequest)
//   network defaults:             packages/flash-v2/src/network.ts (MAINNET)
//
// SAFETY: caps are enforced HERE in code (not just the UI), before any tx is
// built or signed. Nothing auto-submits — callers gate every real tx behind the
// confirmation modal. RPC/API base come from env and are NEVER logged.
// ─────────────────────────────────────────────────────────────────────────────
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { TradeSide } from "@pump/shared";

// ── HARD CAPS (real mode only) — enforced in code ───────────────────────────
/** Max position notional in USD. Reject anything larger before signing. */
export const REAL_MAX_NOTIONAL_USD = 2;
/** Max leverage in real mode (the 10× game default does NOT apply here). */
export const REAL_MAX_LEVERAGE = 2;

// ── network (mainnet) — from env, public defaults from the example's MAINNET ──
// erRpc serves CORS and is called directly from the browser (per the example's
// .env.example). We only use the ER RPC for trading (open/close); the keyed
// base RPC is only for setup/withdrawal, which this module does not do.
const API_BASE = (process.env.NEXT_PUBLIC_FLASH_API_BASE || "https://flashapi.trade/v2").replace(/\/$/, "");
const ER_RPC = process.env.NEXT_PUBLIC_ER_RPC || "https://flash.magicblock.xyz";
const COLLATERAL = "USDC";
const MARKET = "SOL";

export type WalletSignTransaction = (tx: VersionedTransaction) => Promise<VersionedTransaction>;

/** Friendly guidance when the wallet has no set-up/funded Flash V2 basket. */
export const BASKET_HINT =
  "No funded FlashTrade basket on this wallet — set it up in the tap-trade example app first.";

/** Preflight basket state. "ready" = basket PDA exists; "no-basket" = not set up;
 *  "unknown" = the read failed (don't block — let open surface the real error). */
export type BasketStatus = "ready" | "no-basket" | "unknown";

/**
 * One clean read — GET /owner/{owner} → BasketSnapshot.basketPubkey — to tell
 * whether this wallet has a Flash V2 basket at all. Funding is NOT cleanly
 * readable (the example parses the deposit ledger over a keyed RPC; we don't
 * reproduce that), so funding is verified at open time via the API error.
 */
export async function checkBasketReady(owner: string): Promise<BasketStatus> {
  try {
    const res = await fetch(`${API_BASE}/owner/${encodeURIComponent(owner)}`, { cache: "no-store" });
    if (!res.ok) return "unknown";
    const snap = (await res.json()) as { basketPubkey?: string | null };
    return snap.basketPubkey ? "ready" : "no-basket";
  } catch {
    return "unknown";
  }
}

/** Map setup/funding-shaped failures to the friendly hint; pass others through clean. */
function friendlyOpenError(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  const m = msg.toLowerCase();
  if (
    m.includes("basket") ||
    m.includes("ledger") ||
    m.includes("deposit") ||
    m.includes("not found") ||
    m.includes("does not exist") ||
    m.includes("insufficient") ||
    m.includes("uninitialized") ||
    m.includes("notinitialized")
  ) {
    return new Error(BASKET_HINT);
  }
  return new Error(msg);
}

export interface OpenRealParams {
  side: TradeSide;
  /** USDC collateral (margin) in UI units. notional = collateralUsd × leverage. */
  collateralUsd: number;
  leverage: number;
  owner: string; // connected wallet pubkey (base58)
  signTransaction: WalletSignTransaction;
}

export interface RealOpenResult {
  signature: string;
  entryPrice: number;
  liquidationPrice: number;
}

export interface RealPositionHandle {
  market: "SOL";
  side: TradeSide;
  owner: string;
}

/**
 * Throws if the requested trade exceeds the hard caps. Call this everywhere a
 * real trade could originate — it is the code-level gate, independent of the UI.
 */
export function assertWithinCaps(collateralUsd: number, leverage: number): void {
  if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
    throw new Error("collateral must be > 0");
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error("leverage must be > 0");
  }
  if (leverage > REAL_MAX_LEVERAGE) {
    throw new Error(`real mode leverage capped at ${REAL_MAX_LEVERAGE}× (got ${leverage}×)`);
  }
  const notional = collateralUsd * leverage;
  if (notional > REAL_MAX_NOTIONAL_USD + 1e-9) {
    throw new Error(`real mode notional capped at $${REAL_MAX_NOTIONAL_USD} (got $${notional.toFixed(2)})`);
  }
}

// ── sign + submit (mirrors packages/flash-v2/src/sign.ts) ────────────────────
// We deserialize the API's PARTIALLY-SIGNED tx and add ONLY the owner signature
// — never touch the blockhash (that would invalidate the server's signatures) —
// then submit to the ER and poll for confirmation.
function decodeTransaction(transactionBase64: string): VersionedTransaction {
  const raw =
    typeof Buffer !== "undefined"
      ? Buffer.from(transactionBase64, "base64")
      : Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(raw);
}

async function sendAndConfirm(tx: VersionedTransaction, timeoutMs = 60_000): Promise<string> {
  const connection = new Connection(ER_RPC, "confirmed");
  const started = Date.now();
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  let polls = 0;
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status) {
      if (status.err) throw new Error(`on-chain error (${signature}): ${JSON.stringify(status.err)}`);
      const level = status.confirmationStatus;
      if (level === "confirmed" || level === "finalized") return signature;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`confirmation timeout (sent ${signature})`);
    polls += 1;
    await new Promise((r) => setTimeout(r, polls <= 10 ? 30 : 150));
  }
}

async function postBuilder(path: string, body: unknown): Promise<{ transactionBase64?: string; [k: string]: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Flash ${path} ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as { transactionBase64?: string };
}

/**
 * Open ONE real SOL perp. Caps are checked first; nothing is built or signed
 * until they pass. Mirrors app.tsx:217 (owner-signs variant — no session key).
 */
export async function openReal(p: OpenRealParams): Promise<{ result: RealOpenResult; handle: RealPositionHandle }> {
  assertWithinCaps(p.collateralUsd, p.leverage); // hard gate, in code

  // Fail fast (no wallet popup) if there's no basket at all.
  if ((await checkBasketReady(p.owner)) === "no-basket") throw new Error(BASKET_HINT);

  const tradeType = p.side === "long" ? "LONG" : "SHORT";
  try {
    const resp = await postBuilder("/transaction-builder/open-position", {
      inputTokenSymbol: COLLATERAL,
      outputTokenSymbol: MARKET,
      inputAmountUi: String(p.collateralUsd),
      leverage: p.leverage,
      tradeType,
      orderType: "MARKET",
      owner: p.owner,
      slippagePercentage: "0.5",
      // no signer/sessionToken → the OWNER signs (one wallet popup)
    });
    if (!resp.transactionBase64) throw new Error("open-position returned no transaction");

    const signed = await p.signTransaction(decodeTransaction(resp.transactionBase64));
    const signature = await sendAndConfirm(signed);

    return {
      result: {
        signature,
        entryPrice: Number(resp.newEntryPrice),
        liquidationPrice: Number(resp.newLiquidationPrice),
      },
      handle: { market: "SOL", side: p.side, owner: p.owner },
    };
  } catch (e) {
    throw friendlyOpenError(e); // unfunded/uninitialized basket → friendly hint
  }
}

/**
 * Close the real position fully (inputUsdUi "0" = full close). Mirrors
 * app.tsx:249. Used on run end (wipeout / cashout).
 */
export async function closeReal(handle: RealPositionHandle, signTransaction: WalletSignTransaction): Promise<string> {
  const resp = await postBuilder("/transaction-builder/close-position", {
    marketSymbol: handle.market,
    side: handle.side === "long" ? "LONG" : "SHORT",
    inputUsdUi: "0", // full close
    withdrawTokenSymbol: COLLATERAL,
    owner: handle.owner,
    slippagePercentage: "0.5",
  });
  if (!resp.transactionBase64) throw new Error("close-position returned no transaction");
  const signed = await signTransaction(decodeTransaction(resp.transactionBase64));
  return sendAndConfirm(signed);
}
