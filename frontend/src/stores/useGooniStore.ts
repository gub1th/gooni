import { create } from "zustand";
import { persist } from "zustand/middleware";

// Surface mode for the floating Gooni shell:
//   "modal"   — popup bubble anchored to the FAB (default).
//   "sidebar" — full-height docked panel on the right.
// PlanView mounts its own non-floating GooniPanel directly, so this flag
// only governs the FAB-driven open path.
export type GooniSurface = "modal" | "sidebar";

// Composer mode for the panel input bar:
//   "chat" — message goes to Gooni (default).
//   "note" — message saves as a quick note in General space.
// Persisted so the panel reopens in whatever mode you were last in.
export type ComposerMode = "chat" | "note";

interface GooniState {
  isOpen: boolean;
  width: number;
  surface: GooniSurface;
  composerMode: ComposerMode;
  // Transient (not persisted): set true while a chrome-heavy view is
  // mounted (e.g. PlanView) so the walking mascot doesn't roam across
  // the chat. Resets to false on unmount.
  mascotSuppressed: boolean;
  toggle: () => void;
  setWidth: (w: number) => void;
  setSurface: (s: GooniSurface) => void;
  setComposerMode: (m: ComposerMode) => void;
  setMascotSuppressed: (v: boolean) => void;
}

export const useGooniStore = create<GooniState>()(
  persist(
    (set) => ({
      isOpen: false,
      width: 300,
      surface: "modal",
      composerMode: "chat",
      mascotSuppressed: false,
      toggle: () => set((s) => ({ isOpen: !s.isOpen })),
      setWidth: (w: number) => set({ width: Math.min(600, Math.max(220, w)) }),
      setSurface: (surface) => set({ surface }),
      setComposerMode: (composerMode) => set({ composerMode }),
      setMascotSuppressed: (mascotSuppressed) => set({ mascotSuppressed }),
    }),
    {
      // v4: added composerMode (chat | note) so panel reopens in last mode.
      name: "gooni-v4",
      partialize: (s) => ({ width: s.width, surface: s.surface, composerMode: s.composerMode }),
    }
  )
);
