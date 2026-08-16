"""Generic event ingest — logs iOS Shortcuts automation pings as Trackables.

A Shortcuts automation (App Opened, Arrive/Leave a location, CarPlay connect,
charger plugged, NFC tag, Focus mode…) POSTs `{subject, event, at?}` every time
it fires. Each ping is +1 on a per-`"{subject} {event}"` sum-agg numeric
Trackable, created on the fly — so "instagram open", "gym arrive", "house leave"
all become countable daily-dot rows with ZERO backend change per new trigger.
The event's clock time rides in `value_json.at` — the seam for future
dwell/session math (pair arrive+leave → minutes at location).

No hardcoded event vocab (that IS the generalization): the Shortcut names the
verb. No Apple Screen Time API (that needs the paid FamilyControls entitlement);
no session pairing yet (counts only).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..common import local_now
from . import device_activity, trackable_service

SOURCE = "shortcuts"

# Focus-session distraction alert: a WhatsApp callout the moment an app-open
# ping arrives while a focus session is running. Dedup key = (target_reminder_id,
# app_name) so reopening the same app doesn't spam — cleared whenever the
# session's target changes (new session = clean slate). Module-level because
# there's no session table to hang this on (see focus_cam_service — the session
# itself is a client store; `target_reminder_id` + `control_at` on the Settings
# blob are the only server-visible trace one exists).
_alerted: dict[int | None, set[str]] = {}

# Mirrors focus_cam's own run cap (focusTime.ts / focus_attribution.py) — past
# this a `control_at` stamp is stale, not a live session.
_MAX_RUN = timedelta(hours=6)

# Same-trackable pings within this window collapse into ONE stream card — the
# "aggregate hard" rule (one card per run, not per app-switch).
#
# The constant now lives in `device_activity`, which owns the whole device
# vocabulary, because the browser and desktop sensors group their `opened X`
# rows by exactly this rule and window. Two copies of the same 60 minutes is two
# things that can drift; the name is kept as an alias so nothing else has to
# move.
EVENT_CLUSTER_GAP = device_activity.CLUSTER_GAP

# Strip anything that isn't a letter/digit/space so subject/event stay clean,
# human-readable trackable parts. "Instagram" → "instagram", "Gym!" → "gym".
_STRIP = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    return _WS.sub(" ", _STRIP.sub("", (s or "").lower())).strip()


def _parse_at(raw, now_local: datetime) -> datetime:
    """Best-effort event timestamp → tz-aware datetime. Accepts ISO-8601 (with
    or without offset; trailing Z ok) or epoch seconds. A naive ISO string is
    assumed to be in the user's local tz. Anything unparseable falls back to
    `now_local` — a bad `at` must never drop the ping."""
    if raw is None or raw == "":
        return now_local
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc)
    s = str(raw).strip()
    if s.replace(".", "", 1).isdigit():
        return datetime.fromtimestamp(float(s), tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return now_local
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=now_local.tzinfo)
    return dt


def log_event(db: Session, *, subject: str, event: str, at=None) -> dict:
    """Record one event ping.

    Idempotent get-or-create on the `"{subject} {event}"` Trackable, then append
    +1 on the event's LOCAL calendar day (a late-night ping must land on the
    right day, never the UTC tomorrow). The precise clock time is kept in
    `value_json.at`. Returns the day's running count so a manual test can
    eyeball it; the Shortcut ignores the response.
    """
    subj = _norm(subject)
    ev = _norm(event)
    if not subj:
        raise ValueError("subject required")
    if not ev:
        raise ValueError("event required")

    now_local = local_now(db)
    when = _parse_at(at, now_local)
    local_day = when.astimezone(now_local.tzinfo).date()

    name = f"{subj} {ev}"
    t = trackable_service.create(
        db,
        name=name,
        kind="numeric",
        agg="sum",
        source=SOURCE,
        schema_hint={"description": f"'{ev}' events for '{subj}' (iOS Shortcuts ping)"},
    )
    trackable_service.log_entry(
        db,
        t,
        day=local_day,
        value_numeric=1.0,
        value_json={"at": when.isoformat()},
        source=SOURCE,
    )

    entries = trackable_service.entries_for(db, t, start=local_day, end=local_day)
    count = trackable_service.day_value(entries, t) or 0

    if ev == "open":
        _maybe_alert_distraction(db, subject=subj)

    return {
        "subject": subj,
        "event": ev,
        "trackable": name,
        "count": int(count),
        "at": when.isoformat(),
    }


def _maybe_alert_distraction(db: Session, *, subject: str) -> None:
    """WhatsApp callout when an app-open ping lands during a LIVE focus session.

    Reads the same `Settings.focus_cam` blob `activity_context.live_focus_session`
    trusts — `control == "running"`, a `target_reminder_id`, and a `control_at`
    stamp inside `_MAX_RUN` — so a stale/unstamped blob (an old sidecar, a crashed
    tab) never fires a false alarm. Best-effort: a failure here must never break
    the event ingest it rides on.
    """
    try:
        from .interval_ingest import parse_dt
        from . import focus_cam_service, promise_service
        from .messaging.whatsapp import whatsapp_channel

        blob = focus_cam_service.get_blob(db)
        if blob.get("control") != "running":
            return
        target_id = blob.get("target_reminder_id")
        if not target_id:
            return
        started = parse_dt(blob.get("control_at"))
        now = datetime.utcnow()
        if started is None or now - started > _MAX_RUN or started > now + timedelta(minutes=5):
            return

        sent = _alerted.setdefault(target_id, set())
        if subject in sent:
            return

        promise = promise_service.get(db, target_id)
        task_title = (promise.summary or promise.utterance) if promise else "your focus task"

        target = next(iter(getattr(whatsapp_channel, "_allowed", None) or set()), None)
        if not target:
            return

        text = f"yo you just opened {subject}. you're on \"{task_title}\"."
        delivered = whatsapp_channel.send(target, whatsapp_channel.format_outbound(text))
        if not delivered:
            return
        sent.add(subject)

        from .conversation_service import conversation_service

        conv = conversation_service.find_or_create_session("whatsapp", db)
        conversation_service.add_message(conv.id, "assistant", text, db)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[event_service] distraction alert failed: {e}")


def _to_utc(raw) -> datetime | None:
    """Parse an ISO-8601 string (offset or trailing Z; a naive one is assumed
    UTC) into an aware UTC datetime. None on anything unparseable."""
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def list_recent_events(db: Session, *, start, end) -> list[dict]:
    """Shortcuts events across the [start, end] LOCAL-day window, aggregated
    HARD: each run of same-trackable pings within EVENT_CLUSTER_GAP collapses
    to ONE card (count = pings in the run), timed at the run's latest ping.
    Powers the focus stream's device-event interleave — quiet telemetry beside
    the thoughts. Newest-first. Each item:
      {type:'event', label, kind, at (UTC-aware ISO), count}

    NOTE: this shows every event kind (clustered), NOT anomalies-only — baseline
    deviation filtering is a deferred stream-polish step. The clustering + the
    FE's quiet styling keep it from drowning the thoughts.
    """
    from ..db.models import Trackable

    trackables = db.query(Trackable).filter(Trackable.source == SOURCE).all()
    items: list[dict] = []
    for t in trackables:
        times: list[datetime] = []
        for e in trackable_service.entries_for(db, t, start=start, end=end):
            at = None
            if e.value_json:
                try:
                    at = _to_utc(json.loads(e.value_json).get("at"))
                except (TypeError, ValueError, AttributeError):
                    at = None
            if at is None and e.date is not None:  # fallback: day start
                at = _to_utc(e.date.isoformat())
            if at is not None:
                times.append(at)
        if not times:
            continue
        times.sort()
        kind = t.name.split()[-1] if t.name else ""
        # Same sentence the log sheet shows ("opened instagram"), not the raw
        # trackable key ("instagram open"). The timeline now interleaves opens
        # from the browser and desktop sensors alongside these, and three
        # sensors printing the same event three ways is three vocabularies.
        label = device_activity.event_phrase(t.name)

        # Cluster the ping times into runs; emit one card per run.
        runs: list[tuple[datetime, int]] = []  # (latest_ping, count)
        run_latest, run_count = times[0], 1
        for at in times[1:]:
            if at - run_latest <= EVENT_CLUSTER_GAP:
                run_latest, run_count = at, run_count + 1
            else:
                runs.append((run_latest, run_count))
                run_latest, run_count = at, 1
        runs.append((run_latest, run_count))

        for latest, count in runs:
            items.append(
                {
                    "type": "event",
                    "label": label,
                    "kind": kind,
                    "at": latest.isoformat(),
                    "count": count,
                }
            )

    items.sort(key=lambda it: it["at"], reverse=True)
    return items
