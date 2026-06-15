"use client";

import { useEffect, useRef } from "react";
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { RoughGenerator } from "roughjs/bin/generator";
import type { Drawable } from "roughjs/bin/core";
import { subscribePrice } from "../../lib/price-feed";

// SAME data pipeline as before (Pyth-seeded 1-min history + live tick stream).
// Only the RENDERING changed: a hand-sketched Rough.js candlestick chart.
const CANDLE_SEC = 60;
const SEED_MINUTES = 120;
const MAX_BARS = 600;
const FLASH_API = (process.env.NEXT_PUBLIC_FLASH_API_BASE || "https://flashapi.trade/v2").replace(/\/$/, "");

const INK = "#2a2a2a";
const GRID = "rgba(42,42,42,0.16)";
const LABEL = "#6b6357";
const UP = "#1f9e63";
const DOWN = "#d83a4d";

type Bar = { time: number; open: number; high: number; low: number; close: number };

/** Stable per-candle seed so each candle's sketch is deterministic (no shimmer)
 *  and safe to cache — derived from its 1-minute bucket timestamp. */
const candleSeed = (time: number) => (Math.floor(time) % 2_000_000_000) + 1;

/** Pyth Benchmarks seed — identical to the previous implementation. */
async function fetchSeed(minutes: number): Promise<Bar[] | null> {
  try {
    let ticker = "Crypto.SOL/USD";
    try {
      const tokens = (await (await fetch(`${FLASH_API}/tokens`)).json()) as { symbol?: string; pythTicker?: string | null }[];
      const t = tokens.find((x) => x.symbol?.toUpperCase() === "SOL")?.pythTicker;
      if (t) ticker = t;
    } catch {
      /* fall back to the standard Pyth SOL/USD symbol */
    }
    const to = Math.floor(Date.now() / 1000);
    const from = to - minutes * 60;
    const url =
      `https://benchmarks.pyth.network/v1/shims/tradingview/history` +
      `?symbol=${encodeURIComponent(ticker)}&resolution=1&from=${from}&to=${to}`;
    const j = (await (await fetch(url)).json()) as { s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[] };
    if (j.s !== "ok" || !Array.isArray(j.t) || j.t.length < 2) return null;
    const bars: Bar[] = [];
    for (let i = 0; i < j.t.length; i++) {
      const o = j.o?.[i], h = j.h?.[i], l = j.l?.[i], c = j.c?.[i], time = j.t[i];
      if ([o, h, l, c, time].every((v) => typeof v === "number" && Number.isFinite(v))) {
        bars.push({ time: time as number, open: o!, high: h!, low: l!, close: c! });
      }
    }
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

const niceStep = (range: number) => {
  const raw = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return step * mag;
};

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const c: CanvasRenderingContext2D = ctx; // non-null binding for the draw closure

    const rc: RoughCanvas = rough.canvas(canvas);
    const gen: RoughGenerator = rough.generator();

    const bars: Bar[] = [];
    // Cache of CLOSED-candle drawables — keyed by time+layoutVersion. The forming
    // (latest) candle is regenerated each frame; everything else is reused, so the
    // chart stays smooth at the tick rate.
    const cache = new Map<string, { body: Drawable; wick: Drawable }>();
    let layoutVer = "";
    const domain = { min: 0, max: 0 };
    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let rafId = 0;
    let dead = false;

    const numFont = (getComputedStyle(canvas).getPropertyValue("--font-num").trim() || "ui-monospace, monospace");

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = container.clientWidth;
      cssH = container.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      cache.clear();
      layoutVer = "";
      draw();
    };

    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        draw();
      });
    };

    function draw() {
      if (dead || cssW === 0 || cssH === 0) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, cssW, cssH);
      if (bars.length === 0) return;

      const padL = 10, padR = 60, padT = 16, padB = 26;
      const plotW = cssW - padL - padR;
      const plotH = cssH - padT - padB;
      if (plotW <= 0 || plotH <= 0) return;

      // candle geometry — anchored to the right edge (newest candle on the right)
      const step = Math.max(4, Math.min(14, plotW / Math.min(bars.length, 90)));
      const candleW = Math.max(3, Math.min(9, step * 0.62));
      const visibleCount = Math.min(bars.length, Math.floor(plotW / step));
      const visible = bars.slice(-visibleCount);
      const offset = plotW - visibleCount * step;
      const xLeft = (i: number) => padL + offset + i * step + (step - candleW) / 2;

      // y-domain with rounding + hysteresis so the scale (and the cache) is stable
      let lo = Infinity, hi = -Infinity;
      for (const b of visible) {
        if (b.low < lo) lo = b.low;
        if (b.high > hi) hi = b.high;
      }
      const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
      const rawMin = lo - pad, rawMax = hi + pad;
      const within = rawMin >= domain.min && rawMax <= domain.max;
      const notTooWide = domain.max - domain.min < (rawMax - rawMin) * 2.2;
      if (!(within && notTooWide) || domain.max === 0) {
        const stepP = niceStep(rawMax - rawMin);
        domain.min = Math.floor(rawMin / stepP) * stepP;
        domain.max = Math.ceil(rawMax / stepP) * stepP;
      }
      const y = (price: number) => padT + plotH - ((price - domain.min) / (domain.max - domain.min)) * plotH;

      // bump layout version → invalidate cache when the mapping changes. Includes
      // the oldest-visible candle time so a window SLIDE (new candle every minute,
      // which shifts every candle's x) regenerates the cache; within a minute the
      // window is static, so only the forming candle is regenerated per tick.
      const ver = `${Math.round(plotW)}:${Math.round(plotH)}:${candleW.toFixed(1)}:${domain.min}:${domain.max}:${visibleCount}:${visible[0]?.time ?? 0}`;
      if (ver !== layoutVer) {
        cache.clear();
        layoutVer = ver;
      }

      // gridlines + price labels (clean num font)
      c.font = `11px ${numFont}`;
      c.textBaseline = "middle";
      c.fillStyle = LABEL;
      const gridStep = niceStep(domain.max - domain.min);
      c.lineWidth = 1;
      c.strokeStyle = GRID;
      for (let p = Math.ceil(domain.min / gridStep) * gridStep; p <= domain.max + 1e-9; p += gridStep) {
        const gy = y(p);
        c.beginPath();
        c.moveTo(padL, gy);
        c.lineTo(padL + plotW, gy);
        c.stroke();
        c.textAlign = "left";
        c.fillText(`$${p.toFixed(p < 10 ? 3 : 2)}`, padL + plotW + 6, gy);
      }

      // candles — forming (last) regenerated fresh, all others cached
      for (let i = 0; i < visible.length; i++) {
        const b = visible[i]!;
        const x = xLeft(i);
        const cx = x + candleW / 2;
        const yO = y(b.open), yC = y(b.close), yH = y(b.high), yL = y(b.low);
        const up = b.close >= b.open;
        const color = up ? UP : DOWN;
        const top = Math.min(yO, yC);
        const bodyH = Math.max(Math.abs(yO - yC), 1.6);
        const seed = candleSeed(b.time);
        const isForming = i === visible.length - 1;

        let entry = isForming ? null : cache.get(`${b.time}:${layoutVer}`) ?? null;
        if (!entry) {
          const body = gen.rectangle(x, top, candleW, bodyH, {
            seed, roughness: 0.8, bowing: 0.6, stroke: INK, strokeWidth: 1, fill: color, fillStyle: "solid",
          });
          const wick = gen.line(cx, yH, cx, yL, { seed, roughness: 0.8, bowing: 0.5, stroke: INK, strokeWidth: 1 });
          entry = { body, wick };
          if (!isForming) cache.set(`${b.time}:${layoutVer}`, entry);
        }
        rc.draw(entry.wick);
        rc.draw(entry.body);
      }

      // last-price marker line + tag
      const last = visible[visible.length - 1]!;
      const ly = y(last.close);
      const lastUp = last.close >= last.open;
      c.strokeStyle = lastUp ? UP : DOWN;
      c.globalAlpha = 0.55;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(padL, ly);
      c.lineTo(padL + plotW, ly);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.fillStyle = lastUp ? UP : DOWN;
      c.fillRect(padL + plotW, ly - 9, padR, 18);
      c.fillStyle = "#fbf9f1";
      c.font = `bold 11px ${numFont}`;
      c.textAlign = "left";
      c.fillText(`$${last.close.toFixed(last.close < 10 ? 3 : 2)}`, padL + plotW + 5, ly);

      // sparse time labels (bottom)
      c.fillStyle = LABEL;
      c.font = `10px ${numFont}`;
      c.textAlign = "center";
      c.textBaseline = "top";
      const labelEvery = Math.max(1, Math.ceil(visibleCount / 8));
      for (let i = 0; i < visible.length; i += labelEvery) {
        const d = new Date(visible[i]!.time * 1000);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        c.fillText(`${hh}:${mm}`, xLeft(i) + candleW / 2, padT + plotH + 6);
      }
    }

    const onTick = ({ price, ts }: { price: number; ts: number }) => {
      const bucket = Math.floor(ts / 1000 / CANDLE_SEC) * CANDLE_SEC;
      const last = bars[bars.length - 1];
      if (!last || bucket > last.time) {
        bars.push({ time: bucket, open: price, high: price, low: price, close: price });
        if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
      } else if (bucket === last.time) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
      } else {
        return; // stale/out-of-order tick
      }
      schedule();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let unsubscribe = () => {};
    void (async () => {
      const seed = await fetchSeed(SEED_MINUTES);
      if (dead) return;
      if (seed) {
        bars.splice(0, bars.length, ...seed.slice(-MAX_BARS));
        draw();
      }
      unsubscribe = subscribePrice(onTick); // live ticks extend the seeded history
    })();

    return () => {
      dead = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      unsubscribe();
    };
  }, []);

  return (
    <div ref={containerRef} className="price-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}
