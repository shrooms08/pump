import { describe, it, expect } from "vitest";
import {
  deriveHazards,
  deriveCoins,
  seedToState,
  mulberry32,
} from "../src/rng.js";
import {
  HAZARD_GAP,
  HAZARD_SPACING,
  FLOOR,
  CEIL,
} from "../src/constants.js";

const SEED = 1234567890123456789n; // a representative u64 run seed

describe("deriveHazards determinism", () => {
  it("returns identical output across two separate calls (the core invariant)", () => {
    const a = deriveHazards(SEED, 4200);
    const b = deriveHazards(SEED, 4200);
    // Deep-equal proves byte-for-byte identical layout — what the client's
    // prediction and the server's authority must agree on.
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it("derives the same layout from the seed's number / bigint / string forms", () => {
    const asBig = deriveHazards(123456789n, 1000);
    const asNum = deriveHazards(123456789, 1000);
    const asStr = deriveHazards("123456789", 1000);
    expect(asNum).toEqual(asBig);
    expect(asStr).toEqual(asBig);
  });

  it("gives a stable hazard identity for a column across different scroll windows", () => {
    // A column visible from two overlapping viewports must be identical in both.
    const early = deriveHazards(SEED, 1000);
    const later = deriveHazards(SEED, 1000 + HAZARD_SPACING);
    const shared = early.filter((h) => later.some((l) => l.index === h.index));
    expect(shared.length).toBeGreaterThan(0);
    for (const h of shared) {
      const match = later.find((l) => l.index === h.index)!;
      expect(match).toEqual(h);
    }
  });

  it("keeps every gap opening fully inside the play field", () => {
    for (const h of deriveHazards(SEED, 0)) {
      expect(h.gapHeight).toBe(HAZARD_GAP);
      expect(h.gapY - HAZARD_GAP / 2).toBeGreaterThanOrEqual(FLOOR);
      expect(h.gapY + HAZARD_GAP / 2).toBeLessThanOrEqual(CEIL);
    }
  });

  it("produces different layouts for different seeds", () => {
    const s1 = deriveHazards(1n, 0).map((h) => h.gapY);
    const s2 = deriveHazards(2n, 0).map((h) => h.gapY);
    expect(s1).not.toEqual(s2);
  });
});

describe("deriveCoins determinism", () => {
  it("returns identical output across two separate calls", () => {
    expect(deriveCoins(SEED, 4200)).toEqual(deriveCoins(SEED, 4200));
  });

  it("places coins inside the vertical play field", () => {
    for (const c of deriveCoins(SEED, 0)) {
      expect(c.y).toBeGreaterThan(FLOOR);
      expect(c.y).toBeLessThan(CEIL);
      expect(c.value).toBeGreaterThan(0);
    }
  });
});

describe("PRNG primitives", () => {
  it("mulberry32 yields the same sequence for the same state", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqB).toEqual(seqA);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("seedToState is stable and equal across seed encodings", () => {
    expect(seedToState(123456789n)).toBe(seedToState("123456789"));
    expect(seedToState(123456789n)).toBe(seedToState(123456789));
  });
});
