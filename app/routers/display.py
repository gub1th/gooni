"""Ambient display state routes — the kiosk's reconcile target.

  GET   /display          → the current desired state (kiosk polls this)
  POST  /display/control  → set desired state (iOS Shortcuts + the desk button)

Bearer-authed by the global middleware, like every other route — the desk button
and the leave/arrive-home automations are Shortcuts actions carrying the token,
so no new auth path is introduced.

See app/services/display_service.py for why the write side is a declarative
target rather than a command.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import display_service

router = APIRouter()


@router.get("/display")
def get_display(db: Session = Depends(get_db)):
    """The desired display state. The /focus kiosk polls this and reconciles."""
    return display_service.get_blob(db)


@router.post("/display/control")
def post_display_control(body: dict, db: Session = Depends(get_db)):
    """Set the desired display state.

    Bodies come from three places, all one-liners:
      {"desired": "dash"}                       — the desk button (NFC → Shortcuts)
      {"desired": "deep_rest", "source": "..."} — Shortcuts, leaving the house
      {"desired": "rest",      "source": "..."} — Shortcuts, arriving home
    """
    desired = (body.get("desired") or "").strip()
    source = body.get("source")
    try:
        blob = display_service.set_desired(db, desired, source=source)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return blob
