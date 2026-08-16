"""The initiative synthesizer's read + manual-refresh surface.

`GET /initiatives` is a pure cache read — it never clusters and never spends a
model call, because every one of its callers (the memory graph, and the prompt
block through the same service) sits on a request path and a build is N model
calls over the whole corpus. `background._initiative_loop` owns refreshes;
`POST /initiatives/refresh` is the manual door through the identical code.

Bearer-authed by the global middleware, like every other route. Nothing here
clusters, labels or ranks — that all lives in services/initiative_service, and a
second cascade here is how two surfaces drift.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import initiative_service

router = APIRouter()


@router.get("/initiatives")
def get_initiatives(embeddings: bool = False, db: Session = Depends(get_db)):
    """The cached initiative snapshot.

    An empty one (`built_at: null`, no clusters) is the honest answer before the
    first refresh — not a 404, and never a placeholder initiative. `?embeddings=1`
    adds each cluster's centroid, which is ~15KB per cluster and useful only to
    something matching new rows against existing initiatives.
    """
    snapshot = initiative_service.get_snapshot(db)
    return initiative_service.serialize(snapshot, include_embeddings=embeddings)


@router.post("/initiatives/refresh")
def refresh_initiatives(db: Session = Depends(get_db)):
    """Re-cluster and re-label now, replacing the cache.

    Costs one cheap model call per cluster plus an O(n²) pass over the corpus,
    so this is a deliberate action, not something a page load triggers. A sync
    def, so FastAPI runs it in a threadpool and the blocking model calls don't
    stall the event loop.
    """
    snapshot = initiative_service.refresh(db)
    return initiative_service.serialize(snapshot)
