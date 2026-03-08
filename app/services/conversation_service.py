from datetime import datetime, timezone, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session

from ..db.models import Conversation, Message


SESSION_GAP_MINUTES = 10  # new session if last message was > 10 minutes ago


class ConversationService:

    # ── Session management ─────────────────────────────────────────────────────

    def find_or_create_session(self, source: str, db: Session) -> Conversation:
        """Reuse the active conversation for the given source if the last message
        was < SESSION_GAP_MINUTES ago. Otherwise start a new one.
        Works for both 'telegram' and 'web' sources."""
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=SESSION_GAP_MINUTES)

        existing = (
            db.query(Conversation)
            .filter(
                Conversation.source == source,
                Conversation.last_message_at >= cutoff,
            )
            .order_by(Conversation.last_message_at.desc())
            .first()
        )
        if existing:
            return existing
        return self.create(goal_id=None, source=source, db=db)

    def create(
        self,
        db: Session,
        source: str = "web",
        goal_id: Optional[int] = None,
        title: Optional[str] = None,
    ) -> Conversation:
        conv = Conversation(goal_id=goal_id, source=source, title=title)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        return conv

    # ── Messages ───────────────────────────────────────────────────────────────

    def add_message(
        self, conversation_id: int, role: str, content: str, db: Session
    ) -> Message:
        msg = Message(conversation_id=conversation_id, role=role, content=content)
        db.add(msg)
        db.commit()
        # Update last_message_at on the conversation
        conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        if conv:
            conv.last_message_at = datetime.now(timezone.utc)
            db.commit()
        db.refresh(msg)
        return msg

    def get_messages(self, conversation_id: int, db: Session) -> List[Message]:
        return (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
            .all()
        )

    def get_recent_messages(
        self, conversation_id: int, limit: int, db: Session
    ) -> List[Message]:
        """Most recent N messages for LLM context window (returned oldest-first)."""
        rows = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
            .all()
        )
        return list(reversed(rows))

    def get_recent_conversations(
        self, db: Session, goal_id: Optional[int] = None, limit: int = 20
    ) -> List[Conversation]:
        q = db.query(Conversation)
        if goal_id is not None:
            q = q.filter(Conversation.goal_id == goal_id)
        else:
            q = q.filter(Conversation.goal_id.is_(None))
        return q.order_by(Conversation.created_at.desc()).limit(limit).all()


conversation_service = ConversationService()
