import { create } from "zustand";

// What a just-ended session offers you, once.
//
// Stopping and finishing are DIFFERENT EVENTS. You stop because you were
// interrupted, or you are switching tasks, or the day ended — so a stop that
// auto-completed the task would make it impossible to stop without lying about
// the work. The offer is therefore exactly that: taking it completes the task,
// ignoring it leaves the task open and simply ends the session. The row's
// checkbox remains the deliberate way to complete.
//
// Ephemeral and not persisted: an offer is about the moment you stopped, and a
// reload is not that moment. It is set by `endFocusSession` — the one place a
// session legitimately ends — so every surface that can stop gets the offer for
// free rather than each of them remembering to raise it.
export interface SessionEndOffer {
  promiseId: number;
  title: string;
  /** already kept during the session — nothing left to offer */
  alreadyKept: boolean;
}

interface SessionEndOfferState {
  offer: SessionEndOffer | null;
  raise: (offer: SessionEndOffer) => void;
  clear: () => void;
}

export const useSessionEndOfferStore = create<SessionEndOfferState>((set) => ({
  offer: null,
  raise: (offer) => set({ offer: offer.alreadyKept ? null : offer }),
  clear: () => set({ offer: null }),
}));
