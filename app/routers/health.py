import os

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.get("/health")
async def health():
    # Fly injects these env vars on every machine; useful to surface so the
    # dev-tools modal can show "what's actually deployed" without a dashboard hop.
    return {
        "message": "Health check",
        "fly": {
            "app": os.getenv("FLY_APP_NAME"),
            "machine_id": os.getenv("FLY_MACHINE_ID"),
            "machine_version": os.getenv("FLY_MACHINE_VERSION"),
            "region": os.getenv("FLY_REGION"),
            "image_ref": os.getenv("FLY_IMAGE_REF"),
            "release_version": os.getenv("FLY_RELEASE_VERSION"),
        },
    }


@router.get("/health/scores")
def health_scores(db: Session = Depends(get_db)):
    """Composite 0-100 score per Gooni health axis. Drives the Build
    mode dashboard. Computed on-demand; cheap aggregates over existing
    tables, no caching. See `health_service.compute_all` for the per-
    axis scoring logic."""
    from ..services.health_service import compute_all
    return compute_all(db)
