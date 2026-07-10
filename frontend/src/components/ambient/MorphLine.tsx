import { useEffect, useRef, type MutableRefObject } from "react";
import { GREEN, WHITE, mixColor, roundedRectPath } from "./wavePath";
import { useReducedMotion } from "../creative/useReducedMotion";

// THE line. One continuous stroke that IS the waveform at rest and BENDS into
// the input's rounded-rect outline when you capture — in place, so it reads as
// "the wave became the box." Both shapes are sampled into N ordered points;
// each frame we lerp point-by-point by an eased morph value. Breathing damps
// to zero as it becomes the box. Fully ref-driven — no React re-render.

const N = 120;
const HUMPS = 1.5;

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

export interface MorphRect {
  cx: number; // center x, px
  cy: number; // center y, px
  w: number;
  h: number;
  r: number;
}

export function MorphLine({
  boxMode,
  rect,
  waveWidth = 380,
  energyRef,
  activeRef,
}: {
  boxMode: boolean;
  rect: MorphRect;
  waveWidth?: number;
  energyRef: MutableRefObject<number>;
  activeRef: MutableRefObject<number>;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const samplerRef = useRef<SVGPathElement>(null);
  const rectPtsRef = useRef<[number, number][]>([]);
  const morphRef = useRef(0);
  const reduce = useReducedMotion();

  // keep latest inputs in refs so the rAF loop never needs restarting
  const boxRef = useRef(boxMode);
  boxRef.current = boxMode;
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // resample the rect perimeter into N ordered points whenever it changes
  useEffect(() => {
    const el = samplerRef.current;
    if (!el) return;
    el.setAttribute("d", roundedRectPath(rect.cx - rect.w / 2, rect.cy - rect.h / 2, rect.w, rect.h, rect.r));
    try {
      const L = el.getTotalLength();
      if (!L) return;
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const p = el.getPointAtLength((i / N) * L);
        pts.push([p.x, p.y]);
      }
      rectPtsRef.current = pts;
    } catch {
      /* jsdom / no layout — skip; the wave still renders */
    }
  }, [rect.cx, rect.cy, rect.w, rect.h, rect.r]);

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
      morphRef.current += ((boxRef.current ? 1 : 0) - morphRef.current) * Math.min(1, dt * 6);
      const m = smoothstep(morphRef.current);

      const r = rectRef.current;
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.7);
      // taller, Spectre-like amplitude; collapses to 0 as it becomes the box
      const amp = (26 + 12 * breathe) * (0.8 + e.cur * 0.6) * (1 + a.cur * 0.4) * (1 - m);
      const W = Math.min(waveWidth, r.w * 1.05);
      const rectPts = rectPtsRef.current;
      const hasRect = rectPts.length === N + 1;

      let d = "";
      for (let i = 0; i <= N; i++) {
        const tt = i / N;
        const env = Math.sin(Math.PI * tt);
        const x0 = r.cx - W / 2 + tt * W;
        const y0 = r.cy - Math.sin(tt * Math.PI * 2 * HUMPS + t * 0.8) * amp * env;
        let x = x0;
        let y = y0;
        if (hasRect && m > 0.001) {
          const rp = rectPts[i];
          x = x0 + (rp[0] - x0) * m;
          y = y0 + (rp[1] - y0) * m;
        }
        d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
      }

      const p = pathRef.current;
      if (p) {
        p.setAttribute("d", d.trim());
        p.setAttribute("stroke", e.cur > 0.02 ? mixColor(WHITE, GREEN, Math.min(1, e.cur)) : WHITE);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduce, waveWidth, energyRef, activeRef]);

  return (
    <svg
      width="100%"
      height="100%"
      aria-hidden
      style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "visible", zIndex: 1 }}
    >
      <path ref={samplerRef} d="" fill="none" stroke="none" />
      <path
        ref={pathRef}
        fill="none"
        stroke={WHITE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: "drop-shadow(0 0 5px rgba(74,222,128,0.22))" }}
      />
    </svg>
  );
}
