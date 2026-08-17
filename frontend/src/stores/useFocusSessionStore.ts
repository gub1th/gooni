import { create } from "zustand";
import {
  createFocusSession,
  fetchActiveFocusSession,
  pauseFocusSession,
  patchFocusSession,
  resumeFocusSession,
  type ServerFocusSession,
} from "../services/api";

// The running focus session — a THIN CLIENT over the server, since 2026-08-16.
//
// It used to be the whole thing: a localStorage store that owned the lifecycle,
// the 6h cap, the write-then-clear ordering and the per-day retry ledger. That
// was defensible while a session's only durable artifact was the TrackableEntry
// it wrote on stop, and it had four ways to lose data that all shared one cause
// — the only process that knew a session existed could be closed at any moment:
//
//   · a tab closed mid-session left the run uncapped and the camera sensing;
//   · a machine that slept came back to a clock that had kept counting;
//   · nothing outside that tab could start or stop a session (so Claude
//     couldn't, and the sidecar only ever saw a reconcile flag);
//   · the retry ledger for a partially-written multi-day session lived in the
//     same storage the failure could take with it.
//
// The lifecycle is now `app/services/focus_session_service.py` and every rule
// lives there once. What stays here is what a client is genuinely for: an
// optimistic local mirror so the clock is instant, a localStorage cache so the
// first paint after a reload isn't empty, and cross-tab sync.
//
// **The server is the truth.** Every mutator applies its change locally, calls
// the server, and adopts the server's answer — so a disagreement always
// resolves the same way, and `syncFocusSession` (polled by `useFocusSessionSync`)
// is what makes a refresh, a sleep, a second monitor and a session Claude
// started all converge on the same row.

// Every segment is focus time. BREAK was removed in pass 3; the union stays a
// single member on purpose so `FocusSegment.mode` and the `mode === "focus"`
// filter in `splitSegmentsByDay` need no edit.
export type FocusMode = "focus";

/**
 * How the session is being TIMED. A display concern, not an accounting one —
 * both styles accrue focus identically and produce identical segments.
 *
 *   stopwatch → counts up, no target, the DEFAULT
 *   timer     → counts down from `targetMs`
 */
export type FocusStyle = "stopwatch" | "timer";

/** Timer default when you switch to it: a pomodoro, adjustable per session. */
export const DEFAULT_TIMER_MS = 25 * 60_000;

export interface FocusSegment {
  start: number; // epoch ms
  end: number; // epoch ms
  mode: FocusMode;
  /** the run was CAPPED rather than closed by a human — a floor, not a measurement */
  truncated?: boolean;
}

export interface FocusSession {
  /** the server row's id — what every lifecycle call addresses */
  id: number;
  /**
   * The commitment this session is FOR. NULLABLE now: a session started from
   * Claude legitimately has no Promise behind it, and attribution simply has
   * nothing to bind to — which is honest rather than broken. Every consumer
   * comparing it to a row id already behaves correctly on null.
   */
  promiseId: number | null;
  title: string;
  mode: FocusMode;
  style: FocusStyle;
  /** timer target; ignored in stopwatch style */
  targetMs: number;
  /** epoch ms the CURRENT run began; meaningless while paused */
  startedAt: number;
  /** closed runs so far */
  segments: FocusSegment[];
  running: boolean;
  /** the task was marked kept while this session runs */
  kept: boolean;
}

const KEY = "gooni_focus_session";

/**
 * The longest a single open run may claim.
 *
 * Still here because the CLIENT renders the clock and must not draw a nine-hour
 * session while the server is about to seal it at six. The server holds the
 * same constant (`focus_session_service.MAX_RUN_SEC`) and is the one that
 * ACTS on it — which is the whole improvement, since a client-side cap could
 * only ever fire in a tab that was still open.
 */
export const MAX_RUN_MS = 6 * 60 * 60 * 1000;

/** ISO (or null) → epoch ms. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * A server session → the client shape.
 *
 * A STOPPED session becomes `null`: this store holds the LIVE session only, and
 * a stopped row lingering here would keep a dead clock on screen.
 */
