"use client";

import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import rough from "roughjs";

// Hand-inked chrome. Every card / button / divider border is a Rough.js
// rectangle drawn behind the element (transparent CSS border) so nothing in the
// terminal is a clean rectangle. Seeds are STABLE per instance — the sketch only
// regenerates on resize, never on re-render, so lines don't shimmer.

const INK = "#2a2a2a";
const CARD_FILL = "#fbf9f1";
const CHART_FILL = "#fcfaf3";
const GHOST_FILL = "#ece4d2";
const INPUT_FILL = "#fffdf7";
const UP = "#1f9e63";
const DOWN = "#d83a4d";

export type SketchVariant =
  | "card"
  | "modal"
  | "chart"
  | "outline"
  | "ghost"
  | "up"
  | "down"
  | "input"
  | "chipLong"
  | "chipShort";

interface FrameStyle {
  pad: number;
  roughness: number;
  bowing: number;
  strokeWidth: number;
  fill?: string;
}

const STYLES: Record<SketchVariant, FrameStyle> = {
  card: { pad: 3, roughness: 1.05, bowing: 1.4, strokeWidth: 1.5, fill: CARD_FILL },
  modal: { pad: 3, roughness: 1.0, bowing: 1.2, strokeWidth: 1.8, fill: CARD_FILL },
  chart: { pad: 3, roughness: 0.9, bowing: 1.0, strokeWidth: 1.6, fill: CHART_FILL },
  outline: { pad: 2.5, roughness: 1.5, bowing: 1.8, strokeWidth: 1.3 },
  ghost: { pad: 2.5, roughness: 1.2, bowing: 1.5, strokeWidth: 1.4, fill: GHOST_FILL },
  up: { pad: 2.5, roughness: 1.2, bowing: 1.5, strokeWidth: 1.5, fill: UP },
  down: { pad: 2.5, roughness: 1.2, bowing: 1.5, strokeWidth: 1.5, fill: DOWN },
  input: { pad: 2, roughness: 1.5, bowing: 1.8, strokeWidth: 1.2, fill: INPUT_FILL },
  chipLong: { pad: 1.5, roughness: 1.3, bowing: 1.6, strokeWidth: 1.1, fill: "#cfe9da" },
  chipShort: { pad: 1.5, roughness: 1.3, bowing: 1.6, strokeWidth: 1.1, fill: "#f3d2d7" },
};

/** Drop-in hand-drawn border. Place as the first child of a `position:relative`
 *  element; it measures the parent and draws a Rough rectangle behind the content. */
export function SketchFrame({ variant = "card", seed }: { variant?: SketchVariant; seed?: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const seedRef = useRef<number>(seed ?? 1 + Math.floor(Math.random() * 1_000_000));

  useEffect(() => {
    const svg = svgRef.current;
    const parent = svg?.parentElement;
    if (!svg || !parent) return;

    const draw = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      const s = STYLES[variant];
      const rc = rough.svg(svg);
      const node = rc.rectangle(s.pad, s.pad, w - s.pad * 2, h - s.pad * 2, {
        seed: seedRef.current,
        roughness: s.roughness,
        bowing: s.bowing,
        stroke: INK,
        strokeWidth: s.strokeWidth,
        ...(s.fill ? { fill: s.fill, fillStyle: "solid" } : {}),
      });
      svg.appendChild(node);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [variant]);

  return <svg ref={svgRef} className="sketch-frame" aria-hidden="true" />;
}

/** A button whose border/fill is hand-drawn (`frame` picks the look). */
export function SketchButton({
  frame,
  className,
  children,
  ...rest
}: { frame: SketchVariant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`sketch-btn ${className ?? ""}`} {...rest}>
      <SketchFrame variant={frame} />
      <span className="sketch-btn-label">{children}</span>
    </button>
  );
}

/** A hand-drawn horizontal divider line. */
export function SketchDivider() {
  const svgRef = useRef<SVGSVGElement>(null);
  const seedRef = useRef<number>(1 + Math.floor(Math.random() * 1_000_000));
  useEffect(() => {
    const svg = svgRef.current;
    const parent = svg?.parentElement;
    if (!svg || !parent) return;
    const draw = () => {
      const w = parent.clientWidth;
      if (w === 0) return;
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", "8");
      svg.setAttribute("viewBox", `0 0 ${w} 8`);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const rc = rough.svg(svg);
      svg.appendChild(
        rc.line(2, 4, w - 2, 4, { seed: seedRef.current, roughness: 1.6, bowing: 2, stroke: INK, strokeWidth: 1.2 }),
      );
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="sketch-divider">
      <svg ref={svgRef} aria-hidden="true" />
    </div>
  );
}
