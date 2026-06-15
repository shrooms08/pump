/**
 * On-chain side-effects of a run, with PER-PLAYER SESSION KEYS (Phase B1).
 *
 * Attribution: each RunSession.player is the player's REAL wallet, not the
 * server. We mirror the MagicBlock session-keys example
 * (../magicblock-engine-examples/session-keys): the player's wallet signs ONCE
 * to authorize an ephemeral session key (gum `createSessionV2`), and that
 * server-held session key then signs every in-run ER tx — so taps never prompt
 * and the score still belongs to the player.
 *
 *   POST /runs:        prepareSession()  → build createSessionV2 (player signs once)
 *   /runs/:id/ready:   markSessionReady() → confirm the token landed on base
 *   on WS join:        start_run(player = wallet, payer = session key) + delegate
 *   per scoring event:  apply_event(... session key)  → ER
 *   on run end:         end_run (commit + undelegate, session key) → finalizes base
 *
 * Resilience: if any session step is missing/unconfirmed, we FALL BACK to the
 * old server-signed path (player = server key) so a run never breaks — the guard
 * `#[session_auth_or(player == payer)]` accepts both paths. Failures are logged,
 * never fatal. Gameplay and the trade path are untouched.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import type { RunState } from "./run.js";

const ER_ENABLED = process.env.ER_ENABLED === "true";
const RUN_SEED = "run";
const SESSION_TOKEN_SEED = "session_token_v2";
const SESSION_TTL_SECS = 3600; // session valid 1 hour — covers terminal → ride
const SESSION_TOPUP_LAMPORTS = Math.floor(0.01 * web3.LAMPORTS_PER_SOL); // funds rent+fees for start_run PDA + delegate buffer
// How long erStartRun waits for the player's session authorization to confirm
// before falling back to the server key. Runs entirely in the background (the
// game renders immediately on join), so this never freezes the screen — it only
// delays the first on-chain write, which the spawn runway absorbs.
const SESSION_WAIT_MS = 18_000;

type Progs = { base: any; er: any };

// Lazy one-time context. program/programER are typed `any`: the IDL is loaded as
// a generic anchor.Idl so generated methods aren't statically typed (the calls
// are the proven ones from scripts/er-smoke.ts).
let ctx: {
  idl: anchor.Idl;
  baseConn: web3.Connection;
  erConn: web3.Connection;
  serverKp: web3.Keypair;
  program: any; // server-key base program — reads + fallback signer
  programER: any; // server-key ER program
  programId: web3.PublicKey;
  validator: web3.PublicKey;
  stm: SessionTokenManager; // gum session-token manager (build createSessionV2 + program id)
} | null = null;

function getCtx() {
  if (ctx) return ctx;
  // IDL is committed inside this package (services/game-server/idl/pump.json) so it
  // ships on a fresh clone / cloud deploy — `target/` is gitignored, so the old
  // ../../../target/idl path is absent off the build machine.
  const idl = JSON.parse(
    readFileSync(new URL("../idl/pump.json", import.meta.url), "utf8"),
  ) as anchor.Idl;
  // Server signer: prefer SERVER_KEYPAIR_B64 (a base64 of the keypair JSON array —
  // for cloud deploys with no filesystem key). Falls back to the local keypair
  // file (KEYPAIR_PATH or ~/.config/solana/id.json) so local dev is unchanged.
  let secret: Uint8Array;
  const kpB64 = process.env.SERVER_KEYPAIR_B64;
  if (kpB64) {
    secret = Uint8Array.from(JSON.parse(Buffer.from(kpB64, "base64").toString("utf8")) as number[]);
  } else {
    const kpPath = (process.env.KEYPAIR_PATH || `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
    secret = Uint8Array.from(JSON.parse(readFileSync(kpPath, "utf8")) as number[]);
  }
  const serverKp = web3.Keypair.fromSecretKey(secret);
  const wallet = new anchor.Wallet(serverKp);
  // Two-chain routing, exactly as er-smoke.ts: base devnet for setup, ER for trades.
  const baseConn = new anchor.web3.Connection(
    process.env.PROVIDER_ENDPOINT || process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    { commitment: "confirmed" },
  );
  const erConn = new anchor.web3.Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", {
    wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app",
    commitment: "confirmed",
  });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
  const program = new Program(idl, baseProvider);
  ctx = {
    idl,
    baseConn,
    erConn,
    serverKp,
    program,
    programER: new Program(idl, erProvider),
    programId: program.programId,
    validator: new web3.PublicKey(process.env.VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
    stm: new SessionTokenManager(wallet, baseConn),
  };
  console.log(
    `[er] enabled — server ${ctx.serverKp.publicKey.toBase58().slice(0, 8)} program ${ctx.programId.toBase58().slice(0, 8)} session ${ctx.stm.program.programId.toBase58().slice(0, 8)}`,
  );
  return ctx;
}

/** Build a base+ER program pair that signs (and pays) as `kp` — used so the
 *  per-run session key (not the server) is the fee payer/signer for that run. */
