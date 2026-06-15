"use client";

import { useRef } from "react";
import type { TradeSide } from "@pump/shared";
import type { BasketStatus } from "../../lib/flash-real";
import type { Position, StakeToken } from "../../lib/position";
import { WalletBar } from "../wallet-bar";
import { MarketHeader } from "./MarketHeader";
import { PriceChart } from "./PriceChart";
import { TradePanel } from "./TradePanel";
import { PositionsPanel, type ClosedResult } from "./PositionsPanel";
import { LeaderboardPanel } from "./LeaderboardPanel";
import { SketchFrame } from "./sketch";

/**
 * The trading-terminal home surface: market header + wallet bar on top, live
 * candlestick chart as the centerpiece, trade controls + positions panel in the
 * right column. Holds no state — page.tsx owns it and passes it in.
 */
export function Terminal(props: {
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
  // positions
  position: Position | null;
  closed: ClosedResult | null;
  closing: boolean;
  onClosePosition: () => void;
  // A3 ride: chart-click opens the prompt; the panel button rides directly.
  // Both pass the chart's rect so the zoom grows out of the chart.
  onRideChart: (from: DOMRect) => void;
  onRideStart: (from: DOMRect) => void;
  onDismissClosed: () => void;
  // leaderboard
  wallet: string | null;
  leaderboardKey?: number;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartRect = (): DOMRect =>
    chartRef.current?.getBoundingClientRect() ??
    new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);

  return (
    <div className="terminal">
      <header className="terminal-top">
        <div className="terminal-brand">
          <span className="pump">PUMP</span> ▲
        </div>
        <MarketHeader realMode={props.realMode} />
        <WalletBar />
      </header>

      <div className="terminal-main">
        <div
          ref={chartRef}
          className="terminal-chart rideable"
          onClick={() => props.onRideChart(chartRect())}
          role="button"
          aria-label="Ride this chart"
        >
          <SketchFrame variant="chart" />
          <PriceChart />
          <div className="ride-hint">▲ Ride this chart</div>
        </div>
        <aside className="terminal-rail">
          <TradePanel
            connected={props.connected}
            opening={props.opening}
            hasPosition={props.position !== null}
            realMode={props.realMode}
            setRealMode={props.setRealMode}
            basket={props.basket}
            side={props.side}
            setSide={props.setSide}
            stake={props.stake}
            setStake={props.setStake}
            stakeToken={props.stakeToken}
            setStakeToken={props.setStakeToken}
            leverage={props.leverage}
            setLeverage={props.setLeverage}
            onOpen={props.onOpen}
            error={props.error}
          />
          <PositionsPanel
            position={props.position}
            closed={props.closed}
            closing={props.closing}
            onClose={props.onClosePosition}
            onRide={() => props.onRideStart(chartRect())}
            onDismissClosed={props.onDismissClosed}
          />
        </aside>
      </div>

      <div className="terminal-board">
        <LeaderboardPanel wallet={props.wallet} refreshKey={props.leaderboardKey} />
      </div>
    </div>
  );
}
