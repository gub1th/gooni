import { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX, Timer } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const STORAGE_KEY = "gooni-focus-mode";
const MUTE_KEY = "gooni-focus-mode-muted";
const POMODORO_KEY = "gooni-focus-mode-pomodoro";

// Classic 25/5 with a 15-min long break every 4 work blocks. Tuned to match
// the de-facto pomodoro convention so the muscle memory carries over.
const POMODORO_WORK_MS = 25 * 60 * 1000;
const POMODORO_SHORT_BREAK_MS = 5 * 60 * 1000;
const POMODORO_LONG_BREAK_MS = 15 * 60 * 1000;
const POMODORO_CYCLES_BEFORE_LONG = 4;

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
  // Pomodoro is session-bound — exiting focus mode wipes it so a fresh
  // session next time doesn't resume mid-phase.
  try { localStorage.removeItem(POMODORO_KEY); } catch {}
}

// Pomodoro state lives separate from focus state so toggling pomo on/off
// doesn't disturb the wider focus session. Survives reload — phaseStart is
// epoch ms, so the countdown keeps decrementing from when the phase
// actually started, not when the page mounted.
type PomodoroPhase = "work" | "short_break" | "long_break";
interface PomodoroState {
  phase: PomodoroPhase;
  phaseStart: number;     // epoch ms
  workCyclesDone: number; // increments after each work block ends
}

