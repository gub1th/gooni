import json
import math
from typing import Dict, Any, List, Optional

from sqlalchemy.orm import Session

from ..db.models import Memory, MemoryType
from ..llm.client import llm_client


class MemoryService:
    def upsert_profile_fact(self, memory_data: Dict[str, Any], db: Session) -> Memory:
        """Upsert a PROFILE_FACT memory with key-based superseding."""
        key = memory_data["key"].lower().replace(" ", "_")
        content = memory_data["content"]
        confidence = memory_data.get("confidence", 0.8)
        goal_id = memory_data.get("goal_id")

        embedding, _ = llm_client.generate_embedding(content)
        embedding_json = json.dumps(embedding)

        existing = db.query(Memory).filter(
            Memory.key == key,
            Memory.memory_type == MemoryType.PROFILE_FACT,
            Memory.is_active == True,
        ).first()

        if existing:
            if self._values_are_similar(existing.content, content, existing.embedding, embedding):
                existing.confidence = min(1.0, (existing.confidence or 0.8) + 0.1)
                db.commit()
                return existing
            else:
                existing.is_active = False

        new_memory = Memory(
            memory_type=MemoryType.PROFILE_FACT,
            key=key,
            content=content,
            goal_id=goal_id,
            embedding=embedding_json,
            confidence=confidence,
            is_active=True,
        )
        db.add(new_memory)
        db.commit()
        db.refresh(new_memory)

        if existing:
            existing.superseded_by = new_memory.id
            db.commit()

        return new_memory

    def create_episode(self, content: str, goal_id: Optional[int], db: Session) -> Memory:
        """Create an EPISODE memory from a conversation."""
        embedding, _ = llm_client.generate_embedding(content)
        memory = Memory(
            memory_type=MemoryType.EPISODE,
            content=content,
            goal_id=goal_id,
            embedding=json.dumps(embedding),
            is_active=True,
        )
        db.add(memory)
        db.commit()
        db.refresh(memory)
        return memory

    def search_similar(self, query: str, limit: int, db: Session) -> List[Memory]:
        """Search all active memories by embedding similarity."""
        query_embedding, _ = llm_client.generate_embedding(query)
        if not query_embedding:
            return []

        memories = db.query(Memory).filter(
            Memory.is_active == True,
            Memory.embedding.isnot(None),
        ).all()

        similarities = []
        for m in memories:
            m_embedding = json.loads(m.embedding)
            sim = self._cosine_similarity(query_embedding, m_embedding)
            similarities.append((m, sim))

        similarities.sort(key=lambda x: x[1], reverse=True)
        return [m for m, _ in similarities[:limit]]

    def build_memory_context(self, query: str, db: Session) -> str:
        """Build context string from profile facts + relevant episodes."""
        profile_facts = db.query(Memory).filter(
            Memory.memory_type == MemoryType.PROFILE_FACT,
            Memory.is_active == True,
        ).all()

        relevant = self.search_similar(query, 3, db)
        episodes = [m for m in relevant if m.memory_type == MemoryType.EPISODE]

        if not profile_facts and not episodes:
            return ""

        lines = []
        if profile_facts:
            lines.append("Known about you:")
            for m in profile_facts:
                lines.append(f"- {m.content}")
        if episodes:
            lines.append("Relevant past context:")
            for m in episodes:
                snippet = m.content[:200].replace("\n", " ")
                lines.append(f"- {snippet}")

        return "\n".join(lines)

    def get_name(self, db: Session) -> str | None:
        """Return the user's name if known, else None."""
        mem = db.query(Memory).filter(
            Memory.key == "name",
            Memory.memory_type == MemoryType.PROFILE_FACT,
            Memory.is_active == True,
        ).first()
        return mem.content if mem else None

    def get_all_active(self, db: Session) -> List[Memory]:
        return (
            db.query(Memory)
            .filter(Memory.is_active == True)
            .order_by(Memory.created_at.desc())
            .all()
        )

    def _values_are_similar(
        self, content1: str, content2: str, embedding1: Optional[str], embedding2: List[float]
    ) -> bool:
        if content1.lower().strip() == content2.lower().strip():
            return True
        if not embedding1:
            return False
        try:
            emb1 = json.loads(embedding1)
            return self._cosine_similarity(emb1, embedding2) > 0.85
        except Exception:
            return False

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        if not vec1 or not vec2:
            return 0.0
        dot = sum(a * b for a, b in zip(vec1, vec2))
        mag1 = math.sqrt(sum(a * a for a in vec1))
        mag2 = math.sqrt(sum(b * b for b in vec2))
        if mag1 == 0 or mag2 == 0:
            return 0.0
        return dot / (mag1 * mag2)


memory_service = MemoryService()
