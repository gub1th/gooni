import { useEffect, useRef, useState } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";

// Floating chat-launcher (FAB) — bottom-right, fixed. Visible on every authed
// route via GooniLayer. Click toggles the floating GooniPanel.
//
// Visual: 64px black circle, brand-green border, green pulse dot indicator
// top-right, simplified Gooni character embedded inside (head + green body,
// legs cropped by the circular border). Hover: scale 1.08, lighter rim.
//
// Click vs drag: pointerup within 200ms + delta < 5px counts as click.
// Anything longer or further is ignored — leaves room for a drag-out mascot
// handoff in a follow-up without re-architecting.

const SIZE = 64;
const MARGIN = 24;
const CLICK_MAX_MS = 200;
const CLICK_MAX_PX = 5;

export function ChatLauncher() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const toggle = useGooniStore((s) => s.toggle);
  const setRect = useChatLauncherRectStore((s) => s.setRect);
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  // Track pointer-down to distinguish click from drag, and to fire the
  // mascot drag-handoff once the pointer has moved beyond the click threshold.
  const pointerStateRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const handedOffRef = useRef(false);

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

  function handlePointerDown(e: React.PointerEvent) {
    pointerStateRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    handedOffRef.current = false;
    setPressed(true);
    // Capture so we keep getting move events even if the pointer slides off
    // the button. Released the moment we detect a drag handoff.
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
  }
  function handlePointerMove(e: React.PointerEvent) {
    const start = pointerStateRef.current;
    if (!start || handedOffRef.current) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < CLICK_MAX_PX) return;
    // Drag detected — hand off to the mascot. Release pointer capture so the
    // window listeners installed by the mascot receive subsequent events.
    handedOffRef.current = true;
    setPressed(false);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    window.dispatchEvent(new CustomEvent("gooni:spawn-drag", {
      detail: { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId },
    }));
    pointerStateRef.current = null;
  }
  function handlePointerUp(e: React.PointerEvent) {
    setPressed(false);
    const start = pointerStateRef.current;
    pointerStateRef.current = null;
    if (handedOffRef.current) {
      handedOffRef.current = false;
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    if (dt < CLICK_MAX_MS && Math.hypot(dx, dy) < CLICK_MAX_PX) {
      toggle();
    }
  }
  function handlePointerLeave() {
    setHovered(false);
    setPressed(false);
    pointerStateRef.current = null;
    handedOffRef.current = false;
  }

  // Border lightens on hover; a touch greener on press. Scale animates in CSS.
  const borderColor = hovered ? "#6EE7A0" : "#4ADE80";
  const scale = pressed ? 0.94 : hovered ? 1.08 : 1;

  return (
    <>
      <style>{`
        @keyframes gooni-fab-pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(0.7); }
        }
        @keyframes gooni-fab-aura {
          0%, 100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 0 rgba(74,222,128,0.0); }
          50%      { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 6px rgba(74,222,128,0.18); }
        }
      `}</style>

      <button
        ref={ref}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerLeave}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={handlePointerLeave}
        title={isOpen ? "Close chat" : "Open chat"}
        aria-label={isOpen ? "Close Gooni chat" : "Open Gooni chat"}
        style={{
          position: "fixed",
          bottom: MARGIN,
          right: MARGIN,
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          background: "#1A1A1A",
          border: `2px solid ${borderColor}`,
          overflow: "hidden",
          cursor: pressed ? "grabbing" : "pointer",
          zIndex: 1000,
          padding: 0,
          outline: "none",
          transform: `scale(${scale})`,
          transition: "transform 0.15s ease, border-color 0.18s ease",
          // Idle aura pulse — stops when open since the X already says "active".
          animation: isOpen ? "none" : "gooni-fab-aura 3.6s ease-in-out infinite",
        }}
      >
        {/* Embedded Gooni character — head + body, legs cropped by circle.
            Uses the same palette as the live mascot so the FAB reads as
            Gooni's "self portrait." Sized so head sits high in the circle. */}
        <svg
          width={SIZE + 16}
          height={SIZE + 16}
          viewBox="0 0 90 100"
          style={{
            position: "absolute",
            bottom: -8,
            left: -8,
            pointerEvents: "none",
            transition: "opacity 0.2s ease, transform 0.2s ease",
            // Hide the character when open — the X icon takes its place so the
            // button reads cleanly as a close affordance.
            opacity: isOpen ? 0 : 1,
            transform: isOpen ? "translateY(8px)" : "translateY(0)",
          }}
        >
          {/* Body — green rounded square, partially cropped at the bottom by
              the FAB's overflow:hidden. */}
          <rect x="29" y="50" width="32" height="38" rx="6" fill="#4ADE80" />
          {/* Arms — short stubs at body sides */}
          <rect x="6" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
          <rect x="60" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
          {/* Head — dark circle with f2 face plate */}
          <circle cx="45" cy="32" r="22" fill="#1A1A1A" />
          <circle cx="45" cy="32" r="17" fill="#F2F2F2" />
          {/* Smirk face — eyes + curve mouth */}
          <circle cx="38" cy="30" r="3" fill="#1A1A1A" />
          <circle cx="52" cy="30" r="3" fill="#1A1A1A" />
          <path d="M38 39 Q45 45 52 40" stroke="#1A1A1A" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </svg>

        {/* Soft top-half radial highlight — sells the spherical depth. */}
        <span
          aria-hidden
          style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            background: "radial-gradient(ellipse at 50% 18%, rgba(255,255,255,0.10), rgba(255,255,255,0) 55%)",
            pointerEvents: "none",
          }}
        />

        {/* Status pulse dot — top-right, brand green, gently animated. */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "#4ADE80",
            boxShadow: "0 0 6px rgba(74,222,128,0.85)",
            animation: "gooni-fab-pulse-dot 2.2s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />

        {/* X icon — fades in when panel is open. */}
        {isOpen && (
          <span
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M6 6 L18 18 M18 6 L6 18" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </button>
    </>
  );
}
