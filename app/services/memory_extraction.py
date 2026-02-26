import json
import re
from typing import List, Dict, Any

from ..llm.client import llm_client


class MemoryExtractionService:
    def extract_profile_memories(self, user_message: str, assistant_response: str) -> List[Dict[str, Any]]:
        """
        Extract structured user profile updates from conversation.
        Returns list of memory objects following the schema.
        """
        extraction_prompt = f"""Extract structured user profile updates from this conversation.

User: {user_message}
Assistant: {assistant_response}

Extract only persistent, stable information about the user. Return JSON array with this exact schema:

[
  {{
    "memory_type": "preference | goal | fact | routine | constraint",
    "key": "snake_case_key",
    "value": "descriptive value",
    "context": {{
      "time": "string | null",
      "location": "string | null",
      "situation": "string | null",
      "scope": "global | contextual"
    }},
    "confidence": 0.0-1.0
  }}
]

Rules:
- Only extract persistent traits, NOT temporary states
- Use snake_case for keys (e.g., "coffee_temperature_preference")
- scope "global" = always applies, "contextual" = situation-specific
- confidence 0.8+ for explicit statements, 0.6-0.7 for inferences
- Return [] if no extractable memories

Examples:
- "I prefer hot coffee" → preference, coffee_temperature, hot, global, 0.9
- "I work from home on Tuesdays" → routine, tuesday_work_location, home, contextual, 0.8
- "My goal is to build an AI assistant" → goal, primary_project, ai_assistant, global, 0.9

Extract memories:"""

        try:
            response, _ = llm_client.generate_chat_response(extraction_prompt)

            # Strip markdown code fences if present
            clean = response.strip()
            clean = re.sub(r'^```(?:json)?\s*', '', clean)
            clean = re.sub(r'\s*```$', '', clean).strip()

            memories = json.loads(clean)

            # Validate structure
            if not isinstance(memories, list):
                return []

            validated_memories = []
            for memory in memories:
                if self._validate_memory_structure(memory):
                    validated_memories.append(memory)

            return validated_memories

        except (json.JSONDecodeError, Exception) as e:
            print(f"Memory extraction error: {e}")
            return []

    def _validate_memory_structure(self, memory: Dict[str, Any]) -> bool:
        """Validate memory object has required fields and valid values"""
        required_fields = ["memory_type", "key", "value", "context", "confidence"]

        if not all(field in memory for field in required_fields):
            return False

        valid_types = ["preference", "goal", "fact", "routine", "constraint"]
        if memory["memory_type"] not in valid_types:
            return False

        if not isinstance(memory["confidence"], (int, float)) or not (0.0 <= memory["confidence"] <= 1.0):
            return False

        context = memory["context"]
        if not isinstance(context, dict) or "scope" not in context:
            return False

        if context["scope"] not in ["global", "contextual"]:
            return False

        return True


# Global instance
memory_extraction_service = MemoryExtractionService()