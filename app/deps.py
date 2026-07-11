"""Shared app-level singletons.

Lives here (not main.py) so routers and background loops can share accessors
without creating a router -> main import cycle. Used to own the daily-digest
nudge fan-out too — that died with the proactiveness reset (2026-07); the
next proactive system starts from scratch.
"""
from sqlalchemy.orm import Session

from .db.models import Settings


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
