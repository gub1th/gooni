import { create } from "zustand";
import { persist } from "zustand/middleware";

// Per-widget home-screen layout state: where each draggable widget was parked
// and whether it's enabled. `enabled` only holds EXPLICIT user overrides — an
// absent key means "use the registry's defaultEnabled", so a newly-registered
// default widget shows up without needing a migration/seed.
//
// Positions are top-left viewport coords (clamped at render). `null`/absent =
// the widget uses its computed default corner.
export interface WidgetPos {
  x: number;
  y: number;
}

interface WidgetLayoutState {
  positions: Record<string, WidgetPos>;
  enabled: Record<string, boolean>;
  setPos: (id: string, pos: WidgetPos) => void;
  setEnabled: (id: string, on: boolean) => void;
}

export const useWidgetLayoutStore = create<WidgetLayoutState>()(
  persist(
    (set) => ({
      positions: {},
      enabled: {},
      setPos: (id, pos) => set((s) => ({ positions: { ...s.positions, [id]: pos } })),
      setEnabled: (id, on) => set((s) => ({ enabled: { ...s.enabled, [id]: on } })),
    }),
    // Bump the version suffix if this shape changes (Zustand persist gotcha).
    { name: "gooni-widgets-v1" },
  ),
);
