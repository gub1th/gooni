import { useDashboardStore, type DashboardMode } from "../../stores/useDashboardStore";
import { FONT } from "../../ui";

// ModeToggle — top-tier dashboard toggle. Three modes:
//   Today  — current dashboard (todos/focuses/habits/take)
//   Ops    — Gooni health + backlog + capability profile
//   Stats  — life stats (Whoop/LeetCode/Dev/Usage/Activity), merged from
//            the old Pulse mode + the now-removed Stats sidebar page


const MODES: { id: DashboardMode; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "ops", label: "Ops" },
  { id: "stats", label: "Stats" },
];

export function ModeToggle() {
  const activeMode = useDashboardStore((s) => s.activeMode);
  const setActiveMode = useDashboardStore((s) => s.setActiveMode);

  return (
    <div style={{
      display: "flex", alignItems: "center",
      marginBottom: 14, fontFamily: FONT,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 0,
        background: "rgba(0,0,0,0.04)",
        borderRadius: 12, padding: 3, width: "fit-content",
      }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setActiveMode(m.id)}
            style={{
              padding: "5px 16px",
              borderRadius: 9,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              background: activeMode === m.id
                ? "var(--gooni-card, #fff)"
                : "transparent",
              color: activeMode === m.id
                ? "var(--gooni-text, #1C1C1E)"
                : "var(--gooni-muted, #8E8E93)",
              border: "none",
              transition: "all 0.15s",
              fontFamily: "inherit",
              boxShadow: activeMode === m.id
                ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
