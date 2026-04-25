import json
import threading
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Focus, FocusActivity
from ..llm.client import llm_client
from .note_service import _cosine_similarity


# Below this length, a chat message is too short to carry meaningful
# focus signal — treating "ok" or "got it" as activity is noise.
MIN_MESSAGE_LEN_FOR_MATCH = 30


# Mirrors the similarity floor used for note→space matching. Below this,
# the match is too noisy to count as activity on a focus.
DEFAULT_MATCH_THRESHOLD = 0.62

# Status ordering for context injection — committed comes first because
# those are what Daniel said he's actively working on.
_STATUS_RANK = {"committed": 0, "pending": 1, "someday": 2, "done": 3}


class FocusService:
    @staticmethod
    def _embed_text(text: str) -> list[float] | None:
        if not text.strip():
            return None
        embedding, _ = llm_client.generate_embedding(text)
        return embedding or None

    def _refresh_embedding(self, focus: Focus) -> None:
        raw = f"{focus.name}\n{focus.endgoal}".strip()
        emb = self._embed_text(raw)
        if emb:
            focus.embedding = json.dumps(emb)

    def list_focuses(
        self, db: Session, statuses: list[str] | None = None
    ) -> list[Focus]:
        q = db.query(Focus)
        if statuses:
            q = q.filter(Focus.status.in_(statuses))
        focuses = q.all()
        focuses.sort(
            key=lambda f: (
                _STATUS_RANK.get(f.status, 99),
                -(f.last_activity_at.timestamp() if f.last_activity_at else 0),
            )
        )
        return focuses

    def get_focus(self, db: Session, focus_id: int) -> Focus | None:
        return db.query(Focus).filter(Focus.id == focus_id).first()

    def create_focus(
        self,
        db: Session,
        name: str,
        endgoal: str,
        due_date: datetime | None = None,
        status: str = "committed",
    ) -> Focus:
        focus = Focus(name=name, endgoal=endgoal, status=status, due_date=due_date)
        self._refresh_embedding(focus)
        db.add(focus)
        db.commit()
        db.refresh(focus)
        return focus

    def update_focus(self, db: Session, focus_id: int, **patch) -> Focus | None:
        focus = self.get_focus(db, focus_id)
        if not focus:
            return None
        text_changed = False
        for key in ("name", "endgoal", "status", "due_date"):
            if key in patch and patch[key] is not None:
                if key in ("name", "endgoal") and getattr(focus, key) != patch[key]:
                    text_changed = True
                setattr(focus, key, patch[key])
        if text_changed:
            self._refresh_embedding(focus)
        db.commit()
        db.refresh(focus)
        return focus

    def delete_focus(self, db: Session, focus_id: int) -> bool:
        focus = self.get_focus(db, focus_id)
        if not focus:
            return False
        # Cascade: drop activity rows so we don't orphan them
        db.query(FocusActivity).filter(FocusActivity.focus_id == focus_id).delete()
        db.delete(focus)
        db.commit()
        return True

    def mark_activity(
        self,
        db: Session,
        focus_id: int,
        source_type: str,
        source_id: int | None = None,
        similarity: float | None = None,
    ) -> FocusActivity | None:
        focus = self.get_focus(db, focus_id)
        if not focus:
            return None
        activity = FocusActivity(
            focus_id=focus_id,
            source_type=source_type,
            source_id=source_id,
            similarity=similarity,
        )
        db.add(activity)
        focus.last_activity_at = datetime.utcnow()
        db.commit()
        db.refresh(activity)
        return activity

    def match_vec_to_focuses(
        self,
        db: Session,
        vec: list[float],
        threshold: float = DEFAULT_MATCH_THRESHOLD,
    ) -> list[tuple[int, float]]:
        """Cosine-match a precomputed embedding vector against active focus
        embeddings. Cheaper than match_text_to_focuses when the caller
        already has a fresh embedding (e.g. note save).
        """
        if not vec:
            return []
        focuses = (
            db.query(Focus)
            .filter(
                Focus.status.in_(("committed", "pending", "someday")),
                Focus.embedding.isnot(None),
            )
            .all()
        )
        if not focuses:
            return []
        matches = []
        for f in focuses:
            try:
                sim = _cosine_similarity(vec, json.loads(f.embedding))
                if sim >= threshold:
                    matches.append((f.id, sim))
            except Exception:
                pass
        return matches

    def match_text_to_focuses(
        self,
        db: Session,
        text: str,
        threshold: float = DEFAULT_MATCH_THRESHOLD,
    ) -> list[tuple[int, float]]:
        """Return list of (focus_id, similarity) for active focuses whose
        cached embedding scores above threshold against the input text.
        """
        if not text or not text.strip():
            return []
        text_vec = self._embed_text(text)
        return self.match_vec_to_focuses(db, text_vec, threshold)

    def match_message_async(self, content: str, message_id: int) -> None:
        """Fire-and-forget activity match for a chat message. Opens its own
        DB session since the worker runs after the HTTP response is sent.
        Short messages are skipped (noise gate) — see MIN_MESSAGE_LEN_FOR_MATCH.
        """
        if not content or len(content.strip()) < MIN_MESSAGE_LEN_FOR_MATCH:
            return
        thread = threading.Thread(
            target=self._match_message_worker,
            args=(content, message_id),
            daemon=True,
        )
        thread.start()

    def _match_message_worker(self, content: str, message_id: int) -> None:
        from ..db.database import SessionLocal
        db = SessionLocal()
        try:
            for fid, sim in self.match_text_to_focuses(db, content):
                self.mark_activity(
                    db, fid,
                    source_type="message",
                    source_id=message_id,
                    similarity=sim,
                )
        except Exception as e:
            print(f"focus-activity match (message) failed: {e}")
        finally:
            db.close()

    def stale_focuses(self, db: Session, days: int = 5) -> list[Focus]:
        cutoff = datetime.utcnow() - timedelta(days=days)
        focuses = (
            db.query(Focus)
            .filter(Focus.status.in_(("committed", "pending")))
            .all()
        )
        stale = [
            f for f in focuses
            if f.last_activity_at is None or f.last_activity_at < cutoff
        ]
        stale.sort(
            key=lambda f: f.last_activity_at or datetime.min
        )
        return stale

    def get_focus_context(self, db: Session) -> str:
        """Return a human-readable block listing Daniel's active focuses for
        injection into the orchestrator system prompt. Limits to 5 with
        someday capped at 1 to avoid noise.
        """
        focuses = self.list_focuses(
            db, statuses=["committed", "pending", "someday"]
        )
        if not focuses:
            return ""

        someday_count = 0
        kept = []
        for f in focuses:
            if f.status == "someday":
                if someday_count >= 1:
                    continue
                someday_count += 1
            kept.append(f)
            if len(kept) >= 5:
                break

        lines = ["Daniel's active focuses:"]
        now = datetime.utcnow()
        for f in kept:
            parts = [f.status]
            if f.due_date:
                parts.append(f"due {f.due_date.strftime('%b %d')}")
            if f.last_activity_at:
                days_ago = (now - f.last_activity_at).days
                if days_ago == 0:
                    parts.append("touched today")
                else:
                    parts.append(f"last touched {days_ago}d ago")
            else:
                parts.append("no activity yet")
            meta = ", ".join(parts)
            lines.append(f"- {f.name} ({meta}): {f.endgoal}")
        return "\n".join(lines)


focus_service = FocusService()
