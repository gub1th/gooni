"""Browser-attention ingest routes — the Chrome extension's landing pad.

Bearer-authed by the global middleware, same as the iOS Shortcuts /events
ingest and the focus-cam /focus/cam/* routes: the sensor holds the token and
attaches it, there is no per-route guard.

  POST /browser/intervals   → a batch of closed focus intervals (idempotent
                              on each interval's client-generated client_id)
  GET  /browser/intervals   → recent intervals, newest-first (verification
                              read; no UI consumes it — dashboards are
                              deliberately out of scope for the base sensor)

Raw intervals only. Nothing here writes a Trackable or binds attention to a
Topic/Promise — see app/services/browser_activity_service.py.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..common import _parse_iso_date
from ..db.database import get_db
from ..services import browser_activity_service

router = APIRouter()


@router.post("/browser/intervals")
def ingest_browser_intervals(body: dict, db: Session = Depends(get_db)):
    """Accept a batch of closed focus intervals from the browser extension.

    Body: {"intervals": [{client_id, host, url?, path?, title?, started_at,
    ended_at, end_reason?, truncated?}, …]}

    Replaying an identical batch is a no-op: every interval carries a stable
    client-generated `client_id`, UNIQUE in the table, so retries after a
    timeout or an offline stretch count as `duplicates` instead of inflating
    attention. Rejected rows come back with a reason each; the rest still land
    (one malformed interval must not cost the extension its whole buffer).
    """
    try:
        return browser_activity_service.ingest_batch(db, body.get("intervals"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/browser/intervals")
def list_browser_intervals(
    day: str | None = None, limit: int = 100, db: Session = Depends(get_db)
):
    """Recent intervals, newest-first. `day=YYYY-MM-DD` scopes to that LOCAL
    calendar day."""
    parsed = _parse_iso_date(day) if day else None
    return {"intervals": browser_activity_service.list_intervals(db, day=parsed, limit=limit)}
