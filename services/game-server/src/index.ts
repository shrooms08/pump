/**
 * Game server (PUMP_ARCHITECTURE.md §7.3) — the authoritative loop.
 *
 * - Subscribes to Redis `ticks` for the live (mocked) price.
 * - Serves POST /runs to register a run (MVP: folded in here; moves to a Next.js
 *   route in Step 8) and a WebSocket at /ws for play.
 * - Runs a fixed-timestep simulation: derives bird altitude from price, checks
 *   collisions/coins against the shared seeded layout, and broadcasts
 *   tick / event / state / dead. Score is computed server-side only.
 * - ER apply_event writes are STUBBED (services/game-server/src/onchain.ts).
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { createClient } from "redis";
import {
  SIM_HZ,
  FLAP_IMPULSE,
  COIN_POINTS,
  HAZARD_CLEAR_POINTS,
  COIN_MULT_DELTA_BPS,
  type Side,
  type ClientMessage,
  type ServerMessage,
  type LeaderboardEntry,
  type LeaderboardResponse,
} from "@pump/shared";
import { createRunState, stepRun, type RunState, type DeathReason } from "./run.js";
import {
  erStartRun,
  applyEventTx,
  endRunTx,
  closePosition,
  settle,
  prepareSession,
  markSessionReady,
  setFinalizedHandler,
  type FinalizedRun,
} from "./onchain.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT || 8787);
const SYMBOL = process.env.PRICE_SYMBOL || "SOL-USDC";
const WS_URL = process.env.GAME_WS_URL || `ws://localhost:${PORT}/ws`;
const POOL = process.env.POOL || "devnet.1";
const DT = 1 / SIM_HZ;
const STATE_HEARTBEAT_MS = 500;

const runs = new Map<string, RunState>();
let latestPrice = 0;

// Redis cache client (price seed + leaderboard). Assigned in main(); module-scoped
// so the leaderboard recorder and HTTP reader can use it.
let cache: ReturnType<typeof createClient> | null = null;

// ── leaderboard (Redis ZSET, architecture §6) ────────────────────────────────
// lb:all  ZSET  member=wallet, score=best finalized on-chain points (one row/player)
// lb:meta HASH  field=wallet → JSON { score, multiplierBps, pda, runId, ts }
const LB_ZSET = "lb:all";
const LB_META = "lb:meta";

/** Record a finalized run on the board — best score per player wins. Source of
 *  truth is the authoritative on-chain score passed in from end_run finalization. */
async function recordFinalized(r: FinalizedRun): Promise<void> {
  const c = cache;
  if (!c) return;
  try {
    const prev = await c.zScore(LB_ZSET, r.wallet);
    if (prev !== null && r.score <= prev) return; // not a new best — keep the higher
    await c.zAdd(LB_ZSET, { score: r.score, value: r.wallet });
    await c.hSet(
      LB_META,
      r.wallet,
      JSON.stringify({ score: r.score, multiplierBps: r.multiplierBps, pda: r.pda, runId: r.runId, ts: r.ts }),
    );
    console.log(`[lb] recorded ${r.wallet.slice(0, 8)} score=${r.score} (prev=${prev ?? "—"})`);
  } catch (e) {
    console.error("[lb] record failed:", (e as Error).message);
  }
}

/** Read the top N players + the connected wallet's placement. */
async function readLeaderboard(me: string | null, limit: number): Promise<LeaderboardResponse> {
  const empty: LeaderboardResponse = { top: [], me: null, updatedAt: Date.now() };
  const c = cache;
  if (!c) return empty;
  const rows = await c.zRangeWithScores(LB_ZSET, 0, limit - 1, { REV: true });
  const meta = (await c.hGetAll(LB_META)) as Record<string, string>;
  const multOf = (wallet: string): number => {
    try {
      return meta[wallet] ? (JSON.parse(meta[wallet]).multiplierBps as number) : 0;
    } catch {
      return 0;
    }
  };
  const top: LeaderboardEntry[] = rows.map((row, i) => ({
    rank: i + 1,
    wallet: row.value,
    score: row.score,
    multiplierBps: multOf(row.value),
  }));

  let meEntry: LeaderboardEntry | null = null;
  if (me) {
    const inTop = top.find((e) => e.wallet === me);
    if (inTop) {
      meEntry = inTop;
    } else {
      const rank = await c.zRevRank(LB_ZSET, me); // 0-based, null if absent
      const score = await c.zScore(LB_ZSET, me);
      if (rank !== null && score !== null) {
        meEntry = { rank: rank + 1, wallet: me, score, multiplierBps: multOf(me) };
      }
    }
  }
  return { top, me: meEntry, updatedAt: Date.now() };
}

