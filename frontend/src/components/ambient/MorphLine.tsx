import { useEffect, useRef, type MutableRefObject } from "react";
import { GREEN, WHITE, mixColor, roundedRectPoints } from "./wavePath";
import { useReducedMotion } from "../creative/useReducedMotion";

// THE line. One continuous stroke that IS the waveform at rest and BENDS into
// the input's rounded-rect outline when you capture — in place, so it reads as
// "the wave became the box." Rest wave and rect are both N ordered points; each
// frame we lerp point-by-point by an eased morph value. The box height eases
// too (grow-on-focus / grow-with-content). A soft blurred underlay feathers the
// stroke so it's not razor-hard on black. Fully ref-driven, no React re-render.

const N = 140;
const HUMPS = 1.5;

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

export interface MorphRect {
  cx: number;
  cy: number;
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
  const crispRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const morphRef = useRef(0);
  const hRef = useRef(rect.h);
  const reduce = useReducedMotion();

  const boxRef = useRef(boxMode);
  boxRef.current = boxMode;
  const rectRef = useRef(rect);
  rectRef.current = rect;

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

      // morph eases toward target; snap the last sliver so the box is a clean
      // rect (no residual wave wiggle in the corners)
      const target = boxRef.current ? 1 : 0;
      morphRef.current += (target - morphRef.current) * Math.min(1, dt * 6);
      if (target === 1 && morphRef.current > 0.995) morphRef.current = 1;
      if (target === 0 && morphRef.current < 0.004) morphRef.current = 0;
      const m = smoothstep(morphRef.current);

      const r = rectRef.current;
      hRef.current += (r.h - hRef.current) * Math.min(1, dt * 8); // box height eases
      const h = hRef.current;

      const breathe = 0.5 + 0.5 * Math.sin(t * 0.7);
      const amp = (26 + 12 * breathe) * (0.8 + e.cur * 0.6) * (1 + a.cur * 0.4) * (1 - m);
      const W = Math.min(waveWidth, r.w * 1.05);
      const rectPts = m > 0.001 ? roundedRectPoints(r.cx - r.w / 2, r.cy - h / 2, r.w, h, r.r, N) : null;

      let d = "";
      for (let i = 0; i <= N; i++) {
        const tt = i / N;
        const env = Math.sin(Math.PI * tt);
        const x0 = r.cx - W / 2 + tt * W;
        const y0 = r.cy - Math.sin(tt * Math.PI * 2 * HUMPS + t * 0.8) * amp * env;
        let x = x0;
        let y = y0;
        if (rectPts) {
          const rp = rectPts[i];
          x = x0 + (rp[0] - x0) * m;
          y = y0 + (rp[1] - y0) * m;
        }
        d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
      }
      d = d.trim();

      const stroke = e.cur > 0.02 ? mixColor(WHITE, GREEN, Math.min(1, e.cur)) : WHITE;
      if (crispRef.current) {
        crispRef.current.setAttribute("d", d);
        crispRef.current.setAttribute("stroke", stroke);
      }
      if (glowRef.current) {
        glowRef.current.setAttribute("d", d);
        glowRef.current.setAttribute("stroke", stroke);
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
      {/* soft blurred underlay — feathers the stroke so it isn't razor-hard */}
      <path
        ref={glowRef}
        fill="none"
        stroke={WHITE}
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.4}
        style={{ filter: "blur(5px)" }}
      />
      {/* crisp core */}
      <path
        ref={crispRef}
        fill="none"
        stroke={WHITE}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.92}
        style={{ filter: "blur(0.4px)" }}
      />
    </svg>
  );
}
