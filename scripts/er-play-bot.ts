/**
 * Headless autopilot — joins a run and threads candle gaps (using the shared
 * deterministic layout) so it actually SCORES, exercising the live ER write path
 * (start_run/delegate → apply_event per score → end_run). For verification only.
 *
 *   pnpm exec tsx scripts/er-play-bot.ts
 */
import { deriveHazards, birdWorldX } from "../packages/shared/src/index.js";

const HTTP = process.env.GAME_HTTP || "http://localhost:8787";

async function main() {
  const price = (await (await fetch(`${HTTP}/health`)).json()).price as number;
  const run = (await (
    await fetch(`${HTTP}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "long", entryPrice: price }),
    })
  ).json()) as { runId: string; seed: string; wsUrl: string };
  console.log(`bot: run ${run.runId.slice(0, 8)} seed ${run.seed}`);

  const ws = new WebSocket(run.wsUrl);
  let seq = 0;
  let score = 0;
  ws.onopen = () => ws.send(JSON.stringify({ t: "join", runId: run.runId, sessionKeyPubkey: "" }));
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (m.t === "tick") {
      // aim for the gap-center of the next candle ahead; bang-bang flap control.
      const bx = birdWorldX(m.scrollX);
      const hazards = deriveHazards(run.seed, m.scrollX);
      const ahead = hazards.filter((h) => h.x + 40 >= bx).sort((a, b) => a.x - b.x);
      const target = ahead.length ? ahead[0]!.gapY : 500;
      if (m.birdY < target + 10 && ws.readyState === 1) ws.send(JSON.stringify({ t: "tap", seq: seq++ }));
    } else if (m.t === "event") {
      score = m.score;
    } else if (m.t === "dead") {
      console.log(`bot: DEAD finalScore=${m.finalScore} (events scored ${score})`);
      ws.close();
      process.exit(0);
    }
  };
  ws.onerror = () => process.exit(1);
  setTimeout(() => {
    console.log("bot: timeout, closing (run still scoring)");
    ws.close();
    process.exit(0);
  }, 40000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
