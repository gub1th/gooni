"""Browser-attention ingest — lands focus intervals from the Chrome extension.

The extension (`extension/`) watches which tab actually has focus and, when an
interval closes (tab switch, window blur, machine idle), buffers a record in
chrome.storage.local. It flushes batches here.

Deterministic, no LLM, no Trackable writes. Raw intervals land in their own
table and stop there — attribution to a Topic/Promise is a deliberately
separate later task (see BrowserInterval's docstring).

Two things this module is strict about:

1. **Idempotency.** `client_id` is minted once by the extension at interval
   close and survives every retry, so a redelivered batch must be a no-op. We
   pre-filter against the ids already stored (one IN query per batch) AND
   catch IntegrityError per row, so two concurrent flushes of the same buffer
   still can't double-count.
2. **Trusting clocks, not arithmetic.** `duration_sec` is recomputed from
   started/ended here; a client-supplied duration is ignored. Intervals that
   are backwards, absurdly long, or hostless are rejected with a reason rather
   than silently clamped — a sensor that reports a 16-hour "focus session" is
   broken, and quietly trimming it hides the breakage.

Privacy: full URLs are captured for every host (see BrowserInterval). The
extension scrubs credential-bearing query params before buffering; `scrub_url`
below re-runs the same strip as a server-side backstop, so an old extension
build or a hand-rolled client still can't park an OAuth `code` in the log. The
extension's list is the editable one (its options page); this one is a fixed
floor.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..common import local_now
from ..db.models import BrowserInterval

SOURCE = "chrome_extension"

# Batch ceiling. The extension flushes on a 60s timer + a size threshold well
# under this; anything bigger is a bug or an abusive caller.
MAX_BATCH = 500

# Longest interval we accept as real. chrome.idle closes intervals after a
# minute of no input, so nothing legitimate comes close. A span past this means
# the sensor lied (or the machine's clock jumped) and the row would poison
# every number computed over it.
MAX_INTERVAL_SEC = 6 * 60 * 60

# Sub-second intervals are tab-switch noise, not attention. Dropped as
# "too_short" rather than stored — they'd triple the row count and mean nothing.
MIN_INTERVAL_SEC = 1.0

# Guards a clock-skewed client from writing the future into the log.
MAX_FUTURE_SKEW = timedelta(minutes=5)

_END_REASONS = {
    "tab_change",
    "url_change",
    "window_blur",
    "idle",
    "locked",
    "shutdown",
    "truncated",
}


def _parse_dt(raw) -> datetime | None:
    """ISO-8601 (offset or trailing Z) or epoch seconds → naive UTC datetime.

    Naive UTC is the storage convention everywhere else in this codebase, so a
    naive input is taken at face value and an aware one is converted. None on
    anything unparseable — the caller turns that into a per-row rejection, not
    a fallback-to-now (a made-up timestamp is worse than a dropped interval).
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc).replace(tzinfo=None)
    s = str(raw).strip()
    if s.replace(".", "", 1).isdigit():
        return datetime.fromtimestamp(float(s), tz=timezone.utc).replace(tzinfo=None)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


# Query params whose VALUE is a credential. Matched case-insensitively against
# the param name as a substring, so `access_token`, `id_token`, `refresh_token`
# and `X-Amz-Security-Token` all fall out of one entry. Kept in sync by hand
# with extension/src/scrub.js — that copy is the user-editable one; this is the
# floor a bad client can't get under.
SCRUB_PARAM_SUBSTRINGS = (
    "token",
    "secret",
    "password",
    "passwd",
    "auth",
    "session",
    "sig",
    "signature",
    "credential",
    "apikey",
    "api_key",
)

# Exact-match names. `code`, `key` and `state` are too short/common to match as
# substrings ("zipcode", "keyword", "estate") but are the standard names for an
# OAuth authorization code, an API key and a CSRF nonce.
SCRUB_PARAM_EXACT = ("code", "key", "state", "id_token", "pwd", "otp")

_REDACTED = "REDACTED"


def _is_secret_param(name: str) -> bool:
    n = (name or "").lower()
    if n in SCRUB_PARAM_EXACT:
        return True
    return any(frag in n for frag in SCRUB_PARAM_SUBSTRINGS)


def scrub_url(raw: str | None) -> str | None:
    """Strip credential-bearing query params, keep everything else.

    Values are replaced with `REDACTED` rather than dropped, so the log still
    shows that a callback URL *had* a code without recording it. The fragment
    is dropped wholesale — implicit-flow OAuth returns `#access_token=…` there
    and a fragment carries no identity worth the risk.
    """
    if not raw:
        return raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw
    if not parts.query and not parts.fragment:
        return raw
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    cleaned = [(k, _REDACTED if _is_secret_param(k) else v) for k, v in pairs]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(cleaned), "")
    )


