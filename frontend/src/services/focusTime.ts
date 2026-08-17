import {
  BASE,
  apiFetch,
  createTrackable,
  fetchTrackableEntries,
  stopFocusSession as stopFocusSessionApi,
  type ServerFocusSession,
  type Trackable,
  type TrackableEntryRow,
} from "./api";
import { useFocusSessionStore, type FocusSegment } from "../stores/useFocusSessionStore";

// Focus time — ONE trackable, attribution on the ENTRY.
//
// `Trackable.parent_promise_id` binds a definition to exactly one Promise, so a
// trackable per task would grow the log matrix a column per task and destroy
// it. The definition therefore leaves it NULL and the promise id rides on
// `TrackableEntry.value_json`, which the entry docstring already blesses:
// multiple rows per (trackable, date) are legal and the pivot folds them per
// `agg`. `agg=sum` makes the day fold to focused-minutes for free.
//
// **THE WRITE MOVED TO THE SERVER (2026-08-16).** `focus_session_service.stop`
// produces those entries now, in exactly this shape, because there is more than
// one thing that can end a session: a click here, a click on `/focus`, Claude
// over MCP, and the server's own 6h cap firing on a tab that was closed hours
// ago. Two writers of one artifact is how a UI stop and an MCP stop start
// disagreeing, so the client's copy is gone rather than kept as a fallback —
// along with the per-day retry ledger it needed, which the server's single
// transaction makes unnecessary.
//
// What stays here is the READ side and the pure day-fold, which the live UI
// still needs to answer "how much of this session has landed on TODAY" without
// asking the server every second. The three traps that shaped the write are
// documented on the server now (`focus_session_service._write_entries`); the
// one that still binds this file is trap 3: `value_json` is unindexed Text and
// the only index is (trackable_id, date), so per-task totals are a read of this
// one trackable's entries grouped in code. That is fine at this volume — do not
// add an index or a column to avoid it.

export const FOCUS_TRACKABLE = "focus";

/** How far back per-task totals look. One read, grouped in code. */
export const FOCUS_LOOKBACK_DAYS = 60;

/**
 * Trackables the log matrix may show but must never WRITE.
 *
 * Right now that is exactly one: `focus`. Every matrix verb — numeric edit, cell
 * clear, boolean toggle, boolean tag — arrives with `replace: true`, and
 * `trackable_service.log_entry` under `replace` DELETEs the whole (trackable,
 * day) before inserting. On this column that destroys each session row's
 * `value_json` (promise id, window, `truncated`), which no cell edit could
 * reconstruct: the sessions are the source of truth and the cell is only their
 * sum. Hand-editing a rollup was never meaningful.
 *
 * Deliberately NOT every `source="derived"` trackable — the whoop and leetcode
 * numeric mirrors share that source and stay editable exactly as before.
 */
export function isReadOnlyRollup(t: { name: string; source?: string | null }): boolean {
  return t.source === "derived" && t.name === FOCUS_TRACKABLE;
}

export interface FocusEntryDraft {
  /** local YYYY-MM-DD — the calendar day the minutes landed on */
  date: string;
  minutes: number;
  startedAt: string; // ISO
  endedAt: string; // ISO
  /**
   * The EXACT focus runs this day's minutes came from, clipped at midnight.
   *
   * `startedAt`/`endedAt` are the day's ENVELOPE — every run folds into one
   * entry, so a session paused for lunch has an envelope spanning the lunch.
   * That is fine for the number (only focus segments are summed) and wrong for
   * anything that asks WHAT HAPPENED inside the window: the backend's
   * attribution layer overlaps device intervals against these windows to bind
   * observed attention to the Promise, and the envelope would credit it with
   * whatever was on screen while the timer was paused.
   *
   * Rides on `value_json` for the same reason `promise_id` and `truncated` do —
   * free-form Text, no migration, no new column. An older entry without it
   * still attributes, from the envelope, flagged imprecise.
   */
  segments: { start: string; end: string }[];
  /**
   * Some of these minutes came from a CAPPED run (a session nobody closed), so
   * the number is a floor rather than a measurement. It rides on the entry for
   * the same reason the promise id does: `value_json` is unindexed free-form
   * Text, so a capped session stays distinguishable from a genuine one with no
   * migration and no new column.
   */
  truncated: boolean;
}

