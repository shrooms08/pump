"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import type { VersionedTransaction } from "@solana/web3.js";
import { LEVERAGE_X, type TradeSide } from "@pump/shared";
import { Game } from "../components/Game";
import { Terminal } from "../components/terminal/Terminal";
import type { ClosedResult } from "../components/terminal/PositionsPanel";
import { RidePrompt } from "../components/terminal/RidePrompt";
import { RideTransition } from "../components/terminal/RideTransition";
import { ConfirmRealModal } from "../components/confirm-real-modal";
import { openPosition, registerRun, authorizeSession, tradeLiquidationPrice, computePnl, type Position, type StakeToken } from "../lib/position";
import { lastPrice } from "../lib/price-feed";
import {
  openReal,
  closeReal,
  assertWithinCaps,
  checkBasketReady,
  REAL_MAX_LEVERAGE,
  REAL_MAX_NOTIONAL_USD,
  type RealPositionHandle,
  type BasketStatus,
} from "../lib/flash-real";

type Screen =
  | { kind: "terminal"; error?: string }
  | { kind: "opening" }
  | { kind: "playing"; position: Position };

type Confirm =
  | null
  | { kind: "open"; busy: boolean; error?: string | null }
  | { kind: "close"; handle: RealPositionHandle; busy: boolean; error?: string | null };

export default function Page() {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [screen, setScreen] = useState<Screen>({ kind: "terminal" });

  // the one open position (lives in the terminal; closed from the panel, A2)
  const [position, setPosition] = useState<Position | null>(null);
  const [closed, setClosed] = useState<ClosedResult | null>(null);

  // A3 "ride the chart" — the confirm prompt, then the zoom transition.
  const [ridePrompt, setRidePrompt] = useState<{ from: DOMRect } | null>(null);
  const [ride, setRide] = useState<{ from: DOMRect; position: Position } | null>(null);

  // Bumped when the player returns from a run, to refresh the leaderboard promptly.
  const [leaderboardKey, setLeaderboardKey] = useState(0);

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
      const owner = publicKey?.toBase58();
      const { position: pos, session } = await openPosition({ side, stake, stakeToken, leverage }, owner);
      setClosed(null);
      setPosition(pos);
      setScreen({ kind: "terminal" });
      // One wallet signature authorizes the run's session key (player attribution).
      // Best-effort: failure leaves the run on the server-signed fallback.
      if (session && owner && signTransaction) {
        void authorizeSession(pos.runId, session, signTransaction, connection);
      }
    } catch (e) {
      setScreen({ kind: "terminal", error: `Couldn't open position: ${(e as Error).message}. Is the game server running?` });
    }
  }, [side, stake, stakeToken, leverage, publicKey, signTransaction, connection]);

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
      const run = await registerRun(side, result.entryPrice, publicKey.toBase58());
      const pos: Position = {
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
      setClosed(null);
      setPosition(pos);
      setConfirm(null);
      setScreen({ kind: "terminal" });
      // Authorize the run's session key (one signature) for player attribution.
      if (run.session && signTransaction) {
        void authorizeSession(run.runId, run.session, signTransaction, connection);
      }
    } catch (e) {
      setConfirm({ kind: "open", busy: false, error: (e as Error).message });
    }
  }, [publicKey, signTransaction, side, stake, leverage, connection]);

  // ── close from the panel (independent of the game) ────────────────────────
  // Simulated: realize PnL at the live mark instantly. Real: route through the
  // SAME confirm modal + caps (no real tx without it).
  const onClosePosition = useCallback(() => {
    if (!position) return;
    if (position.real && position.owner) {
      setConfirm({ kind: "close", handle: { market: "SOL", side: position.side, owner: position.owner }, busy: false });
      return;
    }
    const mark = lastPrice()?.price ?? position.entryPrice;
    const pnl = computePnl(position, mark);
    setClosed({ side: position.side, entry: position.entryPrice, exit: mark, pnlPct: pnl.pct, pnlUsd: pnl.usd, real: false });
    setPosition(null);
  }, [position]);

  // ── A3: ride the chart ────────────────────────────────────────────────────
  // Chart-click → confirm prompt (nudges to open one if none). The panel button
  // and the prompt's confirm both start the zoom transition, growing the game
  // out of the chart's rect. The transition's completion launches gameplay.
  const onRideChart = useCallback((from: DOMRect) => {
    if (screen.kind !== "terminal" || confirm || ride) return;
    setRidePrompt({ from });
  }, [screen.kind, confirm, ride]);

  const onRideStart = useCallback((from: DOMRect) => {
    if (position) {
      setRidePrompt(null);
      setRide({ from, position });
    }
  }, [position]);

  const confirmRide = useCallback(() => {
    if (ridePrompt && position) {
      setRide({ from: ridePrompt.from, position });
      setRidePrompt(null);
    }
  }, [ridePrompt, position]);

  const onRideComplete = useCallback(() => {
    setRide((r) => {
      if (r) setScreen({ kind: "playing", position: r.position });
      return null;
    });
  }, []);

  const confirmRealClose = useCallback(async () => {
    if (confirm?.kind !== "close" || !signTransaction || !position) return;
    setConfirm({ ...confirm, busy: true });
    try {
      const sig = await closeReal(confirm.handle, signTransaction as (tx: VersionedTransaction) => Promise<VersionedTransaction>);
      const mark = lastPrice()?.price ?? position.entryPrice;
      const pnl = computePnl(position, mark);
      setClosed({ side: position.side, entry: position.entryPrice, exit: mark, pnlPct: pnl.pct, pnlUsd: pnl.usd, real: true, sig });
      setPosition(null);
      setConfirm(null);
    } catch (e) {
      setConfirm({ ...confirm, busy: false, error: (e as Error).message });
    }
  }, [confirm, signTransaction, position]);

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
        collateralUsd={position?.stake ?? stake}
        leverage={position?.leverage ?? leverage}
        busy={confirm.busy}
        error={confirm.error}
        onConfirm={confirmRealClose}
        onCancel={() => setConfirm(null)}
      />
    ) : null;

  if (screen.kind === "playing") {
    return (
      <main className="wrap game-enter">
        <Game
          position={screen.position}
          onExit={() => {
            setScreen({ kind: "terminal" });
            setLeaderboardKey((k) => k + 1); // your run just finalized — refresh the board
          }}
        />
        {modal}
      </main>
    );
  }

  return (
    <main className={`terminal-wrap ${ride ? "riding" : ""}`}>
      <Terminal
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
        error={screen.kind === "terminal" ? screen.error : undefined}
        position={position}
        closed={closed}
        closing={confirm?.kind === "close" && confirm.busy}
        onClosePosition={onClosePosition}
        onRideChart={onRideChart}
        onRideStart={onRideStart}
        onDismissClosed={() => setClosed(null)}
        wallet={publicKey?.toBase58() ?? null}
        leaderboardKey={leaderboardKey}
      />
      {ridePrompt && (
        <RidePrompt position={position} onConfirm={confirmRide} onCancel={() => setRidePrompt(null)} />
      )}
      {ride && <RideTransition from={ride.from} side={ride.position.side} onComplete={onRideComplete} />}
      {modal}
    </main>
  );
}
