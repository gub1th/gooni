import { FONT } from "../../ui";
import type { FocusPalette } from "./focusPalette";
import { AWAY_KINDS, DISTRACTION_KINDS, kindLabel } from "./focusDetectionKinds";
import { type ScoreTier } from "../../services/focusScore";

// Small SVG/CSS chart primitives for the session recap dashboard. No chart
// library — the shapes here (a ring, a horizontal-bar list, a binned area
// chart, a colored timeline) are all a handful of divs/paths, and pulling in
// a dependency for them would cost more than it saves. Pure presentational —
// every input here is data the session/sensors already produced (see
// `focusScore.ts` and `FocusSessionRecap.tsx`), nothing invented here either.

// Semantic status colors that don't live in `FocusPalette` because nothing
// else on the focus surface needed a red — `pal.warn` (amber) already covers
// "distracted", but "away" (no camera presence at all) needs to read as more
// severe than a flagged-but-present moment.
const AWAY_COLOR = "#D9534F";

export function scoreColor(tier: ScoreTier, pal: FocusPalette): string {
  if (tier === "good") return pal.accent;
  if (tier === "ok") return pal.warn;
  return AWAY_COLOR;
}

// ── Score ring ───────────────────────────────────────────────────────────

interface ScoreRingProps {
  score: number | null;
  tier: ScoreTier;
  pal: FocusPalette;
  size?: number;
}

export function FocusScoreRing({ score, tier, pal, size = 148 }: ScoreRingProps) {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = score == null ? 0 : score / 100;
  const color = score == null ? pal.ink3 : scoreColor(tier, pal);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={pal.rule} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          style={{ transition: "stroke-dashoffset 400ms ease" }}
        />
      </svg>
      <div
        style={{
          position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", fontFamily: FONT,
        }}
      >
        <div style={{ fontSize: size * 0.3, fontWeight: 600, color: pal.ink, lineHeight: 1 }}>
          {score == null ? "—" : score}
        </div>
        <div style={{ fontSize: 10, letterSpacing: "0.1em", color: pal.ink3, marginTop: 4 }}>
          FOCUS SCORE
        </div>
      </div>
    </div>
  );
}

// ── Timeline bar ─────────────────────────────────────────────────────────

export interface TimelineFocusSegment {
  start: number;
  end: number;
  truncated?: boolean;
}

export interface TimelineMarker {
  at: number;
  kind: string;
}

interface TimelineBarProps {
  spanStart: number;
  spanEnd: number;
  focusSegments: TimelineFocusSegment[];
  markers: TimelineMarker[];
  pal: FocusPalette;
}

/** The horizontal timeline — green over every closed focus run (the ONLY
 *  continuous state this data actually supports), gray (`pal.rule`, the
 *  track's own background) everywhere else, meaning "paused". Detections are
 *  drawn as ticks rather than colored spans on purpose: the sensors report
 *  discrete events with no duration, not a continuous presence/away signal —
 *  painting a wide red band from one `left_desk` event would be a claim the
 *  data doesn't back. Same honesty rule `focus_attribution` follows: a number
 *  that might be wrong is useful when it says what it actually is. */
export function FocusTimelineBar({ spanStart, spanEnd, focusSegments, markers, pal }: TimelineBarProps) {
  const span = spanEnd - spanStart;
  if (span <= 0) return null;
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - spanStart) / span) * 100));

  return (
    <div>
      <div style={{ position: "relative", height: 22, background: pal.rule, borderRadius: 6, overflow: "hidden" }}>
        {focusSegments.map((seg, i) => {
          const left = pct(seg.start);
          const width = Math.max(0.5, pct(seg.end) - left);
          return (
            <div
              key={i}
              title={seg.truncated ? "capped run" : "focused"}
              style={{
                position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${width}%`,
                background: seg.truncated ? pal.warn : pal.accent,
              }}
            />
          );
        })}
        {markers.map((m, i) => {
          const color = AWAY_KINDS.has(m.kind) ? AWAY_COLOR : DISTRACTION_KINDS.has(m.kind) ? pal.warn : pal.ink3;
          return (
            <div
              key={i}
              title={kindLabel(m.kind)}
              style={{
                position: "absolute", top: 0, bottom: 0, left: `${pct(m.at)}%`, width: 3,
                marginLeft: -1.5, background: color, boxShadow: `0 0 0 1px ${pal.paper}`,
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10.5, color: pal.ink3, flexWrap: "wrap" }}>
        <LegendDot color={pal.accent} label="focused" />
        <LegendDot color={pal.rule} outline={pal.ink3} label="paused" />
        <LegendDot color={pal.warn} label="distracted" />
        <LegendDot color={AWAY_COLOR} label="away" />
      </div>
    </div>
  );
}

function LegendDot({ color, outline, label }: { color: string; outline?: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, border: outline ? `1px solid ${outline}` : "none" }} />
      {label}
    </span>
  );
}

// ── Horizontal bar chart ────────────────────────────────────────────────

export interface BarRow {
  key: string;
  label: string;
  value: number;
}

interface BarChartProps {
  rows: BarRow[];
  pal: FocusPalette;
  color?: string;
  formatValue?: (v: number) => string;
}

/** Ranked horizontal bars — site distribution, device pings, detection
 *  counts. One shape, three call sites, so it can't drift between them. */
export function RecapBarChart({ rows, pal, color, formatValue }: BarChartProps) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = formatValue ?? ((v: number) => String(v));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 92, flexShrink: 0, fontSize: 11.5, color: pal.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.label}
          </span>
          <div style={{ flex: 1, height: 8, background: pal.rule, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${(r.value / max) * 100}%`, height: "100%", background: color ?? pal.accent, borderRadius: 4 }} />
          </div>
          <span style={{ width: 44, flexShrink: 0, textAlign: "right", fontSize: 11, color: pal.ink3, fontVariantNumeric: "tabular-nums" }}>
            {fmt(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Focus-over-time area chart ─────────────────────────────────────────

interface AreaChartProps {
  series: number[]; // fractions 0..1, one per bucket, left to right
  pal: FocusPalette;
  width?: number;
  height?: number;
}

/** Binned focus-fraction line, filled underneath — "focus over time". Built
 *  from `focusScore.ts::focusFractionSeries`, a pure bucket fold over the
 *  same closed runs the timeline bar draws, so the two can't disagree. */
export function FocusOverTimeChart({ series, pal, width = 560, height = 90 }: AreaChartProps) {
  if (series.length === 0) return null;
  const stepX = width / Math.max(1, series.length - 1 || 1);
  const points = series.map((v, i) => [i * stepX, height - v * (height - 6) - 3]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={areaPath} fill={pal.accent} opacity={0.14} />
      <path d={linePath} fill="none" stroke={pal.accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
