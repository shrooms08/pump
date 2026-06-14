# PUMP — System Architecture & Minimal Production Build

Repos cloned: `flash-trade/examples-v2` (tap-trading template), `magicblock-labs/magicblock-engine-examples` (ER delegate/commit/undelegate).

This doc is the source of truth Claude Code builds from. Read top to bottom; build in the order of §10.

---

## 0. The architectural decision everything depends on: trust zones

PUMP has three trust zones tied together by one live price:

| Zone | Owns | Authority |
|------|------|-----------|
| Game server (off-chain) | The authoritative game simulation — collisions, coins, death | Trusted to compute score honestly (standard server-authoritative model) |
| MagicBlock ER (on-chain) | The canonical, tamper-evident score record, gaslessly updated, committed to Solana | Source of truth at settlement |
| FlashTrade (on-chain) | The real money — one perp position per run | Source of truth for PnL |

Why server-authoritative and not client-authoritative: the client controls taps, so if the client computed score it could submit a perfect run. The server simulates the run against the seeded hazard layout and the live price, so the client can only *send inputs*, not *claim outcomes*. The ER is where that server-produced score lives as a finalized, composable on-chain record the settlement program reads — that's the load-bearing reason MagicBlock is in the design, not bolted on.

Hardening path (post-MVP, state it but don't build it): the ER program enforces invariants (monotonic tick, bounded per-event points, multiplier range) so even a compromised server can't write an impossible score; full anti-cheat re-simulates from seed + signed price path + input log.

MVP scope cut: single game-server instance, in-memory run state checkpointed to Redis, REST folded into Next.js API routes, settlement folded into the game server. The architecture below is the scalable shape; the cuts are noted inline as `MVP:`.

---

## 1. Architecture (runtime topology)

```
                         ┌──────────────────────┐
                         │   Browser client      │  Next.js + canvas, predictive render
                         │   (wallet + WS)       │
                         └───────────┬──────────┘
                                     │  WS: tap / cashout  ▲ tick / event / state
   FlashTrade WS ──► ┌────────────┐  │
   (single upstream) │ Price relay├──┼──► Redis ◄── leaderboard ZSET, run checkpoints,
                     └────────────┘  │     (pub/sub ticks, cache)   rate limits
                                     ▼
                         ┌──────────────────────┐
                         │  Game server          │  authoritative loop, session-key signer
                         │  (1..N, runs sharded) │
                         └───┬────────┬─────────┬┘
                  score txs  │        │ open/   │ records
                  (gasless)  ▼        │ close   ▼
              ┌──────────────────┐    ▼   ┌──────────────┐
              │  MagicBlock ER    │  FlashTrade │ Postgres │  runs, settlements, users
              │  RunSession PDA   │  (devnet)   │ (Supabase)│
              └────────┬─────────┘            └──────────────┘
                       │ commit + undelegate
                       ▼
              ┌──────────────────┐
              │  Pump program     │  settle(): payout = realized PnL × multiplier
              │  (base layer)     │  reads finalized RunSession + escrow pot
              └──────────────────┘
```

Component responsibilities:
- Price relay — one upstream FlashTrade WS connection; writes latest tick to Redis and publishes to `ticks`. Decouples N clients from FlashTrade's rate limits and guarantees one consistent price across all runs. `MVP:` can run in-process inside the game server.
- Game server — authoritative game loop, one run pinned to one instance (sticky WS). Subscribes to `ticks`, computes bird altitude from price, runs collision/coin logic against the seeded layout, writes score deltas to the ER via the run's session key, persists records to Postgres, triggers settlement on death.
- MagicBlock ER — runs the `RunSession` PDA delegated for the session; sub-50ms gasless score updates; commits to Solana periodically and on death.
- FlashTrade — opens one perp at run start, closes on death; its live price is the single input to both altitude and PnL.
- Redis — price pub/sub, leaderboard ZSET, run-state checkpoints, rate limiting.
- Postgres (Supabase) — durable run history, settlement idempotency, user profiles, leaderboard backing.
- Pump program (base layer) — `start_run`, `delegate_run`, `apply_event` (ER), `end_run` (ER), `settle` (base).

---

## 2. Component structure (monorepo)

```
pump/
  programs/pump/            Anchor program (Rust) — RunSession + settlement
  app/                      Next.js client + REST API routes
    app/api/runs/route.ts
    app/api/leaderboard/route.ts
    components/Game.tsx      canvas loop
  services/
    price-relay/            FlashTrade WS → Redis              (MVP: optional, fold in)
    game-server/            authoritative WS loop + ER writes + settlement
  packages/
    shared/                 seed RNG, game constants, types — used by client AND server
      rng.ts                deterministic PRNG (client & server derive identical hazards)
      constants.ts          GRAVITY, SCROLL_SPEED, HAZARD_GAP, COIN_POINTS, etc.
      types.ts              wire-protocol types
  db/schema.sql
  CLAUDE.md
  PUMP_SPEC.md
  PUMP_ARCHITECTURE.md
```

The `packages/shared` RNG is critical: the client predicts hazard/coin positions for smooth rendering, the server is authoritative — both must derive the identical layout from the run `seed`. Same PRNG, same seed, same world.

---

## 3. Data flow (run lifecycle)

1. Register — `POST /runs {wallet, side, stake}` → server inserts a `pending` run, generates `seed`, returns `{runId, seed, wsUrl, pool}`.
2. Start — client signs ONE bundle: create/authorize a session key, open the FlashTrade position (stake = collateral, fixed leverage), init + delegate the `RunSession` PDA to the ER. Server verifies on-chain, flips run to `active`, records `position_pubkey`, `session_pda`, `opened_sig`.
3. Play — client opens WS, sends `join {runId, sessionKey}`, then streams `tap {seq}`. Server, on each `ticks` message, computes bird altitude from live price and broadcasts `tick`. On each tap, server runs authoritative collision/coin checks against the seeded layout at the current scroll position, updates score/multiplier, signs an `apply_event` ER tx with the session key, and broadcasts `state`. Client renders predictively and reconciles to server `state`.
4. Death — bird hits floor (price dumped past the run's liquidation band) or collides with a hazard. Server submits final `apply_event`, then `end_run` (commit + undelegate → state finalized on Solana), closes the FlashTrade position, enqueues settlement.
5. Settle — `settle()` reads the finalized `RunSession` score + realized PnL, computes `payout = max(0, realized_pnl) × multiplier_bps/10000` (or pot share), pays from escrow, writes `settlements` row (idempotent), updates Redis leaderboard ZSET.
6. Leaderboard — `GET /leaderboard` reads the Redis ZSET (reconciled against finalized on-chain `RunSession` accounts).

---

## 4. API design

### REST (Next.js route handlers — `MVP:` same process as client)

```
POST /api/runs
  body:  { wallet: string, side: "long"|"short", stakeLamports: number }
  200:   { runId: string, seed: string, wsUrl: string, pool: "devnet.1" }
  429:   rate limited (token bucket per wallet)

GET /api/runs/:id
  200:   { id, status, score, multiplierBps, positionPubkey, payoutLamports }

GET /api/leaderboard?window=daily|all&limit=50
  200:   { entries: [{ rank, wallet, handle, score, payoutLamports }] }

GET /api/users/:wallet
  200:   { wallet, handle, runs: [...recent], best: {...} }
```

Server-side actions (not public): `confirmStart(runId)` verifies the on-chain start bundle; `closeAndSettle(runId)` runs on death.

### WebSocket (game server)

Client → server:
```
{ t:"join", runId, sessionKeyPubkey }
{ t:"tap",  seq }                     // seq = monotonic client input counter
{ t:"cashout" }                       // voluntary exit at current PnL
```
Server → client:
```
{ t:"tick",  price, birdY, pnlBps }            // ~20–30 Hz, derived from live price
{ t:"event", kind:"coin"|"hazard"|"nearmiss", score, multiplierBps }
{ t:"state", score, multiplierBps, lives }     // authoritative snapshot for reconciliation
{ t:"dead",  finalScore, realizedPnl, settle:"pending" }
{ t:"settled", payoutLamports, txSig }
```

Wire rule: the server never trusts a `tap` to carry score; it carries only intent (`seq`). All scoring is computed server-side.

---

## 5. Database schema (Postgres / Supabase)

```sql
create type run_status as enum ('pending','active','dead','settled','void');
create type trade_side as enum ('long','short');

create table users (
  wallet      text primary key,
  handle      text unique,
  created_at  timestamptz not null default now()
);

create table runs (
  id              uuid primary key default gen_random_uuid(),
  wallet          text not null references users(wallet),
  seed            bigint not null,
  side            trade_side not null,
  stake_lamports  bigint not null,
  status          run_status not null default 'pending',
  score           bigint not null default 0,
  multiplier_bps  int not null default 10000,
  session_pda     text,
  position_pubkey text,
  opened_sig      text,
  closed_sig      text,
  realized_pnl    bigint,
  payout_lamports bigint,
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);
create index runs_status_idx        on runs (status);
create index runs_wallet_recent_idx on runs (wallet, created_at desc);
create index runs_leaderboard_idx   on runs (score desc) where status in ('dead','settled');

create table settlements (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null unique references runs(id),
  payout_lamports bigint not null,
  tx_sig          text,
  status          text not null default 'pending',   -- pending|paid|failed
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

-- audit trail for anti-cheat replay; sample or cap in MVP
create table run_events (
  id          bigserial primary key,
  run_id      uuid not null references runs(id),
  seq         int not null,
  tick        int not null,
  kind        smallint not null,
  score_after bigint not null,
  ts          timestamptz not null default now()
);
create index run_events_run_seq_idx on run_events (run_id, seq);
```

What lives where: on-chain is source of truth for stake, finalized score, payout. Postgres is for fast queries, history, idempotency, and analytics. Never trust Postgres `score` for payout — settlement reads the finalized on-chain `RunSession`.

---

## 6. Caching strategy (Redis)

```
price:SOL-USDC        STRING  latest tick JSON, set by price relay
channel "ticks"       PUBSUB  every tick; game servers subscribe and fan out
run:{id}              HASH    { score, multiplierBps, lives, lastTick }  TTL 1h (crash recovery)
lb:all                ZSET    member="{wallet}|{runId}", score=points
lb:{YYYY-MM-DD}       ZSET    daily window
rl:{wallet}           STRING  token-bucket counter, TTL 60s (rate limit POST /runs)
```

- Leaderboard reads: `ZREVRANGE lb:all 0 49 WITHSCORES` — O(log n + k), serves `GET /leaderboard` with a 1–2s HTTP cache (stale-while-revalidate).
- On settle: `ZADD lb:all <score> "<wallet>|<runId>"` and the daily key.
- Reconciliation job: every ~30s, read finalized `RunSession` accounts and correct any ZSET drift (on-chain wins).
- Client-side: predictive rendering is the real latency hide — the client simulates locally and only corrects on server `state`, so a 50–150ms WS round-trip never stutters the 60fps loop.

---

## 7. Implementation code (core pieces)

> SDK-exact CPI signatures for delegate/commit/undelegate: copy verbatim from the cloned `magicblock-engine-examples/anchor-counter`. The structure below is correct; the macro/CPI call shapes must match the example's version.

### 7.1 Anchor program — `programs/pump/src/lib.rs`

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

declare_id!("Pump1111111111111111111111111111111111111");

const MAX_POINTS_PER_EVENT: u64 = 5_000;
const MULT_MIN: u32 = 5_000;
const MULT_MAX: u32 = 100_000;

#[ephemeral]
#[program]
pub mod pump {
    use super::*;

    pub fn start_run(ctx: Context<StartRun>, seed: u64, side: u8, stake: u64) -> Result<()> {
        let r = &mut ctx.accounts.run;
        r.player = ctx.accounts.player.key();
        r.seed = seed;
        r.side = side;
        r.stake = stake;
        r.score = 0;
        r.multiplier_bps = 10_000;
        r.lives = 1;
        r.last_tick = 0;
        r.status = Status::Active as u8;
        r.started_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Delegate the RunSession PDA to the ER. Copy the delegate CPI body from anchor-counter.
    pub fn delegate_run(ctx: Context<DelegateRun>, seed: u64) -> Result<()> {
        ctx.accounts.delegate_run(
            &ctx.accounts.player,
            &[b"run", ctx.accounts.player.key.as_ref(), &seed.to_le_bytes()],
            DelegateConfig::default(),
        )?;
        Ok(())
    }

    /// Runs INSIDE the ER. Authoritative server signs with the session key.
    /// Enforces invariants so even a bad server can't write an impossible score.
    pub fn apply_event(ctx: Context<ApplyEvent>, tick: u32, points: u64, mult_delta: i32) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == Status::Active as u8, PumpError::NotActive);
        require!(tick > r.last_tick, PumpError::StaleTick);
        require!(points <= MAX_POINTS_PER_EVENT, PumpError::PointsTooHigh);

        let earned = points.saturating_mul(r.multiplier_bps as u64) / 10_000;
        r.score = r.score.saturating_add(earned);
        r.multiplier_bps = (r.multiplier_bps as i64 + mult_delta as i64)
            .clamp(MULT_MIN as i64, MULT_MAX as i64) as u32;
        r.last_tick = tick;

        commit_accounts(
            &ctx.accounts.player,
            vec![&r.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Runs INSIDE the ER. Final commit + hands the PDA back to base layer.
    pub fn end_run(ctx: Context<EndRun>) -> Result<()> {
        let r = &mut ctx.accounts.run;
        r.status = Status::Dead as u8;
        r.ended_at = Clock::get()?.unix_timestamp;
        commit_and_undelegate_accounts(
            &ctx.accounts.player,
            vec![&r.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Base layer. Idempotent: only Dead → Settled.
    pub fn settle(ctx: Context<Settle>, realized_pnl: i64) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == Status::Dead as u8, PumpError::NotSettleable);
        let base = realized_pnl.max(0) as u64;
        let payout = base.saturating_mul(r.multiplier_bps as u64) / 10_000;
        // transfer `payout` from escrow pot PDA to player (omitted: standard SPL/SOL transfer)
        r.payout = payout;
        r.status = Status::Settled as u8;
        Ok(())
    }
}

#[account]
pub struct RunSession {
    pub player: Pubkey,
    pub seed: u64,
    pub side: u8,
    pub stake: u64,
    pub score: u64,
    pub multiplier_bps: u32,
    pub lives: u8,
    pub last_tick: u32,
    pub status: u8,
    pub payout: u64,
    pub started_at: i64,
    pub ended_at: i64,
}

#[repr(u8)]
pub enum Status { Pending, Active, Dead, Settled, Void }

#[error_code]
pub enum PumpError {
    #[msg("run not active")] NotActive,
    #[msg("stale tick")] StaleTick,
    #[msg("points too high")] PointsTooHigh,
    #[msg("not settleable")] NotSettleable,
}
// Context structs (StartRun, DelegateRun, ApplyEvent, EndRun, Settle): mirror anchor-counter's
// account contexts, including magic_context / magic_program for the ER instructions.
```

### 7.2 Price relay — `services/price-relay/index.ts`

```ts
import WebSocket from "ws";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const up = new WebSocket(process.env.FLASHTRADE_WS_URL!); // from examples-v2 config
up.on("message", async (raw) => {
  const tick = parseFlashTick(raw);            // -> { symbol, price, ts }
  await redis.set(`price:${tick.symbol}`, JSON.stringify(tick));
  await redis.publish("ticks", JSON.stringify(tick));
});
up.on("close", () => process.exit(1));          // let the supervisor restart + reconnect
```

### 7.3 Game server (authoritative core) — `services/game-server/index.ts`

```ts
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import { deriveHazards } from "@pump/shared/rng";
import { altitudeFromPnl, checkCollision, COIN_POINTS } from "@pump/shared/constants";
import { applyEventTx, endRunTx, closePosition, settle } from "./onchain";

const sub = createClient({ url: process.env.REDIS_URL }); await sub.connect();
const runs = new Map<string, RunState>();       // MVP: in-memory, checkpoint to Redis

await sub.subscribe("ticks", (msg) => {
  const tick = JSON.parse(msg);
  for (const run of runs.values()) {
    run.price = tick.price;
    run.birdY = altitudeFromPnl(run);           // bird = live unrealized PnL
    if (run.birdY <= FLOOR) return kill(run, "liquidated");
    run.ws.send(JSON.stringify({ t: "tick", price: tick.price, birdY: run.birdY, pnlBps: run.pnlBps }));
  }
});

const wss = new WebSocketServer({ port: Number(process.env.WS_PORT) });
wss.on("connection", (ws) => {
  ws.on("message", async (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.t === "join") return attach(ws, m.runId, m.sessionKeyPubkey);
    const run = runFor(ws);
    if (m.t === "tap") return handleTap(run, m.seq);
    if (m.t === "cashout") return kill(run, "cashout");
  });
});

async function handleTap(run: RunState, seq: number) {
  run.birdVy = FLAP_IMPULSE;                     // server-authoritative physics
  const ev = checkCollision(run, deriveHazards(run.seed, run.scrollX));
  if (ev?.kind === "coin") {
    run.score += COIN_POINTS; run.multiplierBps += 250;
    await applyEventTx(run, COIN_POINTS, 250);   // signed by session key, gasless ER tx
    run.ws.send(JSON.stringify({ t: "event", kind: "coin", score: run.score, multiplierBps: run.multiplierBps }));
  } else if (ev?.kind === "hazard") {
    await kill(run, "hazard");
  }
}

async function kill(run: RunState, _reason: string) {
  await endRunTx(run);                            // commit + undelegate -> finalize on Solana
  const realized = await closePosition(run);      // close FlashTrade position
  run.ws.send(JSON.stringify({ t: "dead", finalScore: run.score, realizedPnl: realized, settle: "pending" }));
  const { payout, txSig } = await settle(run, realized);   // idempotent
  run.ws.send(JSON.stringify({ t: "settled", payoutLamports: payout, txSig }));
  runs.delete(run.id);
}
```

### 7.4 REST — `app/app/api/runs/route.ts` and leaderboard

```ts
// POST /api/runs
export async function POST(req: Request) {
  const { wallet, side, stakeLamports } = await req.json();
  if (await rateLimited(wallet)) return Response.json({ error: "slow down" }, { status: 429 });
  const seed = randomSeed();
  const run = await db.runs.insert({ wallet, side, stake_lamports: stakeLamports, seed, status: "pending" });
  return Response.json({ runId: run.id, seed: seed.toString(), wsUrl: process.env.WS_URL, pool: "devnet.1" });
}

// GET /api/leaderboard
export async function GET(req: Request) {
  const win = new URL(req.url).searchParams.get("window") ?? "all";
  const key = win === "daily" ? `lb:${today()}` : "lb:all";
  const rows = await redis.zRevRangeWithScores(key, 0, 49);
  return Response.json({ entries: await hydrate(rows) }, { headers: { "cache-control": "public, max-age=2" } });
}
```

### 7.5 Client game loop — `app/components/Game.tsx` (sketch)

```ts
// 60fps predictive loop. Bird altitude reconciles to server `tick`; hazards from shared RNG.
function loop(dt: number) {
  bird.vy += GRAVITY * dt; bird.y += bird.vy * dt;            // predicted
  bird.y = lerp(bird.y, server.birdY, 0.2);                   // reconcile to authoritative
  scrollX += SCROLL_SPEED * dt;
  const hazards = deriveHazards(seed, scrollX);               // SAME rng as server
  render(bird, hazards, coins, hud);                          // canvas draw
  requestAnimationFrame((t) => loop(t - last));
}
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.t === "tick")  server.birdY = m.birdY;
  if (m.t === "event") flashCoin();
  if (m.t === "state") { score = m.score; mult = m.multiplierBps; }
  if (m.t === "dead")  showDeath(m.finalScore, m.realizedPnl);
  if (m.t === "settled") showPayout(m.payoutLamports, m.txSig);
};
function onTap() { bird.vy = FLAP_IMPULSE; ws.send(JSON.stringify({ t: "tap", seq: seq++ })); }
```

---

## 8. Scalability notes (how this grows past the demo)

- Price fan-out: 1 upstream WS → Redis pub/sub → N game servers. Clients never touch FlashTrade directly.
- Horizontal game servers: a run is pinned to one instance (sticky WS); shard runs across instances by `runId` hash. State is in-memory with Redis checkpoints, so a crashed instance's runs can be recovered or voided cleanly.
- ER write throughput: gasless and sub-50ms, but throttle `apply_event` to meaningful events (coin, hazard, milestone) rather than every frame; one delegated PDA per run.
- Settlement: deaths enqueue settlement jobs; a worker pool drains the queue so a burst of deaths doesn't block the game loop. Idempotency via `settlements.idempotency_key`.
- Leaderboard: O(log n) ZSET writes, O(k) top-N reads; periodic on-chain reconciliation.

What MVP cuts (and why it's safe for a devnet hackathon): single instance, in-process price relay, settlement in the game loop, no worker pool. The interfaces above don't change when you split these out later.

---

## 9. The three correctness rules Claude Code must not violate

1. Never compute or trust score on the client. Taps carry intent (`seq`) only; the server simulates.
2. One real FlashTrade position per run — open at start, close at death. Never per-tap.
3. The ER program is the canonical score; settlement reads the finalized `RunSession`, not Postgres.

---

## 10. Build sequence — prompts for Claude Code (one at a time, verify each)

Order matters: prove each layer on devnet before stacking the next.

1. "Read PUMP_ARCHITECTURE.md and PUMP_SPEC.md. Create the monorepo structure in §2. In `packages/shared`, implement the deterministic seed RNG and game constants. Add the wire-protocol types from §4. Nothing on-chain yet."
2. "Scaffold the Anchor program in §7.1: `RunSession` account, `start_run`, `delegate_run`, `apply_event`, `end_run`, `settle`. Compile only — no ER wiring yet."
3. "Wire MagicBlock ER by copying the delegate/commit/undelegate CPI shapes from the cloned `magicblock-engine-examples/anchor-counter`. Make `delegate_run`, `apply_event` (commit), and `end_run` (commit+undelegate) work. Write a script that delegates a run PDA, applies 3 events in the ER, and undelegates on devnet. Verify finalized state on-chain."
4. "Build the price relay (§7.2) and the game server tick loop (§7.3) — for now drive bird altitude from a mocked price, no FlashTrade. Build the Next.js canvas client (§7.5) with predictive rendering and shared-RNG hazards. Playable single-player, no money."
5. "Replace the mocked price with the live FlashTrade feed from the cloned `examples-v2`. Bird altitude = live unrealized PnL."
6. "Tier 1: at run start open one real FlashTrade devnet position; on death close it and pass realized PnL into `settle`. Use the flashtrade MCP for the SDK calls."
7. "Wire score writes: server signs `apply_event` ER txs with a session key (from `flash-trade/session-keys`) so taps don't prompt signatures. Implement `settle` payout from an escrow pot PDA."
8. "Add the Postgres schema (§5), the REST routes (§7.4), and the Redis leaderboard ZSET (§6). Wire `GET /api/leaderboard`."
9. "Polish: death animation, coin sound, landing page, and the 30-second demo flow. Confirm the full lifecycle end-to-end on devnet."

After each prompt: run it, confirm a real on-chain result, then proceed. A working step 6 beats a half-built step 9.
