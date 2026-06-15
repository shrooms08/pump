use anchor_lang::prelude::*;
// ER wiring copied from ../magicblock-engine-examples/anchor-counter
// (ephemeral-rollups-sdk 0.14.3). Signatures are taken verbatim from that
// example and the SDK source — nothing here is invented.
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

// Session keys — per-player attribution. The `#[session_auth_or]` / `Session` /
// `SessionTokenV2` shapes are taken verbatim from
// ../magicblock-engine-examples/session-keys/programs/anchor-counter-session.
// Each guarded ix passes if EITHER the owner signs OR a valid session token
// authorizes the signer — so the server-signed fallback path keeps working.
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

declare_id!("Ev2NEthdMuGpiCQHUMqRuzZsagYcvF3xbk58zedxVzeF");

/// PDA seed prefix for a RunSession: [b"run", player, seed_le].
pub const RUN_SEED: &[u8] = b"run";

// ─────────────────────────────────────────────────────────────────────────
// Invariants. These MUST stay byte-identical to packages/shared/constants.ts
// (duplicated in Rust by necessity — the ER program is the canonical guard, the
// shared TS file is the same numbers for client/server simulation).
// ─────────────────────────────────────────────────────────────────────────
/// Hard cap on points a single apply_event may award (mirrors MAX_POINTS_PER_EVENT).
pub const MAX_POINTS_PER_EVENT: u64 = 5_000;
/// Multiplier floor in basis points: 0.5x (mirrors MULT_MIN_BPS).
pub const MULT_MIN_BPS: u32 = 5_000;
/// Multiplier ceiling in basis points: 10.0x (mirrors MULT_MAX_BPS).
pub const MULT_MAX_BPS: u32 = 100_000;
/// Starting multiplier in basis points: 1.0x (mirrors MULT_START_BPS).
pub const MULT_START_BPS: u32 = 10_000;

/// Denominator for basis-point math.
const BPS_DENOMINATOR: u64 = 10_000;

#[ephemeral]
#[program]
pub mod pump {
    use super::*;

    /// Create the RunSession PDA for a player and mark it active. Base layer.
    ///
    /// `side`: 0 = long/PUMP, 1 = short. The real FlashTrade position (Tier 1)
    /// or pot stake (Tier 0) is opened off-chain in the same start bundle; this
    /// instruction only stands up the canonical score record.
    ///
    /// Attribution: `player` is the real wallet and need not sign — the session
    /// key (`payer`) does, authorized by `session_token`. The guard accepts the
    /// server-signed fallback too (when player == payer, no token needed).
    #[session_auth_or(
        ctx.accounts.player.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn start_run(ctx: Context<StartRun>, seed: u64, side: u8, stake: u64) -> Result<()> {
        require!(side <= 1, PumpError::InvalidSide);

        let r = &mut ctx.accounts.run;
        r.player = ctx.accounts.player.key();
        r.seed = seed;
        r.side = side;
        r.stake = stake;
        r.score = 0;
        r.multiplier_bps = MULT_START_BPS;
        r.lives = 1;
        r.last_tick = 0;
        r.status = Status::Active as u8;
        r.payout = 0;
        r.started_at = Clock::get()?.unix_timestamp;
        r.ended_at = 0;
        Ok(())
    }

