import {
  BASE,
  apiFetch,
  createTrackable,
  fetchTrackableEntries,
  logTrackable,
  type Trackable,
  type TrackableEntryRow,
} from "./api";
import type { FocusSegment } from "../stores/useFocusSessionStore";

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

/**
 * Write a finished session. One entry per calendar day, each carrying the
 * promise id. Returns the drafts actually written.
 */
export async function writeFocusSession(
  segments: FocusSegment[],
  promiseId: number,
  title: string,
): Promise<FocusEntryDraft[]> {
  const drafts = splitSegmentsByDay(segments);
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
  }
  return drafts;
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
