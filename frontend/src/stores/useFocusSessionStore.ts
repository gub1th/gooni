import { create } from "zustand";

// The running focus session — a CLIENT store, deliberately.
//
// There is no session table and no migration: `FocusSession` was retired into
// `TrackableEntry` on purpose, and the only durable artifact a session produces
// is the entry written when it ends. What the session needs while it's alive is
// agreement between `/` and `/focus` across navigation, reload, and a second tab
// on another monitor — which is exactly what localStorage + the `storage` event
// give, with no server round-trip on every tick.
//
// Segments, not a single stopwatch. The brief's field list (started-at,
// accumulated ms, running) totals correctly but can't answer "how much of this
// landed on which calendar day" once a pause splits the window — and a session
// crossing midnight has to write one entry per day or the daily fold lies. So a
// closed [start, end] pair is recorded per run, and `accumulatedMs` is derived
// from them. Each segment carries its mode: BREAK time is real elapsed time but
// it is not focus, and only focus segments are ever written.

export type FocusMode = "focus" | "break";

export interface FocusSegment {
  start: number; // epoch ms
  end: number; // epoch ms
  mode: FocusMode;
}

export interface FocusSession {
  promiseId: number;
  title: string;
  mode: FocusMode;
  /** epoch ms the CURRENT run began; meaningless while paused */
  startedAt: number;
  /** closed runs so far */
  segments: FocusSegment[];
  running: boolean;
}

const KEY = "gooni_focus_session";

interface FocusSessionState {
  session: FocusSession | null;
  start: (promiseId: number, title: string) => void;
  pause: () => void;
  resume: () => void;
  setMode: (mode: FocusMode) => void;
  /** Close the session and hand back its segments for the entry write. */
  stop: () => FocusSegment[];
  /** Rename in place — ticking a task from the session page shouldn't drop it. */
  rename: (title: string) => void;
  /** Adopt whatever another tab wrote. */
  hydrate: (session: FocusSession | null) => void;
}

function read(): FocusSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FocusSession;
    if (typeof parsed?.promiseId !== "number") return null;
    return { ...parsed, segments: Array.isArray(parsed.segments) ? parsed.segments : [] };
  } catch {
    return null;
  }
}

function write(session: FocusSession | null) {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / quota — the session still runs in memory */
  }
}

/** Close the open run (if any) at `now`, returning the full segment list. */
function sealed(s: FocusSession, now: number): FocusSegment[] {
  if (!s.running) return s.segments;
  // Sub-second runs are noise, not work.
  if (now - s.startedAt < 1000) return s.segments;
  return [...s.segments, { start: s.startedAt, end: now, mode: s.mode }];
}

export const useFocusSessionStore = create<FocusSessionState>((set, get) => ({
  session: read(),

  start: (promiseId, title) => {
    const session: FocusSession = {
      promiseId,
      title,
      mode: "focus",
      startedAt: Date.now(),
      segments: [],
      running: true,
    };
    write(session);
    set({ session });
  },

  pause: () => {
    const s = get().session;
    if (!s || !s.running) return;
    const next: FocusSession = { ...s, running: false, segments: sealed(s, Date.now()) };
    write(next);
    set({ session: next });
  },

  resume: () => {
    const s = get().session;
    if (!s || s.running) return;
    const next: FocusSession = { ...s, running: true, startedAt: Date.now() };
    write(next);
    set({ session: next });
  },

  setMode: (mode) => {
    const s = get().session;
    if (!s || s.mode === mode) return;
    // Switching mode closes the current run — the minutes on either side of the
    // switch belong to different buckets.
    const now = Date.now();
    const next: FocusSession = {
      ...s,
      mode,
      segments: sealed(s, now),
      startedAt: now,
    };
    write(next);
    set({ session: next });
  },

  stop: () => {
    const s = get().session;
    if (!s) return [];
    const segments = sealed(s, Date.now());
    write(null);
    set({ session: null });
    return segments;
  },

  rename: (title) => {
    const s = get().session;
    if (!s) return;
    const next = { ...s, title };
    write(next);
    set({ session: next });
  },

  hydrate: (session) => set({ session }),
}));

// Cross-tab sync. `storage` fires in every OTHER tab when one writes, so a
// session started on the laptop shows as running on the second monitor without
// either surface polling.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY) return;
    useFocusSessionStore.getState().hydrate(read());
  });
}

/** Milliseconds of `mode` work in a session, including its open run. */
export function elapsedMs(s: FocusSession | null, mode: FocusMode, now: number): number {
  if (!s) return 0;
  let total = 0;
  for (const seg of s.segments) {
    if (seg.mode === mode) total += Math.max(0, seg.end - seg.start);
  }
  if (s.running && s.mode === mode) total += Math.max(0, now - s.startedAt);
  return total;
}
