import { create } from "zustand";

// Is the running session ATTACHED to the wave's slot, or DETACHED into the band?
//
// Pass 5 gave the session the wave's slot so the home has exactly one anchor.
// That left no way out of it short of stopping — and stopping is a different
// event from "I want my wave back". Detaching collapses the session into the
// slim top band and returns the wave to the middle; the session keeps running
// the whole time. Clicking the band re-attaches it.
//
// Deliberately NOT in the session store: that store's shape is a separate open
// captain decision, and this is a view preference rather than part of the
// session. It is persisted anyway, under its own key, because a reload that
// silently re-attached would undo a choice you made on purpose — and the
// session itself survives reloads, so the preference has to as well.
const KEY = "gooni_focus_attached";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true; // private mode — attached is the default
  }
}

function write(attached: boolean) {
  try {
    localStorage.setItem(KEY, attached ? "true" : "false");
  } catch {
    /* private mode / quota — it still holds in memory for this session */
  }
}

interface SessionAttachState {
  attached: boolean;
  setAttached: (attached: boolean) => void;
}

export const useSessionAttachStore = create<SessionAttachState>((set) => ({
  attached: read(),
  setAttached: (attached) => {
    write(attached);
    set({ attached });
  },
}));

/**
 * A new session starts ATTACHED.
 *
 * Starting focus is the moment you most want the session to be the thing you
 * are looking at, and inheriting "detached" from some earlier session would
 * hide the one you just deliberately started.
 */
export function resetAttachedForNewSession() {
  useSessionAttachStore.getState().setAttached(true);
}
