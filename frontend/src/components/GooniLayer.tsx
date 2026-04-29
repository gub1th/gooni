import { useRef } from "react";
import { ChatLauncher } from "./ChatLauncher";
import { GooniMascot } from "./GooniMascot";
import { GooniPanel } from "./GooniPanel";
import { useGooniStore } from "../stores/useGooniStore";
import { useWindowWidth } from "../hooks/useWindowWidth";

// Mounts the chat-related global UI: FAB, floating Gooni panel, walking
// mascot. Used by every authed route so the experience is consistent across
// the dashboard, notes, and the new /memories page.
//
// Mascot bounds default to the viewport when no dashboardRef is provided.
// We keep an optional ref so a route can constrain the mascot to a specific
// content area (e.g. excluding the sidebar) — but the FAB and panel are
// always viewport-anchored.
export function GooniLayer() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const windowWidth = useWindowWidth();
  const isSmall = windowWidth < 1100;
  // The mascot still needs a bounds ref. We hand it a viewport-sized invisible
  // div so it walks across the full visible area (sans the sidebar).
  const boundsRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div
        ref={boundsRef}
        // Invisible. Just provides a getBoundingClientRect anchored to the
        // visible page so GooniMascot has a "world" to walk in. Pointer-events
        // off so the actual UI underneath is unaffected.
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
        }}
        aria-hidden
      />

      <GooniMascot dashboardRef={boundsRef} />

      {isOpen && (
        <>
          <style>{`
            @keyframes gooni-bubble-pop {
              /* Origin set on the element to bottom-right so the panel
                 scales out of the FAB area, not the center. */
              0%   { transform: scale(0.20) translate(20px, 30px); opacity: 0; }
              60%  { transform: scale(1.04) translate(0, 0);       opacity: 1; }
              82%  { transform: scale(0.985) translate(0, 0); }
              100% { transform: scale(1.0) translate(0, 0); }
            }
          `}</style>
          <div
            style={{
              position: "fixed",
              bottom: 110,
              right: 24,
              width: isSmall ? "calc(100vw - 48px)" : 380,
              maxWidth: 420,
              height: isSmall ? "calc(100vh - 130px)" : 560,
              maxHeight: "calc(100vh - 130px)",
              background: "#FFFFFF",
              borderRadius: 18,
              boxShadow:
                "0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)",
              overflow: "hidden",
              zIndex: 999,
              display: "flex",
              transformOrigin: "bottom right",
              animation: "gooni-bubble-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            <GooniPanel floating />
          </div>
        </>
      )}

      <ChatLauncher />
    </>
  );
}
