"""Folders for notes — a Topic wearing a notes-shaped API.

Spaces died in the v2 nuke and tags took over ALL organization. Tags are the
wrong shape for a folder: a note has many, so "which folder is this in" has no
answer, and the sidebar can't render a tree. `Note.topic_id` is a real FK, so
a note is in exactly ONE folder by construction, and `Topic.parent_id` is a
self-FK, so nesting costs nothing.

This is deliberately NOT a new primitive. `Topic` already existed, already
nests, and already had rows — Claude's `log_note(kind="thought", topic=...)`
has been writing them for months. Those topics become visible folders, which
is the point: one grouping, not two.

WHAT THIS LAYER IGNORES: salience. A Topic carries a decay curve so the focus
dashboard can shrink subjects you have stopped thinking about. A FOLDER must
not fade — a folder that quietly shrinks is a folder you lose things in. The
curve is untouched (the focus surfaces still read it); this surface simply
never looks at it, and folders are ordered by name.
"""

from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from ...db.models import Note, Topic
from ...serializers import _not_archived

def _visible(q):
    """Live, human-written notes — the rows a person browses.

    Shares `_BROWSE_HIDDEN_TAGS` with the notes router rather than restating
    the list: counts and contents must hide exactly what the notes tab hides,
    or a folder reports 40 and opens on 6.
    """
    from ...routers.notes import _BROWSE_HIDDEN_TAGS

    q = _not_archived(q)
    for tag in _BROWSE_HIDDEN_TAGS:
        q = q.filter((Note.tags.is_(None)) | (~Note.tags.like(f'%"{tag}"%')))
    return q


def list_folders(db: Session) -> list[dict]:
    """Every folder with its DIRECT note count, ordered by name.

    The count is direct-only, not rolled up through children: a parent whose
    own count included its subfolders' would show a number you can't reconcile
    with what opening it shows. The tree is built client-side from `parent_id`.
    """
    counts = dict(
        _visible(db.query(Note.topic_id, func.count(Note.id)))
        .filter(Note.topic_id.isnot(None))
        .group_by(Note.topic_id)
        .all()
    )
    rows = db.query(Topic).order_by(func.lower(Topic.name).asc()).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "parent_id": t.parent_id,
            "color": t.color,
            "note_count": int(counts.get(t.id, 0)),
        }
        for t in rows
    ]


def unfiled_count(db: Session) -> int:
    """Notes in no folder. Rendered as its own row so notes can't go missing
    simply by never having been filed."""
    return int(_visible(db.query(func.count(Note.id))).filter(Note.topic_id.is_(None)).scalar() or 0)


def rename_folder(db: Session, topic: Topic, name: str) -> Topic:
    name = (name or "").strip()
    if not name:
        raise ValueError("folder name required")
    topic.name = name
    db.commit()
    db.refresh(topic)
    return topic


def reparent_folder(db: Session, topic: Topic, parent_id: int | None) -> Topic:
    """Move a folder under another, or to the root with None.

    Refuses a cycle. `Topic.parent_id` is a plain self-FK with nothing
    enforcing acyclicity, so dragging a folder into its own descendant would
    orphan the whole branch from the root and it would vanish from the tree
    while still holding notes.
    """
    if parent_id is not None:
        if parent_id == topic.id:
            raise ValueError("a folder cannot be its own parent")
        seen = {topic.id}
        cur = db.query(Topic).filter(Topic.id == parent_id).first()
        if cur is None:
            raise ValueError("parent folder not found")
        while cur is not None:
            if cur.id in seen:
                raise ValueError("that move would create a loop")
            seen.add(cur.id)
            cur = (
                db.query(Topic).filter(Topic.id == cur.parent_id).first()
                if cur.parent_id
                else None
            )
    topic.parent_id = parent_id
    db.commit()
    db.refresh(topic)
    return topic


def delete_folder(db: Session, topic: Topic) -> dict:
    """Delete the folder. NOTES ARE NEVER DELETED — they become unfiled.

    Child folders are lifted to this folder's parent rather than deleted, for
    the same reason: deleting a folder is a statement about the container, and
    a recursive delete would destroy a subtree from one click. Both moves are
    visible immediately in the sidebar, so nothing goes missing silently.
    """
    # NOT filtered by `_visible`: an archived or `thought` note in this folder
    # is hidden from counts and listings but still HAS the FK, and leaving it
    # pointing at a deleted row would surface the moment it is unarchived.
    unfiled = (
        db.query(Note).filter(Note.topic_id == topic.id).update(
            {"topic_id": None}, synchronize_session=False
        )
    )
    lifted = (
        db.query(Topic).filter(Topic.parent_id == topic.id).update(
            {"parent_id": topic.parent_id}, synchronize_session=False
        )
    )
    db.delete(topic)
    db.commit()
    return {"deleted": topic.id, "notes_unfiled": int(unfiled), "children_lifted": int(lifted)}
