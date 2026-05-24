
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Note,
    NoteComment,
)

from ..serializers import (
    _serialize_comment
)


router = APIRouter()


@router.get("/notes/{note_id}/comments")
def list_note_comments(note_id: int, db: Session = Depends(get_db)):
    """All comments on a note, oldest first. Mirrors how Confluence threads
    read top-down so newest replies stay at the bottom of the editor."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    rows = (
        db.query(NoteComment)
        .filter(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc(), NoteComment.id.asc())
        .all()
    )
    return [_serialize_comment(c) for c in rows]


@router.post("/notes/{note_id}/comments")
def create_note_comment(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Append a comment. `author` defaults to "daniel" when the request
    doesn't supply one — Claude/Gooni pass their own label via the MCP tool
    so the bubble can show who wrote it."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    author = (body.get("author") or "daniel").strip() or "daniel"
    c = NoteComment(note_id=note_id, author=author, content=content)
    db.add(c)
    db.commit()
    db.refresh(c)
    return _serialize_comment(c)


@router.delete("/comments/{comment_id}")
def delete_note_comment(comment_id: int, db: Session = Depends(get_db)):
    c = db.query(NoteComment).filter(NoteComment.id == comment_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    db.delete(c)
    db.commit()
    return {"ok": True}
