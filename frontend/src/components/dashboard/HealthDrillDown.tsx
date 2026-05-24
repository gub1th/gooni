import { useEffect } from "react";
import { X } from "lucide-react";
import type { HealthAxis } from "../../services/api";
import { FONT } from "../../ui";

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
  useEffect(() => {
    if (!axis) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [axis, onClose]);

  if (!axis) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #fff)",
          borderRadius: 16,
          width: "min(540px, 90vw)",
          maxHeight: "80vh", overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          color: "var(--gooni-text, #1C1C1E)",
        }}
      >
        <div style={{
          padding: "16px 20px",
          borderBottom: "0.5px solid rgba(0,0,0,0.08)",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)", letterSpacing: 0.4, textTransform: "uppercase" }}>
              Health axis
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.1 }}>
              {AXIS_LABEL[axis.axis] ?? axis.axis}
            </div>
            <div style={{
              fontSize: 12, color: "var(--gooni-muted, #8E8E93)", marginTop: 4,
            }}>
              {axis.headline}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: 4, color: "var(--gooni-muted, #8E8E93)",
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "14px 20px 20px" }}>
          {axis.components.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--gooni-muted, #8E8E93)" }}>
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
                        fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
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
                    fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                    marginTop: 4,
                  }}>
                    {c.detail}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
