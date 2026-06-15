"use client";

import { useEffect, useRef, useState } from "react";
import {
  GRAVITY,
  TERMINAL_VY,
  BIRD_SPAWN_Y,
  BIRD_X,
  CEIL,
  CANDLE_BODY_WIDTH,
  CANDLE_WICK_WIDTH,
  COIN_RADIUS,
  BIRD_RADIUS,
  COIN_POINTS,
  MULT_START_BPS,
  LEVERAGE_X,
  deriveHazards,
  deriveCoins,
  coinHit,
  birdWorldX,
  candleRects,
  clamp,
  mulberry32,
  type Rect,
  type ServerMessage,
} from "@pump/shared";
import type { Position } from "../lib/position";
import { resumeAudio, playFlap, playCoin, playDeath } from "./sound";

// Uniform world→screen scale so on-screen distances are isotropic and the
// rendered candle sprites line up exactly with the server's world-unit hitboxes.
const W = 900;
const H = 600;
const S = H / CEIL; // 0.6
const sx = (worldX: number, scrollX: number) => (worldX - scrollX) * S;
const sy = (worldY: number) => H - worldY * S;

const BIRD_SPRITE_R = (BIRD_RADIUS + 4) * S; // sprite slightly larger than hitbox
const INTERP_DELAY = 45; // ms behind real-time so we interpolate between two known server samples

// Diagnostics (temporary): prove exactly one render loop / input listener set
// survives the Strict-Mode remount, and that the loop runs at ~60fps not ~120.
let activeLoops = 0;
let activeInputEffects = 0;

interface Props {
  position: Position;
  onExit: () => void;
  /** Fired once when the run ends (death/cashout) — real mode closes the position. */
  onRunEnd?: () => void;
}
interface Hud {
  price: number;
  pnlBps: number;
  score: number;
  multiplierBps: number;
  entry: number;
}
interface Receipt {
  entry: number;
  exit: number;
  pnlBps: number;
  multiplierBps: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  color: string;
}
interface Pop {
  x: number;
  y: number;
  text: string;
  life: number;
}

const STAR_RNG = mulberry32(0xc0ffee);
const STARS = Array.from({ length: 70 }, () => ({
  x: STAR_RNG() * W,
  y: STAR_RNG() * H,
  r: 0.5 + STAR_RNG() * 1.8,
  layer: STAR_RNG() < 0.5 ? 0.25 : 0.5,
}));

