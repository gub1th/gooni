import { localDayKey } from "../../services/focusTime";
import type { FocusReminder } from "../../services/api";

// What TODAY shows, given what the server serves.
//
// `/focus/dashboard` serves ACTIVE commitments only, so the server's answer is
// not on its own the list: two things have to survive its silence.
//
//   1. A row ticked in THIS SITTING stays where it is, struck through. Ticking
//      drops it from the active set immediately, so without retention the row
//      you just clicked vanishes out from under the pointer.
//   2. A row with a RUNNING SESSION on it stays, however it left the active
//      set. Marking it kept from the session page (which this surface never
//      sees) or reloading `/` (retention is in-memory by design) would
//      otherwise take the live clock and the way back to `/focus` with it —
//      and that clock is the attribution model made visible.
//
// Both are "stays put" promises about this sitting, not a second store of
// truth: retention is in memory, and the session's own persisted store is what
// carries case 2 across a reload.
//
// Retention is bounded to the LOCAL DAY, and that bound is load-bearing on an
// always-on surface: the home polls the dashboard every 30s and is never
// reloaded, so without it a row ticked at 21:00 gets spliced back in at 00:01 —
// ranked FIRST, because its first-seen index is the oldest — and TODAY leads
// with yesterday's finished work until someone reloads the tab. A running
// session is deliberately NOT day-bounded: case 2 rebuilds its row from the
// session store, which is exactly what a session across midnight needs.
//
// This is a pure function over explicit state on purpose. The rule was
// previously inline in the home component, which is exactly why case 2 went
// unnoticed — there was nowhere to state it and nothing to test it against.

export interface RetainedRows {
  /** rows ticked in this sitting, by id */
  kept: Map<number, FocusReminder>;
  /** every row the server has served in this sitting, by id */
  seen: Map<number, FocusReminder>;
  /** ids in first-seen order — a retained row re-enters at its OWN index */
  order: number[];
  /** the local day this retention describes; a new day starts clean */
  day: string;
}

export function emptyRetained(now: number = Date.now()): RetainedRows {
  return { kept: new Map(), seen: new Map(), order: [], day: localDayKey(now) };
}

/** Drop everything retained for a day that is over. TODAY has to mean today. */
function rollDay(state: RetainedRows, now: number) {
  const today = localDayKey(now);
  if (state.day === today) return;
  state.kept.clear();
  state.seen.clear();
  state.order.length = 0;
  state.day = today;
}

/**
 * Record a tick's retention change and hand back its exact undo.
 *
 * Both directions matter and they are not symmetric. Ticking ADDS the entry that
 * keeps the row on screen after the server drops it; un-ticking removes it — so
 * a failed un-tick that merely deleted the entry would take the row with it,
 * permanently, since the server still holds the promise as kept and retention is
 * in-memory. The undo restores exactly the entry that was there before.
 */
export function retainTicked(
  state: RetainedRows,
  next: FocusReminder,
  now: number = Date.now(),
): () => void {
  rollDay(state, now);
  const prior = state.kept.get(next.id);
  if (next.state === "kept") state.kept.set(next.id, next);
  else state.kept.delete(next.id);
  return () => {
    if (prior) state.kept.set(next.id, prior);
    else state.kept.delete(next.id);
  };
}

/** The slice of a running focus session this merge needs. */
export interface RunningTask {
  promiseId: number;
  title: string;
  kept: boolean;
}

/**
 * A row for the running session's task when nothing else can supply one.
 *
 * After a reload the session store holds the id and the title and nothing else,
 * which is enough: the row exists to carry the strike-through and the clock.
 */
function rowFromSession(task: RunningTask): FocusReminder {
  return {
    id: task.promiseId,
    type: "promise",
    content: task.title,
    owed_to: null,
    due_at: null,
    due_is_default: true,
    done: task.kept,
    state: task.kept ? "kept" : "active",
    resolved_at: null,
    age_days: 0,
    lasted_days: 0,
    thought_id: null,
  };
}

export function mergeTodayRows(
  serverRows: FocusReminder[],
  state: RetainedRows,
  running: RunningTask | null,
  now: number = Date.now(),
): FocusReminder[] {
  rollDay(state, now);

  for (const r of serverRows) {
    if (!state.order.includes(r.id)) state.order.push(r.id);
    state.seen.set(r.id, r);
  }

  const byId = new Map(serverRows.map((r) => [r.id, r]));

  // (1) a row the server dropped because we just ticked it
  for (const [id, row] of state.kept) if (!byId.has(id)) byId.set(id, row);

  // (2) the running session's task, whichever way it left the active set
  if (running && !byId.has(running.promiseId)) {
    const last = state.seen.get(running.promiseId);
    byId.set(
      running.promiseId,
      last
        ? { ...last, state: running.kept ? "kept" : last.state, done: running.kept || last.done }
        : rowFromSession(running),
    );
    if (!state.order.includes(running.promiseId)) state.order.push(running.promiseId);
  }

  const rank = (id: number) => {
    const i = state.order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}
