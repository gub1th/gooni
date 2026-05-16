import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dashboard-level UI state.
//
//   activeTab — within-mode toggle for the Today view (Todos vs Focuses).
//   activeMode — top-level mode toggle (Today vs Build vs Pulse). Each
//     mode has its own full-body layout.
//   composerFocused — transient flag set while the embedded NoteEditor
//     ("start writing…") is focused. Used by Dashboard to dim/collapse
//     surrounding chrome (TakeTabs, focuses row) so writing feels focused.
//     NOT persisted — purely a session-scoped layout signal.
//
// Persisted under bumped key gooni-dashboard-v3 (v2 had modeColors, removed).

export type DashboardTab = "todos" | "focuses";
export type DashboardMode = "today" | "build" | "pulse";

interface DashboardState {
  activeTab: DashboardTab;
  activeMode: DashboardMode;
  composerFocused: boolean;
  setActiveTab: (t: DashboardTab) => void;
  setActiveMode: (m: DashboardMode) => void;
  setComposerFocused: (v: boolean) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      activeTab: "todos",
      activeMode: "today",
      composerFocused: false,
      setActiveTab: (activeTab) => set({ activeTab }),
      setActiveMode: (activeMode) => set({ activeMode }),
      setComposerFocused: (composerFocused) => set({ composerFocused }),
    }),
    {
      name: "gooni-dashboard-v3",
      partialize: (s) => ({
        activeTab: s.activeTab,
        activeMode: s.activeMode,
      }),
    },
  ),
);
