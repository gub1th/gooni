import { create } from "zustand";

// Is the focus overlay open? Ephemeral, deliberately NOT persisted.
//
// The banner owns the overlay, but it is not the only thing that should be able
// to summon it — the running task's row on the home wants to open it too, and
// that row is nowhere near the banner in the tree. This is the one bit of
// shared UI state between them.
//
// It holds NO session data. The session lives in `useFocusSessionStore`; this
// is "is the expanded view showing", nothing more. Not persisted because
// reopening the app mid-session should hand you the strip and let you get on
// with it, not a modal you have to dismiss.
interface FocusOverlayState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useFocusOverlayStore = create<FocusOverlayState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
