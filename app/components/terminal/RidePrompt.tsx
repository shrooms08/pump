"use client";

import type { Position } from "../../lib/position";
import { SketchFrame, SketchButton } from "./sketch";

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The "Ride this chart?" confirm overlay (A3). Shown when the player clicks the
 * terminal chart. If a position is open it confirms the ride; if not, it nudges
 * the player to open one first (you ride your position). Cancel/confirm only —
 * the actual zoom transition is owned by page.tsx + RideTransition.
 */
export function RidePrompt(props: {
  position: Position | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { position } = props;
  const isLong = position?.side === "long";

  return (
    <div className="overlay ride-overlay" onClick={props.onCancel}>
      <div className="ride-prompt" onClick={(e) => e.stopPropagation()}>
        <SketchFrame variant="modal" />
        {position ? (
          <>
            <div className="ride-bird">▲</div>
            <div className="confirm-title">Ride this chart?</div>
            <p className="ride-sub">
              Your {isLong ? "LONG" : "SHORT"} position becomes the bird — its altitude is your live PnL.
            </p>
            <div className={`pos-tag ${isLong ? "long" : "short"}`}>
              {isLong ? "LONG ▲" : "SHORT ▼"} {position.leverage}× · {position.real ? "REAL" : "sim"}
            </div>
            <div className="ride-rows">
              <div className="r-row"><span>Entry</span><b>${fmt(position.entryPrice)}</b></div>
              <div className="r-row"><span>Liquidation</span><b className="pnl-down">${fmt(position.liquidationPrice)}</b></div>
            </div>
            <div className="row">
              <SketchButton frame="ghost" onClick={props.onCancel}>Cancel</SketchButton>
              <SketchButton frame={isLong ? "up" : "down"} className={isLong ? "tone-up" : "tone-down"} onClick={props.onConfirm}>
                Ride ▲
              </SketchButton>
            </div>
          </>
        ) : (
          <>
            <div className="ride-bird muted">▲</div>
            <div className="confirm-title">Open a position first</div>
            <p className="ride-sub">
              You ride your position — its live PnL is the bird&apos;s altitude. Open one from the panel, then ride the chart.
            </p>
            <div className="row">
              <SketchButton frame="ghost" onClick={props.onCancel}>Got it</SketchButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
