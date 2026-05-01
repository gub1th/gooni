import { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const STORAGE_KEY = "gooni-focus-mode";
const MUTE_KEY = "gooni-focus-mode-muted";

// Wii Mii Channel-vibe ambient layer. A quiet sine pad sets the "warm
// room tone"; over the top a sparse marimba-style pluck sequencer triggers
// pentatonic notes every 2–4 seconds. Pure pentatonic + identical envelope
// per note guarantees consonance — any combo sounds intentional.
//
// Architecture (so mute actually mutes):
//   pluckLayer ─┐
//               ├─► masterGain ─► destination
//   padLayer  ─┘                     │
//                                    └ master is set by user (mute / unmute)
//
// breathingGain (separate node, LFO-modulated) sits BEFORE master so the
// LFO can swell the pad without ever bumping master back above 0. The old
// pad bug was wiring the LFO into master.gain itself; even after
// linearRampToValueAtTime(0) the LFO kept oscillating ±0.15, so mute
// reduced the volume ~70% and called it a day. New graph treats master as
// a hard gate and runs ctx.suspend() in tandem for belt-and-suspenders.
const PAD_TARGET_GAIN = 0.06;       // very quiet bed
const PLUCK_TARGET_GAIN = 0.45;     // headroom for pluck transients
const FADE_IN_MS = 2200;
// C major pentatonic across two octaves — every combination is consonant
// so the random sequencer can't pick a "wrong" note.
const PENTATONIC_HZ = [
  261.63, 293.66, 329.63, 392.00, 440.00, // C4 D4 E4 G4 A4
  523.25, 587.33, 659.25, 783.99, 880.00, // C5 D5 E5 G5 A5
];

function useWiiAmbience(muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const sequencerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const Ctor = (window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    }).AudioContext || (window as unknown as {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    ctxRef.current = ctx;

    // Master = hard gate. Nothing else writes to this gain — mute toggles
    // it directly, no other modulator interferes.
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    masterRef.current = master;

    // ── Pad layer ────────────────────────────────────────────────────────
    // Two octave-stacked sines low-passed, swayed by an LFO. The LFO drives
    // breathingGain (a node BEFORE master), so the pad swells without ever
    // pushing master.gain above its mute target.
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 900;
    padFilter.Q.value = 0.5;
    const breathingGain = ctx.createGain();
    breathingGain.gain.value = PAD_TARGET_GAIN;
    padFilter.connect(breathingGain).connect(master);

    const padFreqs = [196.00, 293.66]; // G3, D4 — open fifth, no thirds
    const padOscs = padFreqs.map((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.detune.value = (i - 0.5) * 6;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.55 : 0.45;
      o.connect(g).connect(padFilter);
      o.start();
      return o;
    });

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = PAD_TARGET_GAIN * 0.4;
    lfo.connect(lfoDepth).connect(breathingGain.gain);
    lfo.start();

    // ── Pluck bus ────────────────────────────────────────────────────────
    // Each note creates its own osc+envelope, schedules itself onto pluckBus.
    // Bus carries a soft low-pass + soft high-shelf so the marimba reads
    // warm, not glassy.
    const pluckBus = ctx.createGain();
    pluckBus.gain.value = PLUCK_TARGET_GAIN;
    const pluckLP = ctx.createBiquadFilter();
    pluckLP.type = "lowpass";
    pluckLP.frequency.value = 3500;
    pluckLP.Q.value = 0.4;
    pluckBus.connect(pluckLP).connect(master);

    function playPluck(freq: number, when: number) {
      // Marimba-ish: triangle fundamental + sine octave at 1/3 amplitude.
      // 5ms attack, 900ms exp decay — woody, not bell-like.
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(0.9, when + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, when + 1.0);
      env.connect(pluckBus);

      const fund = ctx.createOscillator();
      fund.type = "triangle";
      fund.frequency.value = freq;
      const fundGain = ctx.createGain();
      fundGain.gain.value = 0.7;
      fund.connect(fundGain).connect(env);

      const harm = ctx.createOscillator();
      harm.type = "sine";
      harm.frequency.value = freq * 2;
      const harmGain = ctx.createGain();
      harmGain.gain.value = 0.22;
      harm.connect(harmGain).connect(env);

      fund.start(when);
      harm.start(when);
      fund.stop(when + 1.1);
      harm.stop(when + 1.1);
    }

    function scheduleNext() {
      // Every 1.8–4.2s pick a random pentatonic note + the occasional rest.
      // 12% silent ticks keep it from feeling like a machine.
      const wait = 1800 + Math.random() * 2400;
      sequencerRef.current = setTimeout(() => {
        if (Math.random() > 0.12) {
          const f = PENTATONIC_HZ[Math.floor(Math.random() * PENTATONIC_HZ.length)];
          playPluck(f, ctx.currentTime + 0.02);
        }
        scheduleNext();
      }, wait);
    }
    scheduleNext();

    // Fade master in (only if not starting muted).
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(0, now);
    if (!muted) {
      master.gain.linearRampToValueAtTime(1, now + FADE_IN_MS / 1000);
    }
    if (muted && ctx.state === "running") ctx.suspend().catch(() => {});
    if (!muted && ctx.state === "suspended") ctx.resume().catch(() => {});

    teardownRef.current = () => {
      if (sequencerRef.current) {
        clearTimeout(sequencerRef.current);
        sequencerRef.current = null;
      }
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0, t + 0.5);
        padOscs.forEach((o) => { try { o.stop(t + 0.6); } catch {} });
        try { lfo.stop(t + 0.6); } catch {}
        setTimeout(() => { try { ctx.close(); } catch {} }, 700);
      } catch { /* ignore */ }
      ctxRef.current = null;
      masterRef.current = null;
    };
    return () => { teardownRef.current?.(); };
  }, []);

  // Live mute toggle — both gate the gain AND suspend the context. Either
  // alone leaves audible residue: gain ramp can be intercepted by node
  // automation, suspend alone leaves the gain at ~1 if you unmute via
  // resume(). Doing both is cheap and makes mute feel instant + complete.
  useEffect(() => {
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.25);
    if (muted) {
      // Suspend after the ramp completes so we don't cut the fade-out.
      setTimeout(() => {
        if (ctxRef.current?.state === "running") {
          ctxRef.current.suspend().catch(() => {});
        }
      }, 280);
    } else if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }, [muted]);
}

