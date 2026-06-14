# PUMP — Build Spec (Solana Blitz v5)

> Flappy Bird where the bird's altitude is your **real** live PnL on a FlashTrade perp, and the dodge-the-hazards skill game runs inside a MagicBlock Ephemeral Rollup. The bird *is* the position. No fake numbers.

**Theme:** Trading. **Hard requirement:** uses MagicBlock. **+50% prize boost:** integrate FlashTrade. **Submit:** Sunday. **Chain target:** devnet first, mainnet only if time.

---

## 1. The one design decision everything hangs on

You cannot open a real FlashTrade perp *inside* your ER — FlashTrade's accounts aren't delegated to your rollup. So split cleanly:

- **Live price** → read from FlashTrade (oracle / price stream / WS). Read-only. No delegation needed.
- **Real money position** → one real FlashTrade perp, opened on run start, closed on death. Lives on mainnet/devnet.
- **Game state** (score, multiplier, hazards dodged, lives) → your own Anchor PDA, **delegated to the ER**. This is where the hundreds of gasless sub-50ms taps happen. Impossible on raw mainnet — this is *why* you need MagicBlock.

The bird's altitude = the **live unrealized PnL** of the real position. Price up → bird rises. Price down → bird sinks toward the liquidation floor. Honest, because the bird and the position track the exact same live price.

Payout = realized perp PnL **×** in-ER skill multiplier (or a pot weighted by score). Skill changes how much of the move you keep — the game layer is the edge, the perp is the stake.

---

## 2. Two build tiers (pick based on time left)

**Tier 1 — full (earns the +50% boost).** Real FlashTrade perp as the stake. Bird altitude = real position PnL. This is the target.

**Tier 0 — safe downgrade (still valid, no boost).** If perps get fiddly: use FlashTrade's **price feed** to drive altitude, and stake into a pot in your own ER-delegated program instead of a real perp. Still "uses FlashTrade" (price) + "uses MagicBlock" (required). Ship Tier 0 working, then upgrade to Tier 1.

Build order: get Tier 0 loop fully working end-to-end first, *then* swap the stake mechanic to a real perp. Never leave Tier 1 half-wired at submit.

---

## 3. Architecture

```
[Next.js client / canvas game loop]
   │  reads live price (WS)        ┌─────────────────────────┐
   ├──────────────────────────────▶│ FlashTrade (mainnet/dev)│
   │  open/close real position     │  perp DEX + price feed  │
   │                               └─────────────────────────┘
   │  taps: flap / dodge / collect
   ▼
[ER session PDA — delegated]        ┌─────────────────────────┐
   score, multiplier, lives, seed  │ MagicBlock ER           │
   hundreds of gasless writes ─────▶│ sub-50ms, devnet.magic  │
   commit on death                  │ block.app               │
   │                               └─────────────────────────┘
   ▼  commit_and_undelegate
[Your Anchor program — mainnet/devnet]
   final score finalized, payout settled
```

### Session lifecycle
1. **Start run:** player antes. Client opens ONE real FlashTrade position (Tier 1) or stakes pot (Tier 0). Your program creates a `RunSession` PDA, then **delegates** it to the ER.
2. **Play (in ER):** each tap = one ER instruction updating `score`, `multiplier`, `lives` on the delegated PDA. Gasless, sub-50ms. Hazards/coins are deterministic from a per-run `seed` so the run is verifiable.
3. **Death:** bird hits floor (price dumped) or crashes a hazard. Client closes the real position. Final ER instruction calls `commit_and_undelegate_accounts` → state finalizes on base layer.
4. **Settle:** your program reads final score + realized PnL, pays out.

---

## 4. On-chain program (Anchor + ephemeral_rollups_sdk)

State:

```rust
#[account]
pub struct RunSession {
    pub player: Pubkey,
    pub seed: u64,            // deterministic hazard RNG
    pub started_at: i64,
    pub side: u8,             // 0 = long/PUMP, 1 = short
    pub score: u64,
    pub multiplier: u32,      // basis points, starts 10_000
    pub lives: u8,
    pub alive: bool,
    pub stake_lamports: u64,
    pub position_ref: Pubkey, // FlashTrade position (Tier 1) or pot PDA (Tier 0)
}
```

Instructions:
- `start_run(seed, side, stake)` — init PDA, then `delegate_account(...)`
- `tap()` / `apply_event(kind)` — runs **in ER**, mutates score/multiplier/lives, then `commit_accounts(...)` periodically
- `end_run()` — final commit, `commit_and_undelegate_accounts(...)`
- `settle()` — base layer, compute payout = realized PnL × multiplier (Tier 1) or pot share (Tier 0)

Key constants (verify live, see §8):
- Delegation program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- ER devnet endpoint: `https://devnet.magicblock.app`
- SDK: `ephemeral_rollups_sdk` (Rust) — `delegate_account`, `commit_accounts`, `commit_and_undelegate_accounts`. TS SDK for client-side delegate/undelegate.
- Start from `magicblock-labs/magicblock-engine-examples` (Anchor Counter) — it's literally delegate → mutate → commit → undelegate. PUMP is that with a score instead of a counter.

