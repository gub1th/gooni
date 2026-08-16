"""Browser-attention ingest — lands focus intervals from the Chrome extension.

The extension (`extension/`) watches which tab actually has focus and, when an
interval closes (tab switch, window blur, machine idle), buffers a record in
chrome.storage.local. It flushes batches here.

Deterministic, no LLM, no Trackable writes. Raw intervals land in their own
table and stop there — attribution to a Topic/Promise is a deliberately
separate later task (see BrowserInterval's docstring).

The two rules this ingest is strict about — `client_id` idempotency and
recomputing durations rather than trusting a client's arithmetic — are shared
with the desktop frontmost-app sensor and live in `interval_ingest.py`, which
owns the batch loop, the per-row SAVEPOINT and the validation limits. What
stays here is everything specific to a BROWSER interval: the URL scrub, the
host requirement, and the per-host aggregation the extension popup reads.

Privacy: full URLs are captured for every host (see BrowserInterval). The
extension scrubs credential-bearing query params before buffering; `scrub_url`
below re-runs the same strip as a server-side backstop over BOTH `url` and
`path`, so an old extension build or a hand-rolled client still can't park an
OAuth `code` in the log — including one that puts its query string in `path`.
The extension's list is the editable one (its options page); this one is a
fixed floor.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from ..common import local_day_bounds, local_now
from ..db.models import BrowserInterval
from . import device_activity, distraction_alert
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

SOURCE = "chrome_extension"

_END_REASONS = {
    "tab_change",
    "url_change",
    "window_blur",
    "idle",
    "locked",
    "shutdown",
    "truncated",
}


# THE MATCHER IS THREE CHECKS, and a param name is redacted if ANY fires. This
# is the SAME algorithm as extension/src/scrub.js over the same three sets — a
# floor that matched differently from the thing it backstops would not be a
# floor — and both sides are pinned by the same literal KEPT/REDACTED table
# (tests/test_browser_intervals.py and extension/tests/scrub.test.js).
#
# Each check exists because a simpler design failed in one direction or the
# other, and both directions are unacceptable: over-redaction destroys the value
# pre-buffer (unrecoverable), under-redaction stores a live credential.
#
#  1. SQUASHED whole-name — the only check that catches a run-together name with
#     no boundary to split on (`jsessionid`), and what keeps `api_key` covered
#     once `key` stops being a segment. It can't reach the innocent compounds:
#     zip_code→zipcode, sort_key→sortkey, us_state→usstate are not in the set.
#  2. WHOLE-NAME only (code, key, state) — the bare OAuth params. Deliberately
#     absent from the segment set, where they redacted `zip_code`,
#     `country-code`, `error_code`, `sort_key`, `us_state` and friends.
#  3. SEGMENT — split on `_`, `-`, camelCase and digit boundaries. The camelCase
#     split is load-bearing: without it `accessToken`/`sessionId`/`clientSecret`
#     stored verbatim. Segments keep the list short without substring
#     collateral (`auth` catches my_auth_token, not `author`/`authors`).
#
# NOT user-editable, deliberately: the extension's copy is the configurable one,
# and a floor a broken or hostile client could turn off is decoration.
SCRUB_PARAM_SEGMENTS = frozenset(
    {
        "auth",
        "authorization",
        "credential",
        "sig",
        "signature",
        "token",
        "secret",
        "password",
        "passwd",
        "pwd",
        "session",
        "otp",
    }
)

SCRUB_PARAM_WHOLE_NAMES = frozenset({"code", "key", "state"})

SCRUB_PARAM_SQUASHED_NAMES = frozenset(
    {
        "jsessionid",
        "phpsessid",
        "sessionid",
        "csrftoken",
        "accesstoken",
        "apikey",
        # The `x-`-prefixed API-key family walks past all three checks
        # otherwise: `key` is whole-name-only (check 2, which is what keeps
        # `sort_key`), so `x-api-key` has no matching segment and its squashed
        # form is `xapikey`, not `apikey`. Entries here MUST be pre-squashed —
        # a literal `x-api-key` would never match.
        "xapikey",
        "xfunctionskey",
        "subscriptionkey",
    }
)

_REDACTED = "REDACTED"

_SEPARATORS = re.compile(r"[_-]+")
_SEGMENT_SPLIT = re.compile(r"[\s_-]+")
_CAMEL_TAIL = re.compile(r"([a-z0-9])([A-Z])")
_CAMEL_RUN = re.compile(r"([A-Z]+)([A-Z][a-z])")
_ALPHA_DIGIT = re.compile(r"([a-zA-Z])([0-9])")
_DIGIT_ALPHA = re.compile(r"([0-9])([a-zA-Z])")


def _squash_name(name: str) -> str:
    return _SEPARATORS.sub("", (name or "").lower())


def _param_segments(name: str) -> list[str]:
    """Lowercase segments split on `_`, `-`, camelCase and digit boundaries.

    Mirrors extension/src/scrub.js::paramSegments substitution for substitution.
    """
    s = str(name or "")
    s = _CAMEL_TAIL.sub(r"\1 \2", s)
    s = _CAMEL_RUN.sub(r"\1 \2", s)
    s = _ALPHA_DIGIT.sub(r"\1 \2", s)
    s = _DIGIT_ALPHA.sub(r"\1 \2", s)
    return [seg for seg in _SEGMENT_SPLIT.split(s.lower()) if seg]


def _is_secret_param(name: str) -> bool:
    lower = (name or "").lower()
    if not lower:
        return False
    if _squash_name(lower) in SCRUB_PARAM_SQUASHED_NAMES:
        return True
    if lower in SCRUB_PARAM_WHOLE_NAMES:
        return True
    return any(seg in SCRUB_PARAM_SEGMENTS for seg in _param_segments(name))


def scrub_url(raw: str | None) -> str | None:
    """Strip credential-bearing query params, keep everything else.

    Takes a full URL *or* a bare path — `urlsplit` parses both, and the two
    must go through this one function rather than a second path-shaped copy
    that drifts out of sync with it. The extension only ever sends `pathname`
    in `path`, but the floor exists precisely for clients that are not the
    extension, and one that puts `/callback?code=…` in `path` would otherwise
    park a live OAuth code in the log.

    Assumes a string (or None): `normalize` rejects any other type up front, so
    the only exception this needs to survive is `urlsplit` choking on a genuinely
    malformed *string*. Widening the guard past `ValueError` would let a real
    bug in the strip pass silently, and this is the one path where a silent
    failure means storing a credential verbatim.

    HTTP-basic userinfo (`https://alice:hunter2@host/…`) is stripped too. It is
    a strictly stronger credential than an OAuth code, and it lived under this
    floor for two reasons at once: the no-query/no-fragment early return handed
    such a URL straight back, and `urlunsplit` re-emitted `netloc` verbatim when
    it didn't. So the netloc rebuild happens FIRST and the early return is
    conditioned on it being a no-op. Host and port are carried through exactly
    as written (an IPv6 literal keeps its brackets, the host keeps its case);
    only the credentials are replaced, and by `REDACTED@` rather than by
    nothing, so the log still shows a credentialed URL was visited.

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
    netloc = _strip_userinfo(parts.netloc)
    if netloc == parts.netloc and not parts.query and not parts.fragment:
        return raw
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    cleaned = [(k, _REDACTED if _is_secret_param(k) else v) for k, v in pairs]
    return urlunsplit(
        (parts.scheme, netloc, parts.path, urlencode(cleaned), "")
    )


