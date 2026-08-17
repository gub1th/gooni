"""SESSION-SCOPED activity — everything the sensors saw between two instants.

The focus page used to answer "what happened during this session" out of three
endpoints that could not answer it at all:

  · `GET /focus/cam/today`   → camera events for the whole LOCAL DAY
  · `GET /focus/dashboard`   → `rollups`, device telemetry for the whole day
  · `GET /focus/cam/evidence`→ the last few days of evidence frames

So a twenty-minute session reported "17 signals today" and "whatsapp open · 16",
numbers about the day rather than about the session, and the recap said "nothing
flagged" because it was folding the one table (`focus_evidence`) nothing writes
to yet. Three scopes, three fetches, and none of them the session.

This module is the one read that IS scoped to the session: a window in, one fold
over every sensor out. Those three endpoints stay exactly as they are — the
ambient home and the log matrix legitimately want a DAY — but the focus surface
stops calling them.

**Read-only, derived at read time, no new storage.** No table, no column, no
migration, no Trackable, no model call. Every input already exists:

  · camera events   → `focus {kind}` Trackable entries (`source="focus_cam"`),
                      whose `value_json.at` carries the clock time
  · camera evidence → `focus_evidence` json entries, same `at`
  · browser         → `browser_intervals`
  · apps            → `app_intervals`
  · phone           → Shortcuts pings (`source="shortcuts"`), same `at`

**It reuses `focus_attribution`'s overlap machinery rather than restating it.**
A focus session's window is exactly what that module already overlaps intervals
against; the only difference is that it reads windows off WRITTEN session
entries (which don't exist until the session stops) while this one is handed a
window directly. So the window becomes a synthetic `FocusEntry` and the same
`attribute_intervals` / `attribute_events` / `rank` / `rank_counts` decide the
answer. Two surfaces that ask "what happened inside this window" must not be
able to disagree about it, and the way to guarantee that is one implementation,
not two that were written to match.

**Honesty rules, inherited and kept:**

  1. **Overlap, not containment.** A tab held for forty minutes across a
     twelve-minute session contributed twelve. The interval straddling an edge
     is the ORDINARY case — intervals close on switches and idle, not on
     session boundaries.
  2. **Observed ≠ elapsed.** `coverage` is a claim about the SENSORS. An
     uninstalled extension and a genuinely quiet session are the same rows and
     opposite claims, so the number sits beside the window rather than
     standing in for it, and it is the UNION of the two interval layers, never
     their sum (the browser IS one of the apps).
  3. **No silent caps.** Every bound that bit — the window clamp, a scan cap,
     a ranked tail, the evidence cap — is reported in `warnings` or as an
     `other_*` count. A head presented as the whole is how "that's everything"
     becomes a lie.
  4. **Gooni's own tabs are the tool, not activity** — the same `self_hosts`
     exclusion `activity_context` and `proactive_service` apply.
  5. **No on-task VERDICT.** Nothing here decides whether a host was worth the
     time — that needs a classifier, and every ranking surface in this codebase
     is deterministic by rule. The breakdown is reported; the reading is the
     human's (or the model's, from data it can see).

**THE SCORE (2026-08-16).** Rule 5 used to read "no score, no percentage" full
stop, and that was right while the only score available was `focused_ms /
span_ms` — timer state wearing a percentage, which reported **91% for a session
spent at a whiteboard** because the timer was running and the timer was all it
could see. What changed is not the appetite for a number; it is that the sensors
can now answer for the window. So the timer BOUNDS the window and never scores
it, and every second inside a focus run is classified from the sensors alone:

    focused     camera said `focused`, and no violation event was open
    distracted  camera said `distracted`, or a phone/vape/distracted event was
                open at that instant
    away        camera said `away`
    active      NO camera coverage, but a browser or app interval covered it
    unobserved  no camera and no device coverage — nothing saw this second

    scored       = focused + distracted + away + active
    focus_score  = 100 * (focused + active) / scored     (None if scored is 0)
    presence_pct = 100 * (focused + distracted) / camera_sec (None if no camera)

Three choices, each the inverse of a way a score lies. **`unobserved` is out of
the denominator and `focus_score` is None when nothing was observed** — a
session run with the sidecar off and the extension uninstalled scores NOTHING,
not zero and not ninety-one, which is rule 2 applied to a percentage;
`score_basis` names which sensors contributed. **`active` counts toward focus,
and that is safe because of what a device interval IS**: both sensors close
their interval when the human goes idle (`chrome.idle`, `powerMonitor.
getSystemIdleTime()`), so an abandoned tab accrues nothing and device coverage
genuinely means someone was at the machine. **`presence_pct` is a CAMERA claim
only** — folding device activity in would make a camera-less session report full
presence, the whiteboard bug wearing a different name.

The scoring keys are ADDITIVE and appear only when `runs` are supplied (a
session's exact focus windows). `GET /focus/session-activity?since=&until=` is
unchanged: no runs, no score, same payload it has always returned.
"""

