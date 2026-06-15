"use client";

import type { TradeSide } from "@pump/shared";
import { REAL_MAX_LEVERAGE, REAL_MAX_NOTIONAL_USD, BASKET_HINT, type BasketStatus } from "../../lib/flash-real";
import type { StakeToken } from "../../lib/position";
import { SketchFrame, SketchButton } from "./sketch";

/**
 * Open-position controls, relocated from the old home-screen card into the
 * terminal's right panel. Logic, caps, real-mode toggle, basket preflight and
 * the open handler are unchanged — this is presentational only (same props).
 */
export function TradePanel(props: {
  connected: boolean;
  opening: boolean;
  hasPosition: boolean;
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
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const maxLev = props.realMode ? REAL_MAX_LEVERAGE : 50;
  const notional = props.stake * props.leverage;
  const overCap = props.realMode && (notional > REAL_MAX_NOTIONAL_USD + 1e-9 || props.leverage > REAL_MAX_LEVERAGE);
  const noBasket = props.realMode && props.basket === "no-basket";

  const openFrame = props.realMode ? "down" : props.side === "long" ? "up" : "down";

  return (
    <section className="trade-panel">
      <SketchFrame variant="card" />
      <div className="panel-title">Open a position</div>

      {/* mode toggle — real mode is OPT-IN, off by default */}
      <label className="real-toggle">
        <SketchFrame variant="outline" />
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
        <SketchButton
          frame={props.side === "long" ? "up" : "outline"}
          className={`seg-sketch ${props.side === "long" ? "tone-up" : ""}`}
          onClick={() => props.setSide("long")}
        >
          LONG ▲
        </SketchButton>
        <SketchButton
          frame={props.side === "short" ? "down" : "outline"}
          className={`seg-sketch ${props.side === "short" ? "tone-down" : ""}`}
          onClick={() => props.setSide("short")}
        >
          SHORT ▼
        </SketchButton>
      </div>

      {/* stake */}
      <label className="field">
        <span className="label">Stake</span>
        <div className="stake-row">
          <span className="sketch-input">
            <SketchFrame variant="input" />
            <input
              type="number"
              min={1}
              step={1}
              value={props.stake}
              onChange={(e) => props.setStake(Math.max(0, Number(e.target.value)))}
            />
          </span>
          <div className="seg small">
            <SketchButton
              frame={props.stakeToken === "USDC" ? "ghost" : "outline"}
              className="seg-sketch"
              onClick={() => props.setStakeToken("USDC")}
            >
              USDC
            </SketchButton>
            <SketchButton
              frame={props.stakeToken === "SOL" ? "ghost" : "outline"}
              className="seg-sketch"
              disabled={props.realMode}
              onClick={() => !props.realMode && props.setStakeToken("SOL")}
            >
              SOL
            </SketchButton>
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

      <SketchButton
        frame={openFrame}
        className={`open-sketch ${openFrame === "up" ? "tone-up" : "tone-down"}`}
        disabled={!props.connected || props.opening || props.stake <= 0 || overCap || noBasket || props.hasPosition}
        onClick={props.onOpen}
      >
        {props.opening
          ? "Opening…"
          : props.hasPosition
            ? "Position open — close it first"
            : !props.connected
              ? "Connect wallet to open"
              : props.realMode
                ? `Open REAL ${props.side === "long" ? "LONG ▲" : "SHORT ▼"} · mainnet`
                : `Open ${props.side === "long" ? "LONG ▲" : "SHORT ▼"} position`}
      </SketchButton>
      <p className="hint">
        {props.realMode
          ? "Real mode opens an actual Flash V2 mainnet position — you'll confirm before signing."
          : "Devnet-simulated. You'll ride the position as the bird — its altitude is your live PnL."}
      </p>
    </section>
  );
}
