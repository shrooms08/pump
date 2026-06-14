/**
 * Deterministic, seedable world generation shared by client and server.
 *
 * RULE (CLAUDE.md #4): the client predicts hazard/coin positions for smooth
 * rendering and the server is authoritative — both MUST derive the IDENTICAL
 * layout from the run `seed`. That only holds if every value here comes from
 * this PRNG. There is no `Math.random` anywhere in game logic.
 *
 * The world is an infinite ribbon of hazard columns spaced HAZARD_SPACING apart.
 * Column `i` sits at worldX = i * HAZARD_SPACING. Everything about column `i`
 * (gap center, whether it carries a coin, the coin's height) is a pure function
 * of (seed, i), so `derive*(seed, scrollX)` is referentially transparent: same
 * inputs → byte-identical output, on any machine, any number of times.
 */

import {
  HAZARD_SPACING,
  HAZARD_START_X,
  HAZARD_GAP,
  HAZARD_MARGIN,
  FLOOR,
  CEIL,
  VIEW_WIDTH,
  COIN_POINTS,
  COIN_SPAWN_RATE,
} from "./constants.js";

// ── PRNG ───────────────────────────────────────────────────────────────────

/**
 * mulberry32 — a fast 32-bit PRNG. Given the same 32-bit state it produces the
 * exact same sequence of floats in [0, 1) across every JS engine.
 */
export function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Avalanche-mix two 32-bit ints into one well-distributed 32-bit int. */
function mix32(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Normalize a run seed to a 32-bit state. Accepts the on-chain u64 seed in any
 * of the forms it travels as: a JS number, a bigint, or its decimal string
 * (the wire form — see §3, `seed.toString()`). The full 64 bits of entropy are
 * folded in so two seeds that differ only in their high bits still diverge.
 */
export function seedToState(seed: number | bigint | string): number {
  let big: bigint;
  if (typeof seed === "bigint") big = seed;
  else if (typeof seed === "string") big = BigInt(seed);
  else big = BigInt(Math.trunc(seed));
  big &= 0xffffffffffffffffn; // clamp to u64
  const lo = Number(big & 0xffffffffn);
  const hi = Number((big >> 32n) & 0xffffffffn);
  return mix32(lo >>> 0, hi >>> 0);
}

/** A PRNG seeded deterministically from (seed, columnIndex). */
function columnRng(state: number, index: number): () => number {
  return mulberry32(mix32(state, index | 0));
}

// ── World features ─────────────────────────────────────────────────────────

/**
 * A hazard column rendered as a candlestick chart slice: a candle hanging from
 * the ceiling and one rising from the floor, with a passable gap between them.
 * Each candle has a wide body and a thin wick that points into the gap. The
 * collidable region is EXACTLY these shapes (see physics.candleRects), so what
 * the player sees is what kills them.
 *
 * All Y values are altitude space (up-positive).
 */
export interface Hazard {
  /** Column index (i). Stable identity for a hazard across frames. */
  readonly index: number;
  /** World-space x of the candle column (center). */
  readonly x: number;
  /** Center of the passable gap. */
  readonly gapY: number;
  /** Height of the gap; equals HAZARD_GAP. */
  readonly gapHeight: number;
  /**
   * Top candle: body fills [topBodyBottomY, CEIL], wick fills
   * [gapY + gapHeight/2, topBodyBottomY] (the wick tip touches the gap).
   */
  readonly topBodyBottomY: number;
  /**
   * Bottom candle: body fills [FLOOR, bottomBodyTopY], wick fills
   * [bottomBodyTopY, gapY - gapHeight/2].
   */
  readonly bottomBodyTopY: number;
  /** Green (up) vs red (down) candle — cosmetic, derived from the seed. */
  readonly bullish: boolean;
}

export interface Coin {
  /** Column index the coin belongs to. */
  readonly index: number;
  /** World-space x of the coin. */
  readonly x: number;
  /** Coin altitude (up-positive). */
  readonly y: number;
  /** Points awarded on collection. */
  readonly value: number;
}

/** Lowest and highest the gap center may sit so a full opening fits the field. */
const GAP_MIN_Y = FLOOR + HAZARD_MARGIN + HAZARD_GAP / 2;
const GAP_MAX_Y = CEIL - HAZARD_MARGIN - HAZARD_GAP / 2;

/** Compute the single hazard at column `index` from the run state. */
function hazardAt(state: number, index: number): Hazard {
  const rng = columnRng(state, index);
  const gapY = GAP_MIN_Y + rng() * (GAP_MAX_Y - GAP_MIN_Y);
  const gapTop = gapY + HAZARD_GAP / 2;
  const gapBottom = gapY - HAZARD_GAP / 2;
  // Wick length is a fraction of each solid region; the rest is the candle body.
  const topSolid = CEIL - gapTop;
  const bottomSolid = gapBottom - FLOOR;
  const topWick = topSolid * (0.25 + 0.3 * rng());
  const bottomWick = bottomSolid * (0.25 + 0.3 * rng());
  return {
    index,
    x: index * HAZARD_SPACING,
    gapY,
    gapHeight: HAZARD_GAP,
    topBodyBottomY: gapTop + topWick,
    bottomBodyTopY: gapBottom - bottomWick,
    bullish: rng() < 0.5,
  };
}

/** Compute the coin for column `index`, or null if this column carries none. */
function coinAt(state: number, index: number): Coin | null {
  const rng = columnRng(state, index);
  rng(); // consume the draw used for gapY so coin draws are independent of it
  if (rng() > COIN_SPAWN_RATE) return null;
  // Place the coin in the open lane just past the column, height near the gap
  // center with a little jitter, kept inside the opening.
  const hz = hazardAt(state, index);
  const jitter = (rng() - 0.5) * (HAZARD_GAP * 0.6);
  return {
    index,
    x: index * HAZARD_SPACING + HAZARD_SPACING / 2,
    y: hz.gapY + jitter,
    value: COIN_POINTS,
  };
}

/** Inclusive range of column indices whose features fall in [from, to]. */
function columnRange(from: number, to: number): { first: number; last: number } {
  // Coins sit up to half a spacing past their column, so widen the upper bound.
  const first = Math.max(0, Math.floor(from / HAZARD_SPACING));
  const last = Math.ceil((to + HAZARD_SPACING) / HAZARD_SPACING);
  return { first, last };
}

/**
 * All hazards visible in the viewport window starting at `scrollX`.
 * Pure: `deriveHazards(seed, x)` returns identical output every call.
 */
export function deriveHazards(
  seed: number | bigint | string,
  scrollX: number,
): Hazard[] {
  const state = seedToState(seed);
  const { first, last } = columnRange(scrollX, scrollX + VIEW_WIDTH);
  // Columns before HAZARD_START_X are runway — no pipes there.
  const firstHazardIndex = Math.ceil(HAZARD_START_X / HAZARD_SPACING);
  const out: Hazard[] = [];
  for (let i = Math.max(first, firstHazardIndex); i <= last; i++) {
    out.push(hazardAt(state, i));
  }
  return out;
}

/**
 * All coins visible in the viewport window starting at `scrollX`.
 * Pure: same (seed, scrollX) → identical output.
 */
export function deriveCoins(
  seed: number | bigint | string,
  scrollX: number,
): Coin[] {
  const state = seedToState(seed);
  const { first, last } = columnRange(scrollX, scrollX + VIEW_WIDTH);
  const out: Coin[] = [];
  for (let i = first; i <= last; i++) {
    const coin = coinAt(state, i);
    if (coin) out.push(coin);
  }
  return out;
}
