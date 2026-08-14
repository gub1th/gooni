"""Desktop-attention ingest — lands frontmost-app intervals from the Electron shell.

The shell (`desktop/`) polls macOS for the frontmost application and, when an
interval closes (app switch, idle, lock, sleep, quit), buffers a record on disk
and flushes batches here. It is the OS-layer twin of the Chrome extension:
`browser_intervals` answers "which page held my attention", this answers "which
app did".

Deterministic, no LLM, no Trackable writes. Raw intervals land in their own
table and stop there — see AppInterval's docstring for why attribution stays a
separate later design, and why this is a table rather than a `source` value on
`browser_intervals`.

The idempotency boundary, the clock validation and the batch loop are shared
with the browser sensor via `interval_ingest`; this module owns only what is
specific to an APPLICATION interval, which is the app-name requirement and its
normalisation.
"""

from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..common import local_day_bounds, local_now
from ..db.models import AppInterval
from .interval_ingest import (  # noqa: F401 — re-exported: the limits are this module's public contract
    MAX_BATCH,
    MAX_FUTURE_SKEW,
    MAX_INTERVAL_SEC,
    MIN_INTERVAL_SEC,
    clean as _clean,
    ingest_batch as _ingest_batch,
    parse_dt as _parse_dt,
    span as _span,
)

SOURCE = "desktop_shell"

# Deliberately NOT the browser's list. An app interval can end for reasons a tab
# never has (the machine slept) and can't end for reasons a tab does (a URL
# changed under a stationary tab). An unrecognised reason is nulled rather than
# rejected — the reason is annotation, and losing the interval over it would be
# the tail wagging the dog.
#
# It must cover EVERY reason `desktop/src/appfocus.js` can stamp, or the ingest
# silently destroys an annotation the sensor went out of its way to make: an
# `unobserved` close (the frontmost query went blind) still stores its
# `truncated` flag, so the interval is right, but nulling the reason makes a
# wedged sensor indistinguishable from a crash salvage in `GET /app/intervals`
# — the exact silent-failure class this sensor keeps having to close.
_END_REASONS = {
    "app_change",
    "idle",
    "locked",
    "suspended",
    "shutdown",
    "unobserved",
    "truncated",
}

# App names arrive as macOS spells them ("Google Chrome", "Cursor"). Lowercased
# and squeezed so they render in the same voice as the Shortcuts device
# vocabulary, which `event_service._norm` already lowercases — "opened cursor"
# beside "opened instagram". Punctuation is KEPT (unlike _norm's strip): real
# app names contain it (`IINA+`, `Ableton Live 12 Suite`), and this is a display
# label, not a Trackable key that has to collide-match on later writes.
_WS = re.compile(r"\s+")


def _norm_app(raw) -> str | None:
    s = _clean(raw, 255)
    if s is None:
        return None
    return _WS.sub(" ", s).strip().lower() or None


def normalize(item: dict) -> tuple[dict | None, str | None]:
    """Validate one raw interval. Returns (row_kwargs, None) or (None, reason).

    Reasons are stable strings so the shell can log them and a human can grep
    them: not_an_object, missing_client_id, missing_app, bad_started_at,
    bad_ended_at, negative_duration, too_short, too_long, future.
    """
    if not isinstance(item, dict):
        return None, "not_an_object"

    client_id = _clean(item.get("client_id") or item.get("id"), 128)
    if not client_id:
        return None, "missing_client_id"

    app_name = _norm_app(item.get("app"))
    if not app_name:
        return None, "missing_app"

    started = _parse_dt(item.get("started_at"))
    if started is None:
        return None, "bad_started_at"
    ended = _parse_dt(item.get("ended_at"))
    if ended is None:
        return None, "bad_ended_at"

    duration, reason = _span(started, ended)
    if duration is None:
        return None, reason

    end_reason = _clean(item.get("end_reason"), 32)
    if end_reason not in _END_REASONS:
        end_reason = None

    return (
        {
            "client_id": client_id,
            "app": app_name,
            "title": _clean(item.get("title"), 512),
            "started_at": started,
            "ended_at": ended,
            "duration_sec": duration,
            "end_reason": end_reason,
            "truncated": bool(item.get("truncated")),
            "source": SOURCE,
        },
        None,
    )


def ingest_batch(db: Session, intervals) -> dict:
    """Store a batch of frontmost-app intervals, skipping ids already seen.

    Returns {accepted, duplicates, rejected: [{client_id, reason}], stored_ids}
    — identical in shape to the browser sensor's, because the shell's delivery
    rules are the browser extension's rules (retain by default; drop only on a
    body the server would refuse identically forever).
    """
    return _ingest_batch(db, AppInterval, intervals, normalize)


def list_intervals(db: Session, *, day=None, limit: int = 100) -> list[dict]:
    """Recent intervals, newest-first. `day` (a date) filters to that LOCAL
    calendar day. The verification read — the shell has no dashboard, and the
    user-facing surface is the `opened <app>` row in the activity feed."""
    limit = max(1, min(int(limit or 100), 1000))
    q = db.query(AppInterval)
    if day is not None:
        start, end = local_day_bounds(local_now(db).tzinfo, day)
        q = q.filter(
            AppInterval.started_at >= start,
            AppInterval.started_at < end,
        )
    rows = q.order_by(AppInterval.started_at.desc()).limit(limit).all()
    return [serialize(r) for r in rows]


def serialize(r: AppInterval) -> dict:
    return {
        "id": r.id,
        "client_id": r.client_id,
        "app": r.app,
        "title": r.title,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "duration_sec": r.duration_sec,
        "end_reason": r.end_reason,
        "truncated": bool(r.truncated),
        "source": r.source,
    }
