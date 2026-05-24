import type { HealthAxis } from "../../services/api";
import { Modal, color } from "../../ui";

// HealthDrillDown — modal opened by clicking a health card. Lists
// each component with its score bar + drill-down detail string.

const AXIS_LABEL: Record<string, string> = {
  memory: "Memory",
  chat: "Chat quality",
  engagement: "Engagement",
  availability: "Availability",
  cost: "Cost",
  connectors: "Connectors",
};

// Status colors — semantic (red/amber/green), intentionally theme-independent.
function barColor(score: number): string {
  if (score < 40) return "#EF4444";
  if (score < 70) return "#F59E0B";
  return "#22C55E";
}

interface Props {
  axis: HealthAxis | null;
  onClose: () => void;
}

export function HealthDrillDown({ axis, onClose }: Props) {
  return (
    <Modal open={axis != null} onClose={onClose} title="Health axis" width={540}>
      {axis && (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>
              {AXIS_LABEL[axis.axis] ?? axis.axis}
            </div>
            <div style={{ fontSize: 12, color: color.muted, marginTop: 4 }}>
              {axis.headline}
            </div>
          </div>

          {axis.components.length === 0 ? (
            <div style={{ fontSize: 12, color: color.muted }}>
              {axis.error ? `Error: ${axis.error}` : "No components reported."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {axis.components.map((c) => (
                <div key={c.name}>
                  <div style={{
                    display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", marginBottom: 4,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {c.name}
                      <span style={{
                        fontSize: 10, color: color.muted,
                        marginLeft: 6, fontWeight: 400,
                      }}>
                        weight {Math.round(c.weight * 100)}%
                      </span>
                    </div>
                    <div style={{
                      fontSize: 13, fontWeight: 600,
                      color: barColor(c.score),
                      fontVariantNumeric: "tabular-nums",
                    }}>
                      {Math.round(c.score)}
                    </div>
                  </div>
                  <div style={{
                    height: 6, background: "rgba(0,0,0,0.06)",
                    borderRadius: 3, overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${c.score}%`, height: "100%",
                      background: barColor(c.score),
                    }} />
                  </div>
                  <div style={{
                    fontSize: 11, color: color.muted,
                    marginTop: 4,
                  }}>
                    {c.detail}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
