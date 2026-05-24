import type { HealthAxis } from "../../services/api";
import { FONT } from "../../ui";

// HealthCard — single axis on the Build mode dashboard. Composite
// number + colored ring + axis name + headline component summary.
// Click → opens drill-down modal.


const AXIS_LABEL: Record<string, string> = {
  memory: "Memory",
  chat: "Chat",
  engagement: "Engagement",
  availability: "Availability",
  cost: "Cost",
  connectors: "Connectors",
};

function ringColor(score: number): string {
  if (score < 40) return "#791F1F";
  if (score < 70) return "#BA7517";
  return "#0F6E56";
}

function ringBg(score: number): string {
  if (score < 40) return "#FCEBEB";
  if (score < 70) return "#FAEEDA";
  return "#E1F5EE";
}

interface Props {
  axis: HealthAxis;
  onOpen: () => void;
}

export function HealthCard({ axis, onOpen }: Props) {
  const color = ringColor(axis.score);
  const bg = ringBg(axis.score);
  const label = AXIS_LABEL[axis.axis] ?? axis.axis;

  // Ring: SVG circle with stroke-dashoffset proportional to score.
  const r = 26;
  const C = 2 * Math.PI * r;
  const offset = C - (axis.score / 100) * C;

  return (
    <div
      onClick={onOpen}
      style={{
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
        borderRadius: 14,
        padding: "14px 16px",
        cursor: "pointer",
        fontFamily: FONT,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 14,
        alignItems: "center",
      }}
    >
      {/* Ring + score */}
      <div style={{ position: "relative", width: 62, height: 62 }}>
        <svg width={62} height={62}>
          <circle
            cx={31} cy={31} r={r}
            fill={bg} stroke="rgba(0,0,0,0.06)" strokeWidth={4}
          />
          <circle
            cx={31} cy={31} r={r}
            fill="none" stroke={color} strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
            transform={`rotate(-90 31 31)`}
          />
        </svg>
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, fontWeight: 600, color: color,
          fontVariantNumeric: "tabular-nums",
        }}>
          {Math.round(axis.score)}
        </div>
      </div>

      {/* Label + headline */}
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600,
          color: "var(--gooni-text, #1C1C1E)",
          marginBottom: 2,
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
          lineHeight: 1.35,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2 as unknown as number,
          WebkitBoxOrient: "vertical" as unknown as "vertical",
        }}>
          {axis.headline}
        </div>
      </div>
    </div>
  );
}
