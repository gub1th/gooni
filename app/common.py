"""Shared cross-domain date/parse helpers + small constants.

App-level (same dir as main.py): relative imports stay at main.py depth.
"""
import hashlib
import os

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .db.models import Visit


_AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "").strip()


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
