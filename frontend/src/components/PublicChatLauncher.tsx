import { useEffect, useRef, useState } from "react";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";
import { useMascotOutStore } from "../stores/useMascotOutStore";

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
  const characterHidden = isOut;
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
  const pointerStateRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const handedOffRef = useRef(false);
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
      const MAX = 2.5;
      const ux = dx / dist;
      const uy = dy / dist;
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

  const borderColor = hovered ? "#6EE7A0" : "#4ADE80";
  const scale = pressed ? 0.94 : hovered ? 1.08 : 1;

  return (
    <>
      <style>{`
        @keyframes gooni-public-pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(0.7); }
        }
        @keyframes gooni-public-aura {
          0%, 100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 0 rgba(74,222,128,0.0); }
          50%      { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 4px 10px rgba(0,0,0,0.18), 0 0 0 6px rgba(74,222,128,0.18); }
        }
        @keyframes gooni-public-out-glow {
          0%   { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
          50%  { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 10px rgba(74,222,128,0.0),  0 0 26px 6px rgba(74,222,128,0.55); }
          100% { box-shadow: 0 10px 26px rgba(0,0,0,0.30), 0 0 0 0   rgba(74,222,128,0.55), 0 0 14px 2px rgba(74,222,128,0.30); }
        }
        @keyframes gooni-public-out-border {
          0%, 100% { border-color: #4ADE80; }
          50%      { border-color: #86EFAC; }
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
          background: "#1A1A1A",
          border: `2px solid ${borderColor}`,
          overflow: "hidden",
          cursor: pressed ? "grabbing" : "pointer",
          zIndex: 1000,
          padding: 0,
          outline: "none",
          transform: `scale(${scale})`,
          transition: "transform 0.15s ease, border-color 0.18s ease",
          animation: isOut
            ? "gooni-public-out-glow 1.4s ease-in-out infinite, gooni-public-out-border 1.4s ease-in-out infinite"
            : "gooni-public-aura 3.6s ease-in-out infinite",
        }}
      >
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
            opacity: characterHidden ? 0 : 1,
            transform: characterHidden ? "translateY(8px)" : "translateY(0)",
          }}
        >
          <rect x="29" y="50" width="32" height="38" rx="6" fill="#4ADE80" />
          <rect x="6" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
          <rect x="60" y="54" width="24" height="7" rx="3.5" fill="#1A1A1A" />
          <circle cx="45" cy="32" r="22" fill="#1A1A1A" />
          <circle cx="45" cy="32" r="17" fill="#F2F2F2" />
          <circle ref={eyeLeftRef}  cx="38" cy="30" r="3" fill="#1A1A1A" />
          <circle ref={eyeRightRef} cx="52" cy="30" r="3" fill="#1A1A1A" />
          <path d="M38 39 Q45 45 52 40" stroke="#1A1A1A" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </svg>

        <span
          aria-hidden
          style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            background: "radial-gradient(ellipse at 50% 18%, rgba(255,255,255,0.10), rgba(255,255,255,0) 55%)",
            pointerEvents: "none",
          }}
        />

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
            animation: "gooni-public-pulse-dot 2.2s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
      </button>
    </>
  );
}
