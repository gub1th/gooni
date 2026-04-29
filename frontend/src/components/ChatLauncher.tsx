import { useEffect, useRef, useState } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";
import { useMascotOutStore } from "../stores/useMascotOutStore";

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
  // Live mascot is "out" of the FAB whenever its phase ≠ peek. Hide the
  // embedded character while he's out so we don't have two Goonis on screen.
  const isOut = useMascotOutStore((s) => s.isOut);
  const characterHidden = isOpen || isOut;
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  // Track pointer-down to distinguish click from drag, and to fire the
  // mascot drag-handoff once the pointer has moved beyond the click threshold.
  const pointerStateRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const handedOffRef = useRef(false);
  // Eye-tracking refs — eyes follow the cursor while the embedded character
  // is visible (i.e. mascot is "in," panel is closed). Set transform via DOM
  // ref so we don't re-render on every mousemove.
  const eyeLeftRef = useRef<SVGCircleElement>(null);
  const eyeRightRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (characterHidden) return;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      // Eye pupils have ~2.5px travel along each axis — small enough to stay
      // inside the white face plate at the embedded character's scale.
      const MAX = 2.5;
      const ux = dx / dist;
      const uy = dy / dist;
      // Soft falloff with distance so eyes "lock on" only when cursor is
      // close-ish, then drift back to center as the cursor moves far away.
      const t = Math.min(1, dist / 240);
      const tx = ux * MAX * t;
      const ty = uy * MAX * t;
      const transform = `translate(${tx.toFixed(2)} ${ty.toFixed(2)})`;
      eyeLeftRef.current?.setAttribute("transform", transform);
      eyeRightRef.current?.setAttribute("transform", transform);
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [characterHidden]);

  // Reset pupils to center whenever character is hidden so the next reveal
  // doesn't briefly show stale offsets.
  useEffect(() => {
    if (!characterHidden) return;
    eyeLeftRef.current?.setAttribute("transform", "translate(0 0)");
    eyeRightRef.current?.setAttribute("transform", "translate(0 0)");
  }, [characterHidden]);

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

  // When the panel is open, hide the FAB entirely. The panel's top-bar
  // close button (added in GooniPanel's SurfaceToggleBar) takes over the
  // dismiss affordance, and the orb stops crowding the panel's input.
  if (isOpen) return null;

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
        /* When the mascot is out, the FAB radiates a brighter, faster
           green halo — visual cue that it's the drop target. Pulse cycles
           through three states so the glow feels alive, not metronomic. */
        @keyframes gooni-fab-out-glow {
          0%   { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
          50%  { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 10px rgba(74,222,128,0.0),  0 0 26px 6px rgba(74,222,128,0.55); }
          100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
        }
        @keyframes gooni-fab-out-border {
          0%, 100% { border-color: #4ADE80; }
          50%      { border-color: #86EFAC; }
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
          // Three states:
          // - open: no aura (X is the affordance)
          // - mascot out: bright green glow + border pulse (drop-target cue)
          // - idle: subtle background aura
          animation: isOpen
            ? "none"
            : isOut
            ? "gooni-fab-out-glow 1.4s ease-in-out infinite, gooni-fab-out-border 1.4s ease-in-out infinite"
            : "gooni-fab-aura 3.6s ease-in-out infinite",
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
            // Hide character when (a) panel is open — X takes over — or (b) the
            // live mascot is out (dragged from FAB). Never two Goonis on screen.
            opacity: characterHidden ? 0 : 1,
            transform: characterHidden ? "translateY(8px)" : "translateY(0)",
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
          {/* Smirk face — eyes + curve mouth. Eyes carry refs so they can
              translate to follow the cursor (without React re-renders). */}
          <circle ref={eyeLeftRef}  cx="38" cy="30" r="3" fill="#1A1A1A" />
          <circle ref={eyeRightRef} cx="52" cy="30" r="3" fill="#1A1A1A" />
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
