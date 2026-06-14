/**
 * Pure physics + collision helpers shared by the authoritative server and the
 * predictive client. Keeping these in @pump/shared means the client renders and
 * the server scores against the IDENTICAL geometry — what you see is what kills.
 *
 * Coordinate convention: altitude space (up-positive), same as constants.ts.
 */
import {
  BIRD_X,
  BIRD_RADIUS,
  CANDLE_BODY_WIDTH,
  CANDLE_WICK_WIDTH,
  FLOOR,
  CEIL,
  COIN_RADIUS,
  PNL_MID_Y,
  ALTITUDE_SENSITIVITY,
  LEVERAGE_X,
  FLAP_OFFSET_MAX,
} from "./constants.js";
import type { Hazard, Coin } from "./rng.js";

/** 0 = long (PUMP), 1 = short (DUMP). */
export type Side = 0 | 1;

/** Axis-aligned rect in world units; y0 < y1 with up-positive Y. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Unrealized PnL in basis points for a position opened at `entryPrice`, given
 * the current `price`. Longs profit when price rises; shorts when it falls.
 * Scaled by notional leverage so price moves translate into visible altitude.
 */
export function pnlBpsFromPrice(
  side: Side,
  entryPrice: number,
  price: number,
): number {
  if (entryPrice <= 0) return 0;
  const ret = (price - entryPrice) / entryPrice; // long return
  const signed = side === 0 ? ret : -ret;
  return Math.round(signed * LEVERAGE_X * 10_000);
}

/**
 * The price-driven baseline altitude the bird "rides", as a function of the
 * REAL pnlBps. We recover the underlying signed price return from pnlBps, then
 * map it via ALTITUDE_SENSITIVITY — so the LEVERAGE_X baked into pnlBps cancels
 * out and altitude depends ONLY on the price move and the game-feel sensitivity.
 * Capped at the ceiling, but intentionally NOT floored: a hard enough adverse
 * move drags the baseline below FLOOR so the bird liquidates even at max flap.
 */
export function pnlAltitude(pnlBps: number): number {
  const signedReturn = pnlBps / (LEVERAGE_X * 10_000); // undo leverage → raw % move
  const y = PNL_MID_Y + signedReturn * ALTITUDE_SENSITIVITY;
  return y > CEIL ? CEIL : y;
}

/**
 * Signed price return at which even a maxed-out flap can't keep the bird off the
 * floor — derived from ALTITUDE_SENSITIVITY so the on-screen LIQ line always
 * matches the altitude the player sees (this is the GAME floor, not the real
 * perp liquidation, which Step 6 derives from LEVERAGE_X).
 */
export const LIQ_RETURN = (FLOOR - FLAP_OFFSET_MAX - PNL_MID_Y) / ALTITUDE_SENSITIVITY;

/** The underlying price at which the bird is forced to the liquidation floor. */
export function liquidationPrice(side: Side, entryPrice: number): number {
  return side === 0 ? entryPrice * (1 + LIQ_RETURN) : entryPrice * (1 - LIQ_RETURN);
}

/** World-space x of the bird (fixed screen position, world scrolls past it). */
export function birdWorldX(scrollX: number): number {
  return scrollX + BIRD_X;
}

/**
 * The four solid rectangles of a candle column — top body + top wick, bottom
 * body + bottom wick — EXACTLY as the client draws them. Collision and
 * rendering both consume this, so hitboxes always match sprites.
 */
export function candleRects(h: Hazard): Rect[] {
  const gapTop = h.gapY + h.gapHeight / 2;
  const gapBottom = h.gapY - h.gapHeight / 2;
  const bodyHalf = CANDLE_BODY_WIDTH / 2;
  const wickHalf = CANDLE_WICK_WIDTH / 2;
  return [
    // top candle body + wick (hangs from the ceiling)
    { x0: h.x - bodyHalf, x1: h.x + bodyHalf, y0: h.topBodyBottomY, y1: CEIL },
    { x0: h.x - wickHalf, x1: h.x + wickHalf, y0: gapTop, y1: h.topBodyBottomY },
    // bottom candle body + wick (rises from the floor)
    { x0: h.x - bodyHalf, x1: h.x + bodyHalf, y0: FLOOR, y1: h.bottomBodyTopY },
    { x0: h.x - wickHalf, x1: h.x + wickHalf, y0: h.bottomBodyTopY, y1: gapBottom },
  ];
}

/** Circle (cx,cy,r) vs axis-aligned rect overlap (closest-point test). */
function circleRectOverlap(cx: number, cy: number, r: number, rect: Rect): boolean {
  const nx = cx < rect.x0 ? rect.x0 : cx > rect.x1 ? rect.x1 : cx;
  const ny = cy < rect.y0 ? rect.y0 : cy > rect.y1 ? rect.y1 : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * Returns the hazard the bird is colliding with, or null. The bird hitbox is
 * BIRD_RADIUS — slightly smaller than the rendered sprite — so grazes are
 * forgiven (Flappy-style) but solid contact with a candle body/wick kills.
 */
export function hazardCollision(
  birdX: number,
  birdY: number,
  hazards: Hazard[],
): Hazard | null {
  for (const h of hazards) {
    // cheap reject: bird far from this column horizontally
    if (Math.abs(h.x - birdX) > CANDLE_BODY_WIDTH / 2 + BIRD_RADIUS) continue;
    for (const rect of candleRects(h)) {
      if (circleRectOverlap(birdX, birdY, BIRD_RADIUS, rect)) return h;
    }
  }
  return null;
}

/** True if the bird overlaps the coin (circle-circle test in world units). */
export function coinHit(birdX: number, birdY: number, coin: Coin): boolean {
  const dx = coin.x - birdX;
  const dy = coin.y - birdY;
  return Math.hypot(dx, dy) < COIN_RADIUS + BIRD_RADIUS;
}
