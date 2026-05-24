import { useEffect, useRef, useState } from "react";
import { ChatLauncher } from "./ChatLauncher";
import { GooniMascot } from "./GooniMascot";
import { GooniPanel } from "./GooniPanel";
import { useGooniStore } from "../stores/useGooniStore";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useGooniModalCornerStore } from "../stores/useGooniModalCornerStore";
import { z } from "../ui";

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

      {/* Hide the walking mascot when a sidebar Gooni is open
          (they share screen real-estate). */}
      {!(isOpen && surface === "sidebar") && (
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
            zIndex: z.panel,
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
  // Bubble-pop animation should fire ONCE on mount, not every time the
  // user releases a drag. Without this gate, dragging→false retriggers
  // the keyframe animation and the modal "bounces" on every drop.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

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
    // Snap-to-side: x always anchors to the nearest screen edge so the
    // modal can't float in the middle. Y stays free so Daniel can park
    // it at any vertical position.
    const centerX = livePos.x + w / 2;
    const snappedX = centerX < vw / 2 ? 8 : vw - w - 8;
    const clamped = {
      x: snappedX,
      y: Math.max(8, Math.min(vh - h - 8, livePos.y)),
    };
    setPos(clamped);
    setDragGrab(null);
    setLivePos(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }

  // Render position: live cursor while dragging, stored pos if set, else
  // the default (very bottom-right corner — sits next to the FAB which
  // hides itself when the modal is open, so flush corner is safe).
  const renderStyle: React.CSSProperties = dragging && livePos
    ? { left: livePos.x, top: livePos.y, right: "auto", bottom: "auto" }
    : pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : { right: 24, bottom: 24, left: "auto", top: "auto" };

  return (
    <>
      <style>{`
        @keyframes gooni-bubble-pop {
          0%   { transform: scale(0.94) translate(6px, 10px); opacity: 0; }
          100% { transform: scale(1.0) translate(0, 0);       opacity: 1; }
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
          zIndex: z.panel,
          display: "flex",
          transformOrigin: pos ? "top left" : "bottom right",
          // Animations: drag glow while dragging; pop ONLY on first mount.
          // Subsequent renders (post-drop, store updates) get no animation —
          // that was the source of the "bouncy on release" bug.
          animation: dragging
            ? "gooni-modal-drag-glow 1.4s ease-in-out infinite"
            : hasMountedRef.current
              ? "none"
              : "gooni-bubble-pop 240ms cubic-bezier(0.22, 1, 0.36, 1)",
          // Transform stays null after drop too — no spring-back.
          transform: dragging ? "scale(1.02) rotate(-0.3deg)" : "none",
          transition: dragging ? "none" : "left 180ms cubic-bezier(0.22,1,0.36,1), top 180ms cubic-bezier(0.22,1,0.36,1)",
          userSelect: dragging ? "none" : undefined,
        }}
      >
        <GooniPanel floating />
      </div>
    </>
  );
}
