"use client";

import { useEffect, useRef, useState } from "react";
import type { TradeSide } from "@pump/shared";

const ZOOM_MS = 760; // must match the CSS transition on .ride-zoom
const HOLD_MS = 170; // brief opaque hold at full screen before handing off

/**
 * The "ride the chart" zoom (A3). A fixed, full-viewport panel that starts
 * geometrically mapped onto the chart's rect (translate + scale, origin 0,0)
 * then animates to identity — so it grows OUT of the chart to fill the screen,
 * with the bird rising in the center. Double-buffered: it stays opaque (game bg)
 * at full screen, then onComplete fires so page.tsx mounts the game beneath and
 * unmounts this — no flash. A designed morph into the game, not a data zoom.
 */
export function RideTransition(props: { from: DOMRect; side: TradeSide; onComplete: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const { from, onComplete } = props;

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      onComplete();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sx = Math.max(from.width / vw, 0.001);
    const sy = Math.max(from.height / vh, 0.001);

    // Start: collapsed onto the chart rect.
    el.style.transform = `translate(${from.left}px, ${from.top}px) scale(${sx}, ${sy})`;
    void el.offsetWidth; // force reflow so the transition runs from this state

    const raf = requestAnimationFrame(() => {
      el.style.transform = "translate(0px, 0px) scale(1, 1)";
      setExpanded(true);
    });
    const done = setTimeout(onComplete, ZOOM_MS + HOLD_MS);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [from, onComplete]);

  return (
    <div className="ride-zoom-wrap">
      <div ref={ref} className={`ride-zoom ${expanded ? "in" : ""}`}>
        <div className="ride-zoom-glow" />
        <div className={`ride-zoom-bird ${props.side === "short" ? "short" : "long"}`}>▲</div>
        <div className="ride-zoom-label">RIDING</div>
      </div>
    </div>
  );
}
