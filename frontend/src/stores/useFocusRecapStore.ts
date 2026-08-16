import { create } from "zustand";
import type { SessionRecapData } from "../components/focus/FocusSessionRecap";

// The just-ended session's recap, held OUTSIDE FocusExpanded on purpose.
//
// `/focus` (FocusKiosk) switches between FocusExpanded and the idle
// GooniAsleep view purely on `session != null` — the moment `stop()` clears
// the session, FocusExpanded unmounts. A recap built and held as FocusExpanded's
// own local state would unmount itself in the same tick it was meant to show.
// So the recap outlives the session the same way the session itself outlives
// any one view of it (`useFocusSessionStore`) — a tiny sibling store, not
// persisted (a recap surviving a reload would describe a session no longer in
// memory).
interface FocusRecapState {
  recap: SessionRecapData | null;
  setRecap: (recap: SessionRecapData) => void;
  clear: () => void;
}

export const useFocusRecapStore = create<FocusRecapState>((set) => ({
  recap: null,
  setRecap: (recap) => set({ recap }),
  clear: () => set({ recap: null }),
}));