---

## 5. FlashTrade integration (Tier 1)

- npm: `flash-sdk` → `PerpetualsClient`, `PoolConfig`, `Side`, `PositionAccount`
- Pool: devnet pools are `devnet.1`…`devnet.5`; mainnet `Crypto.1`. Use `PoolConfig.fromIdsByName('devnet.1', 'devnet')` to start.
- Open: `openPosition(inputTokenSymbol, outputTokenSymbol, inputAmount, side)` — fixed small leverage, ante = collateral.
- Close: `closePositionWithSwap(positionPubKey, ...)` on death/cash-out.
- Price for altitude: subscribe to the live price (WS / oracle) and recompute unrealized PnL each frame.
- **Connect the FlashTrade MCP to Claude Code** (`flash-trade/flash-trade-MCP`) so it can wire SDK calls and read docs without you copy-pasting signatures.

Gotcha: don't fire a perp trade on every tap — fees and min size will wreck it. **One position per run**, fixed direction chosen at entry. Taps only touch the in-ER game.

---

## 6. Client (Next.js + canvas)

- Canvas game loop at 60fps. Bird y-position = mapped live unrealized PnL. Floor = liquidation price.
- Tap → flap (dodge hazard / grab multiplier coin) → fires one ER tx via Magic Router to the delegated PDA.
- Deterministic hazards from `seed` so score is replayable/verifiable.
- HUD: live price, unrealized PnL, score, multiplier, lives.
- Wallet: session keys (FlashTrade ships a `session-keys` repo) so the player isn't signing every tap — critical for game feel.
- Leaderboard: read finalized `RunSession` accounts, sort by score. Global pot ranking.

---

## 7. Build plan (you have ~1.5 days — be ruthless)

**Block A — skeleton (first ~3h)**
- Clone `magicblock-engine-examples` Anchor Counter. Get delegate → increment-in-ER → commit → undelegate passing on devnet.
- Rename Counter → `RunSession`. Add `score`/`multiplier`. This is your whole ER core. Do not over-build.

**Block B — game loop (next ~4h)**
- Next.js canvas: bird, gravity, tap-to-flap, scrolling hazards from a seed, death on collision/floor.
- Wire FlashTrade WS price → bird altitude. Bird now rides the live chart. (Tier 0 visually done here.)

**Block C — bind money (next ~3h)**
- Tier 1: open/close one real FlashTrade devnet position at run start/end. Bind altitude to its real PnL.
- If it fights you past 90 min, ship Tier 0 (own pot) and move on.

**Block D — settle + leaderboard (next ~3h)**
- `end_run` commit+undelegate, `settle` payout, leaderboard reads finalized accounts.
- Session keys so taps don't prompt signatures.

**Block E — polish + demo (remaining time)**
- One juicy death animation, sound on coin grab, a clean landing page. Record the 30s demo. Register on Luma, write submission.

Cut list if behind: drop multiplayer, drop mainnet, drop multiple assets (SOL only), drop session keys (auto-approve in demo wallet). Never cut: delegate→commit→undelegate working, FlashTrade touched, a clean 30s demo.

---

## 8. Live docs for Claude Code to fetch (signatures drift — don't trust this file)
- MagicBlock Anchor flow: https://docs.magicblock.gg/Accelerate/Anchor/counter
- ER delegation concepts: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup
- ER examples repo: https://github.com/magicblock-labs/magicblock-engine-examples
- ER SDK: https://github.com/magicblock-labs/ephemeral-rollups-sdk
- FlashTrade build guide: https://docs.flash.trade/flash-trade/flash-trade/build-on-flash
- FlashTrade TS SDK + trade example: https://github.com/flash-trade/flash-trade-sdk
- FlashTrade MCP (connect to Claude Code): https://github.com/flash-trade/flash-trade-MCP
- FlashTrade × MagicBlock example: github.com/flash-trade/magicblock-grpc-example
- FlashTrade session keys: github.com/flash-trade/session-keys

---

## 9. The 30-second demo (this wins blitzes)
1. Ante. Pick PUMP (long). Bird spawns on the live SOL chart.
2. Price ticks up — bird climbs. Tap to grab a multiplier coin (in-ER, instant, no signature popup).
3. Price dips hard — bird plunges toward the liquidation floor — clutch flap, survive.
4. Cash out at the peak. Realized PnL × your multiplier hits the leaderboard. Pot pays.

Judge takeaway in one line: *"The game state runs gaslessly in the Ephemeral Rollup, the stake is a real FlashTrade perp, and they're the same live price — so it's a real trade you play instead of watch."*

---

## 10. Optional stretch (only if everything else is done)
- A "rival bird" AI riding the same chart with a simple momentum strategy — turns single-player into a race and gives you the agent-flavored differentiator. Cheap because it reads the same price feed and writes to the same ER.