export function Game({ position, onExit, onRunEnd }: Props) {
  const side = position.side;
  const sideNum = side === "long" ? 0 : 1;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState<Hud>({ price: 0, pnlBps: 0, score: 0, multiplierBps: MULT_START_BPS, entry: position.entryPrice });
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const stRef = useRef({
    seed: position.seed,
    sideNum,
    lastFrame: 0,
    dyingVy: 0, // local velocity, death-fall animation only
    serverPnlBps: 0,
    // authoritative samples — bird + scroll are rendered by interpolating these
    // together, so the on-screen bird IS the bird the server collides with.
    serverBirdY: BIRD_SPAWN_Y,
    serverScrollX: 0,
    serverTickAt: 0,
    prevBirdY: BIRD_SPAWN_Y,
    prevScrollX: 0,
    prevTickAt: 0,
    prevRenderY: BIRD_SPAWN_Y,
    scrollX: 0,
    birdY: BIRD_SPAWN_Y,
    angle: 0,
    entry: position.entryPrice,
    price: 0,
    pnlBps: 0,
    score: 0,
    multiplierBps: MULT_START_BPS,
    trail: [] as { x: number; y: number }[],
    particles: [] as Particle[],
    pops: [] as Pop[],
    goneCoins: new Set<number>(),
    shake: 0,
    flash: 0,
    alive: true,
    dying: false,
    showHitboxes: false,
    seq: 0,
  });

  // ── WebSocket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(position.wsUrl);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", runId: position.runId, sessionKeyPubkey: "" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      const st = stRef.current;
      if (m.t === "tick") {
        // Buffer the last two authoritative samples (bird + scroll); the render
        // loop interpolates between them so the drawn bird == the collision bird.
        st.prevBirdY = st.serverBirdY;
        st.prevScrollX = st.serverScrollX;
        st.prevTickAt = st.serverTickAt || performance.now() - 33;
        st.serverBirdY = m.birdY;
        st.serverScrollX = m.scrollX;
        st.serverTickAt = performance.now();
        st.serverPnlBps = m.pnlBps;
        st.price = m.price;
        st.pnlBps = m.pnlBps;
      } else if (m.t === "state" || m.t === "event") {
        st.score = m.score;
        st.multiplierBps = m.multiplierBps;
      } else if (m.t === "dead") {
        triggerDeath(m.realizedPnl);
      }
    };
    return () => {
      ws.onmessage = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.runId, position.wsUrl]);

  function triggerDeath(realizedPnlBps: number) {
    const st = stRef.current;
    if (st.dying) return;
    st.dying = true;
    st.alive = false;
    // snap to the exact authoritative position the server died at (the last tick
    // carried the colliding birdY) so the death lands ON the candle, not behind it.
    st.birdY = st.serverBirdY;
    st.scrollX = st.serverScrollX;
    st.shake = 16;
    st.flash = 1;
    st.dyingVy = 220; // small upward pop, then it arcs down
    playDeath();
    onRunEnd?.(); // real mode: time to close the real position
    const bx = BIRD_X * S;
    const by = sy(st.birdY);
    for (let i = 0; i < 22; i++) {
      const a = (Math.PI * 2 * i) / 22;
      st.particles.push({
        x: bx,
        y: by,
        vx: Math.cos(a) * (120 + STAR_RNG() * 160),
        vy: Math.sin(a) * (120 + STAR_RNG() * 160),
        life: 0.7,
        max: 0.7,
        r: 2 + STAR_RNG() * 3,
        color: sideNum === 0 ? "#19c37d" : "#f6465d",
      });
    }
    setTimeout(
      () =>
        setReceipt({
          entry: st.entry,
          exit: st.price,
          pnlBps: realizedPnlBps,
          multiplierBps: st.multiplierBps,
        }),
      900,
    );
  }

  // ── input ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let lastFlap = 0;
    const flap = () => {
      const st = stRef.current;
      resumeAudio();
      const now = performance.now();
      if (now - lastFlap < 30) return; // dedupe pointer+touch double-fire
      lastFlap = now;
      if (!st.alive) return;
      // Authoritative bird: the server applies the flap and we render its result
      // (no local impulse → the drawn bird can't disagree with collision).
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "tap", seq: st.seq++ }));
      playFlap();
      const bx = BIRD_X * S;
      const by = sy(st.birdY) + BIRD_SPRITE_R;
      for (let i = 0; i < 4; i++) {
        st.particles.push({
          x: bx,
          y: by,
          vx: -40 - STAR_RNG() * 40,
          vy: 20 + STAR_RNG() * 40,
          life: 0.3,
          max: 0.3,
          r: 1.5 + STAR_RNG() * 1.5,
          color: "#5b6b80",
        });
      }
    };
    const onPointer = (e: Event) => {
      e.preventDefault();
      flap();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp" || e.key === " ") {
        e.preventDefault();
        flap();
      } else if (e.key === "h" || e.key === "H") {
        stRef.current.showHitboxes = !stRef.current.showHitboxes;
      }
    };
    const canvas = canvasRef.current;
    canvas?.addEventListener("pointerdown", onPointer);
    canvas?.addEventListener("touchstart", onPointer, { passive: false });
    window.addEventListener("keydown", onKey);
    activeInputEffects++;
    console.log("[diag] input listeners attached; active input effects =", activeInputEffects);
    return () => {
      canvas?.removeEventListener("pointerdown", onPointer);
      canvas?.removeEventListener("touchstart", onPointer);
      window.removeEventListener("keydown", onKey);
      activeInputEffects--;
    };
  }, []);

  // ── HUD mirror ───────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const st = stRef.current;
      setHud({ price: st.price, pnlBps: st.pnlBps, score: st.score, multiplierBps: st.multiplierBps, entry: st.entry });
    }, 80);
    return () => clearInterval(id);
  }, []);

  // ── render + prediction loop ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    activeLoops++;

    let raf = 0;
    let fpsT0 = 0;
    let fpsCount = 0;
    const frame = (now: number) => {
      const st = stRef.current;
      const dtRaw = st.lastFrame ? (now - st.lastFrame) / 1000 : 1 / 60;
      st.lastFrame = now;
      const dt = Math.min(dtRaw, 0.05);

      // fps / loop diagnostic (temporary): ~60 => one loop, ~120 => a zombie.
      if (!fpsT0) fpsT0 = now;
      fpsCount++;
      if (now - fpsT0 >= 1000) {
        console.log(`[diag] fps=${fpsCount} activeLoops=${activeLoops} activeInputEffects=${activeInputEffects}`);
        fpsT0 = now;
        fpsCount = 0;
      }

      // Render the AUTHORITATIVE bird: interpolate the bird AND scroll between the
      // last two server ticks with the SAME alpha, so they stay locked to the
      // exact frame the server collided on (what you see = what kills you). No
      // independent client physics → the drawn bird can't drift from collision.
      if (st.alive) {
        const span = st.serverTickAt - st.prevTickAt;
        if (span > 0) {
          const alpha = Math.max(0, Math.min(1.25, (now - INTERP_DELAY - st.prevTickAt) / span));
          st.birdY = st.prevBirdY + (st.serverBirdY - st.prevBirdY) * alpha;
          st.scrollX = st.prevScrollX + (st.serverScrollX - st.prevScrollX) * alpha;
        } else {
          st.birdY = st.serverBirdY;
          st.scrollX = st.serverScrollX;
        }
      } else {
        // run over — local cosmetic death-fall (the server's no longer ticking)
        st.dyingVy = Math.max(TERMINAL_VY, st.dyingVy + GRAVITY * dt);
        st.birdY += st.dyingVy * dt;
      }

      // Bird rotation from its rendered vertical velocity (nose-up rising / dive falling).
      const vy = (st.birdY - st.prevRenderY) / Math.max(dt, 1e-3);
      st.prevRenderY = st.birdY;
      const targetAngle = clamp(-vy / 1100, -0.5, 1.15);
      st.angle += (targetAngle - st.angle) * 0.2;

      st.trail.unshift({ x: BIRD_X * S, y: sy(st.birdY) });
      if (st.trail.length > 14) st.trail.pop();

      for (const p of st.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 700 * dt;
        p.life -= dt;
      }
      st.particles = st.particles.filter((p) => p.life > 0);
      for (const pop of st.pops) {
        pop.y -= 40 * dt;
        pop.life -= dt;
      }
      st.pops = st.pops.filter((p) => p.life > 0);
      st.shake *= 0.86;
      st.flash *= 0.9;

      draw(ctx, st);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      activeLoops--;
    };
  }, []);

  // ── derived HUD numbers (display reflects the CHOSEN leverage; the bird's
  //     altitude is leverage-independent — driven by ALTITUDE_SENSITIVITY) ────
  const leverage = position.leverage;
  const marginUsd = position.stakeToken === "USDC" ? position.stake : position.stake * position.entryPrice;
  const signedReturn = hud.pnlBps / (LEVERAGE_X * 10000); // recover raw % move
  const pnlPct = signedReturn * leverage * 100;
  const pnlUsd = marginUsd * signedReturn * leverage;
  const pnlUp = signedReturn >= 0;
  const liq = position.liquidationPrice;
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <>
      <div className="stage">
        <canvas ref={canvasRef} style={{ width: W, height: H, touchAction: "none", userSelect: "none" }} />

        {/* live price + score */}
        <div className="hud">
          <div className="col">
            <span className="label">SOL / USDC</span>
            <span className="value">${fmt(hud.price)}</span>
          </div>
          <div className="col right">
            <span className="label">Score</span>
            <span className="value">{hud.score}</span>
            <span className="label" style={{ marginTop: 6 }}>
              Multiplier
            </span>
            <span className="value mult">{(hud.multiplierBps / 10000).toFixed(2)}x</span>
          </div>
        </div>

        {/* position / trade panel */}
        <div className="position">
          <div className={`pos-tag ${sideNum === 0 ? "long" : "short"}`}>
            {sideNum === 0 ? "LONG ▲" : "SHORT ▼"} {leverage}x
          </div>
          <div className="pos-row">
            <span>Entry</span>
            <b>${fmt(hud.entry)}</b>
          </div>
          <div className="pos-row">
            <span>Mark</span>
            <b>${fmt(hud.price)}</b>
          </div>
          <div className="pos-row">
            <span>Stake</span>
            <b>{fmt(position.stake)} {position.stakeToken}</b>
          </div>
          <div className="pos-row">
            <span>Liq.</span>
            <b className="pnl-down">${liq > 0 ? fmt(liq) : "—"}</b>
          </div>
          <div className="pos-pnl">
            <span className={pnlUp ? "pnl-up" : "pnl-down"}>
              {pnlUp ? "+" : "−"}${fmt(Math.abs(pnlUsd))}
            </span>
            <span className={pnlUp ? "pnl-up" : "pnl-down"}>
              {pnlUp ? "+" : ""}
              {pnlPct.toFixed(2)}%
            </span>
          </div>
        </div>

        {receipt && (
          <TradeReceipt r={receipt} sideNum={sideNum} leverage={leverage} marginUsd={marginUsd} onExit={onExit} />
        )}
      </div>
      <p className="hint">Tap / click / Space to flap · H toggles hitboxes · server-authoritative score</p>
    </>
  );
}

