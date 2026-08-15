import json
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..serializers import (
    _serialize_settings
)
from ..deps import _settings_row


router = APIRouter()


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _serialize_settings(_settings_row(db))


@router.patch("/settings")
def patch_settings(body: dict, db: Session = Depends(get_db)):
    s = _settings_row(db)
    if "nudge_tz" in body:
        # Despite the legacy name, this is the app-wide canonical timezone —
        # local_today()/local_now() read it for every user-facing calendar day.
        tz = (body["nudge_tz"] or "").strip()
        # Validate via zoneinfo so we fail fast on typos rather than at next use.
        if ZoneInfo is not None:
            try:
                ZoneInfo(tz)
            except Exception:
                raise HTTPException(status_code=400, detail=f"unknown timezone: {tz!r}")
        s.nudge_tz = tz
    if "overlay_anchor_note_id" in body:
        raw = body["overlay_anchor_note_id"]
        if raw is None:
            s.overlay_anchor_note_id = None
        else:
            try:
                s.overlay_anchor_note_id = int(raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="overlay_anchor_note_id must be int or null")
    if "overlay_whoop_keys" in body:
        keys = body["overlay_whoop_keys"]
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
            raise HTTPException(status_code=400, detail="overlay_whoop_keys must be list[str]")
        s.overlay_whoop_keys = json.dumps(keys)
    if "proactive_enabled" in body:
        # The proactive loop's kill switch — the one knob worth reaching in
        # seconds when the loop starts saying something stupid. Strict bool:
        # a truthy string here would silently turn the loop back ON, which is
        # the wrong direction to be lenient in.
        raw = body["proactive_enabled"]
        if not isinstance(raw, bool):
            raise HTTPException(status_code=400, detail="proactive_enabled must be a bool")
        s.proactive_enabled = raw
    db.commit()
    db.refresh(s)
    return _serialize_settings(s)
