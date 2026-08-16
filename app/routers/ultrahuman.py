from datetime import datetime as _dt, timedelta as _td

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import ultrahuman


router = APIRouter()


@router.get("/ultrahuman/status")
def ultrahuman_status(db: Session = Depends(get_db)):
    return ultrahuman.connection_status(db)


@router.get("/ultrahuman/today")
def ultrahuman_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Same lazy-cache shape as /whoop/today: serve the cached master-
    trackable entry if it's under 2h old, else refetch."""
    doc = ultrahuman.get_today(db)
    updated_at = None
    if doc:
        try:
            updated_at = _dt.fromisoformat(doc.get("updated_at") or "")
        except (ValueError, TypeError):
            updated_at = None
    stale = (
        doc is None
        or updated_at is None
        or (_dt.utcnow() - updated_at) > _td(hours=2)
    )
    if refresh or stale:
        if not ultrahuman.is_configured():
            raise HTTPException(status_code=401, detail="Ultrahuman not configured")
        try:
            payload = ultrahuman.fetch_today_snapshot(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Ultrahuman fetch failed: {e}")
        if payload is None:
            raise HTTPException(status_code=401, detail="Ultrahuman not configured")
        doc = ultrahuman.upsert_today_snapshot(db, payload)

    doc = doc or {}
    return {
        "date": ultrahuman._local_today(db).isoformat(),
        "sleep_score": doc.get("sleep_score"),
        "sleep_minutes": doc.get("sleep_minutes"),
        "recovery_score": doc.get("recovery_score"),
        "hrv_ms": doc.get("hrv_ms"),
        "resting_hr": doc.get("resting_hr"),
        "steps": doc.get("steps"),
        "active_calories": doc.get("active_calories"),
        "updated_at": doc.get("updated_at"),
    }
