
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..services import whoop


router = APIRouter()


@router.get("/whoop/today")
def whoop_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Return today's recovery + strain + sleep snapshot.

    Slice 5: cached as the `whoop` json master Trackable entry (one per
    local day). Pass `?refresh=1` to force a live API hit; otherwise we
    serve the cached payload if it was written within the last 2 hours,
    else refetch. Response shape unchanged from the WhoopSnapshot era.
    """
    from datetime import datetime as _dt, timedelta as _td

    doc = whoop.get_today(db)
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
        try:
            payload = whoop.fetch_today_snapshot(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Whoop fetch failed: {e}")
        if payload is None:
            raise HTTPException(status_code=401, detail="Whoop not connected")
        doc = whoop.upsert_today_snapshot(db, payload)

    doc = doc or {}
    from ..common import stale_day_label
    # subject-day honesty: the served reading may be a day-old sleep (today's
    # sync hasn't landed). day_label is '' when current, else 'yesterday'/'Jul 14'
    # — same vocab the activity rail uses, so the tile never implies today.
    day_label = stale_day_label(whoop._local_today(db), whoop.subject_day(doc, db))
    return {
        "date": whoop._local_today(db).isoformat(),
        "day_label": day_label,
        "recovery_score": doc.get("recovery_score"),
        "hrv_rmssd_ms": doc.get("hrv_rmssd_ms"),
        "resting_hr": doc.get("resting_hr"),
        "strain": doc.get("strain"),
        "sleep_minutes": doc.get("sleep_minutes"),
        "sleep_performance_pct": doc.get("sleep_performance_pct"),
        "sleep_start_at": doc.get("sleep_start_at"),
        "sleep_end_at": doc.get("sleep_end_at"),
        "sleep_efficiency_pct": doc.get("sleep_efficiency_pct"),
        "sleep_disturbance_count": doc.get("sleep_disturbance_count"),
        "updated_at": doc.get("updated_at"),
        "source_updated_at": doc.get("source_updated_at"),
    }


@router.get("/leetcode/today")
def leetcode_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Return today's LeetCode snapshot for the configured username.

    Lazy daily pull: cached in `leetcode_snapshots` (one row per UTC
    date). First viewer per day pays a ~500ms hit to leetcode.com/graphql;
    everyone else gets the cached row. Pass `?refresh=1` to force a live
    refetch.
    """
    from ..services import leetcode_service
    row = leetcode_service.get_or_fetch(db, force=refresh)
    return leetcode_service.serialize(row)
