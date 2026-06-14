/**
 * ER smoke test (PUMP_ARCHITECTURE.md §10 step 3).
 *
 * Mirrors the connection routing of
 * ../magicblock-engine-examples/anchor-counter/tests/public-counter.ts:
 *   - a BASE-layer provider (devnet RPC) for start_run / delegate_run, and
 *   - an EPHEMERAL-ROLLUP provider (a second Program bound to the ER endpoint)
 *     for apply_event / end_run.
 *
 * Flow: start_run + delegate_run on the base RPC, 3 × apply_event on the ER,
 * then end_run (commit + undelegate). Finally re-read the RunSession from the
 * BASE RPC and print score / multiplier_bps / last_tick / status.
 *
 * Run:  pnpm exec tsx scripts/er-smoke.ts
 * Env overrides (all optional):
 *   PROVIDER_ENDPOINT / ANCHOR_PROVIDER_URL   base-layer RPC
 *   EPHEMERAL_PROVIDER_ENDPOINT               ER RPC   (default devnet.magicblock.app)
 *   EPHEMERAL_WS_ENDPOINT                      ER WS
 *   VALIDATOR                                  delegation validator identity
 *   ANCHOR_WALLET                              keypair (default ~/.config/solana/id.json)
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";

const RUN_SEED = "run";

const idl = JSON.parse(
  readFileSync(new URL("../target/idl/pump.json", import.meta.url), "utf8"),
) as anchor.Idl;

// ── Connection routing (copied from the anchor-counter example) ────────────
// Base layer: PROVIDER_ENDPOINT > ANCHOR_PROVIDER_URL > devnet fallback.
const provider = new anchor.AnchorProvider(
  new anchor.web3.Connection(
    process.env.PROVIDER_ENDPOINT ||
      process.env.ANCHOR_PROVIDER_URL ||
      "https://api.devnet.solana.com",
    { wsEndpoint: process.env.WS_ENDPOINT || undefined, commitment: "confirmed" },
  ),
  anchor.Wallet.local(),
);
anchor.setProvider(provider);

// Ephemeral rollup: defaults to the devnet ER endpoint specified for this step.
const providerEphemeralRollup = new anchor.AnchorProvider(
  new anchor.web3.Connection(
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app",
    {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app",
      commitment: "confirmed",
    },
  ),
  anchor.Wallet.local(),
);

const program = new Program(idl, provider);
const programEphemeral = new Program(idl, providerEphemeralRollup);

async function main() {
  const wallet = anchor.Wallet.local();
  console.log("Base Layer Connection:     ", provider.connection.rpcEndpoint);
  console.log("Ephemeral Rollup Connection:", providerEphemeralRollup.connection.rpcEndpoint);
  console.log("Program ID:                 ", program.programId.toString());
  console.log("Wallet:                     ", wallet.publicKey.toString());

  const balance = await provider.connection.getBalance(wallet.publicKey);
  console.log("Balance:                    ", balance / LAMPORTS_PER_SOL, "SOL\n");

  // Unique per-run seed so the RunSession PDA is fresh each smoke run.
  const seed = new BN(randomBytes(8));
  const seedBuf = seed.toArrayLike(Buffer, "le", 8);
  const [runPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(RUN_SEED), wallet.publicKey.toBuffer(), seedBuf],
    program.programId,
  );
  console.log("Run seed:", seed.toString());
  console.log("Run PDA: ", runPDA.toString(), "\n");

  // 1) start_run (BASE) — side 0 = long, stake 0.01 SOL (placeholder; no perp yet).
  {
    const start = Date.now();
    const tx = await program.methods
      .startRun(seed, 0, new BN(0.01 * LAMPORTS_PER_SOL))
      .accounts({ run: runPDA, player: wallet.publicKey })
      .transaction();
    const sig = await provider.sendAndConfirm(tx, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
    console.log(`${Date.now() - start}ms (Base) start_run: ${sig}`);
  }

  // 2) delegate_run (BASE) — pass the validator identity as a remaining account,
  //    exactly as the example's delegate() does.
  {
    const start = Date.now();
    const erEndpoint = providerEphemeralRollup.connection.rpcEndpoint;
    const isLocal = erEndpoint.includes("localhost") || erEndpoint.includes("127.0.0.1");
    const validatorPubkey = new web3.PublicKey(
      process.env.VALIDATOR ||
        (isLocal
          ? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
          : "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
    );
    const tx = await program.methods
      .delegateRun(seed)
      .accounts({ payer: wallet.publicKey, run: runPDA })
      .remainingAccounts([{ pubkey: validatorPubkey, isSigner: false, isWritable: false }])
      .transaction();
    const sig = await provider.sendAndConfirm(tx, [wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
    console.log(`${Date.now() - start}ms (Base) delegate_run: ${sig}`);
    // Give the ER a moment to pick up the freshly delegated account.
    await new Promise((r) => setTimeout(r, 3000));
  }

  // 3) 3 × apply_event (ER) — monotonic ticks, +100 points and +250 bps each.
  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    const sig = await programEphemeral.methods
      .applyEvent(i, new BN(100), 250)
      .accounts({ payer: wallet.publicKey, run: runPDA })
      .rpc();
    console.log(`${Date.now() - start}ms (ER) apply_event tick=${i}: ${sig}`);
  }

  // 4) end_run (ER) — commit + undelegate, then await the base-layer commitment.
  {
    const start = Date.now();
    const sig = await programEphemeral.methods
      .endRun()
      .accounts({ payer: wallet.publicKey, run: runPDA })
      .rpc();
    console.log(`${Date.now() - start}ms (ER) end_run: ${sig}`);
    try {
      const commitSig = await GetCommitmentSignature(
        sig,
        providerEphemeralRollup.connection,
      );
      console.log(`(Base) commit+undelegate finalized: ${commitSig}`);
    } catch (e) {
      console.log("GetCommitmentSignature wait skipped:", (e as Error).message);
    }
  }

  // 5) Read the finalized RunSession from the BASE layer.
  console.log("\nFetching finalized RunSession from the base layer...");
  let acct: any;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      acct = await program.account.runSession.fetch(runPDA, "confirmed");
      if (acct) break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!acct) throw new Error("RunSession not readable on the base layer after undelegate");

  console.log("\n=== Finalized RunSession (base layer) ===");
  console.log("score:          ", acct.score.toString());
  console.log("multiplier_bps: ", acct.multiplierBps);
  console.log("last_tick:      ", acct.lastTick);
  console.log("status:         ", acct.status, "(2 = Dead)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
