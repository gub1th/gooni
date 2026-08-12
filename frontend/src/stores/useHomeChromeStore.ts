import { create } from "zustand";
import type { ApiNote, CalendarEvent } from "../services/api";

// The bridge between the sticky header and the home.
//
// Two of the header's controls — the mic and the log — are HOME functions. The
// mic drives a SpeechRecognition instance whose callbacks read live refs (they
// bind once, so state would freeze at first render), and the log sheet is the
// home's own open/closed state. Neither can move into a header that renders on
// every surface without dragging the recogniser with it, and that is a
// restructure this pass does not want.
//
// So the header owns the BUTTON and the home owns the BEHAVIOUR: the home
// publishes what to display and what to call, the header renders it. It is only
// safe because the home is ALWAYS MOUNTED — pass 7 portals it to the body so a
// surface panel has something to slide over — so these handlers are live on
// every surface, not just `/`.
//
// Deliberately NOT in a home-local context: the header is mounted in AppShell,
// which is a sibling of the portal, so there is no provider that could span both.

interface HomeChromeState {
  /** voice mode is on (the mic will listen when armed) */
  voiceOn: boolean;
  /** mic is hot RIGHT NOW — the only thing that turns the glyph accent-green */
  listening: boolean;
  /** today has a calendar event — the log button wears a dot */
  hasEventToday: boolean;
  /** today's events, from the ONE fetch the home already makes for the dot.
      The notch reads them for UP NEXT rather than fetching a second time. */
  events: CalendarEvent[];
  /** the log sheet is open — the header button reads as active */
  logOpen: boolean;
  /** null until the home has mounted and registered; the header hides the control */
  toggleVoice: (() => void) | null;
  toggleLog: (() => void) | null;
  /** a quickfind note hit — the home peeks it inline rather than routing away */
  openNote: ((note: ApiNote) => void) | null;
  publish: (patch: Partial<Omit<HomeChromeState, "publish">>) => void;
}

export const useHomeChromeStore = create<HomeChromeState>((set) => ({
  voiceOn: false,
  listening: false,
  hasEventToday: false,
  events: [],
  logOpen: false,
  toggleVoice: null,
  toggleLog: null,
  openNote: null,
  publish: (patch) => set(patch),
}));
