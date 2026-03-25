import json
import math
import re

from sqlalchemy.orm import Session

from ..db.models import Note, Space
from ..llm.client import llm_client


def _cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    if not vec1 or not vec2:
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    mag1 = math.sqrt(sum(a * a for a in vec1))
    mag2 = math.sqrt(sum(b * b for b in vec2))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    return dot / (mag1 * mag2)


class NoteService:
    @staticmethod
    def _strip_html(html: str) -> str:
        return re.sub(r"<[^>]+>", " ", html or "").strip()

    def update_embedding(self, note_id: int) -> None:
        """Background task: generate and store an embedding for a note.
        Opens its own DB session since it runs after the HTTP response is sent.
        """
        from ..db.database import SessionLocal

        db = SessionLocal()
        try:
            note = db.query(Note).filter(Note.id == note_id).first()
            if not note:
                return
            raw = f"{note.title or ''}\n{self._strip_html(note.content or '')}".strip()
            if not raw:
                return
            embedding, _ = llm_client.generate_embedding(raw)
            if embedding:
                note.embedding = json.dumps(embedding)
                db.commit()
        except Exception as e:
            print(f"Note embedding error: {e}")
        finally:
            db.close()

    def get_related(self, note_id: int, limit: int, db: Session) -> list[Note]:
        """Return notes most similar to the given note by cosine similarity."""
        note = db.query(Note).filter(Note.id == note_id).first()
        if not note or not note.embedding:
            return []
        query_vec = json.loads(note.embedding)
        candidates = (
            db.query(Note)
            .filter(Note.id != note_id, Note.embedding.isnot(None))
            .all()
        )
        scored = []
        for n in candidates:
            try:
                sim = _cosine_similarity(query_vec, json.loads(n.embedding))
                scored.append((n, sim))
            except Exception:
                pass
        scored.sort(key=lambda x: x[1], reverse=True)
        return [n for n, _ in scored[:limit]]

    def suggest_space(self, note_id: int, db: Session) -> dict:
        """Return best-matching space for a note based on embedding similarity.
        Only suggests when the note is in General (space_id is None).
        """
        note = db.query(Note).filter(Note.id == note_id).first()
        if not note or not note.embedding or note.space_id is not None:
            return {"suggested_space_id": None, "suggested_space_name": None, "suggested_space_emoji": None}

        note_vec = json.loads(note.embedding)
        spaces = db.query(Space).all()
        best_space = None
        best_sim = 0.60  # minimum threshold to suggest

        for space in spaces:
            space_notes = (
                db.query(Note)
                .filter(Note.space_id == space.id, Note.id != note_id, Note.embedding.isnot(None))
                .all()
            )
            if not space_notes:
                continue
            vecs = [json.loads(n.embedding) for n in space_notes]
            centroid = [sum(v[i] for v in vecs) / len(vecs) for i in range(len(vecs[0]))]
            sim = _cosine_similarity(note_vec, centroid)
            if sim > best_sim:
                best_sim = sim
                best_space = space

        if best_space:
            return {
                "suggested_space_id": best_space.id,
                "suggested_space_name": best_space.name,
                "suggested_space_emoji": best_space.emoji,
            }
        return {"suggested_space_id": None, "suggested_space_name": None, "suggested_space_emoji": None}

    def search_by_query(self, query: str, limit: int, db: Session) -> list[Note]:
        """Search notes by semantic similarity to a query string."""
        query_embedding, _ = llm_client.generate_embedding(query)
        if not query_embedding:
            return []
        candidates = db.query(Note).filter(Note.embedding.isnot(None)).all()
        scored = []
        for n in candidates:
            try:
                sim = _cosine_similarity(query_embedding, json.loads(n.embedding))
                scored.append((n, sim))
            except Exception:
                pass
        scored.sort(key=lambda x: x[1], reverse=True)
        return [n for n, _ in scored[:limit]]


note_service = NoteService()