function progsFor(kp: web3.Keypair): Progs {
  const c = getCtx();
  const w = new anchor.Wallet(kp);
  return {
    base: new Program(c.idl, new anchor.AnchorProvider(c.baseConn, w, { commitment: "confirmed" })),
    er: new Program(c.idl, new anchor.AnchorProvider(c.erConn, w, { commitment: "confirmed" })),
  };
}

// ── session authorizations (created at POST /runs, consumed at WS join) ───────
interface SessionAuth {
  signer: web3.Keypair; // server-held ephemeral session key
  player: web3.PublicKey; // the real wallet a run is attributed to
  tokenPda: web3.PublicKey; // gum SessionTokenV2 PDA
  ready: boolean; // createSessionV2 confirmed on base
  // Resolves true once markSessionReady confirms the token on base, false on a
  // failed ready-check. erStartRun awaits this (with a timeout) so the signer
  // decision waits for authorization instead of racing the WS join.
  readyPromise: Promise<boolean>;
  resolveReady: (ok: boolean) => void;
}
const sessionAuths = new Map<string, SessionAuth>();

// DIAGNOSTIC (wrong-wallet race): records which signer each run locked in at
// erStartRun time, so markSessionReady can tell whether the run already started
// (server-fallback) before the session-ready confirmation landed.
const runSignerLog = new Map<string, { useSession: boolean; at: number }>();

const short = (id: string) => id.slice(0, 8);

/**
 * Prepare a per-run session key: generate the ephemeral signer, build a
 * `createSessionV2` tx that the PLAYER's wallet signs once (feePayer = player,
 * topUp funds the session key), partial-signed by the session key here. The
 * client wallet-signs + submits it, then calls markSessionReady().
 * Returns null when ER is off or anything fails → caller uses the fallback path.
 */
export async function prepareSession(
  runId: string,
  ownerB58: string,
): Promise<{ sessionSigner: string; sessionTokenPda: string; txB64: string } | null> {
  if (!ER_ENABLED) return null;
  try {
    const c = getCtx();
    const player = new web3.PublicKey(ownerB58);
    const signer = web3.Keypair.generate();
    const [tokenPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from(SESSION_TOKEN_SEED),
        c.programId.toBuffer(),
        signer.publicKey.toBuffer(),
        player.toBuffer(),
      ],
      c.stm.program.programId,
    );

    const validUntil = new BN(Math.floor(Date.now() / 1000) + SESSION_TTL_SECS);
    const topUp = new BN(SESSION_TOPUP_LAMPORTS);
    const tx: web3.Transaction = await c.stm.program.methods
      .createSessionV2(true, validUntil, topUp)
      .accounts({
        targetProgram: c.programId,
        sessionSigner: signer.publicKey,
        feePayer: player,
        authority: player,
      })
      .transaction();
    const { blockhash } = await c.baseConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = player;
    tx.partialSign(signer); // session key signs now; wallet signs client-side

    let resolveReady!: (ok: boolean) => void;
    const readyPromise = new Promise<boolean>((res) => {
      resolveReady = res;
    });
    sessionAuths.set(runId, { signer, player, tokenPda, ready: false, readyPromise, resolveReady });
    console.log(`[session] ${short(runId)} prepared · player ${ownerB58.slice(0, 8)} signer ${signer.publicKey.toBase58().slice(0, 8)}`);
    return {
      sessionSigner: signer.publicKey.toBase58(),
      sessionTokenPda: tokenPda.toBase58(),
      txB64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    };
  } catch (e) {
    console.error(`[session] ${short(runId)} prepare failed:`, (e as Error).message);
    return null;
  }
}

