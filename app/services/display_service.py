"""Ambient display state — what the persistent monitor is showing right now.

The kiosk at /focus runs 24/7 on a second screen. It is NOT always a dashboard:
at rest it shows Gooni asleep on the desk, and data only appears when summoned.
That progression is a state machine, and this module owns its ONE source of
truth:

    deep_rest → away from home; dimmest, slowest breath, no data
    rest      → home, Gooni asleep on the desk
    awake     → Gooni up behind the desk, still no data
    dash      → the dashboard, summoned deliberately

The write side is deliberately dumb and remote-friendly, because the things that
drive it aren't the browser: an iOS Shortcuts automation on leaving/arriving
home, and a physical button on the desk (an NFC tag → Shortcuts → one POST).
Both just set a DESIRED state; the kiosk polls and reconciles. That's the same
declarative reconcile-poll contract as focus_cam — copied on purpose, so there's
one pattern in the codebase for "a remote thing decides, a local thing catches
up", not two.

Local wake (mouse / keyboard at the desk) is deliberately NOT stored here. It's
per-viewport, it fires constantly, and routing it through the server would mean
a write every time Daniel twitches the mouse. The kiosk owns that transition
locally and only consults the server for the remote intents.

Storage is one nullable Text column (Settings.display), Text-not-JSON so the
shape can grow without a migration — same convention as Settings.focus_cam.
Deterministic, no LLM.
"""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from ..common import local_now
from ..deps import _settings_row

# Ordered least → most awake. The order is meaningful: the kiosk uses it to tell
# a "wake up" intent from a "settle down" one.
VALID_STATES = ("deep_rest", "rest", "awake", "dash")

_DEFAULT_BLOB = {
    "desired": "rest",
    "at": None,
    # Free-form provenance ("shortcuts:left_home", "desk_button", "ui") — read
    # by nobody today, but a state that changed for an unknown reason is the
    # kind of thing that's miserable to debug on a screen across the room.
    "source": None,
}


def get_blob(db: Session) -> dict:
    """Current display blob. Missing/blank/corrupt → the resting default. A bad
    write must never leave the kiosk with nothing to render."""
    s = _settings_row(db)
    if not s.display:
        return dict(_DEFAULT_BLOB)
    try:
        stored = json.loads(s.display)
    except (TypeError, ValueError):
        return dict(_DEFAULT_BLOB)
    if not isinstance(stored, dict):
        return dict(_DEFAULT_BLOB)
    blob = dict(_DEFAULT_BLOB)
    blob.update(stored)
    if blob.get("desired") not in VALID_STATES:
        blob["desired"] = _DEFAULT_BLOB["desired"]
    return blob


def set_desired(db: Session, desired: str, source: str | None = None) -> dict:
    """Set the desired display state (the reconcile target the kiosk polls)."""
    if desired not in VALID_STATES:
        raise ValueError(f"desired must be one of {VALID_STATES}")
    blob = get_blob(db)
    blob["desired"] = desired
    blob["at"] = local_now(db).isoformat()
    blob["source"] = source
    s = _settings_row(db)
    s.display = json.dumps(blob)
    db.commit()
    return blob