    /// Delegate the RunSession PDA to the Ephemeral Rollup so the authoritative
    /// server can write score deltas gaslessly during the run. Base layer.
    ///
    /// Body mirrors session-keys' `delegate`: read the stored `player` out of the
    /// raw account data BEFORE the CPI (UncheckedAccount avoids Anchor
    /// re-serializing stale data after ownership transfers to the delegation
    /// program), session-or-owner auth, then delegate with seeds keyed by the
    /// PLAYER (not the payer) so the PDA matches the one start_run created.
    pub fn delegate_run(ctx: Context<DelegateRun>, seed: u64) -> Result<()> {
        let player = {
            let data = ctx.accounts.run.try_borrow_data()?;
            RunSession::try_deserialize(&mut &data[..])?.player
        };

        // Manual session-or-owner check (UncheckedAccount can't reach `.player`
        // at constraint time, so this can't be the `#[session_auth_or]` macro).
        let session_ok = ctx
            .accounts
            .session_token
            .as_ref()
            .map(|t| t.authority == player)
            .unwrap_or(false);
        require!(
            player == ctx.accounts.payer.key() || session_ok,
            SessionError::InvalidToken
        );

        ctx.accounts.delegate_run(
            &ctx.accounts.payer,
            &[RUN_SEED, player.as_ref(), &seed.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Runs INSIDE the ER. The authoritative server signs this on each
    /// meaningful event (coin / hazard clear / milestone), then commits the
    /// new state up to the base layer.
    ///
    /// Enforces the invariants so even a compromised server cannot write an
    /// impossible score: monotonic tick, bounded per-event points, and a
    /// multiplier clamped to [MULT_MIN_BPS, MULT_MAX_BPS].
    ///
    /// Commit pattern copied verbatim from anchor-counter's `increment_and_commit`.
    /// Guarded: only the run's player (or its authorized session key) may write.
    #[session_auth_or(
        ctx.accounts.run.player.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn apply_event(ctx: Context<ApplyEvent>, tick: u32, points: u64, mult_delta: i32) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == Status::Active as u8, PumpError::NotActive);
        require!(tick > r.last_tick, PumpError::StaleTick);
        require!(points <= MAX_POINTS_PER_EVENT, PumpError::PointsTooHigh);

        // Award points scaled by the current multiplier (basis points).
        let earned = points.saturating_mul(r.multiplier_bps as u64) / BPS_DENOMINATOR;
        r.score = r.score.saturating_add(earned);

        // Apply and clamp the multiplier delta.
        r.multiplier_bps = (r.multiplier_bps as i64 + mult_delta as i64)
            .clamp(MULT_MIN_BPS as i64, MULT_MAX_BPS as i64) as u32;

        r.last_tick = tick;

        // Serialize the Anchor account, then commit it to the base layer.
        r.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.run.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Runs INSIDE the ER. Final state write, then commit + undelegate so the
    /// base layer holds a finalized score for settlement. Active -> Dead.
    ///
    /// RECONCILIATION (write-path fix): `apply_event` writes are best-effort live
    /// updates fired without blocking on confirmation, so the accumulated on-chain
    /// score can lag the authoritative server score when a devnet-ER confirmation
    /// hiccups. end_run therefore SETS the canonical final score/multiplier from
    /// the server (the authority per CLAUDE.md rule #1) so the finalized
    /// RunSession the leaderboard reads is always correct — regardless of how many
    /// individual apply_event confirmations landed. We only ever reconcile UP
    /// (never below what already landed on-chain) and clamp the multiplier.
    ///
    /// Undelegate pattern copied verbatim from anchor-counter's
    /// `increment_and_undelegate`.
    /// Guarded: only the run's player (or its authorized session key) may end it.
    #[session_auth_or(
        ctx.accounts.run.player.key() == ctx.accounts.payer.key(),
        SessionError::InvalidToken
    )]
    pub fn end_run(ctx: Context<EndRun>, final_score: u64, final_mult_bps: u32) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == Status::Active as u8, PumpError::NotActive);
        r.score = r.score.max(final_score);
        r.multiplier_bps = (final_mult_bps as i64).clamp(MULT_MIN_BPS as i64, MULT_MAX_BPS as i64) as u32;
        r.status = Status::Dead as u8;
        r.ended_at = Clock::get()?.unix_timestamp;

        // Serialize the Anchor account, then commit and undelegate.
        r.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.run.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer. Reads the finalized RunSession and pays out.
    /// Idempotent: only Dead -> Settled, so a retried settle is a no-op error.
    pub fn settle(ctx: Context<Settle>, realized_pnl: i64) -> Result<()> {
        let r = &mut ctx.accounts.run;
        require!(r.status == Status::Dead as u8, PumpError::NotSettleable);

        // Payout keeps only the profitable side of the move, scaled by the
        // skill multiplier: payout = max(0, realized_pnl) * multiplier_bps / 10_000.
        let base = realized_pnl.max(0) as u64;
        let payout = base.saturating_mul(r.multiplier_bps as u64) / BPS_DENOMINATOR;

        // TODO(step 7): escrow pot — transfer `payout` lamports from the escrow
        // pot PDA to the player (standard SOL/SPL transfer + signer seeds).

        r.payout = payout;
        r.status = Status::Settled as u8;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct RunSession {
    pub player: Pubkey,
    pub seed: u64,
    pub side: u8,
    pub stake: u64,
    pub score: u64,
    pub multiplier_bps: u32,
    pub lives: u8,
    pub last_tick: u32,
    pub status: u8,
    pub payout: u64,
    pub started_at: i64,
    pub ended_at: i64,
}

#[repr(u8)]
pub enum Status {
    Pending = 0,
    Active = 1,
    Dead = 2,
    Settled = 3,
    Void = 4,
}

// ─────────────────────────────────────────────────────────────────────────
// Account contexts
//
// start_run: base-layer init, seeds derived from the `seed` arg.
// delegate_run: the #[delegate] macro shapes the delegation accounts (buffer,
//   delegation_record, delegation_metadata, owner_program, delegation_program,
//   system_program) and generates the `delegate_run` method from the `run`
//   field marked `del` — mirrors anchor-counter's DelegateInput.
// apply_event / end_run: the #[commit] macro injects `magic_context` and
//   `magic_program` — mirrors anchor-counter's IncrementAndCommit. The run PDA
//   is verified by seeds derived from its own stored player + seed, so it is
//   independent of who signs (the session key in step 7).
// ─────────────────────────────────────────────────────────────────────────

#[derive(Accounts, Session)]
#[instruction(seed: u64)]
pub struct StartRun<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + RunSession::INIT_SPACE,
        seeds = [RUN_SEED, player.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub run: Account<'info, RunSession>,
    /// The session key (or, in fallback, the player themselves) — signs and pays rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the real wallet a run is attributed to. Need not sign — the session
    /// token proves `payer` is authorized to act for it (validated by the guard
    /// and the #[session] constraints below).
    pub player: UncheckedAccount<'info>,
    #[session(signer = payer, authority = player.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateRun<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: deserialized manually in the handler to read `player`; verified via
    /// PDA seeds in the delegate CPI. UncheckedAccount avoids Anchor
    /// re-serializing stale data after ownership transfers to the delegation program.
    #[account(mut, del)]
    pub run: UncheckedAccount<'info>,
    /// CHECK: validated in the handler against the RunSession's stored `player`.
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[commit]
#[derive(Accounts, Session)]
pub struct ApplyEvent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [RUN_SEED, run.player.as_ref(), &run.seed.to_le_bytes()],
        bump
    )]
    pub run: Account<'info, RunSession>,
    #[session(signer = payer, authority = run.player.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[commit]
#[derive(Accounts, Session)]
pub struct EndRun<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [RUN_SEED, run.player.as_ref(), &run.seed.to_le_bytes()],
        bump
    )]
    pub run: Account<'info, RunSession>,
    #[session(signer = payer, authority = run.player.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        has_one = player,
        seeds = [RUN_SEED, run.player.as_ref(), &run.seed.to_le_bytes()],
        bump
    )]
    pub run: Account<'info, RunSession>,
    pub player: Signer<'info>,
}

#[error_code]
pub enum PumpError {
    #[msg("run not active")]
    NotActive,
    #[msg("stale tick")]
    StaleTick,
    #[msg("points too high")]
    PointsTooHigh,
    #[msg("not settleable")]
    NotSettleable,
    #[msg("invalid side")]
    InvalidSide,
}
