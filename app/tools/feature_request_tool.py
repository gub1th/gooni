"""Capture-feature-gap tool. Called when Gooni recognizes Master is
asking for a capability that doesn't exist yet.

Slice 6: the backlog is gone — capability gaps land as NOTES tagged
`feature-request` (the universal capture atom; filter by tag). Cosine
dedup against existing feature-request notes keeps repeat asks from
stacking duplicates: a re-hit just returns the existing note.
"""

from .base import BaseTool


_DEDUP_THRESHOLD = 0.86


class RequestFeatureTool(BaseTool):
    name = "request_feature"
    description = (
        "Log a capability gap as a feature request when Master asks Gooni "
        "to do something not in CAPABILITIES (e.g. set reminders, send "
        "proactive messages, filter notes by date). Lands as a Note tagged "
        "feature-request; repeat asks dedupe onto the existing note. Do NOT "
        "promise the task — only log it, then tell Master what landed."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": (
                    "Short imperative title for the feature (max ~10 words). "
                    "Examples: 'Outbound time-based reminders via Telegram', "
                    "'Filter notes by date range', 'Voice-note transcription'."
                ),
            },
            "why": {
                "type": "string",
                "description": (
                    "One sentence describing what Master asked for and "
                    "what's missing today. Becomes the note body."
                ),
            },
        },
        "required": ["title"],
    }

    def execute(self, db=None, title: str = "", why: str = "", **kwargs) -> str:
        title = (title or "").strip()
        if not title:
            return "(title required)"
        if db is None:
            return "(no db session)"
        note = create_feature_request_note(db, title=title, why=why)
        if note is None:
            return "(feature capture failed)"
        return f"feature request noted (note #{note.id}): {title}"


def create_feature_request_note(db, *, title: str, why: str = ""):
    """Shared with intent_handlers/features.py. Dedup by title cosine
    against existing feature-request-tagged notes; insert a tagged Note
    otherwise. Returns the Note row (existing on dedup hit) or None."""
    import json

    from ..db.models import Note
    from ..services.embedding_utils import cosine, embed_text

    title = (title or "").strip()
    if not title:
        return None

    existing = (
        db.query(Note)
        .filter(Note.tags.is_not(None), Note.tags.like('%feature-request%'))
        .order_by(Note.id.desc())
        .limit(40)
        .all()
    )
    lowered = title.lower()
    for n in existing:
        other_title = (n.title or "").strip().lower()
        if other_title and (lowered in other_title or other_title in lowered):
            return n
    # Cosine fallback for paraphrases. Titles are short; embedding the
    # (≤40) recent candidates costs pennies and only runs when the cheap
    # substring pass missed.
    vec = embed_text(title)
    if vec is not None:
        for n in existing:
            other = embed_text((n.title or "").strip())
            if other is not None and cosine(vec, other) >= _DEDUP_THRESHOLD:
                return n

    body = (why or "").strip()
    note = Note(
        title=title,
        content=f"<p>{body}</p>" if body else "<p></p>",
        excerpt=body[:240] if body else None,
        tags=json.dumps(["feature-request", "from-chat"]),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note
