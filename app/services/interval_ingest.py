"""Shared machinery for the two attention sensors — browser and desktop app.

`browser_activity_service` (Chrome extension → `browser_intervals`) and
`app_activity_service` (Electron shell → `app_intervals`) store different
vocabularies in different tables (a hostname is not an application name), but
they answer to the SAME contract, and that contract is the part worth having
exactly one copy of:

1. **Idempotency.** `client_id` is minted by the sensor when an interval CLOSES
   and survives every retry, so a redelivered batch must be a no-op. Ids
   already stored are pre-filtered (one IN query per batch) AND every insert
   sits inside its own SAVEPOINT, so two concurrent flushes of the same buffer
   still can't double-count — and the loser of that race unwinds only its own
   row, never the rows already inserted alongside it. `accepted`/`stored_ids`
   must therefore only ever name rows that really committed: the sensor deletes
   exactly those ids from its buffer, so an over-reported accept is permanent
   data loss, while an under-reported one just costs a redelivery that dedups.

2. **Trusting clocks, not arithmetic.** `duration_sec` is recomputed from
   started/ended; a client-supplied duration is ignored. Intervals that are
   backwards, absurdly long, or in the future are rejected with a stable reason
   rather than silently clamped — a sensor reporting a 16-hour "focus session"
   is broken, and quietly trimming it hides the breakage.

Nothing here writes a Trackable or binds attention to a Topic/Promise, and
nothing here ever should. Attribution is `focus_attribution`, derived at READ
time from focus-session windows — precisely because rule 1 above means an
interval can arrive hours after it was measured, so "what is running right now"
is not a fact about the row being stored (see BrowserInterval / AppInterval).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

# Batch ceiling. Both sensors flush on a timer + a size threshold well under
# this; anything bigger is a bug or an abusive caller.
MAX_BATCH = 500

# Longest interval accepted as real. Idle detection closes intervals after a
# minute of no input on both sides, so nothing legitimate comes close. A span
# past this means the sensor lied (or the machine's clock jumped) and the row
# would poison every number computed over it.
MAX_INTERVAL_SEC = 6 * 60 * 60

# Sub-second intervals are switch noise, not attention. Dropped as "too_short"
# rather than stored — they'd multiply the row count and mean nothing.
MIN_INTERVAL_SEC = 1.0

# Guards a clock-skewed client from writing the future into the log. Checked
# against BOTH ends of the interval: an NTP correction or a laptop resume
# mid-interval stamps started_at on the old clock and ended_at on the new one,
# and MAX_INTERVAL_SEC is far too loose to catch a jump of an hour or three —
# such a row stores as a real multi-hour block ending in the future.
MAX_FUTURE_SKEW = timedelta(minutes=5)


def parse_dt(raw) -> datetime | None:
    """ISO-8601 (offset or trailing Z) or epoch seconds → naive UTC datetime.

    Naive UTC is the storage convention everywhere else in this codebase, so a
    naive input is taken at face value and an aware one is converted. None on
    anything unparseable — the caller turns that into a per-row rejection, not
    a fallback-to-now (a made-up timestamp is worse than a dropped interval).

    EVERY parse path sits under one guard, deliberately. `fromtimestamp` raises
    OverflowError on an out-of-range epoch (a plain JSON integer like 1e20) and
    ValueError on NaN (which `json.loads` accepts as a bare literal), and
    `astimezone` raises OverflowError near datetime.min — none of them
    ValueError-only. An escape here is not a local bug: it leaves `normalize`
    and 500s the WHOLE batch, which the sensor RETAINS and retries forever, or
    400s it, which makes the sensor drop every valid row alongside the bad one.
    The contract is that a malformed row costs that row and nothing else, so
    unparseable is unparseable regardless of which exception says so.
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return None
    try:
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(float(raw), tz=timezone.utc).replace(tzinfo=None)
        s = str(raw).strip()
        if s.replace(".", "", 1).isdigit():
            return datetime.fromtimestamp(float(s), tz=timezone.utc).replace(tzinfo=None)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except (ValueError, OverflowError, OSError, TypeError, AttributeError):
        return None


