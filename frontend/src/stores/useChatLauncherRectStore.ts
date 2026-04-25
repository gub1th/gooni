import { create } from "zustand";

// Lightweight registry for the floating chat-launcher's bounding rect.
// The mascot reads this to anchor its drop zone + idle "docked" position
// at the launcher instead of the old sidebar seam. Updated on FAB mount,
// resize, and scroll. Null when the FAB hasn't mounted yet (e.g. first
// frame of render).

interface LauncherRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LauncherStore {
  rect: LauncherRect | null;
  setRect: (r: LauncherRect | null) => void;
}

export const useChatLauncherRectStore = create<LauncherStore>((set) => ({
  rect: null,
  setRect: (r) => set({ rect: r }),
}));