def _strip_userinfo(netloc: str) -> str:
    """`alice:hunter2@host:8443` → `REDACTED@host:8443`; untouched when absent."""
    if "@" not in netloc:
        return netloc
    _, _, hostport = netloc.rpartition("@")
    return f"{_REDACTED}@{hostport}"


def normalize(item: dict) -> tuple[dict | None, str | None]:
    """Validate one raw interval. Returns (row_kwargs, None) or (None, reason).

    Reasons are stable strings so the extension can log them and a human can
    grep them: missing_client_id, missing_host, bad_path, bad_url,
    bad_started_at, bad_ended_at, negative_duration, too_short, too_long,
    future.
    """
    if not isinstance(item, dict):
        return None, "not_an_object"

    client_id = _clean(item.get("client_id") or item.get("id"), 128)
    if not client_id:
        return None, "missing_client_id"

    # Type-check the two fields that reach `scrub_url` unconverted. Every other
    # field is coerced by `_clean`/`_parse_dt`, but these must stay raw until
    # they are scrubbed, and `urlsplit` on a non-string raises AttributeError
    # or TypeError — neither of which the route's `except ValueError` catches,
    # so one such row would 500 the WHOLE batch. Validating here keeps the rule
    # where every other field's rule lives, and keeps the cost of a malformed
    # row at exactly that row.
    for field in ("path", "url"):
        value = item.get(field)
        if value is not None and not isinstance(value, str):
            return None, f"bad_{field}"

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

    duration, reason = _span(started, ended)
    if duration is None:
        return None, reason

    end_reason = _clean(item.get("end_reason"), 32)
    if end_reason not in _END_REASONS:
        end_reason = None

    return (
        {
            "client_id": client_id,
            "host": host,
            # Full URL for every host; the extension scrubbed credentials
            # already, scrub_url is the backstop for anything that didn't.
            # BOTH fields go through it — a client that puts a query string in
            # `path` must not get under the floor that `url` sits behind.
            "path": _clean(scrub_url(item.get("path")), 2048),
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

    The batch loop, the in-batch dedup and the per-row SAVEPOINT live in
    `interval_ingest` — shared verbatim with the desktop app sensor, because a
    second hand-written copy of an idempotency boundary is how the two drift
    into disagreeing about what "accepted" means.
    """
    result = _ingest_batch(db, BrowserInterval, intervals, normalize)
    _maybe_alert_distractions(db, result.get("stored_ids") or [])
    return result


def _maybe_alert_distractions(db: Session, stored_ids: list) -> None:
    """Distraction callout for freshly-stored intervals (see distraction_alert).

    Runs over STORED rows only — a duplicate redelivery (already alerted or
    deliberately not) and a rejected row must not fire. The session-liveness,
    once-per-subject dedup AND the staleness gate all live in
    `distraction_alert.maybe_alert`: each interval's own `ended_at` goes along
    as `observed_at`, so a buffered batch flushed hours late — the ordinary
    case for this sensor, which retains through outages — stays silent instead
    of nudging about a tab closed at lunch. The subject is `host_label`'s short
    form ("instagram"), the same label the phone's Shortcuts ping uses, so the
    two sensors share one dedup slot per session and one callout covers both.
    Best-effort: an alert failure must never break the ingest.
    """
    if not stored_ids:
        return
    try:
        # `stored_ids` are CLIENT ids (the extension's idempotency keys), not
        # row PKs — that's what `interval_ingest` reports back for the buffer.
        rows = (
            db.query(BrowserInterval.host, BrowserInterval.ended_at)
            .filter(BrowserInterval.client_id.in_(stored_ids))
            .all()
        )
        seen: set[str] = set()
        for host, ended_at in rows:
            if not distraction_alert.is_distraction_host(host):
                continue
            subject = device_activity.host_label(host)
            if subject in seen:
                continue
            seen.add(subject)
            distraction_alert.maybe_alert(db, subject=subject, observed_at=ended_at)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[browser_activity_service] distraction alert failed: {e}")


def list_intervals(db: Session, *, day=None, limit: int = 100) -> list[dict]:
    """Recent intervals, newest-first. `day` (a date) filters to that LOCAL
    calendar day. The verification read — there is no UI for this yet, on
    purpose (dashboards are out of scope for the base sensor)."""
    limit = max(1, min(int(limit or 100), 1000))
    q = db.query(BrowserInterval)
    if day is not None:
        start, end = local_day_bounds(local_now(db).tzinfo, day)
        q = q.filter(
            BrowserInterval.started_at >= start,
            BrowserInterval.started_at < end,
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


# ── aggregation (the popup's read) ───────────────────────────────────────────
#
# Every number the extension popup shows is folded in SQL — GROUP BY host and
# GROUP BY local day, two queries for a whole period regardless of how many
# intervals it covers. The popup never sees a raw interval. That is not a
# micro-optimisation: a tab-switch sensor writes thousands of rows a week, and
# a popup that pulled them all and summed in JavaScript would be visibly slow
# within a month and would keep getting slower forever.
#
# LOCAL-day bucketing, exactly. Rows are stored naive UTC, so the buckets are
# built in Python as tz-aware local midnights and converted back to UTC, then
# handed to SQL as a CASE ladder over `started_at`. The obvious cheaper trick —
# shifting the column by one fixed UTC offset and taking its date — is wrong
# across a DST switch, which is a real event inside any 7-day window twice a
# year. A period is at most 31 days, so the ladder is at most 31 branches.
#
# An interval is attributed WHOLLY to the local day it STARTED on. Splitting a
# midnight-crossing span across two days would be more precise, but intervals
# close on every tab switch, blur and idle, so a span that survives midnight is
# both rare and short — and a split total can't be reconciled against the
# session count that sits next to it. The rule is stated here, tested, and
# reported as-is rather than fudged.

# Longest period the popup may ask for in one go. Bounds the CASE ladder.
MAX_SUMMARY_DAYS = 31


def _day_bounds(tz, day) -> tuple[datetime, datetime]:
    """One local calendar day → its [start, end) in naive UTC."""
    return local_day_bounds(tz, day)


def _sum(col):
    """SUM that reads 0 rather than None on an empty group."""
    return func.coalesce(func.sum(col), 0.0)


def _truncated_only(col):
    """`col` for salvaged rows, 0 for clean ones — so one GROUP BY yields both
    the honest total and the part of it that is only a floor."""
    return case((BrowserInterval.truncated == True, col), else_=0)  # noqa: E712


def summarize(db: Session, *, start=None, end=None) -> dict:
    """Attention totals for a LOCAL date range, folded in SQL.

    `start`/`end` are dates, inclusive, defaulting to today. Returns::

        {start, end, days: [...], hosts: [...], totals: {...}}

    Each of `days`, `hosts` and `totals` carries `total_sec`, `sessions`,
    `truncated_sec` and `truncated_sessions`. The truncated figures are a
    SUBSET of the totals, never a separate pile: a salvaged interval is real
    attention whose duration is a floor (the browser died mid-span and it was
    closed at its last heartbeat), so dropping it would understate focus and
    showing it silently would overstate it. The caller marks it; both numbers
    are here so it can.

    `days` always covers every day in the range, including empty ones — a
    trend chart with a hole in it is a lie about a quiet day.
    """
    now_local = local_now(db)
    tz = now_local.tzinfo
    end = end or now_local.date()
    start = start or end
    if start > end:
        start, end = end, start
    span = (end - start).days + 1
    if span > MAX_SUMMARY_DAYS:
        start = end - timedelta(days=MAX_SUMMARY_DAYS - 1)

    days = []
    d = start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)

    window_start = _day_bounds(tz, days[0])[0]
    window_end = _day_bounds(tz, days[-1])[1]
    in_window = and_(
        BrowserInterval.started_at >= window_start,
        BrowserInterval.started_at < window_end,
    )

    duration = BrowserInterval.duration_sec
    aggregates = (
        _sum(duration),
        func.count(BrowserInterval.id),
        _sum(_truncated_only(duration)),
        func.coalesce(func.sum(_truncated_only(1)), 0),
    )

    host_rows = (
        db.query(BrowserInterval.host, *aggregates)
        .filter(in_window)
        .group_by(BrowserInterval.host)
        .order_by(_sum(duration).desc())
        .all()
    )
    hosts = [
        {
            "host": r[0],
            "total_sec": float(r[1] or 0),
            "sessions": int(r[2] or 0),
            "truncated_sec": float(r[3] or 0),
            "truncated_sessions": int(r[4] or 0),
        }
        for r in host_rows
    ]

    # One CASE branch per local day, boundaries computed per-day so a DST
    # switch inside the window lands on the right side of midnight.
    day_expr = case(
        *[
            (
                and_(
                    BrowserInterval.started_at >= lo,
                    BrowserInterval.started_at < hi,
                ),
                day.isoformat(),
            )
            for day, (lo, hi) in ((day, _day_bounds(tz, day)) for day in days)
        ],
        else_=None,
    )
    day_rows = (
        db.query(day_expr.label("day"), *aggregates)
        .filter(in_window)
        .group_by(day_expr)
        .all()
    )
    by_day = {
        r[0]: {
            "total_sec": float(r[1] or 0),
            "sessions": int(r[2] or 0),
            "truncated_sec": float(r[3] or 0),
            "truncated_sessions": int(r[4] or 0),
        }
        for r in day_rows
        if r[0]
    }

    day_series = [
        {
            "date": day.isoformat(),
            **by_day.get(
                day.isoformat(),
                {"total_sec": 0.0, "sessions": 0, "truncated_sec": 0.0,
                 "truncated_sessions": 0},
            ),
        }
        for day in days
    ]

    # Totals fold the host rows (one per distinct host — tens, not thousands),
    # not the intervals. Deriving them from an already-grouped result keeps the
    # headline arithmetically identical to the list under it; a third SUM query
    # could disagree with the rows if a write landed between the two.
    totals = {
        "total_sec": sum(h["total_sec"] for h in hosts),
        "sessions": sum(h["sessions"] for h in hosts),
        "truncated_sec": sum(h["truncated_sec"] for h in hosts),
        "truncated_sessions": sum(h["truncated_sessions"] for h in hosts),
        "hosts": len(hosts),
    }

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": day_series,
        "hosts": hosts,
        "totals": totals,
    }