// Distraction-free overlay anchored on a single focus name. Mounting persists
// to localStorage so reload doesn't drop you out of focus mode mid-session;
// `started_at` is also saved so the elapsed timer keeps counting from the
// real start moment (not the moment the page reloaded).
//
// Chrome (top bar + timer + esc hint + cursor) fades after ~2s of mouse
// stillness and returns on movement. Esc also exits.

export interface FocusModeState {
  focusId: number;
  focusName: string;
  startedAt: number; // epoch ms
}

export function loadFocusMode(): FocusModeState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.startedAt !== "number" || typeof parsed?.focusName !== "string") return null;
    return parsed as FocusModeState;
  } catch { return null; }
}

export function saveFocusMode(state: FocusModeState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

export function clearFocusMode() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

interface FocusOverlayProps {
  focusName: string;
  startedAt: number;
  onExit: () => void;
}

export function FocusOverlay({ focusName, startedAt, onExit }: FocusOverlayProps) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
  });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useWiiAmbience(muted);

  function toggleMuted() {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onExit(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onExit]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  function bump() {
    setChromeVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setChromeVisible(false), 2000);
  }

  useEffect(() => {
    bump();
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, []);

  return (
    <div
      onMouseMove={bump}
      onTouchStart={bump}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1500,
        background: "rgba(15, 15, 18, 0.78)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
        animation: "gooni-focus-fade-in 320ms ease",
        cursor: chromeVisible ? "default" : "none",
      }}
    >
      <style>{KEYFRAMES}</style>

      {/* Top bar — focus title + exit. Fades alongside chrome. */}
      <div
        style={{
          position: "absolute",
          top: 28,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 24px",
          opacity: chromeVisible ? 1 : 0,
          transition: "opacity 480ms ease",
          pointerEvents: chromeVisible ? "auto" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              letterSpacing: 4,
              textTransform: "uppercase",
              fontWeight: 600,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            focusing on
          </span>
          <span
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.2px",
              color: "rgba(255,255,255,0.92)",
              maxWidth: "60vw",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={focusName}
          >
            {focusName}
          </span>
        </div>

        <div style={{
          position: "absolute",
          top: 0,
          right: 24,
          display: "flex",
          gap: 8,
        }}>
          <ChromeButton
            label={muted ? "Unmute" : "Mute"}
            onClick={toggleMuted}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </ChromeButton>
          <ChromeButton label="Exit focus mode" onClick={onExit}>
            <X size={18} />
          </ChromeButton>
        </div>
      </div>

      {/* Mascot — meditating Gooni with a subtle aura glow behind it. The
          glow is a slow-pulsing soft ring; the figure itself just floats. */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            width: 360,
            height: 360,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(74,222,128,0.22) 0%, rgba(74,222,128,0.05) 55%, rgba(74,222,128,0) 75%)",
            filter: "blur(2px)",
            animation: "gooni-aura-pulse 5.5s ease-in-out infinite",
          }}
        />
        <div style={{ animation: "gooni-meditate-float 4s ease-in-out infinite", position: "relative" }}>
          <MeditatingGooni />
        </div>
      </div>

      {/* Timer + esc hint — bottom band; both fade with chrome. */}
      <div
        style={{
          position: "absolute",
          bottom: 36,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          opacity: chromeVisible ? 1 : 0,
          transition: "opacity 480ms ease",
          pointerEvents: chromeVisible ? "auto" : "none",
        }}
      >
        <div
          style={{
            fontVariantNumeric: "tabular-nums",
            fontSize: 28,
            fontWeight: 300,
            color: "rgba(255,255,255,0.85)",
            letterSpacing: 1.5,
          }}
        >
          {formatElapsed(elapsed)}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.36)",
            letterSpacing: 1.6,
            textTransform: "uppercase",
          }}
        >
          press esc to exit
        </div>
      </div>
    </div>
  );
}

