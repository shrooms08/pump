"use client";

import { useEffect, useState } from "react";
import { subscribePrice } from "../../lib/price-feed";
import { computePnl, type Position } from "../../lib/position";
import { SketchFrame, SketchButton } from "./sketch";

export interface ClosedResult {
  side: "long" | "short";
  entry: number;
  exit: number;
  pnlPct: number;
  pnlUsd: number;
  real: boolean;
  sig?: string;
}

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The positions panel: shows the one open position with LIVE PnL (driven by the
 * same price feed as the chart), plus Close (panel-only) and Ride. Closing is
 * independent of the game. Tidy empty state when nothing is open.
 */
export function PositionsPanel(props: {
  position: Position | null;
  closed: ClosedResult | null;
  closing: boolean; // a real close is in flight (modal busy)
  onClose: () => void;
  onRide: () => void;
  onDismissClosed: () => void;
}) {
  const [mark, setMark] = useState<number | null>(null);
  useEffect(() => subscribePrice((t) => setMark(t.price)), []);

  const { position, closed } = props;

  // Closed summary (after a close, until dismissed / next open).
  if (!position && closed) {
    const up = closed.pnlUsd >= 0;
    return (
      <section className="positions-panel">
        <SketchFrame variant="card" />
        <div className="panel-title">Position closed</div>
        <div className={`pos-tag ${closed.side === "long" ? "long" : "short"}`}>
          {closed.side === "long" ? "LONG ▲" : "SHORT ▼"} · {closed.real ? "mainnet · REAL" : "devnet · sim"}
        </div>
        <div className="ctx-row"><span>Entry</span><b>${fmt(closed.entry)}</b></div>
        <div className="ctx-row"><span>Exit</span><b>${fmt(closed.exit)}</b></div>
        <div className="ctx-row">
          <span>Realized PnL</span>
          <b className={up ? "pnl-up" : "pnl-down"}>
            {up ? "+" : "−"}${fmt(Math.abs(closed.pnlUsd))} ({closed.pnlPct >= 0 ? "+" : ""}{closed.pnlPct.toFixed(2)}%)
          </b>
        </div>
        {closed.real && closed.sig && (
          <div className="ctx-row"><span>Tx</span><b className="muted">{closed.sig.slice(0, 8)}…</b></div>
        )}
        <SketchButton frame="ghost" onClick={props.onDismissClosed}>Done</SketchButton>
      </section>
    );
  }

  // Empty state.
  if (!position) {
    return (
      <section className="positions-panel empty">
        <SketchFrame variant="card" />
        <div className="panel-title">Positions</div>
        <p className="pos-empty">No open position.<br />Open one above to start.</p>
      </section>
    );
  }

  // Open position with live PnL.
  const isLong = position.side === "long";
  const markPrice = mark ?? position.entryPrice;
  const pnl = computePnl(position, markPrice);

  return (
    <section className="positions-panel">
      <SketchFrame variant="card" />
      <div className="positions-head">
        <div className="panel-title">Position</div>
        <div className={`pos-tag ${isLong ? "long" : "short"}`}>
          {isLong ? "LONG ▲" : "SHORT ▼"} {position.leverage}× · {position.real ? "REAL" : "sim"}
        </div>
      </div>

      <div className="pos-pnl-big">
        <span className={pnl.up ? "pnl-up" : "pnl-down"}>
          {pnl.up ? "+" : "−"}${fmt(Math.abs(pnl.usd))}
        </span>
        <span className={`pos-pnl-pct ${pnl.up ? "pnl-up" : "pnl-down"}`}>
          {pnl.pct >= 0 ? "+" : ""}{pnl.pct.toFixed(2)}%
        </span>
      </div>

      <div className="ctx-row"><span>Size</span><b>${fmt(pnl.notionalUsd)}</b></div>
      <div className="ctx-row"><span>Margin</span><b>{fmt(position.stake)} {position.stakeToken}</b></div>
      <div className="ctx-row"><span>Entry</span><b>${fmt(position.entryPrice)}</b></div>
      <div className="ctx-row"><span>Mark</span><b>${fmt(markPrice)}</b></div>
      <div className="ctx-row"><span>Liquidation</span><b className="pnl-down">${fmt(position.liquidationPrice)}</b></div>

      <div className="row">
        <SketchButton frame="ghost" onClick={props.onClose} disabled={props.closing}>
          {props.closing ? "Closing…" : "Close"}
        </SketchButton>
        <SketchButton frame={isLong ? "up" : "down"} className={isLong ? "tone-up" : "tone-down"} onClick={props.onRide}>
          Ride ▲
        </SketchButton>
      </div>
    </section>
  );
}
