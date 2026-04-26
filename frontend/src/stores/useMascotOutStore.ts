import { create } from "zustand";

// Tiny shared signal: whether the live mascot is currently out of the FAB.
// `false` when phase === "peek" (mascot is docked, FAB shows the embedded
// character); `true` for every other phase. The FAB reads this to fade its
// embedded character so only one Gooni is on screen at a time.

interface MascotOutStore {
  isOut: boolean;
  setIsOut: (v: boolean) => void;
}

export const useMascotOutStore = create<MascotOutStore>((set) => ({
  isOut: false,
  setIsOut: (v) => set({ isOut: v }),
}));