// Inline SVG mirroring `meditation_gooni_fixed.html` — black silhouette body,
// green torso + aura ring, hands resting on knees, closed-eye arcs. The
// ground shadow scale-pulses in counter-rhythm with the float for the
// "settled in zen" vibe.
function ChromeButton({ label, onClick, children }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 36, height: 36,
        borderRadius: "50%", border: "none",
        background: "rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.7)",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.16)";
        (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.95)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
        (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.7)";
      }}
    >
      {children}
    </button>
  );
}

function MeditatingGooni() {
  return (
    <svg
      width="280"
      height="300"
      viewBox="0 0 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: "drop-shadow(0 24px 60px rgba(74,222,128,0.18))" }}
    >
      {/* Ground shadow — pulses with float for parallax */}
      <ellipse
        cx="70" cy="142" rx="32" ry="6" fill="#4ADE80" opacity="0.3"
        style={{
          transformOrigin: "70px 142px",
          animation: "gooni-shadow-pulse 4s ease-in-out infinite",
        }}
      />

      {/* Right leg (back) — folded left */}
      <ellipse cx="50" cy="110" rx="16" ry="8" fill="#1a1a1a" transform="rotate(-15 50 110)" />
      {/* Left leg (front) — folded right */}
      <ellipse cx="90" cy="110" rx="16" ry="8" fill="#1a1a1a" transform="rotate(15 90 110)" />
      {/* Right foot peeking out on left side */}
      <ellipse cx="44" cy="113" rx="8" ry="5" fill="#1a1a1a" />
      {/* Left foot peeking out on right side */}
      <ellipse cx="96" cy="113" rx="8" ry="5" fill="#1a1a1a" />

      {/* Seat base where legs meet */}
      <ellipse cx="70" cy="108" rx="24" ry="14" fill="#1a1a1a" />

      {/* Torso */}
      <rect x="54" y="72" width="32" height="38" rx="8" fill="#4ADE80" />

      {/* Arms curved down to knees */}
      <path d="M54 85 Q40 95 38 108" stroke="#1a1a1a" strokeWidth="8" strokeLinecap="round" fill="none" />
      <path d="M86 85 Q100 95 102 108" stroke="#1a1a1a" strokeWidth="8" strokeLinecap="round" fill="none" />

      {/* Hands on knees */}
      <circle cx="37" cy="109" r="6" fill="#1a1a1a" />
      <circle cx="103" cy="109" r="6" fill="#1a1a1a" />

      {/* Head — black silhouette ring + cream face */}
      <circle cx="70" cy="52" r="30" fill="#1a1a1a" />
      <circle cx="70" cy="52" r="24" fill="#f2f2f2" />

      {/* Closed eyes */}
      <path d="M58 50 Q61 47 64 50" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M76 50 Q79 47 82 50" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />

      {/* Smile */}
      <path d="M62 60 Q70 64 78 60" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />

      {/* Aura ring behind head */}
      <circle cx="70" cy="52" r="34" fill="none" stroke="#4ADE80" strokeWidth="1.5" opacity="0.2" />

      {/* Energy dots above head */}
      <circle cx="70" cy="16" r="3" fill="#4ADE80" opacity="0.6" />
      <circle cx="82" cy="20" r="2" fill="#4ADE80" opacity="0.4" />
      <circle cx="58" cy="20" r="2" fill="#4ADE80" opacity="0.4" />
    </svg>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
function pad(n: number) { return n.toString().padStart(2, "0"); }

const KEYFRAMES = `
@keyframes gooni-focus-fade-in {
  from { opacity: 0; backdrop-filter: blur(0px); -webkit-backdrop-filter: blur(0px); }
  to   { opacity: 1; }
}
@keyframes gooni-meditate-float {
  0%, 100% { transform: translateY(0px); }
  50%      { transform: translateY(-12px); }
}
@keyframes gooni-shadow-pulse {
  0%, 100% { transform: scaleX(1);   opacity: 0.30; }
  50%      { transform: scaleX(0.8); opacity: 0.15; }
}
@keyframes gooni-aura-pulse {
  0%, 100% { transform: scale(0.92); opacity: 0.85; }
  50%      { transform: scale(1.08); opacity: 1; }
}
`;
