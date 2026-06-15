/**
 * Price relay — standalone entrypoint (`pnpm dev:relay`).
 *
 * All logic lives in ./relay.ts so the game-server can also run it in-process
 * (RUN_RELAY_INLINE=true) for single-service deploys. Running this file directly
 * is the unchanged separate-process path used by local `pnpm dev`.
 */
import "dotenv/config";
import { startRelay } from "./relay.js";

startRelay().catch((e) => {
  console.error("[price-relay] fatal:", e);
  process.exit(1);
});
