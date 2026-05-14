import { useEffect, useRef, useState } from "react";
import { setBoatAxis } from "./useBoatControls";

// Virtual analog stick — drag the inner knob from the center. Vertical
// drag = thrust (up = forward), horizontal = turn. Clamped to the
// outer ring radius. Touch capture is set on pointerdown so the stick
// keeps tracking even if the finger leaves the visual circle.

const OUTER_RADIUS = 64;
const KNOB_RADIUS = 22;

export function MobileJoystick() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);
  const centerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function recenter() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      centerRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }

    function clampToRadius(dx: number, dy: number) {
      const len = Math.hypot(dx, dy);
      if (len <= OUTER_RADIUS) return { x: dx, y: dy, mag: len / OUTER_RADIUS };
      const k = OUTER_RADIUS / len;
      return { x: dx * k, y: dy * k, mag: 1 };
    }

    function writeAxes(dx: number, dy: number) {
      const { x, y, mag } = clampToRadius(dx, dy);
      // Normalize back to -1..1; dy is screen-down, invert for thrust.
      const turn = -(x / OUTER_RADIUS);
      const thrust = -(y / OUTER_RADIUS);
      setBoatAxis("turn", turn);
      setBoatAxis("thrust", thrust);
      setOffset({ x, y });
      void mag; // mag is intentionally unused; kept for future haptics
    }

    function onPointerDown(e: PointerEvent) {
      recenter();
      activeRef.current = true;
      el?.setPointerCapture(e.pointerId);
      const c = centerRef.current!;
      writeAxes(e.clientX - c.x, e.clientY - c.y);
    }

    function onPointerMove(e: PointerEvent) {
      if (!activeRef.current) return;
      const c = centerRef.current!;
      writeAxes(e.clientX - c.x, e.clientY - c.y);
    }

    function onPointerUp(e: PointerEvent) {
      activeRef.current = false;
      try {
        el?.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be released by the browser; safe to ignore.
      }
      setBoatAxis("thrust", 0);
      setBoatAxis("turn", 0);
      setOffset(null);
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        bottom: 32,
        left: "50%",
        transform: "translateX(-50%)",
        width: OUTER_RADIUS * 2,
        height: OUTER_RADIUS * 2,
        borderRadius: "50%",
        background: "rgba(0,0,0,0.22)",
        border: "1px solid rgba(255,255,255,0.18)",
        backdropFilter: "blur(6px)",
        touchAction: "none",
        zIndex: 6,
        pointerEvents: "auto",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: KNOB_RADIUS * 2,
          height: KNOB_RADIUS * 2,
          marginLeft: -KNOB_RADIUS,
          marginTop: -KNOB_RADIUS,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.86)",
          boxShadow: "0 2px 14px rgba(0,0,0,0.35)",
          transform: offset
            ? `translate(${offset.x}px, ${offset.y}px)`
            : "translate(0,0)",
          transition: offset ? "none" : "transform 180ms ease-out",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
