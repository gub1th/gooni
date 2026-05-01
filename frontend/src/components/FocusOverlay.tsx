import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Distraction-free overlay anchored on a single focus name. The whole app
// dims under a blurred backdrop; a meditating Gooni floats in the middle and
// the focus name reads at the top. The X exit only surfaces when the mouse
// moves and fades out after ~2s of stillness — keeps the canvas calm.
//
// Uses fixed positioning + portal-less render (mount inside the parent's tree
// so theme vars cascade). Esc also exits.

interface FocusOverlayProps {
  focusName: string;
  onExit: () => void;
}

export function FocusOverlay({ focusName, onExit }: FocusOverlayProps) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onExit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onExit]);

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

      {/* Top bar — focus title + exit */}
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
            color: "rgba(255,255,255,0.78)",
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

      {/* Mascot — meditating Gooni, floats with a slow up-down cycle. */}
      <div
        style={{
          animation: "gooni-meditate-float 4.5s ease-in-out infinite",
        }}
      >
        <MeditatingGooni />
      </div>

      {/* Hint — fades alongside chrome. */}
      <div
        style={{
          position: "absolute",
          bottom: 36,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 11,
          color: "rgba(255,255,255,0.36)",
          letterSpacing: 1.6,
          textTransform: "uppercase",
          opacity: chromeVisible ? 1 : 0,
          transition: "opacity 480ms ease",
        }}
      >
        press esc to exit
      </div>
    </div>
  );
}

// Inline SVG so the overlay has no asset dependency. Round body, crossed-leg
// silhouette, hands resting at the knees, eyes closed (small arcs). Soft
// gradient + glow ring around it matches the calm vibe.
function MeditatingGooni() {
  return (
    <svg
      width="240"
      height="240"
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: "drop-shadow(0 24px 60px rgba(74,222,128,0.25))" }}
    >
      <defs>
        <radialGradient id="gooniGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(74,222,128,0.35)" />
          <stop offset="60%" stopColor="rgba(74,222,128,0.05)" />
          <stop offset="100%" stopColor="rgba(74,222,128,0)" />
        </radialGradient>
        <radialGradient id="gooniBody" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#FBFFF6" />
          <stop offset="60%" stopColor="#E2F8E0" />
          <stop offset="100%" stopColor="#A6E3A4" />
        </radialGradient>
      </defs>

      {/* Aura */}
      <circle cx="120" cy="120" r="115" fill="url(#gooniGlow)" />

      {/* Crossed legs — two soft loops at the bottom */}
      <ellipse cx="92" cy="170" rx="42" ry="14" fill="#7AC97A" opacity="0.55" />
      <ellipse cx="148" cy="170" rx="42" ry="14" fill="#7AC97A" opacity="0.55" />
      <path
        d="M 60 170 Q 120 142 180 170 Q 168 184 120 184 Q 72 184 60 170 Z"
        fill="#9BD89B"
      />

      {/* Body */}
      <circle cx="120" cy="120" r="62" fill="url(#gooniBody)" stroke="#7AC97A" strokeWidth="1.5" />

      {/* Hands resting on knees */}
      <circle cx="68" cy="158" r="10" fill="#FBFFF6" stroke="#7AC97A" strokeWidth="1.2" />
      <circle cx="172" cy="158" r="10" fill="#FBFFF6" stroke="#7AC97A" strokeWidth="1.2" />
      {/* Tiny finger curls (OK gesture vibe) */}
      <circle cx="65" cy="155" r="2" fill="#7AC97A" />
      <circle cx="175" cy="155" r="2" fill="#7AC97A" />

      {/* Eyes — closed, gentle arcs */}
      <path
        d="M 96 116 Q 104 110 112 116"
        stroke="#2F4F2F"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 128 116 Q 136 110 144 116"
        stroke="#2F4F2F"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />

      {/* Calm smile */}
      <path
        d="M 108 138 Q 120 144 132 138"
        stroke="#2F4F2F"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />

      {/* Forehead bindi-style dot — focus point */}
      <circle cx="120" cy="92" r="2.4" fill="#4ADE80" opacity="0.85" />
    </svg>
  );
}

const KEYFRAMES = `
@keyframes gooni-focus-fade-in {
  from { opacity: 0; backdrop-filter: blur(0px); -webkit-backdrop-filter: blur(0px); }
  to   { opacity: 1; }
}
@keyframes gooni-meditate-float {
  0%, 100% { transform: translateY(0px); }
  50%      { transform: translateY(-14px); }
}
`;
