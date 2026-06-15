/**
 * B1 verification — proves a run is attributed to the PLAYER's wallet, not the
 * server. Emulates the browser client headlessly with a funded "player" keypair:
 *
 *   1. POST /runs { owner } → get the server-prepared createSessionV2 tx
 *   2. player wallet signs it once, submit to devnet, confirm → session-ready
 *   3. join the WS, thread candle gaps to score (start_run/delegate/apply/end)
 *   4. read the finalized RunSession on BASE devnet and assert player == wallet
 *
 *   PLAYER_KEYPAIR=/tmp/pump-player.json pnpm exec tsx scripts/session-verify.ts
 */
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { deriveHazards, birdWorldX } from "../packages/shared/src/index.js";

const HTTP = process.env.GAME_HTTP || "http://localhost:8799";
const RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const RUN_SEED = "run";

function loadKp(path: string): web3.Keypair {
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

async function main() {
  const player = loadKp(process.env.PLAYER_KEYPAIR || "/tmp/pump-player.json");
  console.log(`player wallet: ${player.publicKey.toBase58()}`);

  const conn = new web3.Connection(RPC, "confirmed");
  const bal = await conn.getBalance(player.publicKey);
  console.log(`player balance: ${bal / web3.LAMPORTS_PER_SOL} SOL`);

  const price = (await (await fetch(`${HTTP}/health`)).json()).price as number;
  const run = (await (
    await fetch(`${HTTP}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "long", entryPrice: price, owner: player.publicKey.toBase58() }),
    })
  ).json()) as {
    runId: string;
    seed: string;
    wsUrl: string;
    session?: { sessionSigner: string; sessionTokenPda: string; txB64: string } | null;
  };
  console.log(`run ${run.runId.slice(0, 8)} seed ${run.seed} · session ${run.session ? "prepared" : "NONE (fallback)"}`);

  // ── authorize the session: ONE wallet signature ──────────────────────────
  if (run.session) {
    const tx = web3.Transaction.from(Buffer.from(run.session.txB64, "base64"));
    tx.partialSign(player); // adds the wallet sig alongside the server's session-key sig
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`createSessionV2 confirmed: ${sig.slice(0, 16)}…  signer=${run.session.sessionSigner.slice(0, 8)}`);
    const ready = (await (await fetch(`${HTTP}/runs/${run.runId}/session-ready`, { method: "POST" })).json()) as {
      ready?: boolean;
    };
    console.log(`session-ready: ${ready.ready}`);
    if (!ready.ready) throw new Error("server did not confirm session ready");
  }

  // ── play to score ────────────────────────────────────────────────────────
  let serverFinalScore = 0;
  let deathAt = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(run.wsUrl);
    let seq = 0;
    let score = 0;
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", runId: run.runId }));
    ws.onmessage = (e: MessageEvent) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      if (m.t === "tick") {
        const bx = birdWorldX(m.scrollX);
        const hazards = deriveHazards(run.seed, m.scrollX);
        const ahead = hazards.filter((h) => h.x + 40 >= bx).sort((a, b) => a.x - b.x);
        const target = ahead.length ? ahead[0]!.gapY : 500;
        if (m.birdY < target + 10 && ws.readyState === 1) ws.send(JSON.stringify({ t: "tap", seq: seq++ }));
      } else if (m.t === "event") {
        score = m.score;
      } else if (m.t === "dead") {
        serverFinalScore = m.finalScore;
        deathAt = Date.now();
        console.log(`DEAD — server authoritative finalScore=${m.finalScore} (last event score ${score})`);
        ws.close();
        resolve();
      }
    };
    ws.onerror = (err) => reject(err as unknown as Error);
    setTimeout(() => {
      // force death via cashout if the bot didn't crash in time
      try {
        if (!deathAt) ws.send(JSON.stringify({ t: "cashout" }));
      } catch {
        /* ignore */
      }
    }, 30000);
    setTimeout(() => {
      ws.close();
      resolve();
    }, 40000);
  });

  // ── poll the finalized RunSession on BASE; measure finalization latency ────
  const idl = JSON.parse(readFileSync(new URL("../target/idl/pump.json", import.meta.url), "utf8")) as anchor.Idl;
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(player), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;
  const seedBuf = new BN(run.seed).toArrayLike(Buffer, "le", 8);
  const [runPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(RUN_SEED), player.publicKey.toBuffer(), seedBuf],
    program.programId,
  );
  console.log(`RunSession PDA (seeded by player): ${runPDA.toBase58()}`);
  console.log("polling base for finalization (status=Dead)…");

  let acct: { player: web3.PublicKey; score: BN; status: number } | null = null;
  const start = Date.now();
  for (let i = 0; i < 40; i++) {
    try {
      const a = (await program.account.runSession.fetch(runPDA, "confirmed")) as {
        player: web3.PublicKey;
        score: BN;
        status: number;
      };
      if (a.status === 2 /* Dead */) {
        acct = a;
        break;
      }
    } catch {
      /* not on base yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!acct) {
    console.log("\n❌ FAIL — run did not finalize (status never reached Dead).");
    process.exit(1);
  }

  const finalizeMs = Date.now() - (deathAt || start);
  const owner = acct.player.toBase58();
  const onchainScore = Number(acct.score.toString());
  console.log(`\nfinalized RunSession.player = ${owner}`);
  console.log(`my wallet               = ${player.publicKey.toBase58()}`);
  console.log(`on-chain score=${onchainScore}  server finalScore=${serverFinalScore}  status=${acct.status}`);
  console.log(`finalization latency after death: ${(finalizeMs / 1000).toFixed(1)}s`);

  const attribOk = owner === player.publicKey.toBase58();
  const scoreOk = onchainScore === serverFinalScore;
  const fastOk = finalizeMs < 30000; // must be far below the old ~70s stall
  console.log(`\nattribution: ${attribOk ? "✅" : "❌"}  score match: ${scoreOk ? "✅" : "❌"}  fast finalize (<30s): ${fastOk ? "✅" : "❌"}`);
  if (attribOk && scoreOk && fastOk) {
    console.log("✅ PASS — fast finalization, authoritative score, player-attributed.");
  } else {
    console.log("❌ FAIL");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
