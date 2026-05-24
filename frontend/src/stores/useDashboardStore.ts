import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dashboard-level UI state.
//
//   activeTab — within-mode toggle for the Today view (Todos vs Focuses).
//   activeMode — top-level mode toggle (Today vs Ops vs Stats).
//     Each mode has its own full-body layout. Build was folded into Ops
//     in PR #213; the sidebar Stats page + Pulse mode were merged into
//     a single Stats mode (renamed from Pulse) in the dashboard restructure.
//   composerFocused — transient flag set while the embedded NoteEditor
//     ("start writing…") is focused. Used by Dashboard to dim/collapse
//     surrounding chrome (TakeTabs, focuses row) so writing feels focused.
//     NOT persisted — purely a session-scoped layout signal.
//
// Persisted under key gooni-dashboard-v3. `migrate` coerces legacy
// activeMode='build' values to 'ops' so existing localStorage doesn't
// land users on a now-deleted tab.

export type DashboardTab = "todos" | "focuses";
export type DashboardMode = "today" | "ops" | "stats" | "review";

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
      migrate: (persisted: unknown) => {
        const s = (persisted ?? {}) as Record<string, unknown>;
        if (s.activeMode === "build") s.activeMode = "ops";
        if (s.activeMode === "pulse") s.activeMode = "stats";
        return s as unknown as DashboardState;
      },
    },
  ),
);
