import { create } from "zustand";
import { persist } from "zustand/middleware";

// One of the four screen corners. Modal anchors here and lays out from
// that corner inward. Default = bottom-right (matches the FAB).
export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

interface State {
  corner: Corner;
  setCorner: (c: Corner) => void;
  reset: () => void;
}

export const useGooniModalCornerStore = create<State>()(
  persist(
    (set) => ({
      corner: "bottom-right",
      setCorner: (corner) => set({ corner }),
      reset: () => set({ corner: "bottom-right" }),
    }),
    { name: "gooni-modal-corner-v1" },
  ),
);

// Convert client coords (during drag) into the closest of the 4 corners.
export function nearestCorner(
  x: number,
  y: number,
  vw: number,
  vh: number,
): Corner {
  const left = x < vw / 2;
  const top = y < vh / 2;
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}` as Corner;
}
