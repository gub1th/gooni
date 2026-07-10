import { useEffect, useRef, type MutableRefObject } from "react";
import { GREEN, WHITE, mixColor, waveformPath } from "./wavePath";
import { useReducedMotion } from "../creative/useReducedMotion";

// The rest-state mark: a single contained SVG stroke that gently breathes.
// Driven by refs (no re-render): energy pushes amplitude + white→green,
// active (hover/focus) swells it a touch. Reduced-motion → a still stroke.

const H = 120;

export function WaveMark({
  width = 440,
  energyRef,
  activeRef,
}: {
  width?: number;
  energyRef: MutableRefObject<number>;
  activeRef: MutableRefObject<number>;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    let raf = 0;
    let t = 0;
    let last = performance.now();
    const e = { cur: 0 };
    const a = { cur: 0 };

    function frame(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!reduce) t += dt;
      e.cur += (energyRef.current - e.cur) * Math.min(1, dt * 3);
      a.cur += (activeRef.current - a.cur) * Math.min(1, dt * 5);

      const breathe = 0.5 + 0.5 * Math.sin(t * 0.7);
      const amp = (10 + 6 * breathe) * (0.75 + e.cur * 0.7) * (1 + a.cur * 0.6);
      const d = waveformPath(width, H, amp, t * 0.8, 1.6);

      const p = pathRef.current;
      if (p) {
        p.setAttribute("d", d);
        p.setAttribute("stroke", e.cur > 0.02 ? mixColor(WHITE, GREEN, Math.min(1, e.cur)) : WHITE);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduce, width, energyRef, activeRef]);

  return (
    <svg
      width={width}
      height={H}
      viewBox={`0 0 ${width} ${H}`}
      aria-hidden
      style={{ overflow: "visible", filter: "drop-shadow(0 0 5px rgba(74,222,128,0.22))" }}
    >
      <path
        ref={pathRef}
        d={waveformPath(width, H, 14, 0, 1.6)}
        fill="none"
        stroke={WHITE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
