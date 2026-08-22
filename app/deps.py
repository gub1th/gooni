"""Shared app-level singletons.

Lives here (not main.py) so routers and background loops can share accessors
without creating a router -> main import cycle. Used to own the daily-digest
nudge fan-out too — that died with the proactiveness reset (2026-07); the
next proactive system starts from scratch.
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from .db.models import Note, Settings


def _settings_row(db: Session) -> Settings:
    """Singleton accessor for the Settings row (id=1), creating it on first
    touch so callers never have to handle the empty-DB case."""
    s = db.query(Settings).filter(Settings.id == 1).first()
    if s is None:
        s = Settings(id=1)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def note_or_404(note_id: int, db: Session, what: str = "Note") -> Note:
    """Fetch a note by id or raise 404. THE fetch-or-404 for router code.

    Extracted because the same three lines were pasted at ~10 call sites and
    had already drifted into four different not-found behaviours — including
    two routes that returned `({"error": ...}, 404)`, a Flask idiom FastAPI
    has no notion of: it JSON-encoded the tuple as a two-element array and
    replied 200, so a missing note read as success to the frontend.

    Deliberately NOT used by `mcp_surface/gateway.py` or `note_service`.
    Their contract is to return None / skip silently — the gateway is a data
    access layer whose callers handle absence, and the service functions run
    on background threads where there is no request to fail. A helper that
    raises would turn both of those into 500s.

    `what` only names the thing in the message (a parent-note lookup says
    "parent note not found"); it never changes the status code.
    """
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return note
