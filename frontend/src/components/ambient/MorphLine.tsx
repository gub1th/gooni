import { useEffect, useRef, type MutableRefObject } from "react";
import { GREEN, mixColor, roundedRectPoints } from "./wavePath";
import { useReducedMotion } from "../creative/useReducedMotion";
import { useGooniThemeStore, WAVE_REST_COLOR } from "../../stores/useGooniThemeStore";

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
  thinking = false,
  dimmed = false,
  waveWidth = 380,
  energyRef,
  activeRef,
}: {
  boxMode: boolean;
  rect: MorphRect;
  thinking?: boolean;
  dimmed?: boolean;
  waveWidth?: number;
  energyRef: MutableRefObject<number>;
  activeRef: MutableRefObject<number>;
}) {
  const crispRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const morphRef = useRef(0);
  const hRef = useRef(rect.h);
  const reduce = useReducedMotion();

  // The line sets its own `stroke` each frame (JS, so no CSS var), so it can't
  // theme via the ambient vars — it picks the rest color by theme: near-white
  // on the black void, ink-dark on the light off-white (a white line vanishes).
  // Held in a ref so the ref-driven rAF loop reads the live value without deps.
  const theme = useGooniThemeStore((s) => s.theme);
  const rest = WAVE_REST_COLOR[theme];
  const restRef = useRef(rest);
  restRef.current = rest;

  const boxRef = useRef(boxMode);
  boxRef.current = boxMode;
  const thinkRef = useRef(thinking);
  thinkRef.current = thinking;
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
      // rest peak ≈ (40+12)*0.8 ≈ 42 half-height, so the wave sits inside the
      // PEEK_H (104) box with margin — the box IS the wave's bounding rect.
      const amp = (40 + 12 * breathe) * (0.8 + e.cur * 0.6) * (1 + a.cur * 0.4) * (1 - m);
      const W = Math.min(waveWidth, r.w * 1.05);
      const rectPts = m > 0.001 ? roundedRectPoints(r.cx - r.w / 2, r.cy - h / 2, r.w, h, r.r, N) : null;

      // a bright bump that travels along the wave = the "thinking" indicator,
      // embedded in the line itself instead of separate dots
      const think = thinkRef.current ? 1 : 0;
      const head = (t * 0.85) % 1;

      let d = "";
      for (let i = 0; i <= N; i++) {
        const tt = i / N;
        // fuller envelope (pow < 1) so amplitude stays high across the span and
        // the ends don't read as faint tails — closer to the Spectre mark
        const env = Math.pow(Math.sin(Math.PI * tt), 0.6);
        const x0 = r.cx - W / 2 + tt * W;
        const dx = tt - head;
        const pulse = think * Math.exp(-(dx * dx) / 0.004) * 20;
        const y0 = r.cy - (Math.sin(tt * Math.PI * 2 * HUMPS + t * 0.8) * amp + pulse) * env;
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

      const restC = restRef.current;
      const stroke = e.cur > 0.02 ? mixColor(restC, GREEN, Math.min(1, e.cur)) : restC;
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
      style={{
        position: "fixed", inset: 0, pointerEvents: "none", overflow: "visible", zIndex: 4,
        opacity: dimmed ? 0 : 1, transition: "opacity 260ms ease",
      }}
    >
      {/* faint even underlay — a low, uniform halo (doesn't pool at the humps
          like a heavy blur did, so brightness stays constant along the line) */}
      <path
        ref={glowRef}
        fill="none"
        stroke={rest}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.18}
        style={{ filter: "blur(3px)" }}
      />
      {/* the line — one solid, uniform stroke */}
      <path
        ref={crispRef}
        fill="none"
        stroke={rest}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={1}
        style={{ filter: "drop-shadow(0 0 2.5px rgba(255,255,255,0.28))" }}
      />
    </svg>
  );
}
