import { useRef, useState } from "react";
import { ChatLauncher } from "./ChatLauncher";
import { GooniMascot } from "./GooniMascot";
import { GooniPanel } from "./GooniPanel";
import { useGooniStore } from "../stores/useGooniStore";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useGooniModalCornerStore } from "../stores/useGooniModalCornerStore";

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
        <FloatingModal isSmall={isSmall} />
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

// ── Floating modal ────────────────────────────────────────────────────────
// Positions the mini chat to one of four screen corners. Drag any non-
// interactive part of its top bar to relocate; on release we snap to the
// nearest corner. Border glows + hue-rotates while dragging.

function FloatingModal({ isSmall }: { isSmall: boolean }) {
  const pos = useGooniModalCornerStore((s) => s.pos);
  const setPos = useGooniModalCornerStore((s) => s.setPos);
  const [dragGrab, setDragGrab] = useState<{ dx: number; dy: number } | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);
  const dragging = dragGrab != null;

  function startDrag(e: React.PointerEvent, modalRect: DOMRect) {
    // Capture the offset from cursor → modal top-left so the modal
    // doesn't jump when drag begins.
    setDragGrab({ dx: e.clientX - modalRect.left, dy: e.clientY - modalRect.top });
    setLivePos({ x: modalRect.left, y: modalRect.top });
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
  }
  function moveDrag(e: React.PointerEvent) {
    if (!dragGrab) return;
    setLivePos({ x: e.clientX - dragGrab.dx, y: e.clientY - dragGrab.dy });
  }
  function endDrag(e: React.PointerEvent) {
    if (!dragGrab || !livePos) {
      setDragGrab(null);
      setLivePos(null);
      return;
    }
    // Clamp to viewport so the modal can't be lost off-edge.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(isSmall ? vw - 48 : 380, 420);
    const h = Math.min(isSmall ? vh - 130 : 560, vh - 24);
    const clamped = {
      x: Math.max(8, Math.min(vw - w - 8, livePos.x)),
      y: Math.max(8, Math.min(vh - h - 8, livePos.y)),
    };
    setPos(clamped);
    setDragGrab(null);
    setLivePos(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }

  // Render position: live cursor while dragging, stored pos if set, else
  // the default (bottom-right near the FAB).
  const renderStyle: React.CSSProperties = dragging && livePos
    ? { left: livePos.x, top: livePos.y, right: "auto", bottom: "auto" }
    : pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : { right: 24, bottom: 88, left: "auto", top: "auto" };

  return (
    <>
      <style>{`
        @keyframes gooni-bubble-pop {
          0%   { transform: scale(0.20) translate(20px, 30px); opacity: 0; }
          60%  { transform: scale(1.04) translate(0, 0);       opacity: 1; }
          82%  { transform: scale(0.985) translate(0, 0); }
          100% { transform: scale(1.0) translate(0, 0); }
        }
        @keyframes gooni-modal-drag-glow {
          0%   { box-shadow: 0 24px 60px rgba(0,0,0,0.22), 0 0 0 2px rgba(74,222,128,0.55), 0 0 18px 2px rgba(74,222,128,0.40); }
          50%  { box-shadow: 0 24px 60px rgba(0,0,0,0.22), 0 0 0 2px rgba(245,158,11,0.55), 0 0 22px 4px rgba(245,158,11,0.40); }
          100% { box-shadow: 0 24px 60px rgba(0,0,0,0.22), 0 0 0 2px rgba(74,222,128,0.55), 0 0 18px 2px rgba(74,222,128,0.40); }
        }
      `}</style>
      <div
        onPointerDown={(e) => {
          // Drag only fires on elements explicitly opted-in via
          // [data-gooni-drag-handle]. Buttons inside the top bar must not
          // carry that attribute, otherwise their click is swallowed.
          const target = e.target as HTMLElement;
          if (!target.closest?.("[data-gooni-drag-handle]")) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          startDrag(e, rect);
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "fixed",
          ...renderStyle,
          width: isSmall ? "calc(100vw - 48px)" : 380,
          maxWidth: 420,
          height: isSmall ? "calc(100vh - 130px)" : 560,
          maxHeight: "calc(100vh - 130px)",
          background: "#FFFFFF",
          borderRadius: 18,
          boxShadow: dragging
            ? undefined
            : "0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)",
          overflow: "hidden",
          zIndex: 1100,
          display: "flex",
          transformOrigin: pos ? "top left" : "bottom right",
          animation: dragging
            ? "gooni-modal-drag-glow 1.4s ease-in-out infinite"
            : "gooni-bubble-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          transform: dragging ? "scale(1.02) rotate(-0.3deg)" : "none",
          transition: dragging ? "none" : "transform 200ms ease",
          userSelect: dragging ? "none" : undefined,
        }}
      >
        <GooniPanel floating />
      </div>
    </>
  );
}
