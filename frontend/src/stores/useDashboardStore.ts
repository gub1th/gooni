import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dashboard-level UI state.
//
//   activeTab — within-mode toggle for the Today view (Todos vs Focuses).
//   activeMode — top-level mode toggle (Today vs Build vs Pulse). Each
//     mode has its own full-body layout.
//   modeColors — per-mode background tint. Picker on the mode toggle
//     swaps the hex. Lets Daniel give each mode a distinct visual
//     identity ("I'm in Build now") without re-theming the whole app.
//
// Persisted under bumped key gooni-dashboard-v2 (v1 had only activeTab).

export type DashboardTab = "todos" | "focuses";
export type DashboardMode = "today" | "build" | "pulse";

// 6-color preset palette for the mode-bg picker. Soft tints — won't
// fight the foreground content. Default null = use the theme's main bg.
export const MODE_COLOR_SWATCHES: { name: string; hex: string }[] = [
  { name: "ivory", hex: "#FAF7F0" },
  { name: "sand", hex: "#FAEEDA" },
  { name: "sage", hex: "#E1F5EE" },
  { name: "sky", hex: "#E6F0FA" },
  { name: "blush", hex: "#FCEBEB" },
  { name: "dusk", hex: "#EEEDFE" },
];

interface DashboardState {
  activeTab: DashboardTab;
  activeMode: DashboardMode;
  modeColors: Record<DashboardMode, string | null>;
  setActiveTab: (t: DashboardTab) => void;
  setActiveMode: (m: DashboardMode) => void;
  setModeColor: (m: DashboardMode, hex: string | null) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      activeTab: "todos",
      activeMode: "today",
      modeColors: { today: null, build: null, pulse: null },
      setActiveTab: (activeTab) => set({ activeTab }),
      setActiveMode: (activeMode) => set({ activeMode }),
      setModeColor: (mode, hex) =>
        set((s) => ({ modeColors: { ...s.modeColors, [mode]: hex } })),
    }),
    {
      name: "gooni-dashboard-v2",
      partialize: (s) => ({
        activeTab: s.activeTab,
        activeMode: s.activeMode,
        modeColors: s.modeColors,
      }),
    },
  ),
);
