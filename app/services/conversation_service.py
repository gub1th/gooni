from datetime import datetime, timezone, timedelta

from sqlalchemy.orm import Session

from ..db.models import Conversation, Message


SESSION_GAP_MINUTES = 10  # new session if last message was > 10 minutes ago


class ConversationService:

    # ── Session management ─────────────────────────────────────────────────────

    def find_or_create_session(self, source: str, db: Session) -> Conversation:
        """Reuse the active conversation for the given source if the last message
        was < SESSION_GAP_MINUTES ago. Otherwise start a new one."""
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
        goal_id: int | None = None,
        title: str | None = None,
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

    def get_messages(self, conversation_id: int, db: Session) -> list[Message]:
        return (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
            .all()
        )

    def get_recent_messages(
        self, conversation_id: int, limit: int, db: Session
    ) -> list[Message]:
        """Most recent N messages for LLM context window (returned oldest-first)."""
        rows = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
            .all()
        )
        return list(reversed(rows))


conversation_service = ConversationService()