def _clean(raw, limit: int) -> str | None:
    """Trim a free-text field to a sane length; empty → None."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    return s[:limit]


def normalize(item: dict) -> tuple[dict | None, str | None]:
    """Validate one raw interval. Returns (row_kwargs, None) or (None, reason).

    Reasons are stable strings so the extension can log them and a human can
    grep them: missing_client_id, missing_host, bad_started_at, bad_ended_at,
    negative_duration, too_short, too_long, future.
    """
    if not isinstance(item, dict):
        return None, "not_an_object"

    client_id = _clean(item.get("client_id") or item.get("id"), 128)
    if not client_id:
        return None, "missing_client_id"

    host = _clean(item.get("host"), 255)
    if not host:
        return None, "missing_host"
    host = host.lower()

    started = _parse_dt(item.get("started_at"))
    if started is None:
        return None, "bad_started_at"
    ended = _parse_dt(item.get("ended_at"))
    if ended is None:
        return None, "bad_ended_at"

    duration = (ended - started).total_seconds()
    if duration < 0:
        return None, "negative_duration"
    if duration < MIN_INTERVAL_SEC:
        return None, "too_short"
    if duration > MAX_INTERVAL_SEC:
        return None, "too_long"
    if started > datetime.utcnow() + MAX_FUTURE_SKEW:
        return None, "future"

    end_reason = _clean(item.get("end_reason"), 32)
    if end_reason not in _END_REASONS:
        end_reason = None

    return (
        {
            "client_id": client_id,
            "host": host,
            # Full URL for every host; the extension scrubbed credentials
            # already, scrub_url is the backstop for anything that didn't.
            "path": _clean(item.get("path"), 2048),
            "url": _clean(scrub_url(item.get("url")), 2048),
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
    """Store a batch of focus intervals, skipping any client_id already seen.

    Returns {accepted, duplicates, rejected: [{client_id, reason}], stored_ids}
    — the extension only needs the counts to decide the batch is safely
    delivered, but the rejection reasons make a misbehaving sensor debuggable
    without server-side log spelunking.
    """
    if intervals is None:
        raise ValueError("intervals required")
    if not isinstance(intervals, list):
        raise ValueError("intervals must be a list")
    if len(intervals) > MAX_BATCH:
        raise ValueError(f"batch too large: {len(intervals)} (max {MAX_BATCH})")

    rejected: list[dict] = []
    rows: list[dict] = []
    seen_in_batch: set[str] = set()
    for item in intervals:
        row, reason = normalize(item)
        if row is None:
            rejected.append(
                {"client_id": (item or {}).get("client_id") if isinstance(item, dict) else None,
                 "reason": reason}
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
        ids = [r["client_id"] for r in rows]
        existing = {
            cid
            for (cid,) in db.query(BrowserInterval.client_id)
            .filter(BrowserInterval.client_id.in_(ids))
            .all()
        }
        duplicates += len(existing)
        rows = [r for r in rows if r["client_id"] not in existing]

    stored: list[str] = []
    for r in rows:
        db.add(BrowserInterval(**r))
        try:
            # Flush per row so one loser in a concurrent-flush race is counted
            # as a duplicate instead of failing the whole batch.
            db.flush()
            stored.append(r["client_id"])
        except IntegrityError:
            db.rollback()
            duplicates += 1
    db.commit()

    return {
        "accepted": len(stored),
        "duplicates": duplicates,
        "rejected": rejected,
        "stored_ids": stored,
    }


def list_intervals(db: Session, *, day=None, limit: int = 100) -> list[dict]:
    """Recent intervals, newest-first. `day` (a date) filters to that LOCAL
    calendar day. The verification read — there is no UI for this yet, on
    purpose (dashboards are out of scope for the base sensor)."""
    limit = max(1, min(int(limit or 100), 1000))
    q = db.query(BrowserInterval)
    if day is not None:
        tz = local_now(db).tzinfo
        start_local = datetime(day.year, day.month, day.day, tzinfo=tz)
        end_local = start_local + timedelta(days=1)
        q = q.filter(
            BrowserInterval.started_at >= start_local.astimezone(timezone.utc).replace(tzinfo=None),
            BrowserInterval.started_at < end_local.astimezone(timezone.utc).replace(tzinfo=None),
        )
    rows = q.order_by(BrowserInterval.started_at.desc()).limit(limit).all()
    return [serialize(r) for r in rows]


def serialize(r: BrowserInterval) -> dict:
    return {
        "id": r.id,
        "client_id": r.client_id,
        "host": r.host,
        "path": r.path,
        "url": r.url,
        "title": r.title,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "duration_sec": r.duration_sec,
        "end_reason": r.end_reason,
        "truncated": bool(r.truncated),
        "source": r.source,
    }
