/**
 * Read a finalized RunSession from the BASE layer (devnet) and print its score.
 *
 *   pnpm exec tsx scripts/er-read.ts <RunSession PDA>
 *
 * The game server logs the PDA on run end ([er] … FINALIZED on base · PDA <…>).
 * Env: PROVIDER_ENDPOINT / ANCHOR_PROVIDER_URL (default devnet).
 */
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";

const pda = process.argv[2];
if (!pda) {
  console.error("usage: tsx scripts/er-read.ts <RunSession PDA>");
  process.exit(1);
}

const idl = JSON.parse(readFileSync(new URL("../target/idl/pump.json", import.meta.url), "utf8")) as anchor.Idl;
const conn = new anchor.web3.Connection(
  process.env.PROVIDER_ENDPOINT || process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
  "confirmed",
);
// Read-only: a dummy wallet is fine, we never sign.
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(web3.Keypair.generate()), { commitment: "confirmed" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const program = new Program(idl, provider) as any;

const STATUS = ["Pending", "Active", "Dead", "Settled", "Void"];

async function main() {
  const acct = (await program.account.runSession.fetch(new web3.PublicKey(pda), "confirmed")) as {
    player: web3.PublicKey;
    seed: anchor.BN;
    score: anchor.BN;
    multiplierBps: number;
    lastTick: number;
    status: number;
  };
  console.log("=== Finalized RunSession (base devnet) ===");
  console.log("PDA:            ", pda);
  console.log("player:         ", acct.player.toBase58());
  console.log("seed:           ", acct.seed.toString());
  console.log("score:          ", acct.score.toString());
  console.log("multiplier_bps: ", acct.multiplierBps);
  console.log("last_tick:      ", acct.lastTick);
  console.log("status:         ", acct.status, `(${STATUS[acct.status] ?? "?"})`);
}

main().catch((e) => {
  console.error("read failed:", (e as Error).message);
  process.exit(1);
});
