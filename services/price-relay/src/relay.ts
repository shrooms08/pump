/**
 * Price relay logic (PUMP_ARCHITECTURE.md §7.2), as an importable function.
 *
 * Publishes a SOL/USDC price to Redis for the game server to consume. The
 * downstream interface is fixed — `{ symbol, price, ts }` JSON on the
 * `price:<symbol>` key and the `ticks` channel — so swapping the source changes
 * nothing else (§6).
 *
 *   PRICE_SOURCE=mock        a seeded random walk (offline-safe demo fallback)
 *   PRICE_SOURCE=flashtrade  the LIVE FlashTrade SOL oracle price
 *
 * Run standalone via src/index.ts (`pnpm dev:relay`), OR in-process by the
 * game-server when RUN_RELAY_INLINE=true (Render free tier = one web service).
 * `startRelay({ inline: true })` never calls process.exit, so a held singleton
 * lock or bad config can't take the game-server down with it.
 */
import { createClient } from "redis";
import { mulberry32 } from "@pump/shared";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const SYMBOL = process.env.PRICE_SYMBOL || "SOL-USDC";
const SOURCE = (process.env.PRICE_SOURCE || "mock").toLowerCase();

interface Tick {
  symbol: string;
  price: number;
  ts: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Redis publish (identical for every source) ──────────────────────────────
/**
 * Singleton guard: a relay binds no port, so a second one doesn't fail like the
 * port-bound server/app — it silently publishes a SECOND price series to the
 * same key, and consumers see the price thrash between the two. We hold a
 * short-TTL Redis lock (refreshed) so a second relay refuses to publish; a
 * crashed relay's lock expires within TTL_MS so a clean restart still works.
 *
 * Returns true if the lock was acquired (this relay may publish), false if
 * another relay holds it — INLINE callers stay idle instead of crashing.
 */
const LOCK_KEY = "relay:singleton";
const LOCK_TTL_MS = 6000;
async function acquireSingletonLock(redis: ReturnType<typeof createClient>, inline: boolean): Promise<boolean> {
  const id = `${process.pid}@${Date.now()}`;
  // Retry while a held lock expires: a `tsx watch` hot-reload kills the old
  // instance and starts a new one before the old's lock release lands, so the
  // new one must wait out the (≤TTL) stale lock rather than refuse outright. A
  // genuinely concurrent second relay keeps refreshing its lock, so these
  // retries never succeed and it stays idle — the singleton guarantee holds.
  let ok: string | null = null;
  for (let attempt = 0; attempt < 9; attempt++) {
    ok = await redis.set(LOCK_KEY, id, { NX: true, PX: LOCK_TTL_MS });
    if (ok === "OK") break;
    await delay(1000);
  }
  if (ok !== "OK") return false;

  const refresh = setInterval(() => {
    void redis.set(LOCK_KEY, id, { PX: LOCK_TTL_MS }).catch(() => {});
  }, LOCK_TTL_MS / 3);
  const release = async () => {
    clearInterval(refresh);
    await redis.del(LOCK_KEY).catch(() => {});
  };
  // Release the lock on shutdown. Standalone owns the process (exit); inline
  // leaves exiting to the game-server, just freeing the lock.
  process.on("SIGINT", () => void release().then(() => !inline && process.exit(0)));
  process.on("SIGTERM", () => void release().then(() => !inline && process.exit(0)));
  return true;
}

/** Connect + acquire the lock. Returns a publish fn, or null if another relay
 *  holds the singleton lock (caller decides whether to idle or exit). */
async function makePublisher(inline: boolean): Promise<((t: Tick) => void) | null> {
  const redis = createClient({ url: REDIS_URL });
  redis.on("error", (e) => console.error("[price-relay] redis error:", e.message));
  await redis.connect();
  console.log(`[price-relay] connected to Redis`);
  if (!(await acquireSingletonLock(redis, inline))) return null;
  return async (tick: Tick) => {
    const payload = JSON.stringify(tick);
    try {
      await redis.set(`price:${tick.symbol}`, payload);
      await redis.publish("ticks", payload);
    } catch (e) {
      console.error("[price-relay] publish failed:", (e as Error).message);
    }
  };
}

// ── Source: mocked random walk ───────────────────────────────────────────────
function runMock(publish: (t: Tick) => void) {
  const INTERVAL_MS = Number(process.env.PRICE_INTERVAL_MS || 100); // 10 Hz
  const START_PRICE = Number(process.env.MOCK_START_PRICE || 150);
  const STEP_VOL = 0.0016;
  const STEP_DRIFT = 0.00002;
  const MEAN_REVERSION = 0.0008;
  const PRICE_FLOOR = 1;
  // Seeded PRNG (no Math.random) — this is an external-feed mock, not game logic.
  const rng = mulberry32((Date.now() ^ (process.pid << 16)) >>> 0);
  const gaussian = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let price = START_PRICE;
  console.log(`[price-relay] source=mock — emitting ${SYMBOL} every ${INTERVAL_MS}ms from ${START_PRICE}`);
  setInterval(() => {
    const reversion = (MEAN_REVERSION * (START_PRICE - price)) / START_PRICE;
    const ret = STEP_DRIFT + reversion + STEP_VOL * gaussian();
    price = Math.max(PRICE_FLOOR, price * (1 + ret));
    publish({ symbol: SYMBOL, price: Number(price.toFixed(4)), ts: Date.now() });
  }, INTERVAL_MS);
}

// ── Source: live FlashTrade SOL price ────────────────────────────────────────
function runFlashTrade(publish: (t: Tick) => void) {
  // apiBase mirrors the example's resolveNetwork(): hosted Flash V2 API, /v2 suffix.
  const API_BASE = (process.env.FLASH_V2_BASE_URL || "https://flashapi.trade/v2").replace(/\/$/, "");
  const FLASH_SYMBOL = process.env.FLASH_SYMBOL || "SOL"; // Flash's token symbol (the pair is vs USDC)
  const POLL_MS = Number(process.env.FLASH_POLL_MS || 1000); // example polls at 1s
  const PUBLISH_MS = Number(process.env.FLASH_PUBLISH_MS || 250); // re-publish (hold) cadence
  const STALE_HOLD_MS = Number(process.env.FLASH_STALE_HOLD_MS || 2000); // gap > this ⇒ hold, log
  const MAX_BACKOFF_MS = 10_000;
  const FETCH_TIMEOUT_MS = 4000;

  let lastPrice: number | null = null;
  let lastFetchAt = 0;
  let connected = false; // are we currently receiving fresh ticks?
  let gapLogged = false;

  console.log(`[price-relay] source=flashtrade — polling ${FLASH_SYMBOL} price every ${POLL_MS}ms (host redacted)`);

  async function fetchPrice(): Promise<number> {
    const res = await fetch(`${API_BASE}/prices/${encodeURIComponent(FLASH_SYMBOL)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as { priceUi?: number };
    if (typeof info.priceUi !== "number" || !Number.isFinite(info.priceUi) || info.priceUi <= 0) {
      throw new Error("invalid price payload");
    }
    return info.priceUi;
  }

  // Fetcher: self-scheduling loop with reconnect-and-backoff. Logs transitions
  // only (no URLs/keys), so a flapping feed doesn't spam the console.
  let backoff = POLL_MS;
  (async function pollLoop() {
    for (;;) {
      try {
        const p = await fetchPrice();
        lastPrice = p;
        lastFetchAt = Date.now();
        backoff = POLL_MS;
        if (!connected) {
          connected = true;
          gapLogged = false;
          console.log("[price-relay] FlashTrade feed connected");
        }
        await delay(POLL_MS);
      } catch (e) {
        if (connected) {
          connected = false;
          console.warn(`[price-relay] FlashTrade feed disconnected (${(e as Error).message}); backing off`);
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await delay(backoff);
      }
    }
  })();

  // Publisher: emits the last good price at a steady cadence. During a feed gap
  // it HOLDS the last price (steady bird) instead of going silent or, on
  // reconnect, lurching — we never publish until we have a real price.
  setInterval(() => {
    if (lastPrice === null) return; // no price yet — wait for the first fetch
    const gap = Date.now() - lastFetchAt;
    if (gap > STALE_HOLD_MS && !gapLogged) {
      console.warn(`[price-relay] no fresh price for ${Math.round(gap)}ms — holding last $${lastPrice}`);
      gapLogged = true;
    }
    publish({ symbol: SYMBOL, price: lastPrice, ts: Date.now() });
  }, PUBLISH_MS);
}

/**
 * Start the relay. Standalone (index.ts): exits on a held lock / bad config.
 * Inline (game-server, RUN_RELAY_INLINE=true): never exits — on a held lock it
 * stays idle (another relay is the source), so the web service keeps serving.
 */
export async function startRelay(opts: { inline?: boolean } = {}): Promise<void> {
  const inline = !!opts.inline;
  const publish = await makePublisher(inline);
  if (!publish) {
    if (inline) {
      console.warn("[price-relay] another relay holds the singleton lock — inline relay idle (ticks come from the other relay)");
      return;
    }
    console.error(
      "[price-relay] another price-relay is already publishing to this Redis — refusing to start a second " +
        "(it would thrash the price). Stop the other relay first (e.g. pkill -f price-relay).",
    );
    process.exit(1);
  }

  if (SOURCE === "flashtrade") runFlashTrade(publish);
  else if (SOURCE === "mock") runMock(publish);
  else {
    console.error(`[price-relay] unknown PRICE_SOURCE="${SOURCE}" (use mock|flashtrade)`);
    if (!inline) process.exit(1);
    return;
  }

  if (!inline) {
    const shutdown = () => process.exit(0);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
