import { useRef, useState } from "react";
import { ChatLauncher } from "./ChatLauncher";
import { GooniMascot } from "./GooniMascot";
import { GooniPanel } from "./GooniPanel";
import { useGooniStore } from "../stores/useGooniStore";
import { useWindowWidth } from "../hooks/useWindowWidth";
import {
  useGooniModalCornerStore,
  nearestCorner,
  type Corner,
} from "../stores/useGooniModalCornerStore";

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
  const corner = useGooniModalCornerStore((s) => s.corner);
  const setCorner = useGooniModalCornerStore((s) => s.setCorner);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function startDrag(e: React.PointerEvent) {
    setDragging(true);
    setDragOffset({ x: e.clientX, y: e.clientY });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function moveDrag(e: React.PointerEvent) {
    if (!dragging) return;
    setDragOffset({ x: e.clientX, y: e.clientY });
  }
  function endDrag(e: React.PointerEvent) {
    if (!dragging) return;
    setDragging(false);
    const next = nearestCorner(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    setCorner(next);
    setDragOffset(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }

  // Anchor offsets — keep the FAB visible on bottom-right by leaving a
  // taller gap there. Other corners hug the edge with a small margin.
  const anchorStyle = anchorStyleFor(corner);
  // While dragging, override anchor with the live cursor position so the
  // modal feels glued to the pointer. The anchor reasserts on release.
  const liveStyle: React.CSSProperties = dragging && dragOffset
    ? {
        left: dragOffset.x - 60,
        top: dragOffset.y - 20,
        right: "auto",
        bottom: "auto",
      }
    : anchorStyle;

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
          // Only start drag from the dedicated handle area or from elements
          // explicitly opted-in via [data-gooni-drag-handle]. Anything else
          // (buttons, inputs) gets to do its own thing.
          const target = e.target as HTMLElement;
          if (!target.closest?.("[data-gooni-drag-handle]")) return;
          startDrag(e);
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "fixed",
          ...liveStyle,
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
          transformOrigin: cornerToOrigin(corner),
          animation: dragging
            ? "gooni-modal-drag-glow 1.4s ease-in-out infinite"
            : "gooni-bubble-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          // Slight tilt + scale while dragging so it feels picked-up.
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

function anchorStyleFor(corner: Corner): React.CSSProperties {
  // Bottom-right keeps a 110px gap so the FAB stays visible. Other corners
  // sit closer to their edge — 24px margin all round.
  switch (corner) {
    case "bottom-right":
      return { right: 24, bottom: 88, left: "auto", top: "auto" };
    case "bottom-left":
      return { left: 24, bottom: 24, right: "auto", top: "auto" };
    case "top-right":
      return { right: 24, top: 24, left: "auto", bottom: "auto" };
    case "top-left":
      return { left: 24, top: 24, right: "auto", bottom: "auto" };
  }
}

function cornerToOrigin(corner: Corner): string {
  switch (corner) {
    case "bottom-right": return "bottom right";
    case "bottom-left":  return "bottom left";
    case "top-right":    return "top right";
    case "top-left":     return "top left";
  }
}
