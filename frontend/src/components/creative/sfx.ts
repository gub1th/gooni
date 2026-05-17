// Tiny Web Audio SFX bank — synthesized, no external assets.
// One-shot sound effects fired from gameplay events (jumps, lands,
// respawn). Uses its own AudioContext separate from the music synth
// so the two don't clobber each other's master gain.

let ctx: AudioContext | null = null;
let muted = false;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    return ctx;
  } catch {
    return null;
  }
}

export function setSfxMuted(m: boolean) {
  muted = m;
}

// Soft "huh" — short pitched whoosh + a breathy noise pop. Reads as a
// cartoon character grunt without being literally voiced.
export function playJumpGrunt() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;

  // Pitched body — falling sine sweep, short attack + release.
  const osc = c.createOscillator();
  const oscGain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(330, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.12);
  oscGain.gain.setValueAtTime(0, t);
  oscGain.gain.linearRampToValueAtTime(0.13, t + 0.015);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  osc.connect(oscGain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.2);

  // Breath layer — band-filtered noise burst.
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.15), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 0.6;
  const src = c.createBufferSource();
  const filt = c.createBiquadFilter();
  const ng = c.createGain();
  filt.type = "bandpass";
  filt.frequency.value = 1100;
  filt.Q.value = 1.2;
  ng.gain.setValueAtTime(0.04, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  src.buffer = buf;
  src.connect(filt).connect(ng).connect(c.destination);
  src.start(t);
}

// Soft "tap" — tile landing thud. Cheap thump using low-pass noise.
export function playLandThud() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.08), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5);
  const src = c.createBufferSource();
  const filt = c.createBiquadFilter();
  const g = c.createGain();
  filt.type = "lowpass";
  filt.frequency.value = 320;
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
  src.buffer = buf;
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
}

// Tile crack — sharp short noise burst w/ midrange band-pass.
export function playTileBreak() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.12), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5);
  const src = c.createBufferSource();
  const filt = c.createBiquadFilter();
  const g = c.createGain();
  filt.type = "bandpass";
  filt.frequency.value = 1400;
  filt.Q.value = 1.2;
  g.gain.setValueAtTime(0.10, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  src.buffer = buf;
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
}

// Tile heal — soft two-tone chime when the tile snaps back together.
export function playTileHeal() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const playTone = (freq: number, when: number, dur: number, gain: number) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t + when);
    g.gain.setValueAtTime(0, t + when);
    g.gain.linearRampToValueAtTime(gain, t + when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + when + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t + when);
    osc.stop(t + when + dur + 0.02);
  };
  playTone(880, 0.00, 0.22, 0.06);
  playTone(1320, 0.04, 0.28, 0.045);
}

// Two-tone descending bonk — classic "can't go there" feedback.
export function playInvalidMove() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const playTone = (freq: number, when: number, dur: number, gain: number) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t + when);
    g.gain.setValueAtTime(0, t + when);
    g.gain.linearRampToValueAtTime(gain, t + when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + when + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t + when);
    osc.stop(t + when + dur + 0.02);
  };
  playTone(380, 0.00, 0.10, 0.09);
  playTone(280, 0.05, 0.12, 0.07);
}

// Rising 3-note arpeggio — note-coin pickup chime. Gold-bell timbre
// (sine + 2nd-harmonic triangle) ascends C6 → E6 → G6 over ~0.18s for
// a "got one" reward feel.
export function playCoinPickup() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const playTone = (freq: number, when: number, dur: number, gain: number) => {
    const osc = c.createOscillator();
    const harm = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    harm.type = "triangle";
    osc.frequency.setValueAtTime(freq, t + when);
    harm.frequency.setValueAtTime(freq * 2, t + when);
    g.gain.setValueAtTime(0, t + when);
    g.gain.linearRampToValueAtTime(gain, t + when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + when + dur);
    osc.connect(g);
    harm.connect(g);
    g.connect(c.destination);
    osc.start(t + when);
    harm.start(t + when);
    osc.stop(t + when + dur + 0.02);
    harm.stop(t + when + dur + 0.02);
  };
  playTone(1046, 0.00, 0.10, 0.07);  // C6
  playTone(1318, 0.05, 0.12, 0.07);  // E6
  playTone(1568, 0.10, 0.20, 0.09);  // G6
}

// "Oof" + slide down — fall-off-the-map noise.
export function playFallOff() {
  if (muted) return;
  const c = ensureCtx();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(420, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.7);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.78);
}