/** local YYYY-MM-DD for an epoch ms. THE day key both folds share. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Epoch ms of the local midnight that STARTS the day after `ms`. */
function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Fold a session's segments into one draft entry per LOCAL calendar day.
 *
 * Only `focus` segments count — break time is real elapsed time but it is not
 * focus, and writing it would make the day's total a lie in the friendlier
 * direction. Segments are clipped at local midnight so a session that runs past
 * it produces two entries rather than one fat one filed under the start day.
 */
export function splitSegmentsByDay(segments: FocusSegment[]): FocusEntryDraft[] {
  const byDay = new Map<
    string,
    { ms: number; start: number; end: number; truncated: boolean; runs: [number, number][] }
  >();

  for (const seg of segments) {
    if (seg.mode !== "focus") continue;
    let cursor = seg.start;
    while (cursor < seg.end) {
      const boundary = Math.min(nextLocalMidnight(cursor), seg.end);
      const key = localDayKey(cursor);
      const prev = byDay.get(key);
      if (prev) {
        prev.ms += boundary - cursor;
        prev.start = Math.min(prev.start, cursor);
        prev.end = Math.max(prev.end, boundary);
        prev.truncated = prev.truncated || seg.truncated === true;
        prev.runs.push([cursor, boundary]);
      } else {
        byDay.set(key, {
          ms: boundary - cursor,
          start: cursor,
          end: boundary,
          truncated: seg.truncated === true,
          runs: [[cursor, boundary]],
        });
      }
      cursor = boundary;
    }
  }

  return [...byDay.entries()]
    .map(([date, v]) => ({
      date,
      minutes: Math.round((v.ms / 60_000) * 100) / 100,
      startedAt: new Date(v.start).toISOString(),
      endedAt: new Date(v.end).toISOString(),
      // Sorted, because the attribution overlap short-circuits on the first
      // window that starts past an interval's end and an unsorted list would
      // cut the scan early. Cheap here, and the alternative is the reader
      // having to distrust the order it was given.
      segments: v.runs
        .sort((a, b) => a[0] - b[0])
        .map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })),
      truncated: v.truncated,
    }))
    // A sub-second sliver either side of midnight isn't an entry.
    .filter((e) => e.minutes > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Total focus minutes per promise id across a set of entry rows. */
export function minutesByPromise(rows: TrackableEntryRow[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of rows) {
    const vj = r.value_json;
    const pid = vj && typeof vj === "object" ? (vj as { promise_id?: unknown }).promise_id : null;
    if (typeof pid !== "number") continue;
    out[pid] = (out[pid] ?? 0) + (r.value_numeric ?? 0);
  }
  return out;
}

/** Total focus minutes on one local day across a set of entry rows. */
export function minutesOnDay(rows: TrackableEntryRow[], date: string): number {
  return rows
    .filter((r) => r.date === date)
    .reduce((n, r) => n + (r.value_numeric ?? 0), 0);
}

// ── the write path ───────────────────────────────────────────────────────────

let cached: Trackable | null = null;

/**
 * Get-or-create the one `focus` definition. `POST /trackables` is
 * name-idempotent, so this is safe to call blind; the row is cached per page
 * load because it never changes.
 */
export async function ensureFocusTrackable(): Promise<Trackable> {
  if (cached) return cached;
  cached = await createTrackable({
    name: FOCUS_TRACKABLE,
    kind: "numeric",
    unit: "minutes",
    agg: "sum",
    source: "derived",
    // parent_promise_id stays NULL — see the header.
  });
  return cached;
}

/**
 * The end that is currently in flight, if any.
 *
 * A second call between the stop request and its response would post `/stop`
 * for the same session again. The server is idempotent (an already-stopped
 * session returns untouched and writes nothing twice), so that is no longer
 * data loss — but it would still clear the store from under a recap being
 * built, and nothing on screen changes until the response lands, which makes a
 * double-click the ordinary way to reach it. A concurrent caller JOINS this
 * promise instead.
 */
let ending: Promise<ServerFocusSession | null> | null = null;

/**
 * End the running session and hand back the server's final word on it.
 *
 * ONE call now: `POST /focus/sessions/{id}/stop` seals the runs, writes one
 * `focus` entry per local day, releases the camera, and returns the session
 * WITH its sensor breakdown — so the recap is built from the same response that
 * ended the session and can never describe minutes that hadn't landed.
 *
 * The write-then-clear ordering that used to live here still holds; it just
 * holds inside one server transaction. The local mirror is dropped only after
 * the server confirms, so a failed stop leaves a session that is still there
 * and still stoppable rather than a clock that vanished with its minutes.
 *
 * Returns null when nothing was running. THROWS when the stop failed.
 */
export async function endFocusSession(): Promise<ServerFocusSession | null> {
  if (ending) return ending;
  const s = useFocusSessionStore.getState().session;
  if (!s) return null;
  if (!s.id) {
    // A start whose POST never landed: there is no server row to stop, and the
    // clock it was drawing was never real. Drop it rather than throw — the
    // failed start already reported itself.
    useFocusSessionStore.getState().clear();
    return null;
  }
  ending = (async () => {
    const stopped = await stopFocusSessionApi(s.id);
    useFocusSessionStore.getState().clear();
    return stopped;
  })();
  try {
    return await ending;
  } finally {
    ending = null;
  }
}

/**
 * Start focus on a task, ending whatever was running first.
 *
 * The SERVER does the ending — `POST /focus/sessions` stops the live session
 * (writing its entries) before creating the new one, in one transaction. That
 * is strictly better than the two-call client sequence it replaces, where a
 * failure in between left a session sealed but unwritten; here a failed write
 * means no new session exists and the old one is still live.
 */
export async function switchFocusSession(promiseId: number, title: string): Promise<void> {
  // Switching to the task ALREADY running is not a switch. Without this it
  // would split one sitting into two entries and reset the clock — the row
  // looks like it restarted because it did. Guarded here, at the call sites,
  // and on the server.
  const live = useFocusSessionStore.getState().session;
  if (live && live.promiseId === promiseId) return;
  await useFocusSessionStore.getState().start(promiseId, title);
}

export interface FocusTotals {
  /** minutes logged today (excludes any session still running) */
  today: number;
  /** minutes per promise id over the lookback window */
  byPromise: Record<number, number>;
}

/** One read of the focus trackable's raw entries, folded two ways. */
export async function fetchFocusTotals(): Promise<FocusTotals> {
  const t = await ensureFocusTrackable();
  const rows = await fetchTrackableEntries(t.id, FOCUS_LOOKBACK_DAYS);
  return {
    today: minutesOnDay(rows, localDayKey(Date.now())),
    byPromise: minutesByPromise(rows),
  };
}

/** `1h 04m` / `12m` / `—`. The corner stat and the per-task suffix share it. */
export function fmtMinutes(mins: number): string {
  const m = Math.round(mins);
  if (m <= 0) return "—";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `40s` / `12m` / `1h 20m`. The seconds twin of `fmtMinutes`, mirroring the
 * backend's `activity_context.fmt_dur` — session-scoped sensor spans are often
 * under a minute, and `fmtMinutes` renders those as `—`, which reads as "no
 * data" when the honest answer is "forty seconds". Rounded at the RENDER
 * boundary, same rule: the fractional seconds are the honest sum. */
export function fmtDuration(seconds: number): string {
  const s = Math.round(Math.max(0, seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${h}h ${String(rem).padStart(2, "0")}m` : `${h}h`;
}

// ── the quiet sensor line (after-the-fact by design) ─────────────────────────
// Most-recent-known values on the existing feed cadence. There is deliberately
// no realtime "what am I looking at right now" endpoint: the timer already
// bounds the window, so a periodic read of what the sensors last said is the
// whole answer.

export interface BrowserInterval {
  id: number;
  host: string;
  path: string | null;
  title: string | null;
  started_at: string;
  ended_at: string;
  duration_sec: number;
}

export async function fetchRecentBrowserIntervals(limit = 5): Promise<BrowserInterval[]> {
  const res = await apiFetch(`${BASE}/browser/intervals?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch browser intervals");
  const data = (await res.json()) as { intervals: BrowserInterval[] };
  return data.intervals ?? [];
}
