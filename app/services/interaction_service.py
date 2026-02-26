from sqlalchemy.orm import Session

from ..db.models import Interaction
from ..db.schemas import InteractionCreate


class InteractionService:
    def create_interaction(self, interaction_input: InteractionCreate, db: Session) -> Interaction:
        """Create a new interaction and return it"""
        interaction = Interaction(**interaction_input.model_dump())
        db.add(interaction)
        db.commit()
        db.refresh(interaction)
        return interaction

    def get_interaction(self, interaction_id: int, db: Session) -> Interaction:
        """Get an interaction by ID"""
        return db.query(Interaction).filter(Interaction.id == interaction_id).first()

    def get_recent(self, db: Session, limit: int = 6) -> list[Interaction]:
        """Get the most recent interactions in chronological order"""
        results = db.query(Interaction).order_by(Interaction.timestamp.desc()).limit(limit).all()
        return list(reversed(results))

    def get_all_interactions(self, db: Session) -> list[Interaction]:
        """Get all interactions"""
        return db.query(Interaction).order_by(Interaction.timestamp.desc()).all()


InteractionService = InteractionService()