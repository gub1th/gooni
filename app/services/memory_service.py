from sqlalchemy.orm import Session

from ..db.models import Memory
from ..db.schemas import MemoryCreate


class MemoryService:
    def create_memory(self, memory_input: MemoryCreate, db: Session) -> Memory:
        """Create a new memory and return it"""
        memory = Memory(**memory_input.model_dump())
        db.add(memory)
        db.commit()
        db.refresh(memory)
        return memory

    def get_memory(self, memory_id: int, db: Session) -> Memory:
        """Get a memory by ID"""
        return db.query(Memory).filter(Memory.id == memory_id).first()

    def get_all_memories(self, db: Session) -> list[Memory]:
        """Get all memories"""
        return db.query(Memory).order_by(Memory.timestamp.desc()).all()

    def search_similar(self, query: str, limit: int, db: Session) -> list[Memory]:
        """Search for similar memories"""
        # TODO: Implement vector search
        return []

    def extract_and_store(self, user_message: str, assistant_response: str, db: Session) -> None:
        """Extract important information from conversation and store as memory"""
        # TODO: Implement extraction logic
        pass

MemoryService = MemoryService()

