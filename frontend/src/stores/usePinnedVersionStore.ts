import { create } from "zustand";

// Lightweight cross-component signal. Anyone that pins/unpins a note bumps the version;
// Sidebar + Dashboard subscribe to it and refetch. This avoids prop-drilling and keeps
// each component's own state simple.
interface PinnedVersionState {
  version: number;
  bump: () => void;
}

export const usePinnedVersionStore = create<PinnedVersionState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
