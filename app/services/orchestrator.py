from ..db.models import Conversation as ConvModel, GoalType
from ..llm.client import llm_client
from .goal_service import goal_service
from .conversation_service import conversation_service
from .memory_service import memory_service


class Orchestrator:
    def handle_chat(
        self,
        message: str,
        db,
        image_url: str = None,
        conversation_id: int = None,
        source: str = "telegram",
        entry_content: str = "",
    ) -> tuple[str, dict | None]:
        """Unified chat handler for all sources.

        - conversation_id=None  → find/create session by source + gap logic
        - conversation_id=<id>  → use that conversation directly (note threads)
        - source                → 'telegram' | 'web' (determines session bucket)
        - entry_content         → original note text injected as context (web only)
        """
        stripped = message.strip()
        command = stripped.lower()

        # Slash commands only apply for Telegram
        if source == "telegram":
            if command == "/memory":
                return self._handle_memory_command(db), None
            if command == "/goals":
                return self._handle_goals_command(db), None
            if command.startswith("/goal "):
                name = stripped[6:].strip()
                return self._handle_goal_detail_command(name, db), None

        # First-time greeting only for Telegram
        is_first_time = source == "telegram" and not memory_service.get_name(db)

        # Session management
        if conversation_id is not None:
            conv = db.query(ConvModel).filter(ConvModel.id == conversation_id).first()
            if conv is None:
                raise ValueError(f"Conversation {conversation_id} not found")
        else:
            conv = conversation_service.find_or_create_session(source, db)

        conversation_service.add_message(conv.id, "user", message, db)

        # Build recent history from this conversation
        recent_messages = conversation_service.get_recent_messages(conv.id, limit=10, db=db)
        recent_history = [{"role": m.role, "content": m.content} for m in recent_messages]

        query = message if message.strip() else "image"
        memory_context = memory_service.build_memory_context(query, db)
        goal_context = goal_service.build_goal_context(db)
        entry_context = (
            f"Note the user wrote:\n\"\"\"{entry_content}\"\"\""
            if entry_content.strip() else ""
        )
        full_context = "\n\n".join(filter(None, [memory_context, goal_context, entry_context]))

        if image_url:
            response, usage = llm_client.generate_response_with_image(
                message, image_url, full_context, "", recent_history, db=db
            )
        else:
            response, usage = llm_client.generate_chat_response_with_memory(
                message, full_context, "", recent_history,
                is_first_time=is_first_time, db=db,
            )

        conversation_service.add_message(conv.id, "assistant", response, db)

        # Save any profile facts the LLM extracted
        for fact in usage.pop("profile_facts", []):
            memory_service.upsert_profile_fact(fact, db)

        # Auto-save episode for future context retrieval
        if message.strip() and len(message.strip()) > 10:
            memory_service.create_episode(
                f"User: {message}\nAssistant: {response}",
                goal_id=getattr(conv, "goal_id", None),
                db=db,
            )

        usage["memory"] = {"episode_saved": True}

        return response, usage

    def _handle_memory_command(self, db) -> str:
        memories = memory_service.get_all_active(db)
        if not memories:
            return "No memories yet."
        lines = [f"Memory ({len(memories)} entries):"]
        for m in memories:
            key_part = f"{m.key}: " if m.key else ""
            lines.append(f"  [{m.memory_type.value}] {key_part}{m.content[:120]}")
        return "\n".join(lines)

    def _handle_goals_command(self, db) -> str:
        goals = goal_service.get_active(db)
        if not goals:
            return "No active goals."
        lines = [f"Active goals ({len(goals)}):"]
        for g in goals:
            type_label = "AVOID" if g.goal_type == GoalType.AVOID else "ACHIEVE"
            lines.append(f"  [{type_label}] {g.title}")
            if g.motivation:
                lines.append(f"    Why: {g.motivation}")
            if g.blocker:
                lines.append(f"    Blocker: {g.blocker}")
        return "\n".join(lines)

    def _handle_goal_detail_command(self, name: str, db) -> str:
        if not name:
            return "Usage: /goal <name>"
        goal = goal_service.get_by_name(name, db)
        if not goal:
            return f"No goal found matching '{name}'."
        return goal_service.build_single_goal_context(goal, db)


Orchestrator = Orchestrator()
