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
} from "@pump/shared";
import { createRunState, stepRun, type RunState, type DeathReason } from "./run.js";
import { erStartRun, applyEventTx, endRunTx, closePosition, settle } from "./onchain.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT || 8787);
const SYMBOL = process.env.PRICE_SYMBOL || "SOL-USDC";
const WS_URL = process.env.GAME_WS_URL || `ws://localhost:${PORT}/ws`;
const POOL = process.env.POOL || "devnet.1";
const DT = 1 / SIM_HZ;
const STATE_HEARTBEAT_MS = 500;

const runs = new Map<string, RunState>();
let latestPrice = 0;

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

// ── HTTP (POST /runs, GET /health) ───────────────────────────────────────────
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

  if (req.method === "POST" && url.pathname === "/runs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let side: Side = 0;
      let entryPrice = 0;
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.side === "short" || parsed.side === 1) side = 1;
        if (typeof parsed.entryPrice === "number" && parsed.entryPrice > 0) entryPrice = parsed.entryPrice;
      } catch {
        /* default long, derive entry from live price */
      }
      const run = createRun(side, entryPrice);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(run));
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function main() {
  const sub = createClient({ url: REDIS_URL });
  const cache = createClient({ url: REDIS_URL });
  sub.on("error", (e) => console.error("[game-server] redis sub error:", e.message));
  cache.on("error", (e) => console.error("[game-server] redis error:", e.message));
  await Promise.all([sub.connect(), cache.connect()]);

  // Seed latest price, then keep it fresh from the pub/sub stream.
  const seeded = await cache.get(`price:${SYMBOL}`);
  if (seeded) latestPrice = JSON.parse(seeded).price ?? 0;
  await sub.subscribe("ticks", (raw) => {
    try {
      const tick = JSON.parse(raw);
      if (tick.symbol === SYMBOL) latestPrice = tick.price;
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
