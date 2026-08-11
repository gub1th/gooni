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
  /** the run was CAPPED rather than closed by a human — a floor, not a measurement */
  truncated?: boolean;
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
  /**
   * The task has been marked kept while this session runs. It lives HERE, not
   * in either surface's local state, because both surfaces need it and one of
   * them may be a reload away: `/focus` marks it kept, `/` has to keep showing
   * that row struck through AND running, and a plain reload of `/` has nothing
   * else left to learn it from — the dashboard serves ACTIVE commitments only.
   */
  kept: boolean;
  /**
   * Local day keys whose entry has already LANDED for this session.
   *
   * The session outliving a failed write makes a retry reachable, and the write
   * is one `logTrackable` per calendar day on a `agg=sum` trackable — so a retry
   * after a PARTIAL success would add the first day's minutes a second time.
   * `replace` is not the answer (it would collapse the day and destroy every
   * other session logged on it). Recording the days that landed, here where the
   * session already lives, means a retry sends only what is missing and a
   * reload can't lose the record either.
   */
  writtenDates: string[];
}

const KEY = "gooni_focus_session";

/**
 * The longest a single open run may claim.
 *
 * The whole point of the timer is that attribution is trustworthy BY
 * CONSTRUCTION, and the feature's most common failure is the least dramatic
 * one: a session left running overnight would otherwise credit ~9h of sleep as
 * focus against a Promise, which makes the primary output wrong. So the run is
 * capped and the capped segment is FLAGGED, exactly as the browser sensor does
 * it (`extension/src/tracker.js` closes a salvaged interval at its last
 * heartbeat, marks it `truncated`, and hard-clamps at the same 6h its ingest
 * rejects past — `browser_activity_service.MAX_INTERVAL_SEC`). A focus session
 * has no heartbeat to fall back to, so the clamp is all there is.
 */
export const MAX_RUN_MS = 6 * 60 * 60 * 1000;

interface FocusSessionState {
  session: FocusSession | null;
  start: (promiseId: number, title: string) => void;
  pause: () => void;
  resume: () => void;
  setMode: (mode: FocusMode) => void;
  /**
   * Close the open run and hand back the segments, WITHOUT ending the session.
   * The caller writes the entry first and calls `stop` only once that
   * succeeded — a failed write must leave the session recoverable rather than
   * destroying the only durable artifact it produces.
   */
  seal: () => FocusSegment[];
  /** Drop the session. Call AFTER its entry is safely written. */
  stop: () => void;
  /** Rename in place — ticking a task from the session page shouldn't drop it. */
  rename: (title: string) => void;
  /** Mark (or unmark) the task kept while the session runs. */
  setKept: (kept: boolean) => void;
  /** Record that this local day's entry has landed, so a retry skips it. */
  markWritten: (date: string) => void;
  /** Adopt whatever another tab wrote. */
  hydrate: (session: FocusSession | null) => void;
}

function read(): FocusSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FocusSession;
    if (typeof parsed?.promiseId !== "number") return null;
    return {
      ...parsed,
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      kept: parsed.kept === true,
      writtenDates: Array.isArray(parsed.writtenDates) ? parsed.writtenDates : [],
    };
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

/**
 * Close the open run (if any) at `now`, returning the full segment list.
 *
 * Pure, and exported: `/` folds the live session through this to work out how
 * much of it landed on TODAY, and the number it shows has to be the number that
 * would be written if the session ended right now.
 */
export function sealedSegments(s: FocusSession, now: number): FocusSegment[] {
  if (!s.running) return s.segments;
  // Sub-second runs are noise, not work.
  if (now - s.startedAt < 1000) return s.segments;
  if (now - s.startedAt > MAX_RUN_MS) {
    // Nobody closed this. Credit the cap, and say so on the segment.
    return [
      ...s.segments,
      { start: s.startedAt, end: s.startedAt + MAX_RUN_MS, mode: s.mode, truncated: true },
    ];
  }
  return [...s.segments, { start: s.startedAt, end: now, mode: s.mode }];
}

/**
 * Is focus ACCRUING right now? The one three-state fact, in one place.
 *
 * A session is live-focus, on a break, or paused, and only the first accrues:
 * `splitSegmentsByDay` drops break segments, so break minutes never reach
 * `focused today` and no entry is ever written for them, and a paused session
 * accrues nothing at all. Every consumer that starts or stops something on the
 * session's liveness reads this rather than `running` alone — `running` stays
 * true through a break, which is how the camera kept sensing and the row kept
 * claiming to tick.
 */
export function isAccruingFocus(s: FocusSession | null): boolean {
  return !!s && s.running && s.mode === "focus";
}

/** Epoch ms the session as a whole began — the window the sensors describe. */
export function sessionStartedAt(s: FocusSession | null): number | null {
  if (!s) return null;
  const starts = s.segments.map((g) => g.start);
  if (s.running) starts.push(s.startedAt);
  return starts.length > 0 ? Math.min(...starts) : s.startedAt;
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
      kept: false,
      writtenDates: [],
    };
    write(session);
    set({ session });
  },

  pause: () => {
    const s = get().session;
    if (!s || !s.running) return;
    const next: FocusSession = { ...s, running: false, segments: sealedSegments(s, Date.now()) };
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
      segments: sealedSegments(s, now),
      startedAt: now,
    };
    write(next);
    set({ session: next });
  },

  seal: () => {
    const s = get().session;
    if (!s) return [];
    const segments = sealedSegments(s, Date.now());
    // Paused, not gone: the clock stops growing while the write is in flight,
    // and a retry seals the same segments rather than a longer set.
    const next: FocusSession = { ...s, running: false, segments };
    write(next);
    set({ session: next });
    return segments;
  },

  stop: () => {
    write(null);
    set({ session: null });
  },

  rename: (title) => {
    const s = get().session;
    if (!s) return;
    const next = { ...s, title };
    write(next);
    set({ session: next });
  },

  setKept: (kept) => {
    const s = get().session;
    if (!s || s.kept === kept) return;
    const next = { ...s, kept };
    write(next);
    set({ session: next });
  },

  markWritten: (date) => {
    const s = get().session;
    if (!s || s.writtenDates.includes(date)) return;
    const next = { ...s, writtenDates: [...s.writtenDates, date] };
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