export function fromServer(s: ServerFocusSession | null): FocusSession | null {
  if (!s || s.state === "stopped") return null;
  const segments: FocusSegment[] = (s.segments ?? [])
    .map((g) => ({
      start: ms(g.start) ?? 0,
      end: ms(g.end) ?? 0,
      mode: "focus" as const,
      ...(g.truncated ? { truncated: true } : {}),
    }))
    // While a session RUNS, the server's `segments` already include the open
    // run sealed at its `now`. Keeping it would double-count against the local
    // clock, which ticks that same run forward from `run_started_at`.
    .filter((g) => g.end > g.start);
  const runStart = ms(s.run_started_at);
  const openRun = s.state === "running" && runStart != null ? runStart : null;
  return {
    id: s.id,
    promiseId: s.promise_id,
    title: s.title,
    mode: "focus",
    style: s.style === "timer" ? "timer" : "stopwatch",
    targetMs: s.target_ms && s.target_ms > 0 ? s.target_ms : DEFAULT_TIMER_MS,
    startedAt: openRun ?? ms(s.started_at) ?? Date.now(),
    segments: openRun == null ? segments : segments.filter((g) => g.start < openRun),
    running: s.state === "running",
    kept: s.kept === true,
  };
}

function read(): FocusSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FocusSession;
    // A cache written by the PRE-server build has no `id` and cannot address
    // any lifecycle route. Dropping it is right: the server is about to answer
    // what is really running, and a phantom local session would let the user
    // pause a row that does not exist.
    if (typeof parsed?.id !== "number") return null;
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    return {
      ...parsed,
      mode: "focus",
      promiseId: typeof parsed.promiseId === "number" ? parsed.promiseId : null,
      segments: segments.filter((g) => (g as { mode?: string }).mode !== "break"),
      style: parsed.style === "timer" ? "timer" : "stopwatch",
      targetMs:
        typeof parsed.targetMs === "number" && parsed.targetMs > 0
          ? parsed.targetMs
          : DEFAULT_TIMER_MS,
      kept: parsed.kept === true,
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
    /* private mode / quota — the session still runs in memory, and on the server */
  }
}

/**
 * Close the open run (if any) at `now`, returning the full segment list.
 *
 * Pure, and exported: `/` folds the live session through this to work out how
 * much of it landed on TODAY. It mirrors `focus_session_service.sealed_runs`,
 * so the number on screen is the number the server would write.
 */
export function sealedSegments(s: FocusSession, now: number): FocusSegment[] {
  if (!s.running) return s.segments;
  // Sub-second runs are noise, not work.
  if (now - s.startedAt < 1000) return s.segments;
  if (now - s.startedAt > MAX_RUN_MS) {
    // Nobody closed this. Credit the cap, and say so on the segment. (The
    // server is about to do exactly this and retire the session.)
    return [
      ...s.segments,
      { start: s.startedAt, end: s.startedAt + MAX_RUN_MS, mode: s.mode, truncated: true },
    ];
  }
  return [...s.segments, { start: s.startedAt, end: now, mode: s.mode }];
}

/**
 * Is focus ACCRUING right now? The one liveness fact, in one place.
 *
 * Every consumer that starts or stops something on the session's liveness (the
 * focus-cam control, the row indicator, the home's tick cadence) reads this
 * rather than re-deriving. Patching those call sites per-state one at a time is
 * exactly what produced two rounds of review findings.
 */
export function isAccruingFocus(s: FocusSession | null): boolean {
  return !!s && s.running;
}

/** Epoch ms the session as a whole began — the window the sensors describe. */
export function sessionStartedAt(s: FocusSession | null): number | null {
  if (!s) return null;
  const starts = s.segments.map((g) => g.start);
  if (s.running) starts.push(s.startedAt);
  return starts.length > 0 ? Math.min(...starts) : s.startedAt;
}

interface FocusSessionState {
  session: FocusSession | null;
  /** true while a lifecycle call is in flight — the UI stays live, not blocked */
  syncing: boolean;
  start: (promiseId: number | null, title: string) => Promise<FocusSession | null>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setStyle: (style: FocusStyle) => Promise<void>;
  setTargetMs: (ms: number) => Promise<void>;
  /** Drop the LOCAL mirror. The server stop goes through `endFocusSession`. */
  clear: () => void;
  rename: (title: string) => void;
  setKept: (kept: boolean) => Promise<void>;
  /** Adopt a server answer (or another tab's write). */
  hydrate: (session: FocusSession | null) => void;
}