function loadPomodoro(): PomodoroState | null {
  try {
    const raw = localStorage.getItem(POMODORO_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.phaseStart !== "number" || typeof p?.workCyclesDone !== "number") return null;
    if (p.phase !== "work" && p.phase !== "short_break" && p.phase !== "long_break") return null;
    return p as PomodoroState;
  } catch { return null; }
}
function savePomodoro(s: PomodoroState) {
  try { localStorage.setItem(POMODORO_KEY, JSON.stringify(s)); } catch {}
}
function clearPomodoro() {
  try { localStorage.removeItem(POMODORO_KEY); } catch {}
}
function phaseDurationMs(phase: PomodoroPhase) {
  if (phase === "work") return POMODORO_WORK_MS;
  if (phase === "long_break") return POMODORO_LONG_BREAK_MS;
  return POMODORO_SHORT_BREAK_MS;
}
function phaseLabel(phase: PomodoroPhase) {
  if (phase === "work") return "focus";
  if (phase === "long_break") return "long break";
  return "break";
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
  const [pomodoro, setPomodoro] = useState<PomodoroState | null>(() => loadPomodoro());
  // Tick driver — re-renders the countdown once per second when pomodoro
  // is active. We don't store the remaining time as state because phaseStart
  // + Date.now() is the source of truth (survives reload), so we just need
  // a heartbeat to force re-renders.
  const [, setNow] = useState(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pomodoroRef = useRef<PomodoroState | null>(pomodoro);
  pomodoroRef.current = pomodoro;

  useWiiAmbience(muted);

  function toggleMuted() {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }

  function togglePomodoro() {
    setPomodoro((prev) => {
      if (prev) {
        clearPomodoro();
        return null;
      }
      // Fresh session — start with a work block.
      const next: PomodoroState = {
        phase: "work",
        phaseStart: Date.now(),
        workCyclesDone: 0,
      };
      savePomodoro(next);
      return next;
    });
  }

  // Phase chime — short A5/E5 pluck via standalone AudioContext so it
  // sidesteps the ambience graph (which can be muted/suspended). One-shot;
  // teardown happens after the envelope decays.
  function playPhaseChime(toPhase: PomodoroPhase) {
    if (muted) return;
    try {
      const Ctor = (window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      }).AudioContext || (window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      // Two-note motif. Work-end (entering break) uses a descending pair so
      // it reads as "release"; break-end (back to work) ascends so it reads
      // as "lift back into it".
      const notes = toPhase === "work" ? [659.25, 880.00] : [880.00, 659.25];
      const t0 = ctx.currentTime + 0.02;
      notes.forEach((freq, i) => {
        const start = t0 + i * 0.16;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = freq;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(0.18, start + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
        osc.connect(env).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.6);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 1200);
    } catch { /* ignore — chime is best-effort */ }
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

  // Pomodoro tick + phase advance. Single 1s interval that re-renders for
  // the countdown AND checks for phase rollover. We read from pomodoroRef
  // so the closure stays current without the interval needing to restart
  // every state change.
  useEffect(() => {
    if (!pomodoro) return;
    const t = setInterval(() => {
      setNow(Date.now());
      const cur = pomodoroRef.current;
      if (!cur) return;
      const elapsedInPhase = Date.now() - cur.phaseStart;
      if (elapsedInPhase < phaseDurationMs(cur.phase)) return;
      // Phase complete → advance.
      let nextPhase: PomodoroPhase;
      let nextWorkCycles = cur.workCyclesDone;
      if (cur.phase === "work") {
        nextWorkCycles = cur.workCyclesDone + 1;
        nextPhase = nextWorkCycles % POMODORO_CYCLES_BEFORE_LONG === 0
          ? "long_break"
          : "short_break";
      } else {
        nextPhase = "work";
      }
      const next: PomodoroState = {
        phase: nextPhase,
        phaseStart: Date.now(),
        workCyclesDone: nextWorkCycles,
      };
      savePomodoro(next);
      setPomodoro(next);
      playPhaseChime(nextPhase);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pomodoro]);

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
            label={pomodoro ? "Stop pomodoro" : "Start pomodoro (25/5)"}
            onClick={togglePomodoro}
            active={!!pomodoro}
          >
            <Timer size={16} />
          </ChromeButton>
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
        {pomodoro ? (() => {
          const total = phaseDurationMs(pomodoro.phase);
          const remaining = Math.max(0, total - (Date.now() - pomodoro.phaseStart));
          const isWork = pomodoro.phase === "work";
          return (
            <>
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: 4,
                  textTransform: "uppercase",
                  fontWeight: 600,
                  color: isWork ? "rgba(74,222,128,0.85)" : "rgba(255,255,255,0.55)",
                  marginBottom: 2,
                }}
              >
                {phaseLabel(pomodoro.phase)} · cycle {pomodoro.workCyclesDone + (isWork ? 1 : 0)}
              </div>
              <div
                style={{
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 44,
                  fontWeight: 200,
                  color: "rgba(255,255,255,0.95)",
                  letterSpacing: 2,
                  lineHeight: 1,
                }}
              >
                {formatCountdown(remaining)}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.32)",
                  letterSpacing: 1.6,
                  textTransform: "uppercase",
                  marginTop: 4,
                }}
              >
                total · {formatElapsed(elapsed)}
              </div>
            </>
          );
        })() : (
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
        )}
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
function ChromeButton({ label, onClick, active, children }: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  // Active state uses the Gooni mascot green so the active pomodoro toggle
  // reads at a glance without taking over the chrome.
  const baseBg = active ? "rgba(74,222,128,0.22)" : "rgba(255,255,255,0.08)";
  const hoverBg = active ? "rgba(74,222,128,0.32)" : "rgba(255,255,255,0.16)";
  const baseColor = active ? "rgba(154,238,184,1)" : "rgba(255,255,255,0.7)";
  const hoverColor = active ? "rgba(180,245,200,1)" : "rgba(255,255,255,0.95)";
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 36, height: 36,
        borderRadius: "50%", border: "none",
        background: baseBg,
        color: baseColor,
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = hoverBg;
        (e.currentTarget as HTMLButtonElement).style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = baseBg;
        (e.currentTarget as HTMLButtonElement).style.color = baseColor;
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
// Pomodoro countdown — always M:SS (no hours, since longest phase is 25m).
// Round up so it ticks 25:00 → 24:59 immediately, not after a full second.
function formatCountdown(ms: number): string {
  if (ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${pad(s)}`;
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
