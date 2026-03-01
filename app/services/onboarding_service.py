import json
import re

from sqlalchemy.orm import Session

from ..db.models import MemoryType, OnboardingState
from ..llm.client import llm_client
from .goal_service import goal_service
from .interaction_service import InteractionService
from .profile_memory_service import profile_memory_service


ONBOARDING_SYSTEM = """You are Gooni, an AI accountability partner. This is your first time meeting this user.

Your goal is to learn six things through natural conversation before you start coaching:
1. Their name
2. Their main goal for the next 3 months (specific and concrete)
3. What's been blocking them from reaching it
4. Why they actually want it — the real underlying motivation
5. How often they want you to check in: daily, every other day, or weekly
6. What time of day works for check-ins (e.g. 9am, 8pm)

How to do this:
- Be warm, direct, and real — like a great coach who also happens to be a friend
- Ask one thing at a time. Don't fire multiple questions at once
- React genuinely to their answers before moving on
- Keep it conversational, not clinical

When you have all six pieces of information, wrap up the conversation naturally — then end your response with [READY] on its own line. Do not add [READY] until you genuinely have all six."""

EXTRACTION_SYSTEM = """Extract structured data from this onboarding conversation. Return only valid JSON, nothing else.

{
  "name": "string or null",
  "goal": "string or null",
  "blocker": "string or null",
  "motivation": "string or null",
  "checkin_frequency": "one of: daily, every other day, weekly — or null",
  "checkin_time": "time string like 9am or 8:30pm — or null"
}"""

REQUIRED_FIELDS = ["name", "goal", "blocker", "motivation", "checkin_frequency", "checkin_time"]
MAX_TURNS = 14  # fallback extraction if LLM never signals [READY]


class OnboardingService:
    def get_or_create_state(self, db: Session) -> OnboardingState:
        state = db.query(OnboardingState).first()
        if not state:
            state = OnboardingState(is_complete=False, current_step=0)
            db.add(state)
            db.commit()
            db.refresh(state)
        return state

    def is_complete(self, db: Session) -> bool:
        state = db.query(OnboardingState).first()
        return state is not None and state.is_complete

    def handle_step(self, message: str, db: Session) -> str:
        state = self.get_or_create_state(db)
        if state.is_complete:
            return None

        # Previous turns from DB (oldest first), not including current message
        history = InteractionService.get_recent(db, limit=MAX_TURNS)

        messages = [{"role": "system", "content": ONBOARDING_SYSTEM}]
        for turn in history:
            messages.append({"role": turn.role, "content": turn.content})
        messages.append({"role": "user", "content": message})

        raw = llm_client.chat_raw(messages)
        ready = "[READY]" in raw
        response = raw.replace("[READY]", "").strip()

        # Fallback: force extraction after too many turns even if LLM forgot to signal
        user_turn_count = sum(1 for m in messages if m["role"] == "user")
        if not ready and user_turn_count >= MAX_TURNS:
            ready = True

        if ready:
            # Include the current exchange in the extraction context
            full_messages = messages + [{"role": "assistant", "content": response}]
            fields = self._extract_fields(full_messages)
            if self._has_required_fields(fields):
                self._complete(state, fields, db)

        return response

    def _extract_fields(self, messages: list[dict]) -> dict:
        transcript = "\n".join(
            f"{m['role'].upper()}: {m['content']}"
            for m in messages
            if m["role"] in ("user", "assistant")
        )
        try:
            raw = llm_client.chat_raw(
                [
                    {"role": "system", "content": EXTRACTION_SYSTEM},
                    {"role": "user", "content": transcript},
                ],
                temperature=0,
                max_tokens=200,
            )
            clean = re.sub(r"^```(?:json)?\s*", "", raw.strip())
            clean = re.sub(r"\s*```$", "", clean).strip()
            return json.loads(clean)
        except Exception as e:
            print(f"[onboarding] Extraction error: {e}")
            return {}

    def _has_required_fields(self, fields: dict) -> bool:
        return all(fields.get(f) for f in REQUIRED_FIELDS)

    def _complete(self, state: OnboardingState, fields: dict, db: Session) -> None:
        # Name → profile memory
        if fields.get("name"):
            profile_memory_service.upsert_memory(
                {
                    "key": "name",
                    "memory_type": MemoryType.FACT.value,
                    "value": fields["name"],
                    "context": {"source": "onboarding", "scope": "global"},
                    "confidence": 1.0,
                },
                db,
            )

        # Goal + blocker + motivation → Goal table
        if fields.get("goal"):
            goal_service.create(fields["goal"], db)
            if fields.get("blocker"):
                goal_service.update_latest(db, blocker=fields["blocker"])
            if fields.get("motivation"):
                goal_service.update_latest(db, motivation=fields["motivation"])

        # Check-in prefs → profile memory + OnboardingState (for scheduler)
        for key, mtype in [
            ("checkin_frequency", MemoryType.PREFERENCE),
            ("checkin_time", MemoryType.PREFERENCE),
        ]:
            val = fields.get(key)
            if val:
                profile_memory_service.upsert_memory(
                    {
                        "key": key,
                        "memory_type": mtype.value,
                        "value": val,
                        "context": {"source": "onboarding", "scope": "global"},
                        "confidence": 1.0,
                    },
                    db,
                )

        state.is_complete = True
        state.checkin_frequency = fields.get("checkin_frequency")
        state.checkin_time = fields.get("checkin_time")
        db.commit()


onboarding_service = OnboardingService()