export const useFocusSessionStore = create<FocusSessionState>((set, get) => ({
  session: read(),
  syncing: false,

  start: async (promiseId, title) => {
    // Re-starting the task already running would throw its segments away and
    // zero the clock. Guarded here AND in `switchFocusSession` AND on the
    // server, because each of the three can be reached on its own.
    const live = get().session;
    if (live && promiseId != null && live.promiseId === promiseId) return live;

    // Optimistic: the clock starts on the click, not on the round trip. `id: 0`
    // marks it un-addressable — every mutator below refuses to call a lifecycle
    // route for it, so a pause during the flight can never hit a wrong row.
    const optimistic: FocusSession = {
      id: 0,
      promiseId,
      title,
      mode: "focus",
      style: "stopwatch",
      targetMs: DEFAULT_TIMER_MS,
      startedAt: Date.now(),
      segments: [],
      running: true,
      kept: false,
    };
    write(optimistic);
    set({ session: optimistic, syncing: true });
    try {
      const server = fromServer(await createFocusSession({ title, promise_id: promiseId }));
      write(server);
      set({ session: server });
      return server;
    } catch (e) {
      // The session never really began. Restoring the previous one is right:
      // `switchFocusSession` has already written its predecessor's minutes, so
      // there is nothing left to lose here but a clock that was never real.
      write(live);
      set({ session: live });
      throw e;
    } finally {
      set({ syncing: false });
    }
  },

  pause: async () => {
    const s = get().session;
    if (!s || !s.running) return;
    const next: FocusSession = { ...s, running: false, segments: sealedSegments(s, Date.now()) };
    write(next);
    set({ session: next });
    if (!s.id) return; // an in-flight start owns its own reconcile
    try {
      const server = fromServer(await pauseFocusSession(s.id));
      write(server);
      set({ session: server });
    } catch {
      // The clock is stopped locally and the server still thinks it runs. The
      // next sync resolves it in the server's favour, which at worst credits a
      // few more seconds of real elapsed time — the safe direction, since the
      // alternative is a session that looks paused and is silently accruing.
      void syncFocusSession();
    }
  },

  resume: async () => {
    const s = get().session;
    if (!s || s.running) return;
    const next: FocusSession = { ...s, running: true, startedAt: Date.now() };
    write(next);
    set({ session: next });
    if (!s.id) return;
    try {
      const server = fromServer(await resumeFocusSession(s.id));
      write(server);
      set({ session: server });
    } catch {
      void syncFocusSession();
    }
  },

  // Switching STYLE does not touch the segments: stopwatch and timer accrue
  // identically and only differ in how the same elapsed time is displayed.
  setStyle: async (style) => {
    const s = get().session;
    if (!s || s.style === style) return;
    const next: FocusSession = { ...s, style };
    write(next);
    set({ session: next });
    if (!s.id) return;
    await patchFocusSession(s.id, { style }).catch(() => {});
  },

  setTargetMs: async (targetMs) => {
    const s = get().session;
    if (!s || targetMs <= 0) return;
    const next: FocusSession = { ...s, targetMs };
    write(next);
    set({ session: next });
    if (!s.id) return;
    await patchFocusSession(s.id, { target_ms: targetMs }).catch(() => {});
  },

  clear: () => {
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

  setKept: async (kept) => {
    const s = get().session;
    if (!s || s.kept === kept) return;
    const next = { ...s, kept };
    write(next);
    set({ session: next });
    if (!s.id) return;
    await patchFocusSession(s.id, { kept }).catch(() => {});
  },

  hydrate: (session) => {
    write(session);
    set({ session });
  },
}));

/**
 * Adopt whatever the server says is running.
 *
 * The one reconcile. It deliberately does NOT run while a lifecycle call is in
 * flight: the server's answer would be the pre-call state, and adopting it
 * would visibly undo the click that is still travelling.
 */
export async function syncFocusSession(): Promise<void> {
  if (useFocusSessionStore.getState().syncing) return;
  try {
    const server = fromServer(await fetchActiveFocusSession());
    const local = useFocusSessionStore.getState().session;
    // An un-addressable optimistic session (a start still in flight, or one
    // whose POST failed) must not be replaced by a stale `null`.
    if (local && !local.id && server == null) return;
    useFocusSessionStore.getState().hydrate(server);
  } catch {
    // Offline / backend down. The local mirror keeps ticking rather than the
    // session vanishing — a failed fetch is not evidence that nothing is
    // running, the same rule the popup's "empty reads as empty" follows.
  }
}

// Cross-tab sync of the local MIRROR. Still worth having alongside the poll:
// it is instant, and it keeps a second monitor from showing a stale clock for
// up to a full poll interval.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY) return;
    useFocusSessionStore.setState({ session: read() });
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
