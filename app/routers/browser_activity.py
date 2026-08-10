"""Browser-attention ingest routes — the Chrome extension's landing pad.

Bearer-authed by the global middleware, same as the iOS Shortcuts /events
ingest and the focus-cam /focus/cam/* routes: the sensor holds the token and
attaches it, there is no per-route guard.

  POST /browser/intervals   → a batch of closed focus intervals (idempotent
                              on each interval's client-generated client_id)
  GET  /browser/intervals   → recent intervals, newest-first (verification
                              read)
  GET  /browser/intervals/summary
                            → SQL-folded totals for a local date range,
                              grouped by host and by day. The extension
                              popup's only read — it never pulls raw rows.

Raw intervals only. Nothing here writes a Trackable or binds attention to a
Topic/Promise — see app/services/browser_activity_service.py.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..common import _parse_iso_date, local_now
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


@router.get("/browser/intervals/summary")
def summarize_browser_intervals(
    start: str | None = None,
    end: str | None = None,
    days: int | None = None,
    db: Session = Depends(get_db),
):
    """Attention totals for a LOCAL date range — the extension popup's read.

    `start`/`end` are `YYYY-MM-DD`, inclusive; `days=N` is shorthand for the
    last N days ending today (so `days=1` is today, `days=7` is the last week).
    Both default to today.

    Aggregation happens in SQL — GROUP BY host and GROUP BY local day — so the
    popup never downloads a raw interval. Salvaged (`truncated`) rows are
    included in the totals AND reported separately, because their duration is a
    floor rather than a measurement and the popup has to say so.

    Declared BEFORE /browser/intervals so it isn't shadowed by a future path
    param on that route (the /notes/search lesson, one router over).
    """
    parsed_start = _parse_iso_date(start) if start else None
    parsed_end = _parse_iso_date(end) if end else None
    if days is not None and parsed_start is None:
        n = max(1, min(int(days), browser_activity_service.MAX_SUMMARY_DAYS))
        anchor = parsed_end or local_now(db).date()
        parsed_end = anchor
        parsed_start = anchor - timedelta(days=n - 1)
    return browser_activity_service.summarize(db, start=parsed_start, end=parsed_end)


@router.get("/browser/intervals")
def list_browser_intervals(
    day: str | None = None, limit: int = 100, db: Session = Depends(get_db)
):
    """Recent intervals, newest-first. `day=YYYY-MM-DD` scopes to that LOCAL
    calendar day."""
    parsed = _parse_iso_date(day) if day else None
    return {"intervals": browser_activity_service.list_intervals(db, day=parsed, limit=limit)}
