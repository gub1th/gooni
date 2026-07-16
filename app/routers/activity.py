"""Unified activity stream endpoint — the "true log" (PRD note #397).

GET /activity = one recency-ordered feed merging chats + notes + promise
events + trackable measurements (Whoop/LeetCode ride in as trackables).
Powers the always-on ambient activity rail. Paginate with `before` (pass
the prior page's last item `at`); empty list = nothing older left.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import activity_service

router = APIRouter()


@router.get("/activity")
def get_activity(
    before: str | None = None,
    limit: int = 40,
    db: Session = Depends(get_db),
):
    before_dt = activity_service.parse_before(before)
    return activity_service.build_activity_feed(db, before=before_dt, limit=limit)