// ── trade receipt (settlement screen) ────────────────────────────────────────
function TradeReceipt({
  r,
  sideNum,
  leverage,
  marginUsd,
  onExit,
}: {
  r: Receipt;
  sideNum: number;
  leverage: number;
  marginUsd: number;
  onExit: () => void;
}) {
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signedReturn = r.pnlBps / (LEVERAGE_X * 10000);
  const pnlPct = signedReturn * leverage * 100;
  const gross = marginUsd * signedReturn * leverage;
  const mult = r.multiplierBps / 10000;
  const net = gross > 0 ? gross * mult : gross;
  const priceMove = r.entry > 0 ? ((r.exit - r.entry) / r.entry) * 100 : 0;
  const win = net >= 0;
  return (
    <div className="overlay">
      <div className="receipt">
        <div className="receipt-head">
          <span>TRADE RECEIPT</span>
          <span className={sideNum === 0 ? "pnl-up" : "pnl-down"}>{sideNum === 0 ? "LONG" : "SHORT"} {leverage}x</span>
        </div>
        <div className="r-row">
          <span>Entry</span>
          <b>${fmt(r.entry)}</b>
        </div>
        <div className="r-row">
          <span>Exit</span>
          <b>
            ${fmt(r.exit)} <span className="muted">({priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}%)</span>
          </b>
        </div>
        <div className="r-row">
          <span>Gross PnL</span>
          <b className={r.pnlBps >= 0 ? "pnl-up" : "pnl-down"}>
            {r.pnlBps >= 0 ? "+" : "−"}${fmt(Math.abs(gross))} ({pnlPct.toFixed(2)}%)
          </b>
        </div>
        <div className="r-row">
          <span>Skill multiplier</span>
          <b className="mult">×{mult.toFixed(2)}</b>
        </div>
        <div className="r-divider" />
        <div className="r-row net">
          <span>Net</span>
          <b className={win ? "pnl-up" : "pnl-down"}>
            {win ? "+" : "−"}${fmt(Math.abs(net))}
          </b>
        </div>
        <button className="btn ghost" onClick={onExit}>
          New trade
        </button>
      </div>
    </div>
  );
}

