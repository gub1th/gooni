import { useState, useRef, useEffect } from "react";
import { Palette } from "lucide-react";
import {
  useDashboardStore,
  MODE_COLOR_SWATCHES,
  type DashboardMode,
} from "../../stores/useDashboardStore";

// ModeToggle — top-tier dashboard toggle. Three modes:
//   Today  — current dashboard (todos/focuses/habits/take)
//   Build  — Gooni health (6-axis composite scores)
//   Pulse  — life stats (Whoop/LeetCode/GitHub/etc)
//
// Per-mode background color customizable via the palette button on the
// right. Choice persists in useDashboardStore.modeColors[mode].

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const MODES: { id: DashboardMode; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "build", label: "Build" },
  { id: "pulse", label: "Pulse" },
];

export function ModeToggle() {
  const activeMode = useDashboardStore((s) => s.activeMode);
  const setActiveMode = useDashboardStore((s) => s.setActiveMode);
  const modeColors = useDashboardStore((s) => s.modeColors);
  const setModeColor = useDashboardStore((s) => s.setModeColor);
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Close picker on outside-click.
  useEffect(() => {
    if (!picking) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPicking(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [picking]);

  const activeColor = modeColors[activeMode];

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      marginBottom: 14, fontFamily: FONT,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 0,
        background: "rgba(0,0,0,0.04)",
        borderRadius: 999, padding: 3, width: "fit-content",
      }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setActiveMode(m.id)}
            style={{
              padding: "5px 16px",
              borderRadius: 999,
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

      {/* Color picker — circle button that opens a swatch popover */}
      <div ref={pickerRef} style={{ position: "relative" }}>
        <button
          onClick={() => setPicking((v) => !v)}
          title={`Background color for ${activeMode}`}
          style={{
            width: 22, height: 22, borderRadius: "50%",
            border: "0.5px solid rgba(0,0,0,0.15)",
            background: activeColor || "var(--gooni-card, #fff)",
            cursor: "pointer", padding: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: activeColor ? "rgba(0,0,0,0.5)" : "var(--gooni-muted, #8E8E93)",
          }}
        >
          {!activeColor && <Palette size={11} />}
        </button>
        {picking && (
          <div style={{
            position: "absolute", top: 28, left: 0,
            background: "var(--gooni-card, #fff)",
            border: "0.5px solid rgba(0,0,0,0.12)",
            borderRadius: 10, padding: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            zIndex: 30, display: "flex", gap: 6,
            alignItems: "center", flexWrap: "wrap",
            width: 200,
          }}>
            {MODE_COLOR_SWATCHES.map((s) => (
              <button
                key={s.hex}
                onClick={() => {
                  setModeColor(activeMode, s.hex);
                  setPicking(false);
                }}
                title={s.name}
                style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: s.hex,
                  border: activeColor === s.hex
                    ? "2px solid var(--gooni-text, #1C1C1E)"
                    : "0.5px solid rgba(0,0,0,0.15)",
                  cursor: "pointer", padding: 0,
                }}
              />
            ))}
            {/* Reset to no-tint */}
            <button
              onClick={() => {
                setModeColor(activeMode, null);
                setPicking(false);
              }}
              title="Default"
              style={{
                width: 22, height: 22, borderRadius: "50%",
                background: "var(--gooni-card, #fff)",
                border: activeColor == null
                  ? "2px solid var(--gooni-text, #1C1C1E)"
                  : "0.5px solid rgba(0,0,0,0.15)",
                cursor: "pointer", padding: 0,
                fontSize: 9, color: "var(--gooni-muted, #8E8E93)",
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