/** Mark a run's session ready once the player confirmed createSessionV2. We
 *  re-check the token account actually landed on base before trusting it — if
 *  not, the run silently falls back to server-signed. */
export async function markSessionReady(runId: string): Promise<boolean> {
  const auth = sessionAuths.get(runId);
  if (!auth) return false;
  // (a)+(c) RACE PROBE: did erStartRun already pick a signer before this landed?
  const started = runSignerLog.get(runId);
  if (started) {
    console.log(
      `[race] ${short(runId)} session-ready @${Date.now()} — run ALREADY STARTED ` +
        `${started.useSession ? "with SESSION" : "SERVER-FALLBACK"} ${Date.now() - started.at}ms earlier ` +
        `${started.useSession ? "" : "→ TOO LATE: run is locked to the server key (player will be the server)"}`,
    );
  } else {
    console.log(`[race] ${short(runId)} session-ready @${Date.now()} — run NOT started yet (good: erStartRun will use the session)`);
  }
  try {
    const c = getCtx();
    const info = await c.baseConn.getAccountInfo(auth.tokenPda, "confirmed");
    if (!info) {
      console.error(`[session] ${short(runId)} ready check: token PDA ${auth.tokenPda.toBase58()} not found — will fall back`);
      auth.resolveReady(false); // unblock erStartRun → server fallback
      return false;
    }
    auth.ready = true;
    auth.resolveReady(true); // erStartRun (waiting) now proceeds with the session key
    console.log(`[session] ${short(runId)} ready · token ${auth.tokenPda.toBase58().slice(0, 8)}`);
    return true;
  } catch (e) {
    console.error(`[session] ${short(runId)} ready check failed:`, (e as Error).message);
    auth.resolveReady(false); // unblock erStartRun → server fallback
    return false;
  }
}

// ── ER lifecycle ─────────────────────────────────────────────────────────────
//
// Write path (B2): apply_event txns are SENT in order but NOT awaited for
// confirmation — the devnet ER is fast and the txs land (score/last_tick
// advance) even when web3.js throws a confirmation hiccup. Blocking the run on
// each confirmation used to stall end_run by up to ~70s. Now:
//   • applies → serial SEND (submission only), never confirmed, never blocking;
//   • end_run → gated only on delegation (NOT on the apply sends), so it fires
//     promptly, and it SETS the authoritative server score (reconciliation), so
//     the finalized RunSession is correct regardless of how many applies landed.
const STATUS_DEAD = 2;

interface ErSession {
  runPDA: web3.PublicKey;
  tick: number;
  ready: Promise<boolean>; // start+delegate done (true) or failed (false) — gates ER txs
  sendChain: Promise<void>; // serial SEND of applies (no confirmation)
  er: any; // ER program (provider wallet = payerKp) — builds ixs
  payerKp: web3.Keypair; // signs ER txs raw (session key, or server key in fallback)
  erConn: web3.Connection;
  sessionToken: web3.PublicKey | null;
  player: web3.PublicKey;
  bh?: { value: string; at: number }; // cached ER blockhash (short TTL)
}
const sessions = new Map<string, ErSession>();

// ── finalized-run sink (leaderboard indexing) ────────────────────────────────
// Additive notification: called only once a run is CONFIRMED finalized on base
// (status Dead), with the authoritative on-chain values. Does not affect the ER
// write path. index.ts registers a handler that writes to Redis.
export interface FinalizedRun {
  wallet: string;
  score: number; // finalized on-chain RunSession.score
  multiplierBps: number;
  pda: string;
  runId: string;
  ts: number;
}
let finalizedHandler: ((r: FinalizedRun) => void) | null = null;
export function setFinalizedHandler(fn: (r: FinalizedRun) => void): void {
  finalizedHandler = fn;
}

/** Cached recent ER blockhash (refreshed ~every 12s) so non-blocking sends don't
 *  pay a getLatestBlockhash round-trip per event. */
async function blockhashFor(s: ErSession): Promise<string> {
  const now = Date.now();
  if (!s.bh || now - s.bh.at > 12_000) {
    s.bh = { value: (await s.erConn.getLatestBlockhash("confirmed")).blockhash, at: now };
  }
  return s.bh.value;
}

