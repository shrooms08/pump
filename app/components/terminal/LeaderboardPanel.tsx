"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LeaderboardEntry, LeaderboardResponse } from "@pump/shared";
import { fetchLeaderboard } from "../../lib/leaderboard";
import { SketchFrame } from "./sketch";

const POLL_MS = 5000; // live-ish — catches a run finalizing (~3–7s after death)
const TOP_N = 14; // a wide board across the bottom shows many players at once

const fmtScore = (n: number) => n.toLocaleString();
const truncWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const fmtMult = (bps: number) => `${(bps / 10000).toFixed(2)}×`;
const medal = (rank: number) => (rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `#${rank}`);

type Status = "loading" | "ok" | "error";

/**
 * Live leaderboard (B2) as a full-width BOARD across the bottom of the desk.
 * Top players by best FINALIZED on-chain score, laid out as a responsive grid of
 * rank cells so it fills the width. Polls every few seconds (and on tab focus) so
 * it updates shortly after a run finalizes. Highlights the connected wallet and
 * shows "You're #N" when they're outside the shown top. Handles me=null (no
 * connected wallet / not on the board yet) gracefully.
 */
export function LeaderboardPanel(props: { wallet: string | null; refreshKey?: number }) {
  const { wallet, refreshKey } = props;
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const b = await fetchLeaderboard(wallet, TOP_N);
      if (!aliveRef.current) return;
      setBoard(b);
      setStatus("ok");
    } catch {
      if (!aliveRef.current) return;
      setStatus((s) => (s === "ok" ? "ok" : "error")); // keep last good data on a transient blip
    }
  }, [wallet]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const id = setInterval(load, POLL_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, refreshKey]);

  const top = board?.top ?? [];
  const me = board?.me ?? null;
  const meInTop = me ? top.some((e) => e.wallet === me.wallet) : false;

  const cell = (e: LeaderboardEntry, mine: boolean) => (
    <div key={e.wallet} className={`lb-cell ${mine ? "mine" : ""} ${e.rank <= 3 ? "podium" : ""}`}>
      <span className="lb-rank">{medal(e.rank)}</span>
      <span className="lb-cellmid">
        <span className="lb-wallet">
          {truncWallet(e.wallet)}
          {mine && <span className="lb-you">you</span>}
        </span>
        <span className="lb-mult">{fmtMult(e.multiplierBps)}</span>
      </span>
      <span className="lb-score">{fmtScore(e.score)}</span>
    </div>
  );

  return (
    <section className="leaderboard-panel board">
      <SketchFrame variant="card" />
      <div className="lb-head">
        <div className="lb-head-l">
          <span className="panel-title">Leaderboard</span>
          <span className="lb-sub">top players · ranked by finalized on-chain score</span>
        </div>
        {me && !meInTop && (
          <span className="lb-you-note">
            You&apos;re #{me.rank} · {fmtScore(me.score)}
          </span>
        )}
        {wallet && board && !me && top.length > 0 && (
          <span className="lb-you-note muted">Finish a run to get on the board</span>
        )}
      </div>

      {top.length > 0 ? (
        <div className="lb-board">{top.map((e) => cell(e, !!wallet && e.wallet === wallet))}</div>
      ) : (
        <p className="lb-empty">
          {status === "loading"
            ? "Loading leaderboard…"
            : status === "error"
              ? "Leaderboard unavailable — is the game server running?"
              : "No finalized runs yet — be the first on the board."}
        </p>
      )}
    </section>
  );
}
