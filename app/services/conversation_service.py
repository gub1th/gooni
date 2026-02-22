from sqlalchemy.orm import Session

from ..db.models import Conversation, Interaction


class ConversationService:
    def create_conversation(self, db: Session) -> Conversation:
        """Create a new conversation and return it"""
        conversation = Conversation()
        db.add(conversation)
        db.commit()
        db.refresh(conversation)
        return conversation

    def get_conversation(self, conversation_id: int, db: Session) -> Conversation:
        """Get a conversation by ID"""
        return db.query(Conversation).filter(Conversation.id == conversation_id).first()

    def get_all_conversations(self, db: Session) -> list[Conversation]:
        """Get all conversations"""
        return db.query(Conversation).order_by(Conversation.updated_at.desc()).all()

    def get_conversation_interactions(
        self, conversation_id: int, db: Session, limit: int = 10
    ) -> list[Interaction]:
        """Get recent interactions for a conversation"""
        return (
            db.query(Interaction)
            .filter(Interaction.conversation_id == conversation_id)
            .order_by(Interaction.timestamp.desc())
            .limit(limit)
            .all()
        )


ConversationService = ConversationService()
