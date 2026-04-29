import { useRef } from "react";
import { ChatLauncher } from "./ChatLauncher";
import { GooniMascot } from "./GooniMascot";
import { GooniPanel } from "./GooniPanel";
import { useGooniStore } from "../stores/useGooniStore";
import { useWindowWidth } from "../hooks/useWindowWidth";

// Mounts the chat-related global UI: FAB, Gooni panel (modal or sidebar
// surface), walking mascot. Used by every authed route so the experience
// is consistent across the dashboard, notes, and the new /memories page.
//
// Surface mode lives in useGooniStore — a top-bar toggle inside GooniPanel
// flips between modal (popup bubble from FAB) and sidebar (full-height
// docked right). Mascot is hidden when sidebar surface is active so it
// can't render over the docked panel's send button.
export function GooniLayer() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const surface = useGooniStore((s) => s.surface);
  const mascotSuppressed = useGooniStore((s) => s.mascotSuppressed);
  const windowWidth = useWindowWidth();
  const isSmall = windowWidth < 1100;
  const boundsRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div
        ref={boundsRef}
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
        }}
        aria-hidden
      />

      {/* Hide the walking mascot whenever:
            (1) a sidebar Gooni is open (they share screen real-estate); or
            (2) a chrome-heavy view sets `mascotSuppressed` (e.g. PlanView). */}
      {!mascotSuppressed && !(isOpen && surface === "sidebar") && (
        <GooniMascot dashboardRef={boundsRef} />
      )}

      {isOpen && surface === "modal" && (
        <>
          <style>{`
            @keyframes gooni-bubble-pop {
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
              // Above mascot's landing/dragging z=1001 so the walking Gooni
              // can't render over the panel's send button.
              zIndex: 1100,
              display: "flex",
              transformOrigin: "bottom right",
              animation: "gooni-bubble-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            <GooniPanel floating />
          </div>
        </>
      )}

      {isOpen && surface === "sidebar" && (
        <div
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            height: "100vh",
            zIndex: 1100,
            display: "flex",
            animation: "gooni-sidebar-slide 280ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <style>{`
            @keyframes gooni-sidebar-slide {
              from { transform: translateX(40px); opacity: 0; }
              to   { transform: translateX(0);    opacity: 1; }
            }
          `}</style>
          <GooniPanel />
        </div>
      )}

      <ChatLauncher />
    </>
  );
}
