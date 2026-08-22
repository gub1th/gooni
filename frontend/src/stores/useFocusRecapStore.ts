import { create } from "zustand";
import { persist } from "zustand/middleware";

// Which session's dashboard `/focus` should show over the idle view — an ID,
// not the recap DATA.
//
// It used to hold the built `SessionRecapData` object directly, written once
// by `FocusExpanded`'s `stop()` from the client's OWN session state. That
// made the dashboard reachable for exactly one session: the one that had
// JUST stopped in THIS tab. A reload lost the in-memory store and the recap
// was gone forever; clicking a DIFFERENT session in the history list had
// nowhere to write to, because the store only knew how to hold the session
// that had just ended, not any session by id.
//
// The fix is the same move the session lifecycle itself made
// (`useFocusSessionStore` → `focus_sessions` the row): stop holding the
// derived VIEW and start holding an ADDRESS. `FocusSessionRecapView` reads
// `sessionId`, fetches that session fresh (`GET /focus/sessions/{id}
// ?activity=1`) and maps it through `recapFromSession` — the SAME path
// whether the session ended a second ago or three weeks ago, so post-stop
// and history-click can never render differently.
//
// PERSISTED, on purpose: "reload right after stopping still shows the
// dashboard" is a real acceptance bar, and an id is cheap and safe to carry
// across a reload in a way a full recap object never was — nothing about the
// address goes stale, only the data behind it, and that's re-fetched anyway.
// It also means clicking a past session, closing the tab and coming back
// tomorrow lands you right back on it, which is the same "the recap is what
// you were last looking at" behaviour rather than a special post-stop case.
interface FocusRecapState {
  sessionId: number | null;
  show: (id: number) => void;
  clear: () => void;
}

export const useFocusRecapStore = create<FocusRecapState>()(
  persist(
    (set) => ({
      sessionId: null,
      show: (id) => set({ sessionId: id }),
      clear: () => set({ sessionId: null }),
    }),
    { name: "gooni-focus-recap-v1" },
  ),
);