/** Build, sign and SUBMIT an apply_event — without awaiting confirmation. */
async function sendApply(s: ErSession, tick: number, points: number, multDeltaBps: number): Promise<void> {
  const tx: web3.Transaction = await s.er.methods
    .applyEvent(tick, new BN(points), multDeltaBps)
    .accounts({ payer: s.payerKp.publicKey, run: s.runPDA, sessionToken: s.sessionToken })
    .transaction();
  tx.feePayer = s.payerKp.publicKey;
  tx.recentBlockhash = await blockhashFor(s);
  tx.sign(s.payerKp);
  // Fire-and-forget: resolves once the ER accepts the tx for processing. We do
  // NOT confirm — the truth is reconciled by end_run.
  await s.erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
}

/** start_run + delegate the RunSession PDA to the ER. Call once at run start.
 *  WAITS (in the background) for the player's session authorization to confirm
 *  before choosing the signer + deriving the PDA, so once authorized the WHOLE
 *  run (start→delegate→apply→end) signs with the session key and player = the
 *  wallet. Falls back to the server key ONLY on genuine timeout/failure — it
 *  never hangs the run, and gameplay renders immediately regardless (the wait is
 *  background; the spawn runway absorbs it). */
export function erStartRun(run: RunState): void {
  if (!ER_ENABLED) return;
  try {
    const c = getCtx();
    const auth = sessionAuths.get(run.id);
    const seed = new BN(run.seed);
    const seedBuf = seed.toArrayLike(Buffer, "le", 8);

    // The session entry is created now (so apply_events can queue + advance tick),
    // but the signer / PDA are FINALIZED inside `ready` once the authorization is
    // resolved. Defaults are the server-fallback values; no ER tx uses them until
    // `ready` resolves (apply/end both gate on it), by which point they're final.
    const serverProgs = progsFor(c.serverKp);
    const session: ErSession = {
      runPDA: web3.PublicKey.findProgramAddressSync(
        [Buffer.from(RUN_SEED), c.serverKp.publicKey.toBuffer(), seedBuf],
        c.programId,
      )[0],
      tick: 0,
      ready: Promise.resolve(false), // replaced just below
      sendChain: Promise.resolve(),
      er: serverProgs.er,
      payerKp: c.serverKp,
      erConn: c.erConn,
      sessionToken: null,
      player: c.serverKp.publicKey,
    };

    // Resolves true once start+delegate succeed (never rejects — false on failure).
    const ready: Promise<boolean> = (async () => {
      // Wait for the player's session authorization to confirm. Race it against a
      // timeout so a never-arriving / failed session degrades to server-signed
      // instead of hanging the run.
      let useSession = false;
      if (auth) {
        useSession = await Promise.race([
          auth.readyPromise,
          new Promise<boolean>((r) => setTimeout(() => r(false), SESSION_WAIT_MS)),
        ]);
      }
      // Finalize signer + PDA BEFORE any apply/end uses them.
      const payerKp = useSession ? auth!.signer : c.serverKp;
      const player = useSession ? auth!.player : c.serverKp.publicKey;
      const sessionToken = useSession ? auth!.tokenPda : null;
      const progs = useSession ? progsFor(payerKp) : serverProgs;
      const [runPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from(RUN_SEED), player.toBuffer(), seedBuf],
        c.programId,
      );
      session.payerKp = payerKp;
      session.player = player;
      session.sessionToken = sessionToken;
      session.er = progs.er;
      session.runPDA = runPDA;

      // (b) which signer this run locked in, after the race resolved.
      runSignerLog.set(run.id, { useSession, at: Date.now() });
      console.log(
        `[race] ${short(run.id)} erStartRun decided @${Date.now()}: sessionAuth=${!!auth} ` +
          `→ ${useSession ? `SESSION (player=${player.toBase58().slice(0, 8)})` : `SERVER-FALLBACK (player=server ${c.serverKp.publicKey.toBase58().slice(0, 8)})`}`,
      );

      try {
        await progs.base.methods
          .startRun(seed, run.side, new BN(0))
          .accounts({ run: runPDA, payer: payerKp.publicKey, player, sessionToken })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await progs.base.methods
          .delegateRun(seed)
          .accounts({ payer: payerKp.publicKey, run: runPDA, sessionToken })
          .remainingAccounts([{ pubkey: c.validator, isSigner: false, isWritable: false }])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await new Promise((r) => setTimeout(r, 3000)); // let the ER pick up the delegation
        console.log(
          `[er] ${short(run.id)} start+delegate done (${useSession ? "session" : "server-fallback"}) · ` +
            `player ${player.toBase58().slice(0, 8)} · PDA ${runPDA.toBase58()}`,
        );
        return true;
      } catch (e) {
        console.error(`[er] ${short(run.id)} start/delegate failed:`, (e as Error).message);
        return false;
      }
    })();

    session.ready = ready;
    session.sendChain = ready.then(() => {});
    sessions.set(run.id, session);
  } catch (e) {
    console.error(`[er] ${short(run.id)} erStartRun error:`, (e as Error).message);
  }
}

