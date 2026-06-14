"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { VersionedTransaction } from "@solana/web3.js";
import { LEVERAGE_X, type TradeSide } from "@pump/shared";
import { Game } from "../components/Game";
import { WalletBar } from "../components/wallet-bar";
import { ConfirmRealModal } from "../components/confirm-real-modal";
import { openPosition, registerRun, tradeLiquidationPrice, type Position, type StakeToken } from "../lib/position";
import {
  openReal,
  closeReal,
  assertWithinCaps,
  checkBasketReady,
  BASKET_HINT,
  REAL_MAX_LEVERAGE,
  REAL_MAX_NOTIONAL_USD,
  type RealPositionHandle,
  type BasketStatus,
} from "../lib/flash-real";

const GAME_HTTP = process.env.NEXT_PUBLIC_GAME_HTTP || "http://localhost:8787";

type Screen =
  | { kind: "form"; error?: string }
  | { kind: "opening" }
  | { kind: "context"; position: Position }
  | { kind: "playing"; position: Position };

type Confirm =
  | null
  | { kind: "open"; busy: boolean; error?: string | null }
  | { kind: "close"; handle: RealPositionHandle; busy: boolean; error?: string | null };

export default function Page() {
  const { connected, publicKey, signTransaction } = useWallet();
  const [screen, setScreen] = useState<Screen>({ kind: "form" });

  // trade form state
  const [realMode, setRealMode] = useState(false); // OFF by default — devnet simulated
  const [side, setSide] = useState<TradeSide>("long");
  const [stake, setStake] = useState<number>(100);
  const [stakeToken, setStakeToken] = useState<StakeToken>("USDC");
  const [leverage, setLeverage] = useState<number>(LEVERAGE_X);

  // real-money confirmation gate (no real tx happens without going through this)
  const [confirm, setConfirm] = useState<Confirm>(null);

  // preflight: does this wallet have a Flash V2 basket? (existence read only)
  const [basket, setBasket] = useState<BasketStatus | "checking" | "idle">("idle");
  useEffect(() => {
    if (!realMode || !publicKey) {
      setBasket("idle");
      return;
    }
    let dead = false;
    setBasket("checking");
    void checkBasketReady(publicKey.toBase58()).then((s) => {
      if (!dead) setBasket(s);
    });
    return () => {
      dead = true;
    };
  }, [realMode, publicKey]);

  // Turning real mode ON clamps inputs into the hard caps (USDC collateral,
  // ≤ REAL_MAX_LEVERAGE, notional ≤ $REAL_MAX_NOTIONAL_USD).
  const enableReal = useCallback((on: boolean) => {
    setRealMode(on);
    if (on) {
      setStakeToken("USDC");
      setLeverage((l) => Math.min(l, REAL_MAX_LEVERAGE));
      setStake((s) => Math.min(s, REAL_MAX_NOTIONAL_USD / Math.min(leverage, REAL_MAX_LEVERAGE)));
    }
  }, [leverage]);

  // ── simulated open (default, devnet) ──────────────────────────────────────
  const openSimulated = useCallback(async () => {
    setScreen({ kind: "opening" });
    try {
      const position = await openPosition({ side, stake, stakeToken, leverage });
      setScreen({ kind: "context", position });
    } catch (e) {
      setScreen({ kind: "form", error: `Couldn't open position: ${(e as Error).message}. Is the game server running?` });
    }
  }, [side, stake, stakeToken, leverage]);

  // ── open button → simulated path, or open the REAL confirmation modal ─────
  const onOpen = useCallback(() => {
    if (realMode) setConfirm({ kind: "open", busy: false });
    else void openSimulated();
  }, [realMode, openSimulated]);

  // ── confirmed real open (only reachable via the modal) ────────────────────
  const confirmRealOpen = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      setConfirm({ kind: "open", busy: false, error: "Wallet not ready" });
      return;
    }
    setConfirm({ kind: "open", busy: true });
    try {
      assertWithinCaps(stake, leverage); // hard cap check (again) before signing
      const { result, handle } = await openReal({
        side,
        collateralUsd: stake,
        leverage,
        owner: publicKey.toBase58(),
        signTransaction: signTransaction as (tx: VersionedTransaction) => Promise<VersionedTransaction>,
      });
      const run = await registerRun(side, result.entryPrice);
      const position: Position = {
        runId: run.runId,
        seed: run.seed,
        wsUrl: run.wsUrl,
        market: "SOL",
        side,
        leverage,
        stake,
        stakeToken: "USDC",
        entryPrice: result.entryPrice,
        liquidationPrice: result.liquidationPrice || tradeLiquidationPrice(side, result.entryPrice, leverage),
        real: true,
        owner: handle.owner,
      };
      setConfirm(null);
      setScreen({ kind: "context", position });
    } catch (e) {
      setConfirm({ kind: "open", busy: false, error: (e as Error).message });
    }
  }, [publicKey, signTransaction, side, stake, leverage]);

  // ── run end → close the real position (also gated by a confirm modal) ─────
  const onRunEnd = useCallback((position: Position) => {
    if (position.real && position.owner) {
      setConfirm({ kind: "close", handle: { market: "SOL", side: position.side, owner: position.owner }, busy: false });
    }
  }, []);

  const confirmRealClose = useCallback(async () => {
    if (confirm?.kind !== "close" || !signTransaction) return;
    setConfirm({ ...confirm, busy: true });
    try {
      await closeReal(confirm.handle, signTransaction as (tx: VersionedTransaction) => Promise<VersionedTransaction>);
      setConfirm(null);
    } catch (e) {
      setConfirm({ ...confirm, busy: false, error: (e as Error).message });
    }
  }, [confirm, signTransaction]);

  const modal =
    confirm?.kind === "open" ? (
      <ConfirmRealModal
        kind="open"
        side={side}
        collateralUsd={stake}
        leverage={leverage}
        busy={confirm.busy}
        error={confirm.error}
        onConfirm={confirmRealOpen}
        onCancel={() => setConfirm(null)}
      />
    ) : confirm?.kind === "close" ? (
      <ConfirmRealModal
        kind="close"
        side={confirm.handle.side}
        collateralUsd={stake}
        leverage={leverage}
        busy={confirm.busy}
        error={confirm.error}
        onConfirm={confirmRealClose}
        onCancel={() => setConfirm(null)}
      />
    ) : null;

  if (screen.kind === "playing") {
    return (
      <main className="wrap">
        <Game
          position={screen.position}
          onExit={() => setScreen({ kind: "form" })}
          onRunEnd={() => onRunEnd(screen.position)}
        />
        {modal}
      </main>
    );
  }

  if (screen.kind === "context") {
    return (
      <main className="wrap">
        <PositionContext position={screen.position} onRide={() => setScreen({ kind: "playing", position: screen.position })} />
        {modal}
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="topbar">
        <div className="title">
          <span className="pump">PUMP</span> ▲
        </div>
        <WalletBar />
      </header>

      <OpenForm
        connected={connected}
        opening={screen.kind === "opening"}
        realMode={realMode}
        setRealMode={enableReal}
        basket={basket}
        side={side}
        setSide={setSide}
        stake={stake}
        setStake={setStake}
        stakeToken={stakeToken}
        setStakeToken={setStakeToken}
        leverage={leverage}
        setLeverage={setLeverage}
        onOpen={onOpen}
        error={screen.kind === "form" ? screen.error : undefined}
      />
      {modal}
    </main>
  );
}

