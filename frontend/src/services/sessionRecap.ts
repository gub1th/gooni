import type { ServerFocusSession } from "./api";
import type { RecapDay, SessionRecapData } from "../components/focus/FocusSessionRecap";

// THE mapper: a server session (`serialize()` + its optional `activity`
// fold) → `SessionRecapData`, the shape `FocusSessionRecap` renders.
//
// This is the ONE place that translation happens. Before it existed, the
// dashboard could only be built from `FocusExpanded`'s local `buildRecap` —
// which read the client's own `useFocusSessionStore` session object, not the
// server row — so it only ever ran for the session that had JUST stopped in
// THIS tab. A reload, or a click on any other session in the history list,
// had nowhere to go. Every field below has a server source (see
// `focus_session_service.serialize` / `.activity`); the ONLY one that
// doesn't is `completion_frame` (the victory selfie), which the write path
// grabs live at stop time and never stores per-session — a past session
// therefore maps to `completionFrame: null`, which `FocusSessionRecap`
// already renders as "no banner" rather than crashing.
//
// `activity` is OPTIONAL on `ServerFocusSession` (present on the stop
// response and on `?activity=1`, absent on a bare `GET
// /focus/sessions/{id}`) — every sensor-derived field below therefore comes
// through optional chaining, and the mapper is the one place that decides
// what "no activity object at all" means for each field. That is NOT the
// same question as "activity present but a sensor saw nothing", which is why
// `observedSeconds` and `focusScore` both preserve a null-vs-absent split
// straight from the server rather than collapsing it — see their comments.

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Fold the session's own closed runs (`ServerFocusSession.segments` — every
 * one already a FOCUS run; the server never stores break spans there) into
 * one `RecapDay` per LOCAL calendar day. Mirrors `focusTime.ts::
 * splitSegmentsByDay`'s day-clipping rule rather than reusing it: that
 * helper folds the CLIENT store's `FocusSegment[]` (which carries a
 * `mode: "focus" | "break"` this server shape has no need for, since a
 * stopped session's segments ARE its focus runs already).
 */
function perDayFromSegments(
  segments: ServerFocusSession["segments"],
): RecapDay[] {
  const byDay = new Map<string, { ms: number; truncated: boolean }>();
  for (const seg of segments) {
    const segStart = Date.parse(seg.start);
    const segEnd = Date.parse(seg.end);
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) continue;
    let cursor = segStart;
    while (cursor < segEnd) {
      const boundary = Math.min(nextLocalMidnight(cursor), segEnd);
      if (boundary <= cursor) break; // defensive: see split_runs_by_day's twin note server-side
      const key = localDayKey(cursor);
      const chunkMs = boundary - cursor;
      const prev = byDay.get(key);
      if (prev) {
        prev.ms += chunkMs;
        prev.truncated = prev.truncated || seg.truncated === true;
      } else {
        byDay.set(key, { ms: chunkMs, truncated: seg.truncated === true });
      }
      cursor = boundary;
    }
  }
  return [...byDay.entries()]
    .map(([date, v]) => ({
      date,
      minutes: Math.round((v.ms / 60_000) * 100) / 100,
      truncated: v.truncated,
    }))
    // A sub-second sliver either side of midnight isn't a day.
    .filter((d) => d.minutes > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * `session` → `SessionRecapData`. Used identically for the just-stopped
 * session (whose response already carries `activity` + `completion_frame`)
 * and for a past one fetched with `?activity=1` (whose `completion_frame` is
 * always absent — see the header comment).
 */
export function recapFromSession(session: ServerFocusSession): SessionRecapData {
  const spanStart = Date.parse(session.started_at);
  // A running/paused session has no `ended_at` yet — fall back to "now" so a
  // session opened mid-sitting (not the intended use of this view, but not
  // forbidden either) still spans something rather than going negative.
  const spanEnd = session.ended_at ? Date.parse(session.ended_at) : Date.now();
  const act = session.activity;

  const eventsByKind: Record<string, number> = {};
  for (const e of act?.camera_events ?? []) eventsByKind[e.kind] = e.count;

  return {
    id: session.id,
    title: session.title,
    // The server's own sum — see `focus_session_service.serialize`'s
    // `focused_ms`/`focused_minutes`, sealed through the same closer the
    // write path used. Never re-derived from the segments here.
    totalMinutes: session.focused_minutes,
    spanMs: Math.max(0, spanEnd - spanStart),
    spanStart,
    spanEnd,
    perDay: perDayFromSegments(session.segments),
    timeline: session.segments.map((s) => ({
      start: Date.parse(s.start),
      end: Date.parse(s.end),
      truncated: s.truncated === true,
    })),
    eventsByKind,
    evidence: act?.camera_evidence ?? [],
    browser: act?.browser.top ?? [],
    apps: act?.app.top ?? [],
    device: act?.device.top ?? [],
    browserOtherSec: act?.browser.other_sec ?? 0,
    appOtherSec: act?.app.other_sec ?? 0,
    // `null` means the activity read FAILED or was never requested — distinct
    // from `0`, which is `act.observed_seconds` itself saying the sensors
    // watched and saw nothing. Collapsing these would be exactly the "same
    // number, opposite claims" bug the rest of this surface refuses to make.
    observedSeconds: act ? act.observed_seconds : null,
    warnings: act?.warnings ?? [],
    // See the header comment — this is the one field with no server-side
    // per-session storage. Present only on a just-stopped session's response.
    completionFrame: session.completion_frame ?? null,
    // The score. `undefined` (no `activity` object at all — this read wasn't
    // scored) and `null` (scored, but nothing was observed) are DIFFERENT
    // answers and must stay different through this mapper — see
    // `SessionRecapData.focusScore`'s own doc for why.
    focusScore: act?.focus_score,
    presencePct: act?.presence_pct,
    scoreBasis: act?.score_basis,
    scoreCoverage: act?.score_coverage,
    sensorTimeline: act?.timeline_segments,
  };
}
