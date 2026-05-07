import { create } from "zustand";

// Cross-component signal — toggling is_draft anywhere bumps the version so
// Sidebar's DRAFTS section refetches. Mirrors usePinnedVersionStore.
interface DraftVersionState {
  version: number;
  bump: () => void;
}

export const useDraftVersionStore = create<DraftVersionState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