// ── live SOL price (server's feed) for the form header ──────────────────────
function useLivePrice(): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const res = await fetch(`${GAME_HTTP}/health`, { cache: "no-store" });
        const { price: p } = (await res.json()) as { price: number };
        if (!dead && Number.isFinite(p) && p > 0) setPrice(p);
      } catch {
        /* keep last */
      }
    };
    void load();
    const id = setInterval(load, 1500);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);
  return price;
}

// ── the "open a position" surface ───────────────────────────────────────────
function OpenForm(props: {
  connected: boolean;
  opening: boolean;
  realMode: boolean;
  setRealMode: (on: boolean) => void;
  basket: BasketStatus | "checking" | "idle";
  side: TradeSide;
  setSide: (s: TradeSide) => void;
  stake: number;
  setStake: (n: number) => void;
  stakeToken: StakeToken;
  setStakeToken: (t: StakeToken) => void;
  leverage: number;
  setLeverage: (n: number) => void;
  onOpen: () => void;
  error?: string;
}) {
  const price = useLivePrice();
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const maxLev = props.realMode ? REAL_MAX_LEVERAGE : 50;
  const notional = props.stake * props.leverage;
  const overCap = props.realMode && (notional > REAL_MAX_NOTIONAL_USD + 1e-9 || props.leverage > REAL_MAX_LEVERAGE);
  const noBasket = props.realMode && props.basket === "no-basket";
  const network = props.realMode ? "mainnet · REAL" : "devnet · simulated";

  return (
    <section className="trade-card">
      <div className="trade-head">
        <div>
          <div className="label">Open a position</div>
          <div className="market">SOL <span className="muted">/ USDC · {network}</span></div>
        </div>
        <div className="mark">
          <div className="label">Mark</div>
          <div className="value">{price ? `$${fmt(price)}` : "—"}</div>
        </div>
      </div>

      {/* mode toggle — real mode is OPT-IN, off by default */}
      <label className="real-toggle">
        <input type="checkbox" checked={props.realMode} onChange={(e) => props.setRealMode(e.target.checked)} />
        <span>
          Real mode <span className="muted">— one real SOL perp on Flash V2 mainnet (real funds, ${REAL_MAX_NOTIONAL_USD} max, {REAL_MAX_LEVERAGE}× max)</span>
        </span>
      </label>

      {/* basket preflight — tell the user before they try */}
      {props.realMode && props.connected && (
        <p className={`hint ${props.basket === "ready" ? "pnl-up" : props.basket === "no-basket" ? "pnl-down" : ""}`}>
          {props.basket === "checking" && "Checking FlashTrade basket…"}
          {props.basket === "ready" && "✓ FlashTrade basket detected on this wallet."}
          {props.basket === "no-basket" && BASKET_HINT}
          {props.basket === "unknown" && "Couldn't check the basket — you can still try; open will report if it's not set up."}
        </p>
      )}

      {/* side */}
      <div className="seg">
        <button className={`seg-btn long ${props.side === "long" ? "on" : ""}`} onClick={() => props.setSide("long")}>
          LONG ▲
        </button>
        <button className={`seg-btn short ${props.side === "short" ? "on" : ""}`} onClick={() => props.setSide("short")}>
          SHORT ▼
        </button>
      </div>

      {/* stake */}
      <label className="field">
        <span className="label">Stake</span>
        <div className="stake-row">
          <input
            type="number"
            min={1}
            step={1}
            value={props.stake}
            onChange={(e) => props.setStake(Math.max(0, Number(e.target.value)))}
          />
          <div className="seg small">
            <button className={`seg-btn ${props.stakeToken === "USDC" ? "on" : ""}`} onClick={() => props.setStakeToken("USDC")}>
              USDC
            </button>
            <button
              className={`seg-btn ${props.stakeToken === "SOL" ? "on" : ""}`}
              disabled={props.realMode}
              onClick={() => !props.realMode && props.setStakeToken("SOL")}
            >
              SOL
            </button>
          </div>
        </div>
      </label>

      {/* leverage */}
      <label className="field">
        <span className="label">
          Leverage <b className="mult">{props.leverage.toFixed(0)}×</b>
          {props.realMode && <span className="muted"> · {REAL_MAX_LEVERAGE}× max in real mode</span>}
        </span>
        <input
          type="range"
          min={1}
          max={maxLev}
          step={1}
          value={Math.min(props.leverage, maxLev)}
          onChange={(e) => props.setLeverage(Math.min(Number(e.target.value), maxLev))}
        />
      </label>

      {props.realMode && (
        <div className="ctx-row">
          <span>Notional</span>
          <b className={overCap ? "pnl-down" : undefined}>${fmt(notional)}</b>
        </div>
      )}

      {props.error && <p className="hint pnl-down">{props.error}</p>}
      {overCap && <p className="hint pnl-down">Over the ${REAL_MAX_NOTIONAL_USD} / {REAL_MAX_LEVERAGE}× real-mode cap — lower stake or leverage.</p>}

      <button
        className={`btn open ${props.side} ${props.realMode ? "real" : ""}`}
        disabled={!props.connected || props.opening || props.stake <= 0 || overCap || noBasket}
        onClick={props.onOpen}
      >
        {props.opening
          ? "Opening…"
          : !props.connected
            ? "Connect wallet to open"
            : props.realMode
              ? `Open REAL ${props.side === "long" ? "LONG ▲" : "SHORT ▼"} · mainnet`
              : `Open ${props.side === "long" ? "LONG ▲" : "SHORT ▼"} position`}
      </button>
      <p className="hint">
        {props.realMode
          ? "Real mode opens an actual Flash V2 mainnet position — you'll confirm before signing."
          : "Devnet-simulated. You'll ride the position as the bird — its altitude is your live PnL."}
      </p>
    </section>
  );
}

