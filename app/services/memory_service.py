import json
import math

from sqlalchemy.orm import Session

from ..db.models import Memory
from ..db.schemas import MemoryCreate
from ..llm.client import llm_client


class MemoryService:
    def create_memory(self, memory_input: MemoryCreate, db: Session) -> Memory:
        """Create a new memory and return it"""
        # Generate embedding for content
        embedding, _ = llm_client.generate_embedding(memory_input.content)

        memory = Memory(
            content=memory_input.content,
            embedding=json.dumps(embedding),
            extra=memory_input.extra,
        )
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
        """Search for similar memories using vector similarity"""
        # Generate embedding for query
        query_embedding, _ = llm_client.generate_embedding(query)

        if not query_embedding:
            return []

        # Get all memories with embeddings
        memories_with_embeddings = (
            db.query(Memory).filter(Memory.embedding.isnot(None)).all()
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

    def extract_and_store(
        self, user_message: str, assistant_response: str, db: Session
    ) -> None:
        """Extract important information from conversation and store as memory"""
        # Simple rule-based extraction for Phase 1
        important_keywords = [
            "remember",
            "important",
            "note that",
            "my goal",
            "prefer",
            "like",
        ]

        combined_text = f"{user_message} {assistant_response}"

        if any(keyword in combined_text.lower() for keyword in important_keywords):
            # Extract the important part
            for keyword in important_keywords:
                if keyword in combined_text.lower():
                    start_idx = combined_text.lower().find(keyword)
                    if start_idx != -1:
                        # Extract surrounding context
                        start = max(0, start_idx - 10)
                        end = min(len(combined_text), start_idx + 100)
                        important_text = combined_text[start:end].strip()

                        if len(important_text) > 20:  # Only store substantial content
                            memory_data = MemoryCreate(
                                content=important_text,
                                extra=json.dumps(
                                    {"source": "conversation_extraction"}
                                ),
                            )
                            self.create_memory(memory_data, db)
                        break

MemoryService = MemoryService()
