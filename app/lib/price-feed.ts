// Single shared SSE client for the live SOL tick stream (game-server
// /prices/stream, which fans out the same Redis `ticks` the game consumes —
// one price source of truth). One EventSource for the whole app; components
// subscribe to ticks. Reconnects automatically (EventSource default behavior).
"use client";

import { GAME_HTTP } from "./backend";

export interface PriceTick {
  price: number;
  ts: number;
}

type Listener = (tick: PriceTick) => void;

let source: EventSource | null = null;
const listeners = new Set<Listener>();
let last: PriceTick | null = null;

function ensureOpen() {
  if (source || typeof window === "undefined") return;
  source = new EventSource(`${GAME_HTTP}/prices/stream`);
  source.onmessage = (e) => {
    try {
      const tick = JSON.parse(e.data) as PriceTick;
      if (typeof tick.price !== "number" || !Number.isFinite(tick.price)) return;
      last = tick;
      for (const fn of listeners) fn(tick);
    } catch {
      /* ignore malformed frame (e.g. ping comments never reach onmessage) */
    }
  };
  // EventSource auto-reconnects on error; nothing to do but keep it open.
}

/** Subscribe to live ticks. Returns an unsubscribe fn. Replays the last tick. */
export function subscribePrice(fn: Listener): () => void {
  ensureOpen();
  listeners.add(fn);
  if (last) fn(last);
  return () => {
    listeners.delete(fn);
    // Keep the connection warm even with no listeners (cheap, avoids churn).
  };
}

export function lastPrice(): PriceTick | null {
  return last;
}
