import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const STORAGE_KEY = "gooni-focus-mode";

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
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

        <button
          onClick={onExit}
          aria-label="Exit focus mode"
          style={{
            position: "absolute",
            top: 0,
            right: 24,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "none",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.7)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
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
          <X size={18} />
        </button>
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
