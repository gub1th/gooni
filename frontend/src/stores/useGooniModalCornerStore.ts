import { create } from "zustand";
import { persist } from "zustand/middleware";

// Free-form modal position. Stores the top-left corner of the modal in
// viewport coordinates. `null` = use the default (anchored bottom-right
// near the FAB). When set, modal renders at exactly that position
// (clamped to viewport at render time).
interface State {
  pos: { x: number; y: number } | null;
  setPos: (p: { x: number; y: number } | null) => void;
  reset: () => void;
}

export const useGooniModalCornerStore = create<State>()(
  persist(
    (set) => ({
      pos: null,
      setPos: (pos) => set({ pos }),
      reset: () => set({ pos: null }),
    }),
    { name: "gooni-modal-pos-v2" },
  ),
);
