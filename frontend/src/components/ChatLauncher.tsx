import { useEffect, useRef } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";

// Floating chat-launcher (FAB) — bottom-right, fixed. Replaces the in-panel
// header bar + close button. Click toggles the floating GooniPanel. Mascot's
// peek/drop-zone anchor here via useChatLauncherRectStore so the head appears
// to perch on top of this launcher when idle.

const SIZE = 64;
const MARGIN = 24;

export function ChatLauncher() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const toggle = useGooniStore((s) => s.toggle);
  const setRect = useChatLauncherRectStore((s) => s.setRect);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function publish() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    publish();
    window.addEventListener("resize", publish);
    window.addEventListener("scroll", publish, true);
    return () => {
      window.removeEventListener("resize", publish);
      window.removeEventListener("scroll", publish, true);
      setRect(null);
    };
  }, [setRect]);

  return (
    <>
      {/* Inline keyframes so we don't have to plumb a global stylesheet. */}
      <style>{`
        @keyframes gooni-fab-breathe {
          0%, 100% {
            box-shadow:
              0 12px 28px rgba(0,0,0,0.28),
              0 4px 8px rgba(0,0,0,0.18),
              0 0 0 0 rgba(74,222,128,0.0);
          }
          50% {
            box-shadow:
              0 12px 28px rgba(0,0,0,0.28),
              0 4px 8px rgba(0,0,0,0.18),
              0 0 0 8px rgba(74,222,128,0.18);
          }
        }
        @keyframes gooni-fab-orbit {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .gooni-fab-halo {
          position: absolute;
          inset: -10px;
          border-radius: 50%;
          background: conic-gradient(
            from 0deg,
            rgba(74,222,128,0.0) 0deg,
            rgba(74,222,128,0.45) 90deg,
            rgba(74,222,128,0.0) 180deg,
            rgba(74,222,128,0.25) 270deg,
            rgba(74,222,128,0.0) 360deg
          );
          filter: blur(8px);
          opacity: 0.8;
          animation: gooni-fab-orbit 6s linear infinite;
          pointer-events: none;
        }
        .gooni-fab-x {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          opacity: 0;
          transition: opacity 0.18s ease, transform 0.18s ease;
          transform: rotate(-45deg) scale(0.8);
        }
        .gooni-fab.is-open .gooni-fab-x {
          opacity: 1;
          transform: rotate(0deg) scale(1);
        }
        .gooni-fab.is-open {
          background: linear-gradient(145deg, #16A34A 0%, #1C1C1E 70%, #0A0A0B 100%) !important;
        }
      `}</style>

      <button
        ref={ref}
        onClick={toggle}
        title={isOpen ? "Close chat" : "Open chat"}
        aria-label={isOpen ? "Close Gooni chat" : "Open Gooni chat"}
        className={`gooni-fab ${isOpen ? "is-open" : ""}`}
        style={{
          position: "fixed",
          bottom: MARGIN,
          right: MARGIN,
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          // Layered depth: outer dark gradient + inner brand-green rim. Looks
          // closer to a physical button than the flat dark ball it was.
          background:
            "linear-gradient(145deg, #2C2C2E 0%, #1C1C1E 55%, #0A0A0B 100%)",
          border: "1px solid rgba(74,222,128,0.18)",
          // Subtle constant breathing pulse — pulls the eye without screaming.
          animation: "gooni-fab-breathe 3.6s ease-in-out infinite",
          cursor: "pointer",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          transition: "transform 0.15s ease, background 0.25s ease",
          outline: "none",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.06)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        }}
        onMouseDown={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.94)";
        }}
        onMouseUp={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.06)";
        }}
      >
        {/* Conic-gradient halo orbits behind the button — wisp of green that
            reads as "alive" without the constant pulsing being too loud. */}
        <span className="gooni-fab-halo" aria-hidden />

        {/* Inner glow ring: warmer center, tunnels eye toward the mascot or X. */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 5,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 50% 30%, rgba(255,255,255,0.10), rgba(255,255,255,0) 65%)",
            pointerEvents: "none",
          }}
        />

        {/* Brand green dot — sits at top-left like an indicator LED. Hidden
            when open since the X takes that visual job. */}
        {!isOpen && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 9,
              left: 9,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#4ADE80",
              boxShadow: "0 0 8px rgba(74,222,128,0.7)",
            }}
          />
        )}

        {/* X icon — fades in when panel is open. White stroke on dark surface. */}
        <span className="gooni-fab-x" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M6 6 L18 18 M18 6 L6 18" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
      </button>
    </>
  );
}
