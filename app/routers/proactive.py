"""The proactive layer's read + dismiss surface.

`GET /proactive/current` is what the ambient home polls; everything else here
exists so the loop is inspectable without waiting fifteen minutes at a screen.
All Bearer-authed by the global middleware, like every other route.

The loop itself lives in `background._proactive_loop`; the decisions live in
`services/proactive_service`. Nothing in this module ranks, filters or phrases
anything — a second cascade here is how two surfaces drift apart.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import proactive_service

router = APIRouter()


@router.get("/proactive/current")
def get_current_observation(db: Session = Depends(get_db)):
    """The one observation the ambient display should be showing, or null.

    Null is the normal answer and means exactly what it says — nothing worth
    surfacing right now. The client renders nothing; it never fills the slot
    with a placeholder.
    """
    row = proactive_service.current(db)
    return {"observation": proactive_service.serialize(row)}


@router.post("/proactive/{obs_id}/dismiss")
def dismiss_observation(obs_id: int, db: Session = Depends(get_db)):
    """Clear an unhelpful observation.

    Durable, and it buys real quiet: `proactive_service.is_repeat` gives a
    dismissed line a longer cooldown than an expired one, so a near-twin can't
    reappear on the next tick.
    """
    row = proactive_service.dismiss(db, obs_id)
    if row is None:
        raise HTTPException(status_code=404, detail="observation not found")
    return {"observation": proactive_service.serialize(row)}


@router.get("/proactive/recent")
def list_recent_observations(limit: int = 20, db: Session = Depends(get_db)):
    """Newest-first history across both channels — the tuning read.

    The asymmetric-value rule is a claim about output quality, and the only way
    to check a claim like that is to read a week of what the loop actually said.
    Includes the reach-outs, expired rows and dismissed ones; this is the log,
    not the surface.
    """
    rows = proactive_service.recent(db, limit=limit)
    return {"items": [proactive_service.serialize(r) for r in rows]}


@router.post("/proactive/tick")
def run_tick_now(db: Session = Depends(get_db)):
    """Run one cadence step immediately.

    A debug door, and the only practical way to exercise the loop locally
    without waiting out the interval. Costs at most one cheap model call, the
    same as any scheduled tick — it goes through the identical `tick()`, gates
    included, so what you see here is what the loop would do. A sync def, so
    FastAPI runs it in a threadpool and the blocking model call doesn't stall
    the event loop.
    """
    return proactive_service.tick(db)