from __future__ import annotations

import json
from datetime import date as _date
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .activity_context import union_seconds
from .device_activity import MAX_SCAN_INTERVALS, event_phrase, host_label
from .event_service import SOURCE as _SHORTCUTS_SOURCE
from .focus_attribution import (
    FocusEntry,
    attribute_events,
    attribute_intervals,
    rank,
    rank_counts,
)
from .focus_cam_service import EVIDENCE_TRACKABLE, VALID_EVENT_KINDS
from .focus_cam_service import SOURCE as _CAM_SOURCE
from .interval_ingest import MAX_INTERVAL_SEC, parse_dt
from .self_hosts import is_self_host

# The widest window one read will answer for.
#
# A focus run is capped at six hours client-side (`useFocusSessionStore`'s
# MAX_RUN_MS, mirrored by `activity_context.MAX_RUN`), but a session with pauses
# can legitimately span a day, and a recap for a session that crossed midnight
# must still work. Past this the read is clamped forward — never refused, since
# a partial answer that says it is partial beats a 400 on the surface that
# renders it — and the clamp is reported.
MAX_WINDOW = timedelta(hours=24)

# Most evidence frames returned. Each carries a base64 JPEG, so this is a
# payload bound rather than a taste one; the route's own cap is the same number.
# Truncation takes the NEWEST and says how many it dropped.
MAX_EVIDENCE = 60

#: How long a camera event without its own `duration_sec` is taken to last.
#: The sidecar reports most detections as instants; a phone pickup is not an
#: instant, and treating it as one would let a session full of them still score
#: as pure focus. Short on purpose — a floor on the disruption, not a guess at
#: its real length.
DEFAULT_EVENT_SEC = 30.0

#: Cap on how long one reported event may claim, so a malformed `duration_sec`
#: cannot blanket an entire session in `distracted`.
MAX_EVENT_SEC = 15 * 60.0

#: Timeline segments shorter than this fold into their neighbour. A hundred
#: sub-second slivers is not a timeline anybody can read, and every second still
#: counts in the totals — only the RENDERED bar is simplified.
MIN_SEGMENT_SEC = 5.0

#: The states a scored second can be in. `paused` is a timeline-only label (the
#: gaps BETWEEN runs) and never enters the fold: a pause is not a second the
#: sensors failed to watch, it is a second the session was not claiming.
SCORE_STATES = ("focused", "distracted", "away", "active", "unobserved")

# Most `value_json` rows parsed for one read, per kind of read. The camera and
# the phone both write one row per event, so a chatty sidecar bounds the cost
# here rather than in the query planner. Truncation is reported.
MAX_JSON_ROWS = 5_000


# ── the json-timestamped sources (camera events, evidence, phone pings) ───────


