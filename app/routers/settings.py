import json
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
)

from ..serializers import (
    _serialize_settings
)
from ..deps import _fire_nudge_once, _settings_row


router = APIRouter()


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _serialize_settings(_settings_row(db))


@router.patch("/settings")
def patch_settings(body: dict, db: Session = Depends(get_db)):
    s = _settings_row(db)
    if "nudge_enabled" in body:
        s.nudge_enabled = bool(body["nudge_enabled"])
    if "nudge_hour" in body:
        h = int(body["nudge_hour"])
        if not 0 <= h <= 23:
            raise HTTPException(status_code=400, detail="nudge_hour must be 0-23")
        s.nudge_hour = h
    if "nudge_minute" in body:
        m = int(body["nudge_minute"])
        if not 0 <= m <= 59:
            raise HTTPException(status_code=400, detail="nudge_minute must be 0-59")
        s.nudge_minute = m
    if "nudge_tz" in body:
        tz = (body["nudge_tz"] or "").strip()
        # Validate via zoneinfo so we fail fast on typos rather than at next fire.
        if ZoneInfo is not None:
            try:
                ZoneInfo(tz)
            except Exception:
                raise HTTPException(status_code=400, detail=f"unknown timezone: {tz!r}")
        s.nudge_tz = tz
    if "nudge_channels" in body:
        chans = body["nudge_channels"]
        if not isinstance(chans, list) or not all(isinstance(c, str) for c in chans):
            raise HTTPException(status_code=400, detail="nudge_channels must be list[str]")
        valid = {"telegram", "whatsapp"}
        bad = [c for c in chans if c not in valid]
        if bad:
            raise HTTPException(status_code=400, detail=f"unknown channel(s): {bad}")
        s.nudge_channels = json.dumps(chans)
    if "nudge_prompt" in body:
        # No length cap server-side — Daniel writes whatever instruction he
        # wants and the LLM cost scales with it. Empty string == use default.
        s.nudge_prompt = (body["nudge_prompt"] or "").strip()
    db.commit()
    db.refresh(s)
    return _serialize_settings(s)


@router.get("/settings/nudge-prompt-default")
def get_nudge_prompt_default():
    """Returns the bundled default digest prompt so the UI's "Use default"
    button doesn't have to mirror the string client-side."""
    return {"prompt": NUDGE_DEFAULT_PROMPT}


@router.post("/settings/test-nudge")
async def test_nudge():
    """Fire the nudge immediately, bypassing the same-day idempotency guard.
    Returns the report from the fan-out so the UI can show what landed."""
    return await _fire_nudge_once(force=True)
