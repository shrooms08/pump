# CLAUDE.md — PUMP

PUMP is a Flappy-Bird-style game where the bird's altitude is a player's live PnL on a real FlashTrade perp, and the skill scoring (taps, coins, hazards) runs in a MagicBlock Ephemeral Rollup. Built for Solana Blitz v5 (theme: trading; must use MagicBlock; FlashTrade integration = +50% prize). Devnet only.

Full design: `PUMP_ARCHITECTURE.md`. Pitch + scope tiers: `PUMP_SPEC.md`. Build one numbered step at a time from `PUMP_ARCHITECTURE.md §10`; verify each on devnet before the next.

## Four rules that must never be violated
1. Score is server-authoritative. The client sends taps (intent + seq) only — never score. The game server re-simulates the run against the seeded world and live price. If you ever find yourself trusting a client-reported score, stop.
2. One real FlashTrade position per run — opened at start, closed at death. NEVER fire a perp per tap.
3. The Ephemeral Rollup `RunSession` is the canonical score. `settle()` reads the finalized on-chain account, never the Postgres copy. Postgres is for speed/history, not truth.
4. Client and server derive the identical hazard/coin layout from one `seed` using the SAME deterministic PRNG in `packages/shared`. No `Math.random` anywhere in game logic.

## Don't rebuild what's cloned
- MagicBlock ER delegate / commit / undelegate CPI shapes: copy verbatim from `magicblock-engine-examples/anchor-counter`. Do not invent SDK signatures — read the example.
- FlashTrade price feed + open/close position: reuse from the cloned `flash-trade/examples-v2` tap-trading template. Use the flashtrade MCP for SDK calls and signatures.
- Session keys: from `flash-trade/session-keys`.
- If unsure of any SDK signature, read the cloned source or the MCP — never guess.

## Stack & layout
- Anchor (Rust) program `programs/pump` using `ephemeral_rollups_sdk`.
- Next.js + canvas client `app/` (predictive rendering, reconciles to server `state`).
- Node WS game server `services/game-server` (authoritative loop, session-key signer).
- Price relay `services/price-relay` (one FlashTrade WS → Redis pub/sub).
- `packages/shared` (seed RNG, constants, wire types) imported by BOTH client and server.
- Postgres (Supabase) for records; Redis for price pub/sub, leaderboard ZSET, checkpoints.

## Conventions
- Devnet everywhere. Tier 0 (own pot, FlashTrade price feed) must work end-to-end before Tier 1 (real perp).
- Deliver complete files, not diffs.
- Throttle `apply_event` ER writes to meaningful events (coin/hazard/milestone), not every frame.
- `settle()` and position-close must be idempotent.
- Each step ends with a real on-chain result verified on devnet before moving on.

## MVP cuts (scoped, not wrong)
Single game-server instance; price relay can run in-process; settlement in the game loop; no worker pool. Keep the interfaces from the architecture doc so these split out later without rework.
