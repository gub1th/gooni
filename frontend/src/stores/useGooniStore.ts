import { create } from "zustand";
import { persist } from "zustand/middleware";

// Surface mode for the floating Gooni shell:
//   "modal"   — popup bubble anchored to the FAB (default).
//   "sidebar" — full-height docked panel on the right.
// PlanView mounts its own non-floating GooniPanel directly, so this flag
// only governs the FAB-driven open path.
export type GooniSurface = "modal" | "sidebar";

interface GooniState {
  isOpen: boolean;
  width: number;
  surface: GooniSurface;
  // Transient (not persisted): set true while a chrome-heavy view is
  // mounted (e.g. PlanView) so the walking mascot doesn't roam across
  // the chat. Resets to false on unmount.
  mascotSuppressed: boolean;
  toggle: () => void;
  setWidth: (w: number) => void;
  setSurface: (s: GooniSurface) => void;
  setMascotSuppressed: (v: boolean) => void;
}

export const useGooniStore = create<GooniState>()(
  persist(
    (set) => ({
      isOpen: false,
      width: 300,
      surface: "modal",
      mascotSuppressed: false,
      toggle: () => set((s) => ({ isOpen: !s.isOpen })),
      setWidth: (w: number) => set({ width: Math.min(600, Math.max(220, w)) }),
      setSurface: (surface) => set({ surface }),
      setMascotSuppressed: (mascotSuppressed) => set({ mascotSuppressed }),
    }),
    {
      // v3: dropped `isOpen` from persisted shape. Persisting it meant a
      // stale "panel open" flag from a prior session could leave the user
      // with no visible FAB (FAB hides when panel is open) AND no visible
      // panel (if surface state ever drifted). Keying afresh nukes any
      // legacy blob so a refresh always boots with the FAB on screen.
      name: "gooni-v3",
      partialize: (s) => ({ width: s.width, surface: s.surface }),
    }
  )
);
