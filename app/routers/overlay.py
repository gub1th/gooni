"""Ambient overlay route (Slice 4). One GET returns all four zones so
the hover open costs a single round-trip."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db

router = APIRouter()


@router.get("/overlay")
def get_overlay(db: Session = Depends(get_db)):
    from ..services import overlay_service

    return overlay_service.build_overlay(db)
