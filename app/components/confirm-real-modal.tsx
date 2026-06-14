"use client";

import type { TradeSide } from "@pump/shared";
import { REAL_MAX_NOTIONAL_USD, REAL_MAX_LEVERAGE } from "../lib/flash-real";

/**
 * Blocking confirmation shown before ANY real-money transaction. The real
 * trade does not proceed unless the user explicitly clicks confirm here.
 */
export function ConfirmRealModal(props: {
  kind: "open" | "close";
  side: TradeSide;
  collateralUsd: number;
  leverage: number;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const notional = props.collateralUsd * props.leverage;
  const overCap = notional > REAL_MAX_NOTIONAL_USD + 1e-9 || props.leverage > REAL_MAX_LEVERAGE;
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="overlay">
      <div className="confirm-real">
        <div className="real-banner">⚠ REAL MONEY · Solana mainnet</div>
        <div className="confirm-title">
          {props.kind === "open" ? "Open real position" : "Close real position"}
        </div>

        <div className="r-row"><span>Market</span><b>SOL / USDC · mainnet</b></div>
        <div className="r-row"><span>Side</span><b className={props.side === "long" ? "pnl-up" : "pnl-down"}>{props.side === "long" ? "LONG ▲" : "SHORT ▼"}</b></div>
        <div className="r-row"><span>Collateral</span><b>${fmt(props.collateralUsd)} USDC</b></div>
        <div className="r-row"><span>Leverage</span><b>{props.leverage}×</b></div>
        <div className="r-row"><span>Notional</span><b>${fmt(notional)}</b></div>

        <div className="caps-note">
          Capped at ${REAL_MAX_NOTIONAL_USD} notional · {REAL_MAX_LEVERAGE}× max — enforced in code.
        </div>

        {overCap && <p className="hint pnl-down">Exceeds the hard cap — cannot proceed.</p>}
        {props.error && <p className="hint pnl-down">{props.error}</p>}

        <div className="row">
          <button className="btn ghost" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </button>
          <button
            className={`btn ${props.side === "long" ? "" : "short"}`}
            onClick={props.onConfirm}
            disabled={props.busy || overCap}
          >
            {props.busy
              ? "Awaiting wallet…"
              : props.kind === "open"
                ? "Sign & open real position"
                : "Sign & close real position"}
          </button>
        </div>
        <p className="hint">You&apos;ll approve the exact transaction in your wallet next.</p>
      </div>
    </div>
  );
}
