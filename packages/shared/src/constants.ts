/**
 * Game + economic constants shared by the client and the authoritative server.
 *
 * Coordinate convention (ALTITUDE space, matches the authoritative server in
 * PUMP_ARCHITECTURE.md §7.3): y increases UPWARD. `FLOOR` is the low liquidation
 * threshold — the bird dies when `birdY <= FLOOR`. Gravity is therefore negative
 * (pulls altitude down) and a flap is a positive instantaneous boost.
 *
 * The client (§7.5) renders in canvas space (y grows downward); it is responsible
 * for flipping the axis at draw time. The physics numbers here are the single
 * source of truth both sides simulate against.
 *
 * All distances are in abstract "world units"; the renderer scales them to pixels.
 */

// ── Physics (altitude space, up-positive) ──────────────────────────────────
/** Downward acceleration applied to vertical velocity each second (units/s²). */
export const GRAVITY = -1800;
/** Instantaneous upward velocity set on a tap/flap (units/s). */
export const FLAP_IMPULSE = 520;
/** Horizontal world-scroll speed (units/s). scrollX advances by this each second. */
export const SCROLL_SPEED = 220;

// ── Vertical play field ────────────────────────────────────────────────────
/** Liquidation floor. Bird dies when birdY <= FLOOR. */
export const FLOOR = 0;
/** Top of the playable column. */
export const CEIL = 1000;
/** Total vertical extent of the play field. */
export const PLAY_HEIGHT = CEIL - FLOOR;

// ── Hazard layout ──────────────────────────────────────────────────────────
/** Vertical opening (the Flappy "pipe gap") the bird must fly through. */
export const HAZARD_GAP = 220;
/** Horizontal distance between consecutive hazard columns (world units). */
export const HAZARD_SPACING = 360;
/**
 * No hazards before this world-x, giving every run a few seconds of runway
 * before the first pipe. Client and server both honor it through the RNG.
 */
export const HAZARD_START_X = 760;
/**
 * Vertical band the gap CENTER can occupy. Kept inside the field so a full
 * HAZARD_GAP opening always fits with margin above floor and below ceiling.
 */
export const HAZARD_MARGIN = 140;

// ── Viewport ───────────────────────────────────────────────────────────────
/**
 * Width of the visible world window; derive*() returns features within it.
 * Sized so the client can render the full [0, CEIL] vertical field at a UNIFORM
 * scale (so on-screen distances match world units and hitboxes match sprites):
 * for a 900×600 stage showing CEIL=1000 tall, the visible width is 900/0.6 = 1500.
 */
export const VIEW_WIDTH = 1500;
/** Bird's fixed horizontal position within the viewport (collision x). */
export const BIRD_X = 220;

// ── Scoring ────────────────────────────────────────────────────────────────
/** Points awarded for collecting one multiplier coin. */
export const COIN_POINTS = 100;
/** Points awarded for cleanly clearing a hazard. */
export const HAZARD_CLEAR_POINTS = 25;
/** Multiplier increase (in bps) granted per coin collected. */
export const COIN_MULT_DELTA_BPS = 250;
/**
 * Hard cap on points the ER program accepts in a single apply_event — mirrors
 * MAX_POINTS_PER_EVENT in the on-chain program (§7.1). Keep in sync.
 */
export const MAX_POINTS_PER_EVENT = 5_000;

// ── Multiplier bounds (basis points) ───────────────────────────────────────
/** Starting multiplier: 1.0x. */
export const MULT_START_BPS = 10_000;
/** Floor multiplier: 0.5x. Mirrors MULT_MIN in the on-chain program (§7.1). */
export const MULT_MIN_BPS = 5_000;
/** Ceiling multiplier: 10.0x. Mirrors MULT_MAX in the on-chain program (§7.1). */
export const MULT_MAX_BPS = 100_000;

// ── Coin layout ────────────────────────────────────────────────────────────
/** Fraction of hazard columns that carry a collectible coin (0..1). */
export const COIN_SPAWN_RATE = 0.7;
/** Collision radius (world units) used for coin pickup tests. */
export const COIN_RADIUS = 28;

// ── Collision geometry ─────────────────────────────────────────────────────
/** Bird collision radius (world units), slightly smaller than the drawn sprite. */
export const BIRD_RADIUS = 18;
/** Width of a candle body (world units). */
export const CANDLE_BODY_WIDTH = 80;
/** Width of a candle wick (world units) — thin, points into the gap. */
export const CANDLE_WICK_WIDTH = 16;
/** Column width used for "hazard cleared" bookkeeping (= candle body width). */
export const HAZARD_WIDTH = CANDLE_BODY_WIDTH;

// ── Flap physics (altitude space, up-positive) ─────────────────────────────
/** Fastest the bird may fall (units/s). Caps gravity so falling stays playable. */
export const TERMINAL_VY = -1000;
/** Where the bird spawns. Classic Flappy: starts mid-field and immediately falls. */
export const BIRD_SPAWN_Y = 600;
/**
 * Legacy flap-offset bounds — retained only for the trade-side liquidation math
 * in physics.ts. The bird's altitude is pure gravity+flap (gravity must win),
 * so these no longer bound the bird.
 */
export const FLAP_OFFSET_MIN = -300;
export const FLAP_OFFSET_MAX = 320;

// ── Price → altitude mapping (drives the "bird rides the chart" baseline) ──
/** Bird altitude at 0 PnL — the resting baseline the flap oscillates around. */
export const PNL_MID_Y = 480;
/**
 * GAME-FEEL altitude amplification — altitude units per 1.0 (100%) of signed
 * price return. This is a DISPLAY/gameplay knob ONLY; it is deliberately NOT the
 * position leverage. Changing LEVERAGE_X (the real perp leverage that sets the
 * Step-6 liquidation price) must NOT change how the bird rides — only this does.
 *
 * Tuned for SOL: a typical ~0.1–0.3% move over ~60s maps to ~120–360 world units
 * (≈20–60% of the screen), so the bird visibly rides up and down. Examples:
 *   0.10% → 120u,  0.25% → 300u,  +0.40% pins the ceiling,  −0.67% liquidates.
 */
export const ALTITUDE_SENSITIVITY = 120_000;
/**
 * Notional leverage of the REAL position — used for the displayed $ / % PnL and,
 * in Step 6, the actual on-chain liquidation price. NOT used to scale altitude.
 */
export const LEVERAGE_X = 10;

// ── Loop rate ──────────────────────────────────────────────────────────────
/** Authoritative server simulation + tick broadcast rate (Hz). Matches §4 "~20–30 Hz". */
export const SIM_HZ = 30;
/**
 * Fixed physics sub-step (seconds). BOTH the client prediction and the server
 * sim integrate the flap in exact PHYS_DT increments, so given the same taps
 * they produce the identical bird path — that's why the client never needs to
 * reconcile its position to the server during normal play. A server frame
 * (1/SIM_HZ) is an exact multiple of PHYS_DT.
 */
export const PHYS_DT = 1 / 120;
