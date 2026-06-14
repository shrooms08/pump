/**
 * Authoritative per-run state and the single-frame simulation step.
 *
 * Score, multiplier, collisions and death are computed HERE and only here — the
 * client sends taps (intent), never outcomes (CLAUDE.md rule #1). The bird's
 * altitude is the price-driven PnL baseline plus a flap offset the player
 * controls; threading hazard gaps is the skill layer.
 */
import type { WebSocket } from "ws";
import {
  GRAVITY,
  SCROLL_SPEED,
  FLOOR,
  CEIL,
  TERMINAL_VY,
  PHYS_DT,
  BIRD_SPAWN_Y,
  HAZARD_WIDTH,
  BIRD_RADIUS,
  COIN_POINTS,
  HAZARD_CLEAR_POINTS,
  COIN_MULT_DELTA_BPS,
  MULT_MIN_BPS,
  MULT_MAX_BPS,
  MULT_START_BPS,
  deriveHazards,
  deriveCoins,
  pnlBpsFromPrice,
  birdWorldX,
  hazardCollision,
  coinHit,
  clamp,
  type Side,
  type EventMessage,
} from "@pump/shared";

export type RunStatus = "pending" | "active" | "dead";
/** "floor"/"hazard" are GAME deaths (Flappy crash) — no effect on the position. */
export type DeathReason = "floor" | "hazard" | "cashout";

export interface RunState {
  id: string;
  seed: string;
  side: Side;
  status: RunStatus;
  ws: WebSocket | null;

  startedAt: number;
  entryPrice: number; // 0 until the first price is observed
  price: number;

  pnlBps: number;
  scrollX: number;
  flapVy: number; // vertical velocity (pure Flappy physics)
  birdY: number; // altitude — pure gravity+flap, NOT price-driven

  score: number;
  multiplierBps: number;
  lives: number;

  collectedCoins: Set<number>;
  clearedHazards: Set<number>;

  lastSeq: number;
  lastStateAt: number;
}

export function createRunState(id: string, seed: string, side: Side, entryPrice = 0): RunState {
  return {
    id,
    seed,
    side,
    status: "pending",
    ws: null,
    startedAt: 0,
    // If the client opened a position at a known fill price, lock it as the
    // entry so PnL matches what the trader saw; else derive from first tick.
    entryPrice,
    price: 0,
    pnlBps: 0,
    scrollX: 0,
    flapVy: 0,
    birdY: BIRD_SPAWN_Y,
    score: 0,
    multiplierBps: MULT_START_BPS,
    lives: 1,
    collectedCoins: new Set(),
    clearedHazards: new Set(),
    lastSeq: 0,
    lastStateAt: 0,
  };
}

export interface StepResult {
  dead: DeathReason | null;
  events: EventMessage[];
  scoreChanged: boolean;
}

/** Advance one fixed timestep. Mutates `run`; returns events + death to broadcast. */
export function stepRun(run: RunState, dt: number): StepResult {
  const events: EventMessage[] = [];
  let scoreChanged = false;

  // Lock in the entry price the moment a live price is available.
  if (run.entryPrice === 0 && run.price > 0) run.entryPrice = run.price;

  // Classic Flappy physics — gravity pulls the bird DOWN every frame; a tap
  // applies an upward impulse to flapVy. The PnL/price does NOT touch altitude.
  // Integrated in fixed PHYS_DT sub-steps so the client prediction mirrors it.
  for (let remaining = dt; remaining > 1e-9; remaining -= PHYS_DT) {
    const h = remaining >= PHYS_DT ? PHYS_DT : remaining;
    run.flapVy = Math.max(TERMINAL_VY, run.flapVy + GRAVITY * h);
    run.birdY += run.flapVy * h;
    if (run.birdY > CEIL) {
      run.birdY = CEIL; // cap at the top (no death), classic Flappy
      if (run.flapVy > 0) run.flapVy = 0;
    }
  }

  // World scrolls; PnL is computed for the HUD only (it does NOT drive altitude).
  run.scrollX += SCROLL_SPEED * dt;
  run.pnlBps = pnlBpsFromPrice(run.side, run.entryPrice, run.price);

  const bx = birdWorldX(run.scrollX);
  const hazards = deriveHazards(run.seed, run.scrollX);

  // Death: hit the floor (game over — a Flappy crash, NOT a liquidation).
  if (run.birdY <= FLOOR) return { dead: "floor", events, scoreChanged };

  // Death: hazard collision.
  if (hazardCollision(bx, run.birdY, hazards)) {
    return { dead: "hazard", events, scoreChanged };
  }

  // Coins: collect on overlap (once per coin index).
  for (const coin of deriveCoins(run.seed, run.scrollX)) {
    if (run.collectedCoins.has(coin.index)) continue;
    if (coinHit(bx, run.birdY, coin)) {
      run.collectedCoins.add(coin.index);
      run.score += COIN_POINTS;
      run.multiplierBps = clamp(
        run.multiplierBps + COIN_MULT_DELTA_BPS,
        MULT_MIN_BPS,
        MULT_MAX_BPS,
      );
      scoreChanged = true;
      events.push({
        t: "event",
        kind: "coin",
        score: run.score,
        multiplierBps: run.multiplierBps,
      });
    }
  }

  // Hazards cleared: small bonus once the column is fully behind the bird.
  for (const h of hazards) {
    if (run.clearedHazards.has(h.index)) continue;
    if (h.x < bx - HAZARD_WIDTH / 2 - BIRD_RADIUS) {
      run.clearedHazards.add(h.index);
      run.score += HAZARD_CLEAR_POINTS;
      scoreChanged = true;
      events.push({
        t: "event",
        kind: "nearmiss",
        score: run.score,
        multiplierBps: run.multiplierBps,
      });
    }
  }

  return { dead: null, events, scoreChanged };
}
