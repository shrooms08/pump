/**
 * On-chain side-effects of a run.
 *
 * ER score writes (apply_event/end_run) are now LIVE — the exact proven
 * lifecycle from scripts/er-smoke.ts (Step 3), moved into the running game
 * server and signed by a server "session key" (a devnet keypair the server
 * controls, so taps never prompt anyone). Gated behind ER_ENABLED so the
 * default flow is unchanged; failures are logged, never fatal (gameplay and the
 * trade path must not be affected).
 *
 *   per run on join:   start_run + delegate_run        → base devnet RPC
 *   per scoring event:  apply_event(tick, pts, mult)   → ER (devnet.magicblock.app)
 *   on run end:         end_run (commit + undelegate)   → finalizes on base
 *
 * The trade path (closePosition / settle) stays stubbed — untouched here.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { RunState } from "./run.js";

const ER_ENABLED = process.env.ER_ENABLED === "true";
const RUN_SEED = "run";

// Lazy one-time context (only built when ER is enabled and first used).
// program/programER are typed `any`: the IDL is loaded as a generic anchor.Idl,
// so the generated methods/accounts aren't statically typed. The exact calls are
// the proven ones from scripts/er-smoke.ts.
let ctx: {
  program: any;
  programER: any;
  signer: web3.PublicKey;
  validator: web3.PublicKey;
} | null = null;

function getCtx() {
  if (ctx) return ctx;
  const idl = JSON.parse(
    readFileSync(new URL("../../../target/idl/pump.json", import.meta.url), "utf8"),
  ) as anchor.Idl;
  const kpPath = (process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
  const secret = Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8")) as number[]);
  const wallet = new anchor.Wallet(web3.Keypair.fromSecretKey(secret));
  // Two-chain routing, exactly as er-smoke.ts: base devnet for setup, ER for trades.
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(
      process.env.PROVIDER_ENDPOINT || process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
      { commitment: "confirmed" },
    ),
    wallet,
  );
  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app",
      commitment: "confirmed",
    }),
    wallet,
  );
  ctx = {
    program: new Program(idl, baseProvider),
    programER: new Program(idl, erProvider),
    signer: wallet.publicKey,
    validator: new web3.PublicKey(process.env.VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
  };
  console.log(`[er] enabled — signer ${ctx.signer.toBase58().slice(0, 8)} program ${ctx.program.programId.toBase58().slice(0, 8)}`);
  return ctx;
}

interface ErSession {
  runPDA: web3.PublicKey;
  tick: number;
  // serial chain: start+delegate → applies (in order) → end_run. Errors are
  // caught per-step so one failure doesn't break ordering or the run.
  chain: Promise<void>;
}
const sessions = new Map<string, ErSession>();
const short = (id: string) => id.slice(0, 8);

/** start_run + delegate the RunSession PDA to the ER. Call once at run start. */
export function erStartRun(run: RunState): void {
  if (!ER_ENABLED) return;
  try {
    const c = getCtx();
    const seed = new BN(run.seed);
    const seedBuf = seed.toArrayLike(Buffer, "le", 8);
    const [runPDA] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from(RUN_SEED), c.signer.toBuffer(), seedBuf],
      c.program.programId,
    );
    const session: ErSession = { runPDA, tick: 0, chain: Promise.resolve() };
    sessions.set(run.id, session);
    session.chain = (async () => {
      await c.program.methods
        .startRun(seed, run.side, new BN(0))
        .accounts({ run: runPDA, player: c.signer })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await c.program.methods
        .delegateRun(seed)
        .accounts({ payer: c.signer, run: runPDA })
        .remainingAccounts([{ pubkey: c.validator, isSigner: false, isWritable: false }])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await new Promise((r) => setTimeout(r, 3000)); // let the ER pick up the delegation
      console.log(`[er] ${short(run.id)} start+delegate done · PDA ${runPDA.toBase58()}`);
    })().catch((e) => console.error(`[er] ${short(run.id)} start/delegate failed:`, (e as Error).message));
  } catch (e) {
    console.error(`[er] ${short(run.id)} erStartRun error:`, (e as Error).message);
  }
}

/** Queue an apply_event to the ER (runs after delegation, in scoring order). */
export function applyEventTx(run: RunState, points: number, multDeltaBps: number): void {
  if (!ER_ENABLED) return;
  const session = sessions.get(run.id);
  if (!session) return;
  session.chain = session.chain
    .then(async () => {
      const c = getCtx();
      const tick = ++session.tick;
      await c.programER.methods
        .applyEvent(tick, new BN(points), multDeltaBps)
        .accounts({ payer: c.signer, run: session.runPDA })
        .rpc({ skipPreflight: true });
    })
    .catch((e) => console.error(`[er] ${short(run.id)} apply_event failed:`, (e as Error).message));
}

/** end_run (commit + undelegate) after all applies, then read the finalized score.
 *  Returns immediately — finalization runs in the background so the death screen
 *  isn't delayed. */
export async function endRunTx(run: RunState): Promise<void> {
  if (!ER_ENABLED) return;
  const session = sessions.get(run.id);
  if (!session) return;
  sessions.delete(run.id); // no applies after end_run
  session.chain
    .then(async () => {
      const c = getCtx();
      const sig = await c.programER.methods
        .endRun()
        .accounts({ payer: c.signer, run: session.runPDA })
        .rpc({ skipPreflight: true });
      console.log(`[er] ${short(run.id)} end_run ${sig.slice(0, 8)} — commit+undelegate`);
      // Await the base-layer commitment (proven step from er-smoke); best-effort.
      try {
        const erConn = (c.programER.provider as anchor.AnchorProvider).connection;
        await GetCommitmentSignature(sig, erConn);
      } catch {
        /* the base read-back below is the real confirmation */
      }
      // Confirm: re-read the finalized RunSession from the BASE layer.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const acct = (await c.program.account.runSession.fetch(session.runPDA, "confirmed")) as {
            score: BN;
            multiplierBps: number;
            lastTick: number;
            status: number;
          };
          console.log(
            `[er] ${short(run.id)} FINALIZED on base · PDA ${session.runPDA.toBase58()} · ` +
              `score=${acct.score.toString()} mult=${acct.multiplierBps} lastTick=${acct.lastTick} status=${acct.status}`,
          );
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      console.error(`[er] ${short(run.id)} could not read finalized RunSession (PDA ${session.runPDA.toBase58()})`);
    })
    .catch((e) => console.error(`[er] ${short(run.id)} end_run failed:`, (e as Error).message));
}

// ── trade path (unchanged stubs) ─────────────────────────────────────────────

/** Close the real FlashTrade position; returns realized PnL. Mocked for now. */
export async function closePosition(run: RunState): Promise<number> {
  return run.pnlBps;
}

/** Settle payout from the escrow pot. Mocked for now. */
export async function settle(
  _run: RunState,
  _realizedPnl: number,
): Promise<{ payoutLamports: number; txSig: string }> {
  return { payoutLamports: 0, txSig: "stub-no-chain" };
}
