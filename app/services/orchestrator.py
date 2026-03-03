from ..db.models import GoalType
from ..db.schemas import InteractionCreate
from ..llm.client import llm_client
from .goal_service import goal_service
from .interaction_service import InteractionService
from .memory_service import memory_service


class Orchestrator:
    def handle_chat(
        self, message: str, db, image_url: str = None
    ) -> tuple[str, dict | None]:
        stripped = message.strip()
        command = stripped.lower()

        if command == "/memory":
            return self._handle_memory_command(db), None
        if command == "/goals":
            return self._handle_goals_command(db), None
        if command.startswith("/goal "):
            name = stripped[6:].strip()
            return self._handle_goal_detail_command(name, db), None

        is_first_time = not memory_service.get_name(db)

        recent_history = InteractionService.get_recent(db, limit=6)
        InteractionService.create_interaction(
            InteractionCreate(role="user", content=message), db
        )

        query = message if message.strip() else "image"
        memory_context = memory_service.build_memory_context(query, db)
        goal_context = goal_service.build_goal_context(db)
        full_context = "\n\n".join(filter(None, [memory_context, goal_context]))

        if image_url:
            response, usage = llm_client.generate_response_with_image(
                message, image_url, full_context, "", recent_history
            )
        else:
            response, usage = llm_client.generate_chat_response_with_memory(
                message, full_context, "", recent_history,
                is_first_time=is_first_time, db=db,
            )

        InteractionService.create_interaction(
            InteractionCreate(role="assistant", content=response), db
        )

        # Auto-save episode for future context retrieval (no LLM call needed)
        if message.strip() and len(message.strip()) > 10:
            memory_service.create_episode(
                f"User: {message}\nAssistant: {response}", goal_id=None, db=db
            )

        tools_used = usage.get("tools_used", [])
        usage["memory"] = {"episode_saved": True, "tools_used": tools_used}

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
