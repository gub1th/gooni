import { create } from "zustand";
import { persist } from "zustand/middleware";

interface GooniState {
  isOpen: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
}

export const useGooniStore = create<GooniState>()(
  persist(
    (set) => ({
      isOpen: false,
      width: 300,
      toggle: () => set((s) => ({ isOpen: !s.isOpen })),
      setWidth: (w: number) => set({ width: Math.min(600, Math.max(220, w)) }),
    }),
    {
      name: "gooni-v1",
      partialize: (s) => ({ isOpen: s.isOpen, width: s.width }),
    }
  )
);
