import { describe, it, expect } from "vitest";
import { deriveHazards } from "../src/rng.js";
import {
  hazardCollision,
  candleRects,
  pnlAltitude,
  pnlBpsFromPrice,
  liquidationPrice,
  LIQ_RETURN,
} from "../src/physics.js";
import { BIRD_RADIUS, CEIL, FLOOR, PNL_MID_Y, ALTITUDE_SENSITIVITY } from "../src/constants.js";

const SEED = 7777n;

describe("collision fairness — hitbox matches the drawn candle", () => {
  const h = deriveHazards(SEED, 0).filter((x) => x.index >= 3)[0]!;
  const gapTop = h.gapY + h.gapHeight / 2;
  const gapBottom = h.gapY - h.gapHeight / 2;

  it("clearing the visible gap always survives", () => {
    // Dead center of the gap, at the column x → must be safe.
    expect(hazardCollision(h.x, h.gapY, [h])).toBeNull();
  });

  it("a bird just inside the gap edges (sprite within gap) survives", () => {
    expect(hazardCollision(h.x, gapTop - BIRD_RADIUS - 1, [h])).toBeNull();
    expect(hazardCollision(h.x, gapBottom + BIRD_RADIUS + 1, [h])).toBeNull();
  });

  it("solid contact with the top/bottom candle body kills", () => {
    expect(hazardCollision(h.x, CEIL - 5, [h])).toBe(h); // deep in top body
    expect(hazardCollision(h.x, FLOOR + 5, [h])).toBe(h); // deep in bottom body
  });

  it("contacting a wick (just past the gap edge) kills", () => {
    expect(hazardCollision(h.x, gapTop + BIRD_RADIUS, [h])).toBe(h);
    expect(hazardCollision(h.x, gapBottom - BIRD_RADIUS, [h])).toBe(h);
  });

  it("far from the column horizontally never collides", () => {
    expect(hazardCollision(h.x + 500, FLOOR + 5, [h])).toBeNull();
  });

  it("candleRects leave the gap empty and fill the solids", () => {
    const rects = candleRects(h);
    const inAnyRect = (x: number, y: number) =>
      rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    expect(inAnyRect(h.x, h.gapY)).toBe(false); // gap center is empty
    expect(inAnyRect(h.x, CEIL - 1)).toBe(true); // top body filled
    expect(inAnyRect(h.x, FLOOR + 1)).toBe(true); // bottom body filled
  });
});

describe("long vs short invert survival", () => {
  it("long rises when price rises; short rises when price falls", () => {
    const up = pnlBpsFromPrice(0, 100, 110); // long, +10%
    const down = pnlBpsFromPrice(1, 100, 110); // short, +10% price
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
    expect(pnlAltitude(up)).toBeGreaterThan(pnlAltitude(down));
  });

  it("liquidation price is below entry for long, above for short", () => {
    expect(liquidationPrice(0, 150)).toBeLessThan(150);
    expect(liquidationPrice(1, 150)).toBeGreaterThan(150);
    expect(LIQ_RETURN).toBeLessThan(0);
  });
});

describe("altitude sensitivity (game-feel amplification)", () => {
  it("a small real SOL move visibly rides the bird", () => {
    // +0.20% long move from $150 → bird climbs a meaningful fraction of the field.
    const pnl = pnlBpsFromPrice(0, 150, 150 * 1.002);
    const climb = pnlAltitude(pnl) - PNL_MID_Y;
    expect(climb).toBeGreaterThan(200); // ~240u — clearly visible across the screen
    // a -0.2% move sinks it symmetrically
    const drop = pnlAltitude(pnlBpsFromPrice(0, 150, 150 * 0.998)) - PNL_MID_Y;
    expect(drop).toBeLessThan(-200);
  });

  it("altitude is independent of LEVERAGE_X (game feel ≠ real leverage)", () => {
    // pnlAltitude recovers the raw return from pnlBps, so altitude == MID +
    // signedReturn * ALTITUDE_SENSITIVITY regardless of the leverage in pnlBps.
    const r = 0.0025; // +0.25% return
    const pnl = pnlBpsFromPrice(0, 100, 100 * (1 + r));
    expect(pnlAltitude(pnl)).toBeCloseTo(PNL_MID_Y + r * ALTITUDE_SENSITIVITY, 4);
  });
});
