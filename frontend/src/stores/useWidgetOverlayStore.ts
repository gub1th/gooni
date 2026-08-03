import { create } from "zustand";

// Ephemeral coordination between the compact home widgets, the app nav, and the
// full-screen widget panels. NOT persisted — which panel is open shouldn't
// survive a reload. `rev` is a mutation tick: any widget that writes (e.g. the
// calendar panel creating an event) calls bump() so the compact cards refetch.
// Agenda was dropped (Daniel doesn't use it) — the full calendar is week-grid
// only now, so the union has a single member. Kept as a type (not inlined) so
// the widget-panel contract stays open to future view modes.
export type WidgetView = "week";

interface WidgetOverlayState {
  openId: string | null;
  view: WidgetView;
  rev: number;
  open: (id: string, view?: WidgetView) => void;
  close: () => void;
  bump: () => void;
}

export const useWidgetOverlayStore = create<WidgetOverlayState>((set) => ({
  openId: null,
  view: "week",
  rev: 0,
  open: (id, view = "week") => set({ openId: id, view }),
  close: () => set({ openId: null }),
  bump: () => set((s) => ({ rev: s.rev + 1 })),
}));
