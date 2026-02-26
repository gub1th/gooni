import json
import math
from typing import List, Dict, Any, Optional

from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from ..db.models import UserProfileMemory, MemoryType
from ..llm.client import llm_client


class ProfileMemoryService:
    def upsert_memory(self, memory_data: Dict[str, Any], db: Session) -> UserProfileMemory:
        """
        Upsert a profile memory with versioning support.
        If same key exists, handle based on value similarity.
        """
        key = memory_data["key"].lower().replace(" ", "_")
        memory_type = MemoryType(memory_data["memory_type"])
        value = memory_data["value"]
        context = json.dumps(memory_data["context"])
        confidence = memory_data["confidence"]

        # Generate embedding for semantic comparison
        embedding, _ = llm_client.generate_embedding(value)
        embedding_json = json.dumps(embedding)

        # Look for existing active memory with same key
        existing = db.query(UserProfileMemory).filter(
            UserProfileMemory.key == key,
            UserProfileMemory.is_active
        ).first()

        if existing:
            # Check if values are similar (semantic comparison)
            if self._values_are_similar(existing.value, value, existing.embedding, embedding):
                # Same value - increase confidence
                existing.confidence = min(1.0, existing.confidence + 0.1)
                existing.updated_at = func.now()
                db.commit()
                return existing
            else:
                # Different value - supersede old memory
                existing.is_active = False

        # Create new memory
        new_memory = UserProfileMemory(
            memory_type=memory_type,
            key=key,
            value=value,
            context=context,
            confidence=confidence,
            embedding=embedding_json,
            is_active=True,
            superseded_by=None
        )

        if existing:
            existing.superseded_by = new_memory.id

        db.add(new_memory)
        db.commit()
        db.refresh(new_memory)

        if existing:
            existing.superseded_by = new_memory.id
            db.commit()

        return new_memory

    def get_all_active(self, db: Session) -> List[UserProfileMemory]:
        """Get all active profile memories"""
        return db.query(UserProfileMemory).filter(
            UserProfileMemory.is_active
        ).order_by(UserProfileMemory.memory_type).all()

    def get_global_memories(self, db: Session) -> List[UserProfileMemory]:
        """Get all global scope active memories"""
        memories = db.query(UserProfileMemory).filter(
            UserProfileMemory.is_active,
            UserProfileMemory.context.contains('"scope": "global"')
        ).all()
        return memories

    def search_contextual_memories(self, query: str, limit: int, db: Session,
                                 confidence_threshold: float = 0.7) -> List[UserProfileMemory]:
        """Search for contextual memories using semantic similarity"""
        query_embedding, _ = llm_client.generate_embedding(query)

        if not query_embedding:
            return []

        # Get all contextual active memories
        memories = db.query(UserProfileMemory).filter(
            UserProfileMemory.is_active,
            UserProfileMemory.confidence >= confidence_threshold,
            UserProfileMemory.context.contains('"scope": "contextual"')
        ).all()

        # Calculate similarities
        similarities = []
        for memory in memories:
            if memory.embedding:
                memory_embedding = json.loads(memory.embedding)
                similarity = self._cosine_similarity(query_embedding, memory_embedding)
                similarities.append((memory, similarity))

        # Sort by similarity and return top N
        similarities.sort(key=lambda x: x[1], reverse=True)
        return [memory for memory, _ in similarities[:limit]]

    def build_profile_context(self, query: str, db: Session) -> str:
        """Build natural language profile context for prompt injection"""
        # Get global memories
        global_memories = self.get_global_memories(db)

        # Get relevant contextual memories
        contextual_memories = self.search_contextual_memories(query, 3, db)

        if not global_memories and not contextual_memories:
            return "No user profile information available."

        context_parts = ["Known user profile:"]

        # Add global memories
        for memory in global_memories:
            context_parts.append(f"- {memory.memory_type.value.title()}: {memory.value}")

        # Add contextual memories
        if contextual_memories:
            context_parts.append("Relevant context:")
            for memory in contextual_memories:
                context_parts.append(f"- {memory.memory_type.value.title()}: {memory.value}")

        return "\n".join(context_parts)

    def _values_are_similar(self, value1: str, value2: str, embedding1: Optional[str], embedding2: List[float]) -> bool:
        """Check if two memory values are semantically similar"""
        if value1.lower().strip() == value2.lower().strip():
            return True

        if not embedding1:
            return False

        try:
            emb1 = json.loads(embedding1)
            similarity = self._cosine_similarity(emb1, embedding2)
            return similarity > 0.85  # High similarity threshold
        except Exception:
            return False

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """Calculate cosine similarity between two vectors"""
        if not vec1 or not vec2:
            return 0.0

        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        magnitude1 = math.sqrt(sum(a * a for a in vec1))
        magnitude2 = math.sqrt(sum(b * b for b in vec2))

        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0

        return dot_product / (magnitude1 * magnitude2)


# Global instance
profile_memory_service = ProfileMemoryService()