/** Submit an apply_event to the ER — ordered but non-blocking (no confirmation).
 *  A genuine SEND failure is logged; it never stalls the run or end_run. */
export function applyEventTx(run: RunState, points: number, multDeltaBps: number): void {
  if (!ER_ENABLED) return;
  const s = sessions.get(run.id);
  if (!s) return;
  const tick = ++s.tick;
  s.sendChain = s.sendChain
    .then(async () => {
      if (!(await s.ready)) return; // never delegated → nothing to write
      await sendApply(s, tick, points, multDeltaBps);
    })
    .catch((e) => console.error(`[er] ${short(run.id)} apply_event send failed (tick ${tick}): ${(e as Error).message}`));
}

/** Finalize: send end_run setting the AUTHORITATIVE server score, then verify on
 *  base (don't depend on the ER rpc confirmation — it can hiccup though the tx
 *  lands). Resends once if the read-back doesn't show Dead. */
async function finalizeRun(s: ErSession, runId: string, finalScore: BN, finalMultBps: number): Promise<void> {
  const c = getCtx();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sig = await s.er.methods
        .endRun(finalScore, finalMultBps)
        .accounts({ payer: s.payerKp.publicKey, run: s.runPDA, sessionToken: s.sessionToken })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`[er] ${short(runId)} end_run ${sig.slice(0, 8)} — commit+undelegate (score=${finalScore.toString()})`);
      try {
        await GetCommitmentSignature(sig, c.erConn);
      } catch {
        /* base read-back below is the real confirmation */
      }
    } catch (e) {
      console.warn(`[er] ${short(runId)} end_run rpc hiccup (attempt ${attempt + 1}): ${(e as Error).message} — verifying on base`);
    }
    // Verify finalization on the BASE layer (status Dead = undelegated + final).
    for (let i = 0; i < 6; i++) {
      try {
        const acct = (await c.program.account.runSession.fetch(s.runPDA, "confirmed")) as {
          player: web3.PublicKey;
          score: BN;
          multiplierBps: number;
          status: number;
        };
        if (acct.status === STATUS_DEAD) {
          console.log(
            `[er] ${short(runId)} FINALIZED on base · PDA ${s.runPDA.toBase58()} · ` +
              `player=${acct.player.toBase58()} score=${acct.score.toString()} mult=${acct.multiplierBps} status=${acct.status}`,
          );
          // Index the finalized run for the leaderboard (authoritative on-chain values).
          try {
            finalizedHandler?.({
              wallet: acct.player.toBase58(),
              score: Number(acct.score.toString()),
              multiplierBps: acct.multiplierBps,
              pda: s.runPDA.toBase58(),
              runId,
              ts: Date.now(),
            });
          } catch (e) {
            console.error(`[er] ${short(runId)} leaderboard index failed:`, (e as Error).message);
          }
          return;
        }
      } catch {
        /* not propagated yet */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.error(`[er] ${short(runId)} could not finalize (PDA ${s.runPDA.toBase58()})`);
}

/** end_run (commit + undelegate). Gated ONLY on delegation — NOT on the apply
 *  sends — so it finalizes promptly. Sets the authoritative server score so the
 *  finalized RunSession is correct. Returns immediately; runs in the background. */
export async function endRunTx(run: RunState): Promise<void> {
  if (!ER_ENABLED) return;
  const session = sessions.get(run.id);
  if (!session) return;
  sessions.delete(run.id); // no applies after end_run
  sessionAuths.delete(run.id); // session served its purpose
  const finalScore = new BN(Math.max(0, Math.floor(run.score)));
  const finalMult = Math.floor(run.multiplierBps);
  session.ready
    .then(async (ok) => {
      if (!ok) {
        console.error(`[er] ${short(run.id)} end_run skipped — run never delegated`);
        return;
      }
      await finalizeRun(session, run.id, finalScore, finalMult);
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
