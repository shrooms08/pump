# PUMP

**A trading app you play.** PUMP is a SOL trading terminal where you open a
position and then *ride it* — the terminal's live candlestick chart zooms into a
Flappy-Bird game played on your own candles, the bird's altitude is your live
PnL, and the run's skill score is finalized on-chain in a **MagicBlock Ephemeral
Rollup**, attributed to your wallet, and ranked on a live on-chain leaderboard.
The whole surface is rendered as a hand-drawn notebook / trader's-desk page.

Built for Solana Blitz v5 (theme: trading; uses MagicBlock; integrates
FlashTrade). **Devnet.**

Solana program: [`Ev2NEthdMuGpiCQHUMqRuzZsagYcvF3xbk58zedxVzeF`](https://explorer.solana.com/address/Ev2NEthdMuGpiCQHUMqRuzZsagYcvF3xbk58zedxVzeF?cluster=devnet)

---

## What you do

1. **Terminal** — connect a wallet, watch the live SOL candlestick chart (Pyth-seeded
   history + live FlashTrade oracle ticks), and **open a position** (side, stake,
   leverage). Simulated by default.
2. **Close** any time from the positions panel — realized PnL, independent of the game.
3. **Ride the chart** — click the chart (or the panel's *Ride ▲*). It zooms from the
   chart rectangle into the game. Your position is now the bird; tap to flap, thread
   the candle hazards, grab coins for multiplier. Altitude = your live PnL.
4. On death the run's **score finalizes on-chain** (~3–7s) and posts to the
   **leaderboard**, ranked by the finalized on-chain score, with your wallet highlighted.

The game itself is classic Flappy physics on a deterministic, seeded candle world —
the chart you traded becomes the level.

---

## Architecture — three trust zones

```
   CLIENT (untrusted)            GAME SERVER (authoritative)        ON-CHAIN (canonical truth)
 ┌──────────────────────┐      ┌───────────────────────────┐     ┌────────────────────────────┐
 │ Next.js terminal +   │ taps │ Node WS loop:             │ ER  │ MagicBlock Ephemeral Rollup │
 │ canvas game          │─────▶│ re-simulates the run vs   │────▶│   RunSession PDA = the      │
 │ predictive rendering │ only │ the SAME seeded world,    │     │   canonical score            │
 │ sends intent, never  │◀─────│ computes the score,       │◀────│ Solana devnet (base layer)  │
 │ outcomes             │ state│ signs the ER writes       │     │   finalized RunSession      │
 └──────────────────────┘      └───────────────────────────┘     │ FlashTrade (price + perp)   │
                                                                  └────────────────────────────┘
```

- **Client — untrusted.** Sends taps (intent + seq) only; never a score. Renders
  predictively and reconciles to the server's authoritative state.
- **Game server — authoritative.** Subscribes to one price stream, runs a fixed-timestep
  loop, derives the same hazard/coin layout from the run `seed` using the shared
  deterministic PRNG (`packages/shared`, no `Math.random` in game logic), computes the
  score server-side, and signs the Ephemeral Rollup transactions. The client can't lie
  about its score.
- **On-chain — source of truth.** The ER `RunSession` is the canonical score; the
  finalized account on Solana devnet is what the leaderboard reads. FlashTrade supplies
  the price feed and the (opt-in) real perp.

### Trust rules (enforced, not aspirational)
- Score is **server-authoritative** — the server re-simulates; a client-reported score is never trusted.
- **One** position per run — opened at start, closed at death/cash-out. Never a perp per tap.
- The **ER RunSession is the canonical score**; settlement reads the finalized on-chain account, not the cache.
- Client and server derive the **identical** layout from one `seed` with the same PRNG.

---

## How the Ephemeral Rollup is used

Per run, signed by the run's **session key** (see below), gated behind `ER_ENABLED`:

```
start_run   (base devnet)  create the RunSession PDA  [b"run", player, seed]
delegate    (base devnet)  delegate the PDA to the MagicBlock ER validator
apply_event (ER)           per scoring event — SENT without blocking on confirmation
                           (the ER is fast; the txs land). Best-effort live writes.
end_run     (ER)           commit_and_undelegate, and SET the authoritative final
                           score → finalizes on the base layer (~3–7s)
```

The score the leaderboard ranks by is the **finalized on-chain `RunSession.score`**,
reconciled to the server's authoritative score by `end_run` so a dropped intermediate
`apply_event` confirmation can never make the final score wrong. The ER wiring
(`#[delegate]`, `MagicIntentBundleBuilder` commit / commit_and_undelegate) mirrors the
MagicBlock examples verbatim.

### Per-player session keys
Runs belong to the **player**, not the server. On run start the player's wallet signs
**once** to authorize an ephemeral session key (gum `createSessionV2`), and that
server-held session key signs every in-run ER transaction — so taps never prompt, yet
the finalized `RunSession.player` is the player's real wallet (enabling a real
leaderboard). The on-chain program accepts either the owner's signature *or* a valid
session token (`#[session_auth_or]`, `SessionTokenV2`), and falls back to server-signing
if session setup fails so a run never breaks.

---

## FlashTrade integration

- **Price feed (always on):** the live SOL price is the FlashTrade V2 oracle
  (`GET https://flashapi.trade/v2/prices/SOL`, read-only, no auth/key). One relay
  connection fans out to every client and the game loop via Redis, so the chart and the
  bird never disagree.
- **Real perp (opt-in, capped):** an opt-in "real mode" opens an actual Flash V2 perp on
  **mainnet** behind a blocking confirmation modal, hard-capped in code (≤ $2 notional,
  ≤ 2× leverage) and gated on a basket preflight. It is **off by default and not part of
  the devnet demo flow** — the demo runs fully in simulated mode (devnet). Real mode
  exists to show the integration path; treat it as experimental.

---

## Stack & layout

- `programs/pump` — Anchor program (`ephemeral_rollups_sdk` + `session-keys`): RunSession,
  `start_run` / `delegate_run` / `apply_event` / `end_run` / `settle`.
- `app/` — Next.js + canvas client: the trading terminal (custom Rough.js candlestick
  chart, trade panel, positions, leaderboard) and the Flappy game.
- `services/game-server` — authoritative WS loop, ER signer, leaderboard indexer.
- `services/price-relay` — one price source → Redis pub/sub.
- `packages/shared` — seeded PRNG, constants, wire types (imported by client **and** server).
- Redis — price pub/sub + leaderboard sorted set.

---

## Run it locally

**Prereqs:** Node 20+, pnpm, and Redis.

```bash
redis-server --daemonize yes                    # Homebrew: brew install redis
# or: docker run --rm -p 6379:6379 redis:7-alpine   (pnpm redis)

pnpm install
cp .env.example .env        # tweak as needed; see below
```

### Off-chain (no wallet, no chain) — fastest way to see it
```bash
pnpm dev          # price-relay + game-server + Next.js app, together → http://localhost:3000
```
Or per process: `pnpm dev:relay`, `pnpm dev:server`, `pnpm dev:app`.

### Price source
```bash
PRICE_SOURCE=mock pnpm dev         # seeded random walk (default; offline-safe)
PRICE_SOURCE=flashtrade pnpm dev   # live FlashTrade SOL oracle
```

### On-chain mode (ER writes + leaderboard)
Run the game-server with `ER_ENABLED=true` and a funded devnet keypair. With ER off,
the app runs fully but records nothing on-chain (the leaderboard stays empty).

```bash
ER_ENABLED=true KEYPAIR_PATH=~/.config/solana/id.json pnpm dev:server
```

Key env (full list with comments in [`.env.example`](.env.example)):

| var | what |
|-----|------|
| `REDIS_URL` | Redis for price pub/sub + leaderboard |
| `PRICE_SOURCE` | `mock` (default) or `flashtrade` |
| `ER_ENABLED` | `true` to write finalized RunSessions on-chain (default `false`) |
| `KEYPAIR_PATH` | devnet keypair for the server-fallback signing path (**path only — never commit the key**) |
| `PROVIDER_ENDPOINT` | base devnet RPC (public works; a private RPC avoids rate limits — don't commit a URL with an api-key) |
| `EPHEMERAL_PROVIDER_ENDPOINT` / `VALIDATOR` | MagicBlock ER endpoint + validator identity |
| `NEXT_PUBLIC_GAME_HTTP` | game-server URL the browser uses |
| `NEXT_PUBLIC_SOLANA_RPC` | devnet RPC the browser uses for the session-key authorization tx |

> **Secrets:** never commit `.env`, keypair/wallet JSONs, or any RPC URL containing an
> api-key. `.gitignore` excludes `.env*` (keeps `.env.example`), `*-keypair.json`,
> `wallet*.json`, `id.json`, `target/`, `node_modules/`, `.next/`.

---

## Verify on-chain

```bash
pnpm exec tsx scripts/er-read.ts <RunSession_PDA>   # read a finalized RunSession from devnet
pnpm exec tsx scripts/session-verify.ts             # end-to-end: session key → play → finalize → assert player == wallet
```

Design docs: [`PUMP_ARCHITECTURE.md`](PUMP_ARCHITECTURE.md), [`PUMP_SPEC.md`](PUMP_SPEC.md).
