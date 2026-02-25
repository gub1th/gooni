import os
from typing import List

from openai import OpenAI

from ..db.models import Memory
from .pricing import calculate_chat_cost, calculate_embedding_cost
from .prompts import build_chat_system_prompt


class LLMClient:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.chat_model = "gpt-4o-mini"  # Cost-effective for Phase 1
        self.embedding_model = "text-embedding-3-small"

    def generate_embedding(self, text: str) -> tuple[List[float], dict]:
        """Generate embedding for text"""
        try:
            response = self.client.embeddings.create(
                model=self.embedding_model, input=text
            )
            cost = calculate_embedding_cost(self.embedding_model, response.usage.total_tokens)
            usage = {
                "embedding_tokens": response.usage.total_tokens,
                "embedding_cost": cost
            }
            return response.data[0].embedding, usage
        except Exception as e:
            print(f"Embedding Error: {e}")
            return [], {"embedding_tokens": 0, "embedding_cost": 0}

    def generate_chat_response(
        self, message: str, relevant_memories: List[Memory]
    ) -> tuple[str, dict]:
        """Generate response with memory context"""

        # Build context from memories
        memory_context = self._build_memory_context(relevant_memories)

        # Create prompt with memory
        system_prompt = build_chat_system_prompt(memory_context)

        try:
            response = self.client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": message},
                ],
                temperature=0.7,
                max_tokens=500,
            )

            # Calculate cost using pricing module
            costs = calculate_chat_cost(
                self.chat_model,
                response.usage.prompt_tokens,
                response.usage.completion_tokens
            )

            usage = {
                "input_tokens": response.usage.prompt_tokens,
                "output_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
                "input_cost": costs["input_cost"],
                "output_cost": costs["output_cost"],
                "total_cost": costs["total_cost"]
            }

            return response.choices[0].message.content, usage

        except Exception as e:
            print(f"LLM Error: {e}")
            return "I'm having trouble generating a response right now.", {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "total_cost": 0}

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