def _json_at_rows(
    db: Session,
    *,
    start_day: _date,
    end_day: _date,
    source: str | None = None,
    names: list[str] | None = None,
) -> tuple[list[tuple], bool]:
    """Trackable entries whose `value_json.at` is the row's real clock time.

    Returns `[(entry_id, trackable_name, at_naive_utc, doc)]` plus whether the
    row cap bit. The `date` column is a LOCAL day and the caller's window is
    naive UTC, so the day filter is a PREFILTER widened by a day on each side
    (no zone offset exceeds that) and the exact cut is the caller's — the same
    indexed-prefilter-plus-exact-predicate shape `focus_attribution._intervals`
    and `device_activity._sensor_rows` both use, for the same reason: `date` is
    indexed and `value_json` is unindexed free-form Text.

    A row whose `at` is missing or unparseable is SKIPPED, never defaulted to
    the day or to now — a made-up timestamp inside a session window is a
    fabricated event, which is worse than a dropped one.
    """
    from ..db.models import Trackable, TrackableEntry

    q = (
        db.query(TrackableEntry.id, Trackable.name, TrackableEntry.value_json)
        .join(Trackable, TrackableEntry.trackable_id == Trackable.id)
        .filter(
            TrackableEntry.date >= start_day - timedelta(days=1),
            TrackableEntry.date <= end_day + timedelta(days=1),
        )
    )
    if source is not None:
        q = q.filter(Trackable.source == source)
    if names is not None:
        if not names:
            return [], False
        q = q.filter(Trackable.name.in_(names))

    try:
        rows = q.order_by(TrackableEntry.id.desc()).limit(MAX_JSON_ROWS + 1).all()
    except Exception as e:  # pragma: no cover — defensive, one source must not
        print(f"[focus_session_activity] entry query failed ({source or names}): {e}")
        return [], False

    capped = len(rows) > MAX_JSON_ROWS
    rows = rows[:MAX_JSON_ROWS]

    out: list[tuple] = []
    for eid, name, raw_json in rows:
        if not raw_json:
            continue
        try:
            doc = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
        except (TypeError, ValueError):
            continue
        if not isinstance(doc, dict):
            continue
        at = parse_dt(doc.get("at"))
        if at is None:
            continue
        out.append((eid, name, at, doc))
    return out, capped