// ── drawing ────────────────────────────────────────────────────────────────
function fillWorldRect(ctx: CanvasRenderingContext2D, scrollX: number, r: Rect) {
  ctx.fillRect(sx(r.x0, scrollX), sy(r.y1), (r.x1 - r.x0) * S, (r.y1 - r.y0) * S);
}
function strokeWorldRect(ctx: CanvasRenderingContext2D, scrollX: number, r: Rect) {
  ctx.strokeRect(sx(r.x0, scrollX), sy(r.y1), (r.x1 - r.x0) * S, (r.y1 - r.y0) * S);
}

function draw(
  ctx: CanvasRenderingContext2D,
  st: {
    seed: string;
    scrollX: number;
    birdY: number;
    angle: number;
    sideNum: number;
    trail: { x: number; y: number }[];
    particles: Particle[];
    pops: Pop[];
    goneCoins: Set<number>;
    shake: number;
    flash: number;
    showHitboxes: boolean;
    entry: number;
  },
) {
  ctx.save();
  if (st.shake > 0.2) ctx.translate((Math.random() * 2 - 1) * st.shake, (Math.random() * 2 - 1) * st.shake);

  // background + parallax
  ctx.fillStyle = "#070b12";
  ctx.fillRect(-20, -20, W + 40, H + 40);
  for (const s of STARS) {
    const x = ((s.x - st.scrollX * S * s.layer) % W + W) % W;
    ctx.globalAlpha = s.layer === 0.5 ? 0.9 : 0.5;
    ctx.fillStyle = "#26405f";
    ctx.beginPath();
    ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // altitude grid
  ctx.strokeStyle = "#101826";
  ctx.lineWidth = 1;
  for (let gy = 0; gy <= CEIL; gy += 200) {
    ctx.beginPath();
    ctx.moveTo(0, sy(gy));
    ctx.lineTo(W, sy(gy));
    ctx.stroke();
  }

  // candles — drawn from the SAME rects the server collides against
  const hazards = deriveHazards(st.seed, st.scrollX);
  for (const h of hazards) {
    if (sx(h.x, st.scrollX) + 40 < 0 || sx(h.x, st.scrollX) - 40 > W) continue;
    const rects = candleRects(h);
    const up = h.bullish;
    ctx.fillStyle = up ? "#1f8f5e" : "#c23b50";
    ctx.strokeStyle = up ? "#2ee08a" : "#ff6076";
    ctx.lineWidth = 1.5;
    for (const r of rects) {
      fillWorldRect(ctx, st.scrollX, r);
      strokeWorldRect(ctx, st.scrollX, r);
    }
  }

  // coins (predict pickup locally for visuals; server owns the score)
  const bx = birdWorldX(st.scrollX);
  for (const coin of deriveCoins(st.seed, st.scrollX)) {
    if (st.goneCoins.has(coin.index)) continue;
    const cx = sx(coin.x, st.scrollX);
    const cy = sy(coin.y);
    if (coinHit(bx, st.birdY, coin)) {
      st.goneCoins.add(coin.index);
      st.pops.push({ x: cx, y: cy, text: `+${COIN_POINTS}`, life: 0.8 });
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI * 2 * i) / 12;
        st.particles.push({ x: cx, y: cy, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130, life: 0.5, max: 0.5, r: 2, color: "#ffd23f" });
      }
      playCoin();
      continue;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, COIN_RADIUS * S, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd23f";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#a8830d";
    ctx.stroke();
  }

  // particles
  for (const p of st.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // trail
  for (let i = st.trail.length - 1; i >= 0; i--) {
    const t = st.trail[i];
    ctx.globalAlpha = (1 - i / st.trail.length) * 0.4;
    ctx.fillStyle = st.sideNum === 0 ? "#19c37d" : "#f6465d";
    ctx.beginPath();
    ctx.arc(t.x, t.y, BIRD_SPRITE_R * (1 - (i / st.trail.length) * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // bird (rotated by velocity)
  const bScreenX = BIRD_X * S;
  const bScreenY = sy(st.birdY);
  ctx.save();
  ctx.translate(bScreenX, bScreenY);
  ctx.rotate(st.angle);
  ctx.fillStyle = st.sideNum === 0 ? "#19c37d" : "#f6465d";
  ctx.strokeStyle = "#e6edf3";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_SPRITE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.ellipse(-2, 2, BIRD_SPRITE_R * 0.5, BIRD_SPRITE_R * 0.32, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffb020";
  ctx.beginPath();
  ctx.moveTo(BIRD_SPRITE_R - 1, -2);
  ctx.lineTo(BIRD_SPRITE_R + 7, 0);
  ctx.lineTo(BIRD_SPRITE_R - 1, 3);
  ctx.fill();
  ctx.fillStyle = "#04110a";
  ctx.beginPath();
  ctx.arc(BIRD_SPRITE_R * 0.35, -BIRD_SPRITE_R * 0.3, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // score pops
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 16px ui-monospace, monospace";
  for (const pop of st.pops) {
    ctx.globalAlpha = Math.max(0, pop.life / 0.8);
    ctx.fillStyle = "#ffd23f";
    ctx.fillText(pop.text, pop.x, pop.y);
  }
  ctx.globalAlpha = 1;

  // liquidation line (the floor), labeled LIQ $X
  const floorY = sy(0);
  ctx.strokeStyle = "#f6465d";
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(W, floorY);
  ctx.stroke();
  ctx.setLineDash([]);
  // The floor is the game wipeout line (sink here and the run ends). The real
  // leverage-based liquidation price lives in the position panel.
  ctx.fillStyle = "#f6465d";
  ctx.font = "bold 11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText("WIPEOUT", 10, floorY - 4);

  // debug hitboxes (H)
  if (st.showHitboxes) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,229,255,0.9)";
    ctx.setLineDash([4, 3]);
    for (const h of hazards) {
      for (const r of candleRects(h)) strokeWorldRect(ctx, st.scrollX, r);
    }
    ctx.setLineDash([]);
    // bird hitbox (smaller) vs sprite (larger)
    ctx.strokeStyle = "rgba(255,60,60,0.95)";
    ctx.beginPath();
    ctx.arc(bScreenX, bScreenY, BIRD_RADIUS * S, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(bScreenX, bScreenY, BIRD_SPRITE_R, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  if (st.flash > 0.02) {
    ctx.fillStyle = `rgba(246,70,93,${st.flash * 0.5})`;
    ctx.fillRect(0, 0, W, H);
  }
}
