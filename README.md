# PUMP

Flappy Bird where the bird's altitude is your live PnL on a FlashTrade perp, with
skill scoring in a MagicBlock Ephemeral Rollup. See `PUMP_ARCHITECTURE.md` and
`PUMP_SPEC.md` for the full design.

## Run the off-chain game loop (Step 4 — mocked price, no wallet, no chain)

You need **Redis** running locally. One line — pick whichever you have:

```bash
redis-server --daemonize yes            # if installed via Homebrew (brew install redis)
docker run --rm -p 6379:6379 redis:7-alpine   # or via Docker  (pnpm redis)
```

Then, from the repo root:

```bash
pnpm install
pnpm dev          # runs price-relay + game-server + Next.js app together
```

Or run each in its own terminal:

```bash
pnpm dev:relay    # price → Redis `ticks` (mock by default)
pnpm dev:server   # authoritative WS game loop on :8787
pnpm dev:app      # Next.js client on :3000
```

### Live price (Step 5)

The relay has two sources, chosen by `PRICE_SOURCE`:

```bash
PRICE_SOURCE=flashtrade pnpm dev   # bird rides the REAL live SOL price
PRICE_SOURCE=mock pnpm dev         # seeded random walk (default; offline-safe)
```

`flashtrade` polls the FlashTrade V2 oracle (`GET https://flashapi.trade/v2/prices/SOL`,
read-only, mainnet price — the real SOL value the HUD shows) once a second, with
reconnect-and-backoff and last-price hold across feed gaps. The game/program stay
on devnet; only the price is read from FlashTrade. Flip back to `mock` instantly if
the feed misbehaves mid-demo.

Open <http://localhost:3000>, pick **PUMP** (long) or **DUMP** (short), and play:

- The bird rides the mocked SOL price (your unrealized PnL). Price up → it climbs.
- **Tap / click the board / press Space** to flap through the hazard gaps and grab
  multiplier coins.
- You die on hazard collision or when the price dumps you to the liquidation floor.

Everything is server-authoritative: the client sends taps (intent) only; the
server simulates collisions, coins, score, and death against the seeded world and
the live price. On-chain ER writes are stubbed at this step.

## Layout

```
packages/shared     seed RNG, constants, physics, wire types (client AND server)
services/price-relay mocked price → Redis (Step 5 swaps in FlashTrade WS)
services/game-server authoritative loop (Step 7 wires ER + session keys)
app/                 Next.js + canvas client
programs/pump        Anchor program (deployed to devnet in Step 3)
scripts/er-smoke.ts  ER lifecycle smoke test
```

## Config

Copy `.env.example` values as needed (defaults work for local dev). The app reads
`NEXT_PUBLIC_GAME_HTTP` (default `http://localhost:8787`) to reach the game server.