def _intervals(db: Session, model, name_col, since: datetime, until: datetime, *, layer: str):
    """One interval table's rows OVERLAPPING `[since, until)`, capped.

    The exact predicate is `started_at < until AND ended_at > since`, but only
    `started_at` is indexed, so this is an indexed prefilter — widened by the
    longest interval the ingest can have accepted — plus that exact predicate.
    Provably sufficient ONLY because `interval_ingest` REJECTS anything longer
    than `MAX_INTERVAL_SEC`, which is why the cap is imported rather than
    restated. Same trick, same reason, as `focus_attribution._intervals`.
    """
    reach = timedelta(seconds=MAX_INTERVAL_SEC)
    try:
        newest_first = (
            db.query(model.id, name_col, model.started_at, model.ended_at)
            .filter(
                model.started_at > since - reach,
                model.started_at < until,
                model.ended_at > since,
            )
            .order_by(model.started_at.desc())
            .limit(MAX_SCAN_INTERVALS + 1)
            .all()
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[focus_session_activity] {layer} interval query failed: {e}")
        return [], False
    capped = len(newest_first) > MAX_SCAN_INTERVALS
    return list(reversed(newest_first[:MAX_SCAN_INTERVALS])), capped


def _clipped_spans(rows, since: datetime, until: datetime):
    """Each interval's overlap with the window, for the coverage union."""
    spans = []
    for _iid, _name, s, e in rows:
        if s is None or e is None:
            continue
        lo, hi = max(s, since), min(e, until)
        if hi > lo:
            spans.append((lo, hi))
    return spans



# ── the score: classifying the window from the sensors ───────────────────────


def _spans_from_states(
    history: list[dict], end: datetime, *, last_report: datetime | None = None
) -> list[tuple[datetime, datetime, str]]:
    """Camera transitions → the spans they imply. A state holds until the next.

    **The FINAL span is bounded by when the sidecar last spoke**, not by the end
    of the window. A sidecar that dies at 14:00 while the state reads `focused`
    leaves no transition behind it, so an unbounded last span would credit the
    rest of the session as focused on the strength of a camera that had stopped
    looking — the single most flattering way this could be wrong. The blob's
    `at` is the liveness signal `focus_cam_service` already leans on
    ("freshness = liveness"), so the span stops there and the remainder falls
    through to `active`/`unobserved`.

    Known limitation: the blob is a singleton and latest-wins, so the bound is
    exact for a live or just-ended session (the recap's case) and useless for a
    session read back days later. There is no per-session record to do better
    with, and a fixed "a state may not last longer than N minutes" cap would be
    a guess that cuts genuine unbroken focus.
    """
    spans = []
    for i, row in enumerate(history):
        start = row["at"]
        if i + 1 < len(history):
            stop = history[i + 1]["at"]
        else:
            stop = end if last_report is None else min(end, max(last_report, start))
        if stop > start:
            spans.append((start, stop, row["state"]))
    return spans


def _event_spans(events: list[tuple]) -> list[tuple[datetime, datetime, str]]:
    """Camera events → the stretch each one makes `distracted`.

    Only the VIOLATION kinds. `stand` and `left_desk` are not lapses (the same
    exclusion `VIOLATION_EVENT_KINDS` draws for the live counter), and `away` is
    a camera STATE that already covers the leaving.
    """
    from .focus_cam_service import VIOLATION_EVENT_KINDS

    out = []
    for kind, at, doc in events:
        if kind not in VIOLATION_EVENT_KINDS:
            continue
        try:
            dur = float(doc.get("duration_sec") or DEFAULT_EVENT_SEC)
        except (TypeError, ValueError):
            dur = DEFAULT_EVENT_SEC
        dur = max(1.0, min(dur, MAX_EVENT_SEC))
        out.append((at, at + timedelta(seconds=dur), kind))
    return out


def classify(
    runs: list[tuple[datetime, datetime]],
    *,
    camera_spans: list[tuple[datetime, datetime, str]],
    violation_spans: list[tuple[datetime, datetime, str]],
    device_spans: list[tuple[datetime, datetime]],
) -> list[dict]:
    """Every focus run, cut into atomic spans and labelled from the sensors.

    Pure, so the scoring rule is testable without a database — the same reason
    `device_activity.opens_from_intervals` and `focus_attribution.
    attribute_intervals` are.

    A boundary sweep rather than per-second sampling: the answer only changes
    where some source starts or stops, so the number of atoms is bounded by the
    number of sensor events, not by the length of the session.
    """
    out: list[dict] = []
    for r0, r1 in runs:
        if r1 <= r0:
            continue
        cuts = {r0, r1}
        for spans in (camera_spans, violation_spans):
            for s0, s1, _ in spans:
                for t in (s0, s1):
                    if r0 < t < r1:
                        cuts.add(t)
        for s0, s1 in device_spans:
            for t in (s0, s1):
                if r0 < t < r1:
                    cuts.add(t)

        ordered = sorted(cuts)
        for a, b in zip(ordered, ordered[1:]):
            if b <= a:
                continue
            mid = a + (b - a) / 2
            cam = next((st for s0, s1, st in camera_spans if s0 <= mid < s1), None)
            violated = any(s0 <= mid < s1 for s0, s1, _ in violation_spans)
            covered = any(s0 <= mid < s1 for s0, s1 in device_spans)

            if cam == "away":
                # An `away` camera outranks a violation event: you cannot be on
                # your phone at the desk and away from it at the same instant,
                # and the stronger claim is the one the state machine made.
                state = "away"
            elif violated:
                state = "distracted"
            elif cam in ("focused", "distracted"):
                state = cam
            else:
                # No camera coverage — including the sidecar's own `paused`
                # state, which means it stopped looking and is not evidence
                # about the human either way.
                state = "active" if covered else "unobserved"
            out.append({"start": a, "end": b, "state": state})
    out.sort(key=lambda r: r["start"])
    return out


def merge_atoms(atoms: list[dict]) -> list[dict]:
    """Adjacent same-state atoms become one segment; slivers fold into their
    neighbour. Presentation ONLY — `fold_states` sums the ATOMS, so no second of
    any state is lost to this simplification."""
    merged: list[dict] = []
    for a in atoms:
        if merged and merged[-1]["state"] == a["state"] and merged[-1]["end"] == a["start"]:
            merged[-1]["end"] = a["end"]
            continue
        merged.append(dict(a))

    if len(merged) <= 1:
        return merged
    out: list[dict] = []
    for seg in merged:
        if out and (seg["end"] - seg["start"]).total_seconds() < MIN_SEGMENT_SEC:
            out[-1]["end"] = seg["end"]
            continue
        out.append(seg)
    # A second pass, because folding can leave two same-state neighbours.
    collapsed: list[dict] = []
    for seg in out:
        if collapsed and collapsed[-1]["state"] == seg["state"]:
            collapsed[-1]["end"] = seg["end"]
            continue
        collapsed.append(seg)
    return collapsed


def fold_states(atoms: list[dict]) -> dict[str, float]:
    """Seconds per state, from the ATOMS — never from the merged segments."""
    totals = {s: 0.0 for s in SCORE_STATES}
    for a in atoms:
        totals[a["state"]] = totals.get(a["state"], 0.0) + (a["end"] - a["start"]).total_seconds()
    return totals


def score(totals: dict[str, float]) -> dict:
    """Seconds per state → the score, and an honest account of its basis.

    `None` rather than `0` when nothing was observed: the whole reason this
    layer exists is that a score which always has a number is a score nobody can
    trust. `score_coverage` is deliberately its OWN key rather than reusing
    `coverage` — that one is the device-interval union over the whole window
    (the shipped meaning, shared with `focus_attribution`), while this one asks
    how much of the SCORED time any sensor watched. Two different questions
    under one name would be a silent contradiction.
    """
    focused = totals.get("focused", 0.0)
    distracted = totals.get("distracted", 0.0)
    away = totals.get("away", 0.0)
    activ = totals.get("active", 0.0)
    unobserved = totals.get("unobserved", 0.0)

    camera_sec = focused + distracted + away
    scored = camera_sec + activ
    total = scored + unobserved

    basis = []
    if camera_sec > 0:
        basis.append("camera")
    if activ > 0:
        basis.append("device")

    return {
        "focus_score": round(100 * (focused + activ) / scored) if scored > 0 else None,
        "presence_pct": round(100 * (focused + distracted) / camera_sec) if camera_sec > 0 else None,
        "score_coverage": round(scored / total, 3) if total > 0 else None,
        "scored_seconds": round(scored, 1),
        "unscored_seconds": round(unobserved, 1),
        "score_basis": basis,
        "seconds": {k: round(v, 1) for k, v in totals.items()},
    }


# ── the read ─────────────────────────────────────────────────────────────────


def session_activity(
    db: Session,
    *,
    since: datetime,
    until: datetime | None = None,
    runs: list[tuple[datetime, datetime]] | None = None,
    session_id: int | None = None,
) -> dict:
    """Every sensor's answer for `[since, until)`, in naive UTC.

    `runs` are the session's EXACT focus windows (`focus_session_service.
    sealed_runs`). Supplying them adds the score block and the timeline; the
    sensor rollups above are unchanged either way, because `[since, until)` is
    still the right question for "what did the sensors see while this session
    was open" — the runs answer the narrower "what was I doing while the clock
    was actually running". Omitting them is the pre-existing behaviour
    `GET /focus/session-activity` relies on, byte for byte.

    Shape::

        {since, until, window_seconds,
         camera_events:   [{kind, count}],
         camera_evidence: [{id, kind, at, session_id, activity, frame}],
         browser:         {top: [{name, label, seconds, intervals}], other_sec},
         app:             {top: [...], other_sec},
         device:          {top: [{name, label, count}], other_count},
         observed_seconds, coverage, warnings}

    `coverage` is the UNION of the two interval layers over the window — a
    claim about the SENSORS, never about the human. `None` on a zero-length
    window rather than a divide-by-zero or a fake 0.0.
    """
    from ..db.models import AppInterval, BrowserInterval

    until = until or datetime.utcnow()
    warnings: list[str] = []

    if until <= since:
        return {
            "since": since.isoformat(),
            "until": until.isoformat(),
            "window_seconds": 0.0,
            "camera_events": [],
            "camera_evidence": [],
            "browser": {"top": [], "other_sec": 0.0},
            "app": {"top": [], "other_sec": 0.0},
            "device": {"top": [], "other_count": 0},
            "observed_seconds": 0.0,
            "coverage": None,
            "warnings": ["empty range"],
            **(
                {
                    "session_id": session_id,
                    "timeline_segments": [],
                    "focus_score": None,
                    "presence_pct": None,
                    "score_coverage": None,
                    "scored_seconds": 0.0,
                    "unscored_seconds": 0.0,
                    "score_basis": [],
                    "seconds": {k: 0.0 for k in SCORE_STATES},
                }
                if runs is not None
                else {}
            ),
        }

    if until - since > MAX_WINDOW:
        asked = until - since
        since = until - MAX_WINDOW
        warnings.append(
            f"asked for a {asked.total_seconds() / 3600:.1f}h window; answered the "
            f"newest {MAX_WINDOW.total_seconds() / 3600:.0f}h (from "
            f"{since.isoformat()}) — a narrower read covers the rest"
        )

    window_sec = (until - since).total_seconds()

    # The window as a synthetic session, so the interval + event folds are the
    # SAME ones `/focus/attribution` runs. `promise_id`/`day` are only bucket
    # keys here; nothing downstream reads them, and no Promise is touched.
    window = FocusEntry(
        promise_id=0,
        title="",
        day=since.date(),
        minutes=0.0,
        windows=[(since, until)],
    )
    bucket_key = (0, window.day)

    # ── the two interval layers ──────────────────────────────────────────────
    layers: dict[str, dict] = {}
    all_spans: list[tuple[datetime, datetime]] = []
    for key, model, col, label_fn in (
        ("browser", BrowserInterval, BrowserInterval.host, host_label),
        ("app", AppInterval, AppInterval.app, None),
    ):
        rows, capped = _intervals(db, model, col, since, until, layer=key)
        if key == "browser":
            # Gooni's own tabs are the tool, not activity — dropped BEFORE the
            # fold so they never enter the ranking or the coverage union.
            rows = [r for r in rows if not is_self_host(r[1])]
        if capped:
            warnings.append(
                f"{key} scan hit its {MAX_SCAN_INTERVALS}-row cap; its seconds "
                f"are a floor"
            )
        names = attribute_intervals([window], rows).get(bucket_key, {})
        top, other = rank(names, label_fn=label_fn)
        layers[key] = {"top": top, "other_sec": other}
        all_spans.extend(_clipped_spans(rows, since, until))

    # The UNION, not the sum: Chrome frontmost while a tab is focused is ONE
    # observed second reported by two sensors.
    observed = union_seconds(all_spans)

    # ── the phone (Shortcuts pings) ──────────────────────────────────────────
    phone_rows, phone_capped = _json_at_rows(
        db, start_day=since.date(), end_day=until.date(), source=_SHORTCUTS_SOURCE
    )
    if phone_capped:
        warnings.append("phone event scan hit its row cap; counts are a floor")
    phone_counts = attribute_events(
        [window], [(eid, name, at) for eid, name, at, _doc in phone_rows]
    ).get(bucket_key, {})
    device_top, device_other = rank_counts(phone_counts, label_fn=event_phrase)

    # ── the camera: discrete events, then kept evidence frames ───────────────
    cam_rows, cam_capped = _json_at_rows(
        db,
        start_day=since.date(),
        end_day=until.date(),
        source=_CAM_SOURCE,
        names=[f"focus {k}" for k in VALID_EVENT_KINDS],
    )
    if cam_capped:
        warnings.append("camera event scan hit its row cap; counts are a floor")
    # Every ping is its own row (`log_event` writes +1 per event), so this is a
    # count of ROWS in the window — deliberately not `day_value`, which folds
    # the whole local day and is exactly the number the old footer showed.
    camera_counts: dict[str, int] = {}
    for _eid, name, at, _doc in cam_rows:
        if at < since or at >= until:
            continue
        kind = name[len("focus ") :] if name.startswith("focus ") else name
        camera_counts[kind] = camera_counts.get(kind, 0) + 1
    camera_events = [
        {"kind": k, "count": c}
        for k, c in sorted(camera_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    ev_rows, ev_capped = _json_at_rows(
        db, start_day=since.date(), end_day=until.date(), names=[EVIDENCE_TRACKABLE]
    )
    if ev_capped:
        warnings.append("evidence scan hit its row cap; older frames were not read")
    in_window = [r for r in ev_rows if since <= r[2] < until]
    in_window.sort(key=lambda r: r[2], reverse=True)
    if len(in_window) > MAX_EVIDENCE:
        warnings.append(
            f"{len(in_window) - MAX_EVIDENCE} more evidence frame(s) in this window "
            f"than the {MAX_EVIDENCE}-frame cap shows"
        )
        in_window = in_window[:MAX_EVIDENCE]
    camera_evidence = []
    for eid, _name, at, doc in in_window:
        b64 = doc.get("jpeg_b64")
        camera_evidence.append(
            {
                "id": eid,
                "kind": doc.get("kind"),
                "at": at.isoformat(),
                "session_id": doc.get("session_id"),
                "activity": doc.get("activity"),
                "frame": f"data:image/jpeg;base64,{b64}" if b64 else None,
            }
        )

    out = {
        "since": since.isoformat(),
        "until": until.isoformat(),
        "window_seconds": round(window_sec, 1),
        "camera_events": camera_events,
        "camera_evidence": camera_evidence,
        "browser": layers["browser"],
        "app": layers["app"],
        "device": {"top": device_top, "other_count": device_other},
        "observed_seconds": round(observed, 1),
        "coverage": round(min(1.0, observed / window_sec), 3) if window_sec > 0 else None,
        "warnings": warnings,
    }
    if runs is None:
        return out

    # ── the score, over the session's ACTUAL runs ────────────────────────────
    # Clipped to the answered window, so the clamp above cannot be sidestepped
    # by a run list that reaches further back than the read does.
    clipped = [(max(r0, since), min(r1, until)) for r0, r1 in runs]
    clipped = [(a, b) for a, b in clipped if b > a]

    from . import focus_cam_service

    history = focus_cam_service.state_history(db, start=since, end=until)
    camera_spans = _spans_from_states(
        history, until, last_report=focus_cam_service.last_report_at(db)
    )
    violation_spans = _event_spans(
        [
            (name[len("focus ") :] if name.startswith("focus ") else name, at, doc)
            for _eid, name, at, doc in cam_rows
            if since <= at < until
        ]
    )
    # The SAME spans `coverage` is built from — already clipped, already free of
    # Gooni's own hosts (rule 4). Reusing them rather than re-collecting is what
    # keeps "what counts as observed device activity" a single answer: two folds
    # differing on self-hosts would put a stretch spent in Gooni's own UI on
    # opposite sides of `active`/`unobserved` depending on which number you read.
    device_spans = all_spans

    atoms = classify(
        clipped,
        camera_spans=camera_spans,
        violation_spans=violation_spans,
        device_spans=device_spans,
    )
    segments = merge_atoms(atoms)
    timeline = [
        {
            "start": seg["start"].isoformat(),
            "end": seg["end"].isoformat(),
            "state": seg["state"],
            "seconds": round((seg["end"] - seg["start"]).total_seconds(), 1),
        }
        for seg in segments
    ]
    # The gaps BETWEEN runs are pauses — real elapsed time the session was not
    # claiming, so they are drawn but never folded into the score.
    for (_a0, a1), (b0, _b1) in zip(clipped, clipped[1:]):
        if b0 > a1:
            timeline.append(
                {
                    "start": a1.isoformat(),
                    "end": b0.isoformat(),
                    "state": "paused",
                    "seconds": round((b0 - a1).total_seconds(), 1),
                }
            )
    timeline.sort(key=lambda seg: seg["start"])

    if not camera_spans:
        warnings.append(
            "no camera data for this window — the score rests on device activity alone"
        )

    out["session_id"] = session_id
    out["focused_seconds"] = round(sum((b - a).total_seconds() for a, b in clipped), 1)
    out["timeline_segments"] = timeline
    out.update(score(fold_states(atoms)))
    return out
