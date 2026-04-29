import { useEffect, useRef, useState } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";
import { useMascotOutStore } from "../stores/useMascotOutStore";
import { AuraOrb } from "./animations/AuraOrb";

// Floating chat-launcher (FAB) — bottom-right, fixed. Visible on every authed
// route via GooniLayer. Click toggles the floating GooniPanel.
//
// Visual: AuraOrb (morphing green halos around a dark Gooni face). Click vs
// drag: pointerup within 200ms + delta < 5px counts as click. Anything longer
// or further hands off to the mascot drag flow.

const SIZE = 80;
const MARGIN = 24;
const CLICK_MAX_MS = 200;
const CLICK_MAX_PX = 5;

export function ChatLauncher() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const toggle = useGooniStore((s) => s.toggle);
  const setRect = useChatLauncherRectStore((s) => s.setRect);
  const isOut = useMascotOutStore((s) => s.isOut);
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
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
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
  }
  function handlePointerMove(e: React.PointerEvent) {
    const start = pointerStateRef.current;
    if (!start || handedOffRef.current) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < CLICK_MAX_PX) return;
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

  const buttonScale = pressed ? 0.94 : hovered ? 1.08 : 1;

  if (isOpen) return null;

  return (
    <>
      <style>{`
        @keyframes gooni-fab-aura {
          0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.0); }
          50%      { box-shadow: 0 0 0 6px rgba(74,222,128,0.18); }
        }
        @keyframes gooni-fab-out-glow {
          0%   { box-shadow: 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
          50%  { box-shadow: 0 0 0 10px rgba(74,222,128,0.0),  0 0 26px 6px rgba(74,222,128,0.55); }
          100% { box-shadow: 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
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
        title="Open chat"
        aria-label="Open Gooni chat"
        style={{
          position: "fixed",
          bottom: MARGIN,
          right: MARGIN,
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          background: "transparent",
          border: "none",
          cursor: pressed ? "grabbing" : "pointer",
          zIndex: 1000,
          padding: 0,
          outline: "none",
          transform: `scale(${buttonScale})`,
          transition: "transform 0.15s ease",
          animation: isOut
            ? "gooni-fab-out-glow 1.4s ease-in-out infinite"
            : "gooni-fab-aura 3.6s ease-in-out infinite",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AuraOrb size={SIZE} intensified={isOut} />
      </button>
    </>
  );
}
