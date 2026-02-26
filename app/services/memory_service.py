import json
import math

from sqlalchemy.orm import Session

from ..db.models import EpisodicMemory
from ..db.schemas import MemoryCreate
from ..llm.client import llm_client


class EpisodicMemoryService:
    def create_memory(self, memory_input: MemoryCreate, db: Session) -> EpisodicMemory:
        """Create a new memory and return it"""
        # Generate embedding for content
        embedding, _ = llm_client.generate_embedding(memory_input.content)

        memory = EpisodicMemory(
            content=memory_input.content,
            embedding=json.dumps(embedding),
            extra=memory_input.extra,
        )
        db.add(memory)
        db.commit()
        db.refresh(memory)
        return memory

    def get_memory(self, memory_id: int, db: Session) -> EpisodicMemory:
        """Get a memory by ID"""
        return db.query(EpisodicMemory).filter(EpisodicMemory.id == memory_id).first()

    def get_all_memories(self, db: Session) -> list[EpisodicMemory]:
        """Get all memories"""
        return db.query(EpisodicMemory).order_by(EpisodicMemory.timestamp.desc()).all()

    def search_similar(self, query: str, limit: int, db: Session) -> list[EpisodicMemory]:
        """Search for similar memories using vector similarity"""
        # Generate embedding for query
        query_embedding, _ = llm_client.generate_embedding(query)

        if not query_embedding:
            return []

        # Get all memories with embeddings
        memories_with_embeddings = (
            db.query(EpisodicMemory).filter(EpisodicMemory.embedding.isnot(None)).all()
        )

        # Calculate similarities
        similarities = []
        for memory in memories_with_embeddings:
            memory_embedding = json.loads(memory.embedding)
            similarity = self._cosine_similarity(query_embedding, memory_embedding)
            similarities.append((memory, similarity))

        # Sort by similarity and return top N
        similarities.sort(key=lambda x: x[1], reverse=True)
        return [memory for memory, _ in similarities[:limit]]

    def build_episodic_context(self, memories: list[EpisodicMemory]) -> str:
        """Build formatted episodic context string for prompt injection"""
        if not memories:
            return "No relevant past conversations."
        return "\n".join(f"- {memory.content}" for memory in memories)

    def _cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        """Calculate cosine similarity between two vectors"""
        if not vec1 or not vec2:
            return 0.0

        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        magnitude1 = math.sqrt(sum(a * a for a in vec1))
        magnitude2 = math.sqrt(sum(b * b for b in vec2))

        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0

        return dot_product / (magnitude1 * magnitude2)

episodic_memory_service = EpisodicMemoryService()
