import { FONT } from "../../ui";
import type { FocusCircle } from "../../services/api";

// The centrepiece: hand-drawn wobbly circles, one per topic. The stroke math is
// lifted verbatim from Daniel's mockup (gooni_dashboard_notch_handdrawn_circles
// .html) — a not-quite-closed path with overshoot (the end passes OUTSIDE the
// start, the way you'd circle something on a whiteboard) plus a summed-sine
// wiggle. That exact look is the point, so the generator is copied, not reinvented.
//
// Encoding of signal (per the plan — color is per-topic IDENTITY, never meaning):
//   • SIZE   = decayed salience   (bigger = hotter)
//   • PULSE  = growth             (touched recently → it breathes)
//   • FIXED slot positions        (spatial stability is what makes a glanceable
//                                  display glanceable — you learn where a topic
//                                  lives and read it without focusing)
//   • slow, MISMATCHED rotation   (coprime-ish periods → they never sync up)
//   • glow via CSS drop-shadow against the near-black screen
//   • view only, no click

// Five fixed slots, asymmetric, gravitating toward centre with clear space
// between (even spacing would read as a chart). Fractions of the viewBox.
// circles[i] (ranked hottest-first by the backend) lands in SLOTS[i].
const SLOTS: { fx: number; fy: number }[] = [
  { fx: 0.5, fy: 0.5 }, // rank 0 — centre, the anchor
  { fx: 0.25, fy: 0.33 }, // rank 1 — upper-left
  { fx: 0.73, fy: 0.65 }, // rank 2 — lower-right
  { fx: 0.29, fy: 0.72 }, // rank 3 — lower-left
  { fx: 0.76, fy: 0.31 }, // rank 4 — upper-right
];

// Rotation periods, seconds. No common factor → the circles never line up.
const PERIODS = [63, 47, 58, 71, 41];
// Alternate spin direction for extra life; still slow + mismatched.
const DIRS = [1, -1, 1, -1, 1];

const VIEW_W = 680;
const VIEW_H = 620;

// SIZE mapping. Decayed salience is 0.01..0.99 but real values cluster low
// (seed 0.30, 7-day half-life), so map [0, SAL_VIS_MAX] → [MIN_R, MAX_R] and
// clamp — this spends the whole size range on the band salience actually lives
// in, keeping the hotness differences legible instead of all-tiny.
const MIN_R = 44;
const MAX_R = 100;
const SAL_VIS_MAX = 0.6;

function radiusFor(salienceDecayed: number): number {
  const t = Math.min(1, Math.max(0, salienceDecayed / SAL_VIS_MAX));
  return MIN_R + (MAX_R - MIN_R) * t;
}

// Hand-drawn closed-ish path centred on (0,0) — positioned via a parent
// translate so rotation can spin it in place around its own bbox centre.
function circlePath(r: number, phase: number): string {
  const pts: string[] = [];
  const n = 90;
  const over = 0.42; // overshoot — the stroke passes ~0.42rad past the start
  const drift = r * 0.056; // outward drift over the sweep, scaled with r (≈3.5 @ r62)
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * (Math.PI * 2 + over) - Math.PI / 2;
    const w =
      1 +
      0.035 * Math.sin(5 * a + phase) +
      0.022 * Math.sin(9 * a + phase * 1.7) +
      0.014 * Math.sin(13 * a + phase * 0.6);
    const rr = r * w + (k / n) * drift;
    pts.push(`${(rr * Math.cos(a)).toFixed(1)},${(rr * Math.sin(a)).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

export function TopicCircles({ circles }: { circles: FocusCircle[] }) {
  const shown = circles.slice(0, SLOTS.length);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      role="img"
      aria-label="Topic salience field"
    >
      <style>{`
        @keyframes focus-spin  { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes focus-spin-r{ from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
        @keyframes focus-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.055); } }
      `}</style>

      {shown.map((c, i) => {
        const slot = SLOTS[i];
        const cx = slot.fx * VIEW_W;
        const cy = slot.fy * VIEW_H;
        const r = radiusFor(c.salience_decayed);
        const color = c.color || "#B4B2A9";
        const phase = i * 2.1;
        const period = PERIODS[i % PERIODS.length];
        const spinName = DIRS[i % DIRS.length] === 1 ? "focus-spin" : "focus-spin-r";
        const strokeWidth = 1.4 + ((r - MIN_R) / (MAX_R - MIN_R)) * 0.9;
        const fontSize = r > 74 ? 15 : 12.5;
        const d = circlePath(r, phase);

        return (
          // Positioning group — SVG transform attribute (NOT a CSS transform,
          // which would be clobbered by the inner CSS animations).
          <g key={c.id} transform={`translate(${cx} ${cy})`}>
            {/* Pulse layer — breathes only when the topic is growing. Scales
                around its own bbox centre (≈ the circle centre). */}
            <g
              style={
                c.growth
                  ? {
                      transformBox: "fill-box",
                      transformOrigin: "center",
                      animation: "focus-pulse 3.4s ease-in-out infinite",
                    }
                  : undefined
              }
            >
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                opacity={0.85}
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  animation: `${spinName} ${period}s linear infinite`,
                  // Glow against the near-black screen (a soft double bloom).
                  filter: `drop-shadow(0 0 5px ${color}) drop-shadow(0 0 14px ${color}66)`,
                }}
              />
            </g>

            {/* Label — static (does not spin or pulse), centred in the circle. */}
            <text
              x={0}
              y={4}
              textAnchor="middle"
              fill={color}
              fontSize={fontSize}
              fontFamily={FONT}
              style={{ pointerEvents: "none" }}
            >
              {c.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
