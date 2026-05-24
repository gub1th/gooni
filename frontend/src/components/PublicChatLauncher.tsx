import { useEffect, useRef, useState } from "react";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";
import { useMascotOutStore } from "../stores/useMascotOutStore";
import { AuraOrb } from "./animations/AuraOrb";

// Public-facing FAB. Same visual + drag-handoff as ChatLauncher, but:
// - No auth/store dependency on useGooniStore (no chat panel on public route)
// - Click toggles a small "no LLM for you" message bubble instead of opening chat
// - Drag still pulls the mascot out (handed off to GooniMascot via custom event)

const SIZE = 64;
const MARGIN = 24;
const CLICK_MAX_MS = 200;
const CLICK_MAX_PX = 5;

export function PublicChatLauncher() {
  const setRect = useChatLauncherRectStore((s) => s.setRect);
  const isOut = useMascotOutStore((s) => s.isOut);
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
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

  useEffect(() => {
    if (!showMsg) return;
    function onDocClick(e: MouseEvent) {
      const el = ref.current;
      if (el && el.contains(e.target as Node)) return;
      setShowMsg(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [showMsg]);

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
      setShowMsg((s) => !s);
    }
  }
  function handlePointerLeave() {
    setHovered(false);
    setPressed(false);
    pointerStateRef.current = null;
    handedOffRef.current = false;
  }

  const scale = pressed ? 0.94 : hovered ? 1.08 : 1;

  return (
    <>
      <style>{`
        @keyframes gooni-public-aura {
          0%, 100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 0 rgba(74,222,128,0.0); }
          50%      { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 6px rgba(74,222,128,0.18); }
        }
        @keyframes gooni-public-out-glow {
          0%   { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
          50%  { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 10px rgba(74,222,128,0.0),  0 0 26px 6px rgba(74,222,128,0.55); }
          100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
        }
        @keyframes gooni-public-msg-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {showMsg && (
        <div
          role="status"
          style={{
            position: "fixed",
            right: MARGIN,
            bottom: MARGIN + SIZE + 12,
            maxWidth: 260,
            padding: "10px 14px",
            background: "#1A1A1A",
            color: "#F2F2F2",
            borderRadius: 12,
            border: "1px solid rgba(74,222,128,0.4)",
            fontSize: 13,
            lineHeight: 1.55,
            fontFamily: "'Inter', system-ui, sans-serif",
            boxShadow: "0 10px 26px rgba(0,0,0,0.30)",
            zIndex: 1001,
            animation: "gooni-public-msg-in 0.18s ease-out",
          }}
        >
          my creator is being stingy and doesn't want to give me llm capabilities to you right now :(
        </div>
      )}

      <button
        ref={ref}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerLeave}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={handlePointerLeave}
        title="Gooni"
        aria-label="Gooni"
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
          transform: `scale(${scale})`,
          transition: "transform 0.15s ease",
          animation: isOut
            ? "gooni-public-out-glow 1.4s ease-in-out infinite"
            : "gooni-public-aura 3.6s ease-in-out infinite",
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
