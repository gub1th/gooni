"""G2 self-PM: auto-detect workflow friction in Gooni's own replies.

Pattern: every assistant reply gets regex-scanned for "I can't X" /
"not yet supported" / "not a current capability" shapes. When matched,
log a FrictionEvent against the nearest cosine-matched backlog ticket
(creating one if no match found at threshold).

Why it lives outside orchestrator.py: the chat path stays clean
(orchestrator only fires the daemon); the detection logic + ticket
lookup is testable in isolation. Same shape as reflexion_service.

Runs in a daemon thread w/ its own SessionLocal so the chat reply
never waits on cosine search + DB writes.
"""

from __future__ import annotations

import re
import threading

from sqlalchemy.orm import Session

from ..db.database import SessionLocal


# Regex patterns that signal Gooni acknowledging a capability gap. Each
# pattern's first capture group should grab the gist (the verb/object
# phrase that names what's missing). Compiled once at import.
_GAP_PATTERNS = [
    # "I can't X" / "I cannot Y" — most common signal
    re.compile(
        r"\bi (?:can'?t|cannot) ([a-z][\w\s,/'\-]{3,80})(?=[.!?,]|$)",
        re.IGNORECASE,
    ),
    # "I don't have a way to X" / "I don't support X"
    re.compile(
        r"\bi don'?t (?:have(?: a way)?|support) ([a-z][\w\s,/'\-]{3,80})(?=[.!?,]|$)",
        re.IGNORECASE,
    ),
    # "not yet supported" / "not a current capability" — descriptive form
    re.compile(
        r"\b(?:not yet supported|not a current capability|not in my capabilities)\b",
        re.IGNORECASE,
    ),
    # "no tool for X" / "no way to Y"
    re.compile(
        r"\bno (?:tool|way|capability) (?:for|to) ([a-z][\w\s,/'\-]{3,80})(?=[.!?,]|$)",
        re.IGNORECASE,
    ),
]


# Auto-detection runs at a more permissive threshold than the manual
# tool's upsert (0.78). The regex match already says "Gooni hit a wall";
# we just need to find the right ticket bucket if one exists.
_AUTO_DETECT_COSINE = 0.70

# Default blast_radius for auto-detected friction. Medium impact —
# Gooni doesn't know how badly this hit Daniel just from emitting "I
# can't." LLM-driven re-scoring can happen at the manual tool path.
_DEFAULT_BLAST_RADIUS = 3


def detect_gap_phrase(reply: str) -> str | None:
    """Return the captured gap phrase (or a flat description) when the
    reply contains a capability-gap signal. None if no match.

    Prefers regexes with explicit capture groups (gives a concrete gap
    description). Falls back to the matched phrase itself for the
    descriptive "not yet supported"-style patterns.
    """
    if not reply:
        return None
    for pat in _GAP_PATTERNS:
        m = pat.search(reply)
        if m is None:
            continue
        # Group 1 = the gist when present; group 0 (whole match) when
        # the pattern is descriptive-only ("not yet supported").
        if m.groups():
            phrase = (m.group(1) or "").strip()
            if phrase:
                # Trim filler tail words that often cling to "I can't X"
                # captures ("right now", "yet", "for you", etc.) so the
                # cosine-match target stays tight.
                phrase = re.sub(
                    r"\s+(?:right now|yet|for you|at the moment)$",
                    "",
                    phrase,
                    flags=re.IGNORECASE,
                ).strip()
                return phrase[:120]
        return m.group(0).strip()[:120]
    return None


def log_async(*, assistant_reply: str, message_id: int | None) -> None:
    """Fire-and-forget detection. Spawns a daemon thread that runs
    cosine search + log_friction with its own session. Same pattern as
    reflexion_service.reflect_async — chat path never waits."""
    if not assistant_reply:
        return
    phrase = detect_gap_phrase(assistant_reply)
    if not phrase:
        return
    t = threading.Thread(
        target=_run_in_thread,
        kwargs={"phrase": phrase, "message_id": message_id},
        daemon=True,
    )
    t.start()


def _run_in_thread(*, phrase: str, message_id: int | None) -> None:
    db = SessionLocal()
    try:
        _log(db, phrase=phrase, message_id=message_id)
    except Exception as e:
        print(f"[friction_detector] failed: {e}", flush=True)
    finally:
        db.close()


def _log(db: Session, *, phrase: str, message_id: int | None) -> None:
    """Cosine-match against open tickets at AUTO_DETECT_COSINE. If
    match, log against it. Else create a new ticket capturing the gap
    and log first event. Synchronous; called from the daemon thread."""
    from .backlog_service import backlog_service

    # find_similar returns descending by similarity; threshold floor at
    # the auto-detect bar so we're not creating dups at the manual
    # tool's stricter 0.78.
    matches = backlog_service.find_similar(
        db, phrase, threshold=_AUTO_DETECT_COSINE, limit=1
    )
    open_match = next(((t, sim) for t, sim in matches if not t.done), None)
    if open_match is not None:
        ticket, _sim = open_match
        backlog_service.log_friction(
            db,
            ticket.id,
            _DEFAULT_BLAST_RADIUS,
            message_id=message_id,
            reason=f"auto-detected from Gooni reply: \"{phrase}\"",
            source="gooni_response",
        )
        return

    # No match — create a fresh ticket capturing the gap. The text
    # itself is the friction phrase; subtitle calls out the auto-detect
    # provenance so Daniel knows this wasn't manually flagged.
    ticket, _event = backlog_service.find_or_create_for_friction(
        db,
        text=phrase[:120],
        blast_radius=_DEFAULT_BLAST_RADIUS,
        message_id=message_id,
        reason=f"auto-detected from Gooni reply: \"{phrase}\"",
        source="gooni_response",
        subtitle="auto-flagged from Gooni's own 'I can't' surface",
    )
