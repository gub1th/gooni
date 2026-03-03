import json
import re
from typing import Any, Dict

from ..llm.client import llm_client


class MemoryExtractionService:
    def extract(
        self, user_message: str, assistant_response: str, active_goals: list
    ) -> Dict[str, Any]:
        """
        Combined extraction returning {memories, note, new_goal}.
        active_goals: list of Goal objects with .id, .title, .goal_type
        """
        goals_list = "\n".join(
            f"- id:{g.id} [{g.goal_type.value.upper()}] {g.title}" for g in active_goals
        ) if active_goals else "(none)"

        from datetime import date
        today = date.today().isoformat()

        yesterday = (date.today() - __import__('datetime').timedelta(days=1)).isoformat()

        prompt = f"""Analyze this conversation and extract structured data.

Today's date: {today} (yesterday was {yesterday})

User: {user_message}
Assistant: {assistant_response}

Active goals:
{goals_list}

Return JSON with this exact structure:
{{
  "memories": [
    {{
      "memory_type": "profile_fact | episode",
      "key": "snake_case_key or null",
      "content": "descriptive text",
      "goal_id": null or <int>,
      "confidence": 0.0-1.0
    }}
  ],
  "note": {{
    "goal_id": <int> or null,
    "outcome": "success | failure | neutral",
    "content": "brief summary of what happened",
    "log_date": "YYYY-MM-DD"
  }} | null,
  "new_goal": {{
    "title": "concise goal title",
    "goal_type": "achieve | avoid",
    "motivation": "string or null"
  }} | null
}}

Rules for memories:
- episode: create one for almost every meaningful exchange — a log of what was discussed. No key needed. Both types can appear together.
- profile_fact: only when stable, persistent info about the user is revealed (name, preference, constraint, habit). Requires a key. confidence 0.8+ explicit, 0.6+ inferred.
- goal_id: set if memory is specifically about one of the listed goals, otherwise null.
- Return [] only if the message is trivial (e.g. pure greeting, no content).

Rules for note:
- Create a note if the user reported doing or not doing something related to an active goal OR a new_goal being created in this same response.
- outcome: success = made progress or did the thing, failure = failed or relapsed/consumed something they're avoiding, neutral = update without clear pass/fail.
- log_date: absolute ISO date. Today={today}, yesterday={yesterday}. If user said "yesterday", use {yesterday}. If they said "today" or nothing specific, use {today}.
- goal_id: reference an active goal id if applicable. Use null if the note is for a new_goal (the system will link them automatically).
- Return null if no activity was reported.

Rules for new_goal:
- Create only if the user expressed clear intent to track, achieve, or avoid something not already in the active goals list.
- goal_type: "avoid" if they want to stop, quit, cut back, or resist something. "achieve" if they want to do, build, or reach something.
- Return null if the intent maps to an existing goal or no goal intent was expressed.

Extract:"""

        try:
            response, _ = llm_client.generate_chat_response(prompt)
            clean = response.strip()
            clean = re.sub(r"^```(?:json)?\s*", "", clean)
            clean = re.sub(r"\s*```$", "", clean).strip()
            data = json.loads(clean)

            memories = [m for m in data.get("memories", []) if self._validate_memory(m)]
            note = data.get("note")
            if note and not self._validate_note(note):
                note = None
            new_goal = data.get("new_goal")
            if new_goal and not self._validate_new_goal(new_goal):
                new_goal = None

            return {"memories": memories, "note": note, "new_goal": new_goal}

        except Exception as e:
            print(f"[extraction] error: {e}")
            return {"memories": [], "note": None, "new_goal": None}

    def _validate_memory(self, m: dict) -> bool:
        if m.get("memory_type") not in ("profile_fact", "episode"):
            return False
        if not m.get("content"):
            return False
        confidence = m.get("confidence", 0)
        if not isinstance(confidence, (int, float)) or not (0.0 <= confidence <= 1.0):
            return False
        return True

    def _validate_note(self, n: dict) -> bool:
        if not n.get("outcome") or not n.get("content"):
            return False
        if n["outcome"] not in ("success", "failure", "neutral"):
            return False
        return True

    def _validate_new_goal(self, g: dict) -> bool:
        if not g.get("title"):
            return False
        if g.get("goal_type") not in ("achieve", "avoid"):
            return False
        return True


memory_extraction_service = MemoryExtractionService()