// ── run registry ───────────────────────────────────────────────────────────
function randomSeed(): string {
  // u64 decimal string — the same form the seed travels as on the wire (§3).
  return BigInt("0x" + randomBytes(8).toString("hex")).toString();
}

function createRun(
  side: Side,
  entryPrice = 0,
): { runId: string; seed: string; wsUrl: string; pool: string } {
  const id = randomUUID();
  const seed = randomSeed();
  runs.set(id, createRunState(id, seed, side, entryPrice));
  return { runId: id, seed, wsUrl: WS_URL, pool: POOL };
}

// ── WS helpers ───────────────────────────────────────────────────────────────
function send(run: RunState, msg: ServerMessage) {
  const ws = run.ws;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function killRun(run: RunState, reason: DeathReason) {
  if (run.status === "dead") return;
  run.status = "dead";
  const realizedPnl = await closePosition(run); // stub → returns pnlBps proxy
  await endRunTx(run); // ER: end_run (commit+undelegate) — finalizes in background
  send(run, { t: "dead", finalScore: run.score, realizedPnl, settle: "pending" });
  // Settlement is on-chain (Step 7); emit a stub so the client can show the flow.
  const { payoutLamports, txSig } = await settle(run, realizedPnl);
  send(run, { t: "settled", payoutLamports, txSig });
  console.log(
    `[game-server] run ${run.id.slice(0, 8)} dead (${reason}) score=${run.score} mult=${run.multiplierBps} pnlBps=${run.pnlBps}`,
  );
  runs.delete(run.id);
}

// ── simulation loop ───────────────────────────────────────────────────────────
function tickLoop() {
  const now = Date.now();
  for (const run of runs.values()) {
    if (run.status !== "active" || !run.ws) continue;
    run.price = latestPrice;

    const result = stepRun(run, DT);

    send(run, {
      t: "tick",
      price: run.price,
      birdY: run.birdY,
      pnlBps: run.pnlBps,
      scrollX: run.scrollX,
    });

    for (const ev of result.events) {
      send(run, ev);
      // Mirror the real throttling: only meaningful events hit the ER (Step 7).
      const points = ev.kind === "coin" ? COIN_POINTS : HAZARD_CLEAR_POINTS;
      const multDelta = ev.kind === "coin" ? COIN_MULT_DELTA_BPS : 0;
      void applyEventTx(run, points, multDelta);
    }

    if (result.scoreChanged || now - run.lastStateAt >= STATE_HEARTBEAT_MS) {
      run.lastStateAt = now;
      send(run, {
        t: "state",
        score: run.score,
        multiplierBps: run.multiplierBps,
        lives: run.lives,
      });
    }

    if (result.dead) void killRun(run, result.dead);
  }
}

// ── message handling ──────────────────────────────────────────────────────────
function handleMessage(ws: WebSocket, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  if (msg.t === "join") {
    const run = runs.get(msg.runId);
    if (!run) {
      ws.close(4004, "unknown run");
      return;
    }
    run.ws = ws;
    run.status = "active";
    run.startedAt = Date.now();
    run.lastStateAt = 0;
    // Only derive the entry from the live price if the run wasn't opened at a
    // known fill price (POST /runs entryPrice).
    if (run.entryPrice === 0 && latestPrice > 0) run.entryPrice = latestPrice;
    (ws as WebSocket & { runId?: string }).runId = run.id;
    // Kick off the on-chain ER lifecycle: start_run + delegate the RunSession PDA
    // (no-op unless ER_ENABLED). Runs in the background during the spawn runway.
    erStartRun(run);
    send(run, {
      t: "state",
      score: run.score,
      multiplierBps: run.multiplierBps,
      lives: run.lives,
    });
    console.log(`[game-server] join run ${run.id.slice(0, 8)} side=${run.side}`);
    return;
  }

  const runId = (ws as WebSocket & { runId?: string }).runId;
  const run = runId ? runs.get(runId) : undefined;
  if (!run || run.status !== "active") return;

  if (msg.t === "tap") {
    run.lastSeq = msg.seq;
    run.flapVy = FLAP_IMPULSE; // server-authoritative flap
  } else if (msg.t === "cashout") {
    void killRun(run, "cashout");
  }
}

// ── price stream (SSE) ────────────────────────────────────────────────────────
// Browsers (the terminal chart) get live ticks here. This fans out the SAME
// Redis `ticks` the game loop consumes — one price source of truth — so the
// chart and the bird never disagree. Read-only; no game/trade logic.
const priceClients = new Set<ServerResponse>();

function broadcastPrice(price: number, ts: number) {
  if (priceClients.size === 0) return;
  const frame = `data: ${JSON.stringify({ price, ts })}\n\n`;
  for (const res of priceClients) res.write(frame);
}

// ── HTTP (POST /runs, GET /health, GET /prices/stream) ───────────────────────
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function httpHandler(req: IncomingMessage, res: ServerResponse) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, runs: runs.size, price: latestPrice }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard") {
    const me = url.searchParams.get("me");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    void (async () => {
      try {
        const board = await readLeaderboard(me, limit);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(board));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    })();
    return;
  }

  if (req.method === "GET" && url.pathname === "/prices/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    priceClients.add(res);
    if (latestPrice > 0) res.write(`data: ${JSON.stringify({ price: latestPrice, ts: Date.now() })}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000); // keep proxies from closing it
    req.on("close", () => {
      clearInterval(ping);
      priceClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/runs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        let side: Side = 0;
        let entryPrice = 0;
        let owner: string | undefined;
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (parsed.side === "short" || parsed.side === 1) side = 1;
          if (typeof parsed.entryPrice === "number" && parsed.entryPrice > 0) entryPrice = parsed.entryPrice;
          if (typeof parsed.owner === "string" && parsed.owner.length >= 32) owner = parsed.owner;
        } catch {
          /* default long, derive entry from live price */
        }
        const run = createRun(side, entryPrice);
        // Prepare the per-run session key (player attribution). Best-effort: if it
        // returns null the run still works via the server-signed fallback.
        const session = owner ? await prepareSession(run.runId, owner) : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...run, session }));
      })();
    });
    return;
  }

  // POST /runs/:id/session-ready — the client confirms it submitted createSessionV2.
  const readyMatch = req.method === "POST" ? url.pathname.match(/^\/runs\/([^/]+)\/session-ready$/) : null;
  if (readyMatch) {
    const runId = decodeURIComponent(readyMatch[1]!);
    void (async () => {
      const ready = await markSessionReady(runId);
      res.writeHead(ready ? 200 : 202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready }));
    })();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function main() {
  const sub = createClient({ url: REDIS_URL });
  const cacheClient = createClient({ url: REDIS_URL });
  cache = cacheClient;
  sub.on("error", (e) => console.error("[game-server] redis sub error:", e.message));
  cacheClient.on("error", (e) => console.error("[game-server] redis error:", e.message));
  await Promise.all([sub.connect(), cacheClient.connect()]);

  // Index finalized runs onto the leaderboard (authoritative on-chain score).
  setFinalizedHandler((r) => void recordFinalized(r));

  // Seed latest price, then keep it fresh from the pub/sub stream.
  const seeded = await cacheClient.get(`price:${SYMBOL}`);
  if (seeded) latestPrice = JSON.parse(seeded).price ?? 0;
  await sub.subscribe("ticks", (raw) => {
    try {
      const tick = JSON.parse(raw);
      if (tick.symbol === SYMBOL) {
        latestPrice = tick.price;
        broadcastPrice(tick.price, tick.ts ?? Date.now()); // fan out to terminal chart (SSE)
      }
    } catch {
      /* ignore malformed tick */
    }
  });

  const server = createServer(httpHandler);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (buf) => handleMessage(ws, buf.toString()));
    ws.on("close", () => {
      const runId = (ws as WebSocket & { runId?: string }).runId;
      const run = runId ? runs.get(runId) : undefined;
      if (run && run.status === "active") void killRun(run, "cashout");
    });
  });

  setInterval(tickLoop, 1000 / SIM_HZ);
  server.listen(PORT, () => {
    console.log(`[game-server] http+ws on :${PORT} (ws ${WS_URL})`);
    console.log(`[game-server] redis ${REDIS_URL}, symbol ${SYMBOL}, sim ${SIM_HZ}Hz`);
  });
}

main().catch((e) => {
  console.error("[game-server] fatal:", e);
  process.exit(1);
});
