"""Desktop-attention ingest routes — the Electron shell's landing pad.

Bearer-authed by the global middleware, same as the browser sensor's
/browser/intervals, the iOS Shortcuts /events ingest and /focus/cam/*: the
sensor holds the token and attaches it, there is no per-route guard.

  POST /app/intervals   → a batch of closed frontmost-app intervals (idempotent
                          on each interval's client-generated client_id)
  GET  /app/intervals   → recent intervals, newest-first (verification read)

Raw intervals only. Nothing here writes a Trackable or binds attention to a
Topic/Promise — the user-facing surface is the derived `opened <app>` row in
the activity feed (see app/services/device_activity.py), which is presentation,
not attribution.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..common import _parse_iso_date
from ..db.database import get_db
from ..services import app_activity_service

router = APIRouter()


@router.post("/app/intervals")
def ingest_app_intervals(body: dict, db: Session = Depends(get_db)):
    """Accept a batch of closed frontmost-app intervals from the desktop shell.

    Body: {"intervals": [{client_id, app, title?, started_at, ended_at,
    end_reason?, truncated?}, …]}

    Replaying an identical batch is a no-op: every interval carries a stable
    client-generated `client_id`, UNIQUE in the table, so retries after a
    timeout or an offline stretch count as `duplicates` instead of inflating
    attention. Rejected rows come back with a reason each; the rest still land
    (one malformed interval must not cost the shell its whole buffer).
    """
    try:
        return app_activity_service.ingest_batch(db, body.get("intervals"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/app/intervals")
def list_app_intervals(day: str | None = None, limit: int = 100, db: Session = Depends(get_db)):
    """Recent intervals, newest-first. `day=YYYY-MM-DD` scopes to that LOCAL
    calendar day."""
    parsed = _parse_iso_date(day) if day else None
    return {"intervals": app_activity_service.list_intervals(db, day=parsed, limit=limit)}
