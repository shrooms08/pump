/**
 * Headless verification of the Step-4 game loop (stands in for the browser).
 * POSTs /runs, joins over WS, taps periodically, and prints the tick/event/
 * state/dead stream so we can confirm the authoritative loop end-to-end.
 *
 *   pnpm exec tsx scripts/loop-smoke.ts
 */
// Uses Node's global WebSocket + fetch (Node 22+), so no extra deps needed.
const HTTP = process.env.GAME_HTTP || "http://localhost:8787";

async function main() {
  const res = await fetch(`${HTTP}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ side: "long" }),
  });
  const run = (await res.json()) as { runId: string; seed: string; wsUrl: string; pool: string };
  console.log("created run:", run.runId, "seed:", run.seed, "pool:", run.pool);

  const ws = new WebSocket(run.wsUrl);
  let ticks = 0;
  let events = 0;
  let lastState: unknown = null;
  let seq = 0;
  let tapTimer: ReturnType<typeof setInterval>;

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "join", runId: run.runId, sessionKeyPubkey: "" }));
    // Flap a few times a second to stay airborne and grab coins.
    tapTimer = setInterval(() => ws.send(JSON.stringify({ t: "tap", seq: seq++ })), 280);
  };

  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (m.t === "tick") {
      ticks++;
      if (ticks % 20 === 0) {
        console.log(
          `tick #${ticks}  price=${m.price.toFixed(2)}  pnlBps=${m.pnlBps}  birdY=${m.birdY.toFixed(1)}  scrollX=${m.scrollX.toFixed(0)}`,
        );
      }
    } else if (m.t === "event") {
      events++;
      console.log(`  event ${m.kind}  score=${m.score}  mult=${m.multiplierBps}`);
    } else if (m.t === "state") {
      lastState = m;
    } else if (m.t === "dead") {
      console.log(`DEAD  finalScore=${m.finalScore}  realizedPnl=${m.realizedPnl}  settle=${m.settle}`);
    } else if (m.t === "settled") {
      console.log(`SETTLED  payout=${m.payoutLamports}  tx=${m.txSig}`);
      clearInterval(tapTimer);
      console.log(`\nsummary: ticks=${ticks} events=${events} lastState=${JSON.stringify(lastState)}`);
      ws.close();
      process.exit(0);
    }
  };

  ws.onerror = () => {
    console.error("ws error connecting to", run.wsUrl);
    process.exit(1);
  };

  // Safety timeout.
  setTimeout(() => {
    console.log(`\n[timeout] ticks=${ticks} events=${events} — closing`);
    ws.close();
    process.exit(0);
  }, 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