// ── position context → ride ─────────────────────────────────────────────────
function PositionContext({ position, onRide }: { position: Position; onRide: () => void }) {
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isLong = position.side === "long";
  return (
    <section className="trade-card">
      <div className="trade-head">
        <div>
          <div className="label">Position opened</div>
          <div className="market">{position.market} <span className="muted">/ USDC · {position.real ? "mainnet · REAL" : "devnet · simulated"}</span></div>
        </div>
        <div className={`pos-tag ${isLong ? "long" : "short"}`}>
          {isLong ? "LONG ▲" : "SHORT ▼"} {position.leverage}×
        </div>
      </div>

      <div className="ctx-row"><span>Entry</span><b>${fmt(position.entryPrice)}</b></div>
      <div className="ctx-row"><span>Stake</span><b>{fmt(position.stake)} {position.stakeToken}</b></div>
      <div className="ctx-row"><span>Leverage</span><b>{position.leverage}×</b></div>
      <div className="ctx-row"><span>Liquidation</span><b className="pnl-down">${fmt(position.liquidationPrice)}</b></div>

      <p className={`hint ${position.real ? "pnl-down" : "sim"}`}>
        {position.real ? "REAL position open on Flash V2 mainnet — closes on run end." : "Simulated fill — no on-chain trade."}
      </p>
      <button className={`btn open ${position.side}`} onClick={onRide}>
        Ride it ▲
      </button>
    </section>
  );
}
