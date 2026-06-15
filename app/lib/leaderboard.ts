// Leaderboard read — top players by best FINALIZED on-chain score, plus the
// connected wallet's placement. Source of truth is the game-server's Redis ZSET,
// which is written only when a run finalizes on-chain (end_run). Read-only.
import type { LeaderboardResponse } from "@pump/shared";
import { GAME_HTTP } from "./backend";

export async function fetchLeaderboard(wallet?: string | null, limit = 50): Promise<LeaderboardResponse> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (wallet) qs.set("me", wallet);
  const res = await fetch(`${GAME_HTTP}/leaderboard?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  return (await res.json()) as LeaderboardResponse;
}
