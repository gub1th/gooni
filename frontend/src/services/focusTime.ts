import {
  BASE,
  apiFetch,
  createTrackable,
  fetchTrackableEntries,
  logTrackable,
  type Trackable,
  type TrackableEntryRow,
} from "./api";
import { useFocusSessionStore, type FocusSegment } from "../stores/useFocusSessionStore";
import { useSessionEndOfferStore } from "../stores/useSessionEndOfferStore";

// Focus time — ONE trackable, attribution on the ENTRY.
//
// `Trackable.parent_promise_id` binds a definition to exactly one Promise, so a
// trackable per task would grow the log matrix a column per task and destroy
// it. The definition therefore leaves it NULL and the promise id rides on
// `TrackableEntry.value_json`, which the entry docstring already blesses:
// multiple rows per (trackable, date) are legal and the pivot folds them per
// `agg`. `agg=sum` makes the day fold to focused-minutes for free.
//
// Three traps, all cheap here and expensive later:
//   1. NEVER pass `replace` — it collapses the day to the last session, the
//      same way it collapses a boolean label write.
//   2. A session spanning midnight writes TWO entries, one per calendar date,
//      or the daily fold lies about both days.
//   3. `value_json` is unindexed Text and the only index is (trackable_id,
//      date), so per-task totals are a read of this one trackable's entries
//      grouped in code. That is fine at this volume — do not add an index or a
//      column to avoid it.

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
  const byDay = new Map<string, { ms: number; start: number; end: number; truncated: boolean }>();

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
      } else {
        byDay.set(key, {
          ms: boundary - cursor,
          start: cursor,
          end: boundary,
          truncated: seg.truncated === true,
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

export interface FocusWriteOptions {
  /**
   * Local day keys already written for THIS session. A partial success followed
   * by a retry must not add the day that landed a second time — and `replace`
   * cannot be the answer, since it would collapse the (trackable, day) and
   * destroy every other session logged that day (trap 1).
   */
  writtenDates?: readonly string[];
  /** Called as each day lands, so the caller can persist the record. */
  onWritten?: (date: string) => void;
}

/**
 * Write a finished session. One entry per calendar day, each carrying the
 * promise id. Returns the drafts actually written (skipped days excluded).
 *
 * Safe to call again with the SAME segments after a failed attempt, as long as
 * the caller feeds back what landed.
 */
export async function writeFocusSession(
  segments: FocusSegment[],
  promiseId: number,
  title: string,
  { writtenDates = [], onWritten }: FocusWriteOptions = {},
): Promise<FocusEntryDraft[]> {
  const already = new Set(writtenDates);
  const drafts = splitSegmentsByDay(segments).filter((d) => !already.has(d.date));
  if (drafts.length === 0) return [];
  const t = await ensureFocusTrackable();
  for (const d of drafts) {
    await logTrackable(t.id, {
      date: d.date,
      value_numeric: d.minutes,
      value_json: {
        promise_id: promiseId,
        title,
        started_at: d.startedAt,
        ended_at: d.endedAt,
        // only on the rows it's true of — an absent flag is the normal case
        ...(d.truncated ? { truncated: true } : {}),
      },
      source: "focus",
      // NO replace — see trap 1.
    });
    onWritten?.(d.date);
  }
  return drafts;
}

/**
 * The end that is currently in flight, if any.
 *
 * `seal()` pauses the session but does NOT clear it, so between the seal and the
 * write resolving a second call would find the same session, seal the identical
 * segments, and post the same day again — on a sum-agg trackable that
 * permanently doubles it. Nothing on screen changes until the write lands, so a
 * double-click is the ordinary way to reach that. A concurrent caller therefore
 * JOINS this promise instead of starting a second write.
 */
let ending: Promise<void> | null = null;

/**
 * End the running session: seal it, write its entry, and only THEN drop it.
 *
 * The one write-then-clear path, shared by the session page's stop control and
 * by starting focus on another task. It THROWS when the write failed, leaving
 * the session paused with its segments intact — the entry is the only durable
 * artifact a session produces, so clearing before it lands would destroy it.
 * A no-op when nothing is running.
 */
export async function endFocusSession(): Promise<void> {
  if (ending) return ending;
  const s = useFocusSessionStore.getState().session;
  if (!s) return;
  ending = (async () => {
    const segments = useFocusSessionStore.getState().seal();
    await writeFocusSession(segments, s.promiseId, s.title, {
      writtenDates: useFocusSessionStore.getState().session?.writtenDates ?? [],
      onWritten: (date) => useFocusSessionStore.getState().markWritten(date),
    });
    const kept = useFocusSessionStore.getState().session?.kept === true;
    useFocusSessionStore.getState().stop();
    // Stopping OFFERS completion, it never performs it — see the offer store.
    // Raised here because this is the one place a session legitimately ends, so
    // every surface that can stop gets the offer without remembering to.
    useSessionEndOfferStore.getState().raise({ promiseId: s.promiseId, title: s.title, alreadyKept: kept });
  })();
  try {
    await ending;
  } finally {
    ending = null;
  }
}

/**
 * Start focus on a task, ending whatever was running first.
 *
 * Switching tasks mid-day is normal, and the focus control is live on every row,
 * so the switch has to be silent AND lossless. Starting is CONDITIONAL on the
 * outgoing session having been durably written: `endFocusSession` throws on a
 * failed write, which aborts the switch and leaves the old session recoverable
 * rather than swapping it away with its minutes unwritten.
 */
export async function switchFocusSession(promiseId: number, title: string): Promise<void> {
  // Switching to the task ALREADY running is not a switch. Without this it
  // ends-and-writes the live session and starts a fresh one on the same task,
  // which splits one sitting into two entries and resets the clock to zero —
  // the row looks like it restarted because it did. Guarded here as well as at
  // the call site, because this is the function that does the damage.
  const live = useFocusSessionStore.getState().session;
  if (live && live.promiseId === promiseId) return;
  await endFocusSession();
  // A SWITCH is not a stop: you are carrying on working, just on something
  // else. Offering to complete the task you just left would be the wrong
  // question at the wrong moment, so the offer endFocusSession raised is
  // dropped before the new session starts.
  useSessionEndOfferStore.getState().clear();
  useFocusSessionStore.getState().start(promiseId, title);
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
