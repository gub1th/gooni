
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.get("/healthz")
async def root():
    return {"message": "ok"}


@router.get("/snapshot/today")
def snapshot_today(db: Session = Depends(get_db)):
    """Gooni's Take — daily reflection on the codebase + Daniel's activity.
    Lazy-built on first read of the day; subsequent reads hit cache.
    """
    from ..services.snapshot_service import snapshot_service
    snap = snapshot_service.get_or_build_today(db)
    return {
        "day": snap.day,
        "taken_at": snap.taken_at.isoformat() if snap.taken_at else None,
        "digest": snap.digest or "",
    }
