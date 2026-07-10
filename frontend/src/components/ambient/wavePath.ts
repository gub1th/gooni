// SVG path builders + tiny color lerp for the line-art ambient home.
// Everything is a single stroke: the rest-state waveform, and the rounded-rect
// outlines that summoned surfaces trace themselves out of.

// A contained waveform: a sine across `w`, centered vertically, tapered to the
// centerline at both ends (envelope) so it reads as an icon-like burst in the
// middle rather than a full-bleed beam. `humps` = periods across the width.
export function waveformPath(
  w: number,
  h: number,
  amp: number,
  phase: number,
  humps = 1.6,
  n = 96,
): string {
  const cy = h / 2;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = t * w;
    const env = Math.sin(Math.PI * t); // 0 at ends → 1 in the middle
    const y = cy - Math.sin(t * Math.PI * 2 * humps + phase) * amp * env;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return d.trim();
}

// Rounded-rect outline as a single closed path — the shape a summoned surface
// (input, nav, card) draws itself into.
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M${x + rr},${y} ` +
    `H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} ` +
    `V${y + h - rr} A${rr},${rr} 0 0 1 ${x + w - rr},${y + h} ` +
    `H${x + rr} A${rr},${rr} 0 0 1 ${x},${y + h - rr} ` +
    `V${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y} Z`
  );
}

// A single point on a rounded-rect perimeter at arc-length `d` (0 → perimeter),
// clockwise from the top edge. Sequential early-returns (not an else-if chain)
// so the mutated-`d` guards don't read as duplicate conditions.
function pointOnRoundedRect(
  x: number, y: number, w: number, h: number, rr: number, sw: number, sh: number, arc: number, d: number,
): [number, number] {
  const HALF = Math.PI / 2;
  let s = d;
  if (s <= sw) return [x + rr + s, y];                                        // top edge
  s -= sw;
  if (s <= arc) { const a = -HALF + (s / arc) * HALF; return [x + w - rr + Math.cos(a) * rr, y + rr + Math.sin(a) * rr]; } // TR
  s -= arc;
  if (s <= sh) return [x + w, y + rr + s];                                    // right edge
  s -= sh;
  if (s <= arc) { const a = (s / arc) * HALF; return [x + w - rr + Math.cos(a) * rr, y + h - rr + Math.sin(a) * rr]; }     // BR
  s -= arc;
  if (s <= sw) return [x + w - rr - s, y + h];                                // bottom edge
  s -= sw;
  if (s <= arc) { const a = HALF + (s / arc) * HALF; return [x + rr + Math.cos(a) * rr, y + h - rr + Math.sin(a) * rr]; }  // BL
  s -= arc;
  if (s <= sh) return [x, y + h - rr - s];                                    // left edge
  s -= sh;
  const a = Math.PI + (s / arc) * HALF;                                       // TL
  return [x + rr + Math.cos(a) * rr, y + rr + Math.sin(a) * rr];
}

// Analytic rounded-rect perimeter sampler → N+1 ordered points, evenly spaced
// by arc length. Beats getPointAtLength: clean corners, no DOM, and the height
// can vary smoothly per-frame (grow-on-focus / grow-with-content box).
export function roundedRectPoints(
  x: number, y: number, w: number, h: number, r: number, n: number,
): [number, number][] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const sw = w - 2 * rr;
  const sh = h - 2 * rr;
  const arc = (Math.PI / 2) * rr;
  const P = 2 * sw + 2 * sh + 4 * arc;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(pointOnRoundedRect(x, y, w, h, rr, sw, sh, arc, (i / n) * P));
  }
  return pts;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

// Linear color mix, t in [0,1]. Used to push the waveform stroke from white
// toward green as pending "energy" climbs.
export function mixColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const WHITE = "#F4F5F4";
export const GREEN = "#4ADE80";
