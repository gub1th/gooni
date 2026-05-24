
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Visit,
)



router = APIRouter()


@router.get("/public/visits/count")
def get_public_visit_count(db: Session = Depends(get_db)):
    """Unique visitor count for the public site. Safe to expose — no PII, just a number."""
    from sqlalchemy import func as sqlfunc
    count = db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash))).scalar() or 0
    return {"unique_visitors": int(count)}


@router.get("/visits/summary")
def get_visits_summary(db: Session = Depends(get_db)):
    """Unique-visitor stats for /public/*. Auth-gated (not a /public route)."""
    from datetime import datetime, timedelta
    from sqlalchemy import func as sqlfunc

    week_ago = datetime.utcnow() - timedelta(days=7)
    total_visits = db.query(Visit).count()
    unique_visitors = db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash))).scalar() or 0
    weekly_unique = (
        db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash)))
        .filter(Visit.created_at >= week_ago)
        .scalar()
        or 0
    )
    top_paths = (
        db.query(Visit.path, sqlfunc.count(Visit.id).label("c"))
        .group_by(Visit.path)
        .order_by(sqlfunc.count(Visit.id).desc())
        .limit(5)
        .all()
    )
    recent = (
        db.query(Visit)
        .order_by(Visit.created_at.desc())
        .limit(10)
        .all()
    )
    return {
        "total_visits": total_visits,
        "unique_visitors": unique_visitors,
        "weekly_unique_visitors": weekly_unique,
        "top_paths": [{"path": p, "count": c} for (p, c) in top_paths],
        "recent": [
            {
                "ip_hash": v.ip_hash,
                "path": v.path,
                "user_agent": (v.user_agent or "")[:80],
                "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in recent
        ],
    }
