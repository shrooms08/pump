/**
 * Tiny Web Audio SFX — synthesized, no assets, no deps. The AudioContext must be
 * created/resumed inside a user gesture, so call `resumeAudio()` from the first
 * tap handler.
 */
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function resumeAudio() {
  ac();
}

/** One enveloped oscillator note, optionally sweeping to `slideTo`. */
function note(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
  delay = 0,
) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function playFlap() {
  note(380, 0.1, "square", 0.05, 620);
}

export function playCoin() {
  note(880, 0.08, "triangle", 0.07);
  note(1320, 0.1, "triangle", 0.06, undefined, 0.05);
}

export function playClear() {
  note(300, 0.06, "sine", 0.03, 460);
}

export function playDeath() {
  note(220, 0.5, "sawtooth", 0.08, 60);
  // a little noise burst for impact
  const c = ac();
  if (!c) return;
  const dur = 0.25;
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buf.getChannelData(0);
  // deterministic-ish noise; this is audio, not game logic
  let s = 1;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((s / 0x7fffffff) * 2 - 1) * (1 - i / data.length);
  }
  const src = c.createBufferSource();
  const g = c.createGain();
  g.gain.value = 0.08;
  src.buffer = buf;
  src.connect(g).connect(c.destination);
  src.start();
}
