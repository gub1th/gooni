import type { DashboardTab } from "../../stores/useDashboardStore";

// TabToggle — segmented pill below the composer. Daniel toggles between
// "what do I need to do" (Todos) and "what am I orbiting" (Focuses).
// Persisted via useDashboardStore so the tab survives reloads.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

export function TabToggle({ active, onChange }: Props) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      background: "rgba(0,0,0,0.04)",
      borderRadius: 8, padding: 3,
      width: "fit-content",
      fontFamily: FONT,
      marginBottom: 14,
    }}>
      <TabButton
        label="Todos"
        active={active === "todos"}
        onClick={() => onChange("todos")}
      />
      <TabButton
        label="Focuses"
        active={active === "focuses"}
        onClick={() => onChange("focuses")}
      />
    </div>
  );
}

function TabButton({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 16px",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        background: active ? "var(--gooni-card, #fff)" : "transparent",
        color: active ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #8E8E93)",
        border: "none",
        transition: "all 0.15s",
        fontFamily: "inherit",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
      }}
    >
      {label}
    </button>
  );
}
