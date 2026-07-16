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

import re
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..common import local_now
from . import trackable_service

SOURCE = "shortcuts"

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
    return {
        "subject": subj,
        "event": ev,
        "trackable": name,
        "count": int(count),
        "at": when.isoformat(),
    }
