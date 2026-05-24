
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..services import whoop


router = APIRouter()


@router.get("/whoop/today")
def whoop_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Return today's recovery + strain + sleep snapshot.

    Cached daily in `whoop_snapshots` (one row per date). Pass `?refresh=1`
    to force a live API hit; otherwise we serve the cached row if it was
    updated within the last 2 hours, else refetch.
    """
    from datetime import datetime as _dt, timedelta as _td
    from ..db.models import WhoopSnapshot
    # `today` keyed on Daniel's local TZ so the snapshot maps to his lived
    # day, not UTC. Whoop service mirrors this in `_local_today`.
    today = whoop._local_today(db)
    row = db.query(WhoopSnapshot).filter(WhoopSnapshot.date == today).first()
    stale = (
        row is None
        or row.updated_at is None
        or (_dt.utcnow() - row.updated_at) > _td(hours=2)
    )
    if refresh or stale:
        try:
            payload = whoop.fetch_today_snapshot(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Whoop fetch failed: {e}")
        if payload is None:
            raise HTTPException(status_code=401, detail="Whoop not connected")
        row = whoop.upsert_today_snapshot(db, payload)
    return {
        "date": row.date.isoformat() if row and row.date else None,
        "recovery_score": row.recovery_score if row else None,
        "hrv_rmssd_ms": row.hrv_rmssd_ms if row else None,
        "resting_hr": row.resting_hr if row else None,
        "strain": row.strain if row else None,
        "sleep_minutes": row.sleep_minutes if row else None,
        "sleep_performance_pct": row.sleep_performance_pct if row else None,
        "sleep_start_at": (
            row.sleep_start_at.isoformat()
            if row and row.sleep_start_at else None
        ),
        "sleep_end_at": (
            row.sleep_end_at.isoformat()
            if row and row.sleep_end_at else None
        ),
        "sleep_efficiency_pct": row.sleep_efficiency_pct if row else None,
        "sleep_disturbance_count": row.sleep_disturbance_count if row else None,
        "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
        "source_updated_at": (
            row.source_updated_at.isoformat()
            if row and row.source_updated_at else None
        ),
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
