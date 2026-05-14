import { create } from "zustand";
import { persist } from "zustand/middleware";

// Dashboard-level UI state. Currently just the Todos/Focuses tab toggle
// below the composer. Persisted so reload doesn't snap back to default.

export type DashboardTab = "todos" | "focuses";

interface DashboardState {
  activeTab: DashboardTab;
  setActiveTab: (t: DashboardTab) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      activeTab: "todos",
      setActiveTab: (activeTab) => set({ activeTab }),
    }),
    {
      name: "gooni-dashboard-v1",
      partialize: (s) => ({ activeTab: s.activeTab }),
    },
  ),
);
