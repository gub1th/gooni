from datetime import date

from .base import BaseTool


class GetGoalsTool(BaseTool):
    name = "get_goals"
    description = (
        "Get the user's active goals with current streaks and recent activity. "
        "Call this whenever you need to reference goal IDs, check streaks, or "
        "see what the user is currently tracking."
    )
    parameters = {"type": "object", "properties": {}, "required": []}

    def execute(self, db=None, **kwargs) -> str:
        from ..services.goal_service import goal_service
        from ..services.note_service import note_service

        goals = goal_service.get_active(db)
        if not goals:
            return "No active goals."

        lines = []
        for g in goals:
            type_label = "AVOID" if g.goal_type.value == "avoid" else "ACHIEVE"
            streak = note_service.calculate_streak(g.id, db)
            line = f"[id:{g.id}] [{type_label}] {g.title}"
            if streak["current_streak"] > 0:
                line += f" — {streak['current_streak']}d streak ({streak['streak_outcome']})"
            lines.append(line)

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


class LogProgressTool(BaseTool):
    name = "log_progress"
    description = (
        "Log something the user said worth remembering in their feed. "
        "Call this whenever they report doing something, feeling something, or sharing an update — "
        "'hit the gym', 'vaped today', 'haven't slept', 'feeling anxious'. "
        "goal_id is optional — only set it if the note is clearly tied to a specific goal. "
        "outcome is optional — only set it if there's a clear pass/fail relative to a goal."
    )
    parameters = {
        "type": "object",
        "properties": {
            "note": {
                "type": "string",
                "description": "Clean, human-readable summary of what happened. First person, past tense.",
            },
            "goal_id": {
                "type": "integer",
                "description": "The goal ID from get_goals. Omit if not tied to a specific goal.",
            },
            "outcome": {
                "type": "string",
                "enum": ["success", "failure", "neutral"],
                "description": (
                    "success = did the thing / resisted the habit, "
                    "failure = relapsed / skipped, "
                    "neutral = progress update without clear pass/fail. "
                    "Omit if not tied to a goal."
                ),
            },
            "log_date": {
                "type": "string",
                "description": "Date in YYYY-MM-DD format. Omit for today.",
            },
        },
        "required": ["note"],
    }

    def execute(self, db=None, goal_id: int = None, outcome: str = None,
                note: str = "", log_date: str = None, **kwargs) -> str:
        from ..services.note_service import note_service, NoteOutcome
        from ..db.models import Goal

        parsed_date = date.today()
        if log_date:
            try:
                parsed_date = date.fromisoformat(log_date)
            except ValueError:
                pass

        parsed_outcome = NoteOutcome(outcome) if outcome else None

        if goal_id:
            goal = db.query(Goal).filter_by(id=goal_id).first()
            if not goal:
                return f"Goal id:{goal_id} not found. Call get_goals to see current goals."

        note_service.create(
            content=note,
            db=db,
            goal_id=goal_id,
            outcome=parsed_outcome,
            log_date=parsed_date,
        )

        if goal_id and outcome:
            from ..services.goal_service import goal_service
            goal = db.query(Goal).filter_by(id=goal_id).first()
            streak = note_service.calculate_streak(goal_id, db)
            streak_msg = ""
            if streak["current_streak"] > 0:
                streak_msg = f" Streak: {streak['current_streak']} day(s) of {streak['streak_outcome']}."
            return f"Logged {outcome} for '{goal.title}'.{streak_msg}"

        return "Logged."
