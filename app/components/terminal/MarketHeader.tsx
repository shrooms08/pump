"use client";

import { useEffect, useState } from "react";
import { subscribePrice } from "../../lib/price-feed";
import { SketchFrame } from "./sketch";

/** SOL/USDC, live mark price (from the shared tick stream), network badge. */
export function MarketHeader({ realMode }: { realMode: boolean }) {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => subscribePrice((t) => setPrice(t.price)), []);
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="market-header">
      <SketchFrame variant="card" />
      <div className="mh-pair">
        <span className="mh-sym">SOL</span>
        <span className="muted">/ USDC</span>
      </div>
      <div className="mh-mark">{price ? `$${fmt(price)}` : "—"}</div>
      <div className={`mh-net ${realMode ? "real" : "sim"}`}>
        <span className="dot" />
        {realMode ? "MAINNET · REAL" : "DEVNET · simulated"}
      </div>
    </div>
  );
}
