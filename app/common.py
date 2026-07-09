"""Shared cross-domain date/parse helpers + small constants.

App-level (same dir as main.py): relative imports stay at main.py depth.
"""
import hashlib
import os
import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .db.models import Visit


_AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "").strip()


# Durable-write claim verbs — the SINGLE source of truth shared by the
# verify rail (orchestrator/steps.py) and reflexion's hallucination
# cross-ref. Verb+object shape on purpose: bare "noted, sir" / "got it"
# are valid terse capture-acks the persona mandates, NOT write claims.
# History: steps.py carried a bare-verb copy that contradicted this one
# and force-regenerated clean persona acks (audit 2026-06-10).
WRITE_CLAIM_RE = re.compile(
    r"\b("
    r"tracked|logged|saved|recorded|stored|"
    r"added (?:it|that|this|a|the|to)|"
    r"created (?:a |the )?(?:todo|task|promise|note|reminder|focus)|"
    r"marked \w+ (?:done|complete|completed)|"
    r"set (?:a |the )?reminder"
    r")\b",
    re.IGNORECASE,
)


def _expected_token() -> str:
    """Derive a stateless token from the configured password."""
    return hashlib.sha256(_AUTH_PASSWORD.encode()).hexdigest()


def _parse_iso_date(s: str | None):
    """Parse YYYY-MM-DD. Returns None if missing/invalid (caller handles)."""
    if not s:
        return None
    from datetime import date as _date
    try:
        y, m, d = s.split("-")
        return _date(int(y), int(m), int(d))
    except Exception:
        return None


def local_now(db: Session):
    """Timezone-aware "now" in Daniel's configured TZ (Settings.nudge_tz,
    default America/Los_Angeles). Use for any user-facing clock math
    (due-date anchoring, day bounds). Convert to storage convention with
    `.astimezone(timezone.utc).replace(tzinfo=None)` — the DB stores
    naive UTC."""
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo
    from .db.models import Settings as _Settings
    s = db.query(_Settings).first()
    tz_name = (s.nudge_tz if s else None) or "America/Los_Angeles"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/Los_Angeles")
    return _dt.now(tz)


def local_today(db: Session):
    """Today in Daniel's configured TZ (Settings.nudge_tz, default
    America/Los_Angeles) — the canonical "what day is it for the user"
    helper. NEVER use `date.today()` for user-facing calendar days: the
    server runs UTC (Fly), so after ~5pm PT the UTC date has already
    rolled to tomorrow and a log/lookup keyed to it lands on the wrong day.
    """
    return local_now(db).date()


def _parse_optional_due(raw):
    from datetime import datetime as _dt
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="invalid due_date")
    cleaned = raw[:-1] if raw.endswith("Z") else raw
    try:
        return _dt.fromisoformat(cleaned)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid due_date")


_DUE_HINTS = {
    "tonight": ("today_eod", None),
    "today": ("today_eod", None),
    "tomorrow": ("plus_days", 1),
    "this week": ("plus_days", 7),
}


def parse_due_hint(hint, db=None):
    """Resolve a due-hint phrase to a concrete datetime (stored naive UTC,
    EOD-anchored in Daniel's LOCAL day). Moved here from the (deleted)
    todos intent handler — promises and todos share deadline parsing now.

    Anchoring is LOCAL (Settings.nudge_tz via local_now), then converted
    to the storage convention (naive UTC). A utcnow() anchor makes
    "tonight" at 6pm PT resolve to 23:59 *UTC* — 4:59pm PT the NEXT day.
    When db is None we degrade to the UTC behavior.

    Two-tier strategy:
      1. Regex map (_DUE_HINTS) handles the canonical enum-shaped phrases
         the LLM emits ("tomorrow", "tonight"). Deterministic, no call.
      2. `dateparser` fallback for free-form phrases ("in 3 days",
         "next friday", "by aug 5"). Pure Python, ~3ms.

    Stays None for context-dependent phrases ("soon", "before the trip").
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    if not hint:
        return None
    h = hint.strip().lower()
    rule = _DUE_HINTS.get(h)

    tzinfo = None
    if db is not None:
        now = local_now(db)
        tzinfo = now.tzinfo
    else:
        now = _dt.utcnow()

    def _to_storage(dt):
        # tz-aware local → naive UTC (storage convention). Naive passes
        # through (degraded no-db path).
        if dt.tzinfo is None:
            return dt
        return dt.astimezone(_tz.utc).replace(tzinfo=None)

    if rule:
        kind, arg = rule
        if kind == "today_eod":
            return _to_storage(now.replace(hour=23, minute=59, second=0, microsecond=0))
        if kind == "plus_days" and isinstance(arg, int):
            return _to_storage(
                (now + _td(days=arg)).replace(
                    hour=23, minute=59, second=0, microsecond=0
                )
            )

    # Regex map missed — try dateparser. PREFER_DATES_FROM='future' so
    # "friday" resolves to the NEXT friday, not last. RELATIVE_BASE anchors
    # relative phrases to Daniel's local clock; result is interpreted as
    # local then converted to naive UTC for storage.
    try:
        import dateparser
        parsed = dateparser.parse(
            h,
            settings={
                "PREFER_DATES_FROM": "future",
                "RETURN_AS_TIMEZONE_AWARE": False,
                "RELATIVE_BASE": now.replace(tzinfo=None),
            },
        )
        if parsed is not None:
            # Date-only (midnight) nudges to EOD so a "next friday"
            # deadline doesn't expire at 00:00.
            if parsed.hour == 0 and parsed.minute == 0:
                parsed = parsed.replace(hour=23, minute=59, second=0, microsecond=0)
            if tzinfo is not None:
                parsed = parsed.replace(tzinfo=tzinfo)
            return _to_storage(parsed)
    except Exception as e:
        print(f"[parse_due_hint] dateparser failed on '{h}': {e}")
    return None


_VALID_STATUS = {"committed", "someday"}


_VALID_SCALE = {"quick", "slow"}


def _parse_optional_dt(raw):
    """ISO datetime parser used for start_at / end_at — same shape as
    _parse_optional_due but explicit so the validation error stays scoped."""
    from datetime import datetime as _dt
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="invalid datetime")
    cleaned = raw[:-1] if raw.endswith("Z") else raw
    try:
        return _dt.fromisoformat(cleaned)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid datetime")


def _validate_health(raw):
    if raw is None or raw == "":
        return None
    try:
        v = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="health must be an integer 0..100")
    if v < 0 or v > 100:
        raise HTTPException(status_code=400, detail="health must be 0..100")
    return v


def _validate_status(raw):
    if raw is None or raw == "":
        return None
    if raw not in _VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_VALID_STATUS)}")
    return raw


def _validate_scale(raw):
    if raw is None or raw == "":
        return None
    if raw not in _VALID_SCALE:
        raise HTTPException(status_code=400, detail=f"scale must be one of {sorted(_VALID_SCALE)}")
    return raw


def _unique_viewers_for_note(db: Session, note_id: int) -> int:
    """Count distinct ip_hash values that hit /public/notes/{note_id}.
    Path-scoped — if a note is unpublished + republished, the historical
    visit rows still count toward the total. Daniel said "idc if data is
    erased if i pull a note out" so we keep it simple + cumulative."""
    from sqlalchemy import func as sqlfunc
    return int(
        db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash)))
        .filter(Visit.path == f"/public/notes/{note_id}")
        .scalar()
        or 0
    )
