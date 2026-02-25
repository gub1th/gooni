import os
from typing import List

from openai import OpenAI

from ..db.models import Memory
from .prompts import build_chat_system_prompt


class LLMClient:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = "gpt-4o-mini"  # Cost-effective for Phase 1

    def generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text"""
        try:
            response = self.client.embeddings.create(
                model="text-embedding-3-small", input=text
            )
            return response.data[0].embedding
        except Exception as e:
            print(f"Embedding Error: {e}")
            return []

    def generate_chat_response(
        self, message: str, relevant_memories: List[Memory]
    ) -> str:
        """Generate response with memory context"""

        # Build context from memories
        memory_context = self._build_memory_context(relevant_memories)

        # Create prompt with memory
        system_prompt = build_chat_system_prompt(memory_context)

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": message},
                ],
                temperature=0.7,
                max_tokens=500,
            )
            return response.choices[0].message.content

        except Exception as e:
            print(f"LLM Error: {e}")
            return "I'm having trouble generating a response right now."

    def _build_memory_context(self, memories: List[Memory]) -> str:
        """Build formatted context from memories"""
        if not memories:
            return "No relevant memories found."

        context_parts = []
        for memory in memories:
            context_parts.append(f"- {memory.content}")

        return "\n".join(context_parts)


# Global instance for easy import
llm_client = LLMClient()
