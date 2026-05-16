import { useDashboardStore, type DashboardMode } from "../../stores/useDashboardStore";

// ModeToggle — top-tier dashboard toggle. Three modes:
//   Today  — current dashboard (todos/focuses/habits/take)
//   Build  — Gooni health (6-axis composite scores)
//   Pulse  — life stats (Whoop/LeetCode/GitHub/etc)
//
// Border-radius matches todo/focus card chrome (12) so the dashboard reads
// as one coherent layout. No per-mode background tint — global theme bg
// owns the page surface (Settings → Appearance).

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const MODES: { id: DashboardMode; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "build", label: "Build" },
  { id: "pulse", label: "Pulse" },
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
