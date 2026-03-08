from .base import BaseTool


class GetGoalsTool(BaseTool):
    name = "get_goals"
    description = (
        "Get the user's active goals. "
        "Call this whenever you need to reference goal IDs or "
        "see what the user is currently tracking."
    )
    parameters = {"type": "object", "properties": {}, "required": []}

    def execute(self, db=None, **kwargs) -> str:
        from ..services.goal_service import goal_service

        goals = goal_service.get_active(db)
        if not goals:
            return "No active goals."

        lines = []
        for g in goals:
            type_label = "AVOID" if g.goal_type.value == "avoid" else "ACHIEVE"
            lines.append(f"[id:{g.id}] [{type_label}] {g.title}")

        return "\n".join(lines)


class CreateGoalTool(BaseTool):
    name = "create_goal"
    description = (
        "Create a new goal for the user. Use 'avoid' for habits they want to quit "
        "or cut back on (vaping, gooning, junk food). Use 'achieve' for things they "
        "want to do or build (get jacked, run a 5k, save money)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short, clear goal title e.g. 'quit vaping', 'bench 225'",
            },
            "goal_type": {
                "type": "string",
                "enum": ["achieve", "avoid"],
                "description": "achieve = do/build something, avoid = quit/cut back on something",
            },
            "motivation": {
                "type": "string",
                "description": "Why they want this goal (optional)",
            },
        },
        "required": ["title", "goal_type"],
    }

    def execute(self, db=None, title: str = "", goal_type: str = "achieve", motivation: str = None, **kwargs) -> str:
        from ..services.goal_service import goal_service
        from ..db.models import GoalType

        gt = GoalType(goal_type)
        goal = goal_service.create(title, db, goal_type=gt)
        if motivation:
            goal_service.update_latest(db, motivation=motivation)

        return f"Goal created: '{goal.title}' (id:{goal.id}, type:{goal_type})"
