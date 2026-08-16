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
  5. **No score, no percentage of the session called productive, no verdict.**
     Same line `focus_attribution`, `device_activity` and `activity_context`
     all refuse to cross: this states what was observed and nothing more.
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


# ── the read ─────────────────────────────────────────────────────────────────


def session_activity(
    db: Session, *, since: datetime, until: datetime | None = None
) -> dict:
    """Every sensor's answer for `[since, until)`, in naive UTC.

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

    return {
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
