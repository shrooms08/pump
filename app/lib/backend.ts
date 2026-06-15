// Where the browser reaches the game-server backend.
//
// The Render backend lives on *.onrender.com, which ad blockers block
// (ERR_BLOCKED_BY_CLIENT). To dodge that, in production we route HTTP + SSE
// through a SAME-ORIGIN path (/game/*) that vercel.json rewrites to the Render
// service — same-origin requests aren't on the blocklists. Locally we hit the
// local game-server directly.
//
// NOTE: this covers fetch() and EventSource (SSE) only. The gameplay WebSocket
// (position.wsUrl, set by the server's GAME_WS_URL) CANNOT go through a Vercel
// rewrite — Vercel doesn't proxy WS upgrades — so the WS still connects directly
// to whatever host GAME_WS_URL points at. Use a custom domain on Render to keep
// the WS off *.onrender.com.
const RAW = process.env.NEXT_PUBLIC_GAME_HTTP || "http://localhost:8787";

/** Base for backend HTTP/SSE calls: same-origin "/game" in prod (Vercel rewrite
 *  → Render), or the direct URL locally. */
export const GAME_HTTP = RAW.includes("onrender.com") ? "/game" : RAW;
