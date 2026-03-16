import json
import math
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from ..db.models import Memory, MemoryType
from ..llm.client import llm_client


class MemoryService:
    def upsert_memory(self, memory_data: Dict[str, Any], db: Session) -> Memory:
        """Upsert a FACT or PREFERENCE memory with key-based superseding."""
        key = memory_data["key"].lower().replace(" ", "_")
        content = memory_data["content"]
        confidence = memory_data.get("confidence", 0.8)
        goal_id = memory_data.get("goal_id")
        memory_type = (
            MemoryType.PREFERENCE
            if memory_data.get("type") == "preference"
            else MemoryType.FACT
        )

        embedding, _ = llm_client.generate_embedding(content)
        embedding_json = json.dumps(embedding)

        existing = (
            db.query(Memory)
            .filter(
                Memory.key == key,
                Memory.memory_type == memory_type,
                Memory.is_active == True,
            )
            .first()
        )

        if existing:
            if self._values_are_similar(
                existing.content, content, existing.embedding, embedding
            ):
                existing.confidence = min(1.0, (existing.confidence or 0.8) + 0.1)
                db.commit()
                return existing
            else:
                existing.is_active = False

        new_memory = Memory(
            memory_type=memory_type,
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

    def create_episode(
        self, content: str, goal_id: Optional[int], db: Session
    ) -> Memory:
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

    def process_content(self, content: str, db: Session) -> dict:
        """Extract and save both an episode and any facts from a piece of text.

        Use this for notes, imported messages, or any non-chat content.
        The chat path (orchestrator) does its own extraction inline for efficiency.

        Returns { "episode_saved": bool, "facts_saved": int }
        """
        result = {"episode_saved": False, "facts_saved": 0}
        content = content.strip()
        if len(content) <= 10:
            return result

        self.create_episode(content, None, db)
        result["episode_saved"] = True

        facts = llm_client.extract_facts(content)
        for fact in facts:
            self.upsert_memory(fact, db)
        result["facts_saved"] = len(facts)

        return result

    def search_similar(
        self,
        query: str,
        limit: int,
        db: Session,
        exclude_types: Optional[List[MemoryType]] = None,
    ) -> List[Memory]:
        """Search active memories by embedding similarity, optionally excluding types."""
        query_embedding, _ = llm_client.generate_embedding(query)
        if not query_embedding:
            return []

        q = db.query(Memory).filter(
            Memory.is_active == True,
            Memory.embedding.isnot(None),
        )
        if exclude_types:
            q = q.filter(Memory.memory_type.notin_(exclude_types))

        memories = q.all()

        similarities = []
        for m in memories:
            m_embedding = json.loads(m.embedding)
            sim = self._cosine_similarity(query_embedding, m_embedding)
            similarities.append((m, sim))

        similarities.sort(key=lambda x: x[1], reverse=True)
        return [m for m, _ in similarities[:limit]]

    def build_memory_context(self, query: str, db: Session) -> str:
        """Build context string for injection into the system prompt.

        - Preferences: always injected (small set, always relevant)
        - Facts + Episodes: top 5 by semantic similarity to the query
        """
        preferences = (
            db.query(Memory)
            .filter(
                Memory.memory_type == MemoryType.PREFERENCE,
                Memory.is_active == True,
            )
            .all()
        )

        # Search facts + episodes only (exclude preferences to avoid double-injection)
        relevant = self.search_similar(
            query, limit=5, db=db, exclude_types=[MemoryType.PREFERENCE]
        )
        facts = [m for m in relevant if m.memory_type == MemoryType.FACT]
        episodes = [m for m in relevant if m.memory_type == MemoryType.EPISODE]

        if not preferences and not facts and not episodes:
            return ""

        lines = []
        if preferences:
            lines.append("User preferences (always apply these):")
            for m in preferences:
                lines.append(f"- {m.content}")
        if facts:
            lines.append("Relevant facts:")
            for m in facts:
                lines.append(f"- {m.content}")
        if episodes:
            lines.append("Relevant past context:")
            for m in episodes:
                snippet = m.content[:200].replace("\n", " ")
                lines.append(f"- {snippet}")

        return "\n".join(lines)

    def get_name(self, db: Session) -> str | None:
        """Return the user's name if known, else None."""
        mem = (
            db.query(Memory)
            .filter(
                Memory.key == "name",
                Memory.memory_type == MemoryType.FACT,
                Memory.is_active == True,
            )
            .first()
        )
        return mem.content if mem else None

    def get_all_active(self, db: Session) -> List[Memory]:
        return (
            db.query(Memory)
            .filter(Memory.is_active == True)
            .order_by(Memory.created_at.desc())
            .all()
        )

    def _values_are_similar(
        self,
        content1: str,
        content2: str,
        embedding1: Optional[str],
        embedding2: List[float],
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