def clean(raw, limit: int) -> str | None:
    """Trim a free-text field to a sane length; empty → None."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    return s[:limit]


def span(started: datetime, ended: datetime) -> tuple[float | None, str | None]:
    """Validate a closed interval's two clock readings.

    Returns (duration_sec, None) or (None, reason). Reasons are stable strings
    so a sensor can log them and a human can grep them.
    """
    duration = (ended - started).total_seconds()
    if duration < 0:
        return None, "negative_duration"
    if duration < MIN_INTERVAL_SEC:
        return None, "too_short"
    if duration > MAX_INTERVAL_SEC:
        return None, "too_long"
    horizon = datetime.utcnow() + MAX_FUTURE_SKEW
    if started > horizon or ended > horizon:
        return None, "future"
    return duration, None


def check_batch(intervals) -> None:
    """Reject a malformed envelope before any row is looked at."""
    if intervals is None:
        raise ValueError("intervals required")
    if not isinstance(intervals, list):
        raise ValueError("intervals must be a list")
    if len(intervals) > MAX_BATCH:
        raise ValueError(f"batch too large: {len(intervals)} (max {MAX_BATCH})")


def existing_client_ids(db: Session, model, ids: list[str]) -> set[str]:
    """Ids already stored, in one IN query.

    This is only the FAST path for idempotency, never the guarantee: a batch
    racing another flush can have a row committed between this read and its own
    insert. The UNIQUE constraint plus the per-row savepoint in `ingest_batch`
    is what actually makes a replay a no-op.
    """
    if not ids:
        return set()
    return {
        cid
        for (cid,) in db.query(model.client_id).filter(model.client_id.in_(ids)).all()
    }


def ingest_batch(db: Session, model, intervals, normalize) -> dict:
    """Store a batch of closed intervals, skipping any client_id already seen.

    `normalize` is the per-sensor validator: (item) -> (row_kwargs, None) or
    (None, reason). Everything else — envelope checks, in-batch dedup, the
    stored-id pre-filter, the per-row SAVEPOINT — is identical for both sensors
    and lives here.

    Returns {accepted, duplicates, rejected: [{client_id, reason}], stored_ids}.
    The sensor only needs the counts to decide the batch is safely delivered,
    but the rejection reasons make a misbehaving sensor debuggable without
    server-side log spelunking.
    """
    check_batch(intervals)

    rejected: list[dict] = []
    rows: list[dict] = []
    seen_in_batch: set[str] = set()
    for item in intervals:
        row, reason = normalize(item)
        if row is None:
            rejected.append(
                {
                    "client_id": (item or {}).get("client_id")
                    if isinstance(item, dict)
                    else None,
                    "reason": reason,
                }
            )
            continue
        # A batch that repeats an id inside itself is the same double-count bug
        # as a redelivered batch, one layer in.
        if row["client_id"] in seen_in_batch:
            continue
        seen_in_batch.add(row["client_id"])
        rows.append(row)

    duplicates = 0
    if rows:
        existing = existing_client_ids(db, model, [r["client_id"] for r in rows])
        duplicates += len(existing)
        rows = [r for r in rows if r["client_id"] not in existing]

    stored: list[str] = []
    for r in rows:
        try:
            # One SAVEPOINT per row. A concurrent flush that won the race on
            # this client_id makes the UNIQUE constraint fire here, and the
            # savepoint unwinds ONLY this row — a plain db.rollback() would
            # discard every row already inserted in this batch while `stored`
            # went on reporting them as accepted, and the sensor would drop
            # them from its buffer on the strength of that.
            with db.begin_nested():
                db.add(model(**r))
            stored.append(r["client_id"])
        except IntegrityError:
            duplicates += 1
    try:
        db.commit()
    except Exception:
        # Nothing committed, so nothing may be claimed. Raising leaves the
        # caller with a 5xx and the sensor with its buffer intact.
        db.rollback()
        raise

    return {
        "accepted": len(stored),
        "duplicates": duplicates,
        "rejected": rejected,
        "stored_ids": stored,
    }
