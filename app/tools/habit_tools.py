"""Habit-related chat tools.

Only log_habit for now — manual habit creation lives in the UI. Allowing
the LLM to create habits from a passing chat mention would surprise
Daniel; he should declare which habits he tracks deliberately.

Tool refuses unknown habit names rather than auto-creating. Fuzzy
prefix match resolves 'gym' → 'went to gym'; ambiguous matches refuse.
"""

from .base import BaseTool


class LogHabitTool(BaseTool):
    name = "log_habit"
    description = (
        "Log a yes/no entry for one of Daniel's tracked habits (e.g. 'went "
        "to gym', 'stayed clean from vaping'). Use when Daniel says things "
        "like 'I went to the gym today', 'didn't smoke', 'no vape', 'went "
        "to office', etc. Habit names use positive phrasing — value=true "
        "means he DID the good thing he committed to. Fuzzy-matches habit "
        "names by case-insensitive prefix. Refuses unknown habits; refuses "
        "ambiguous matches (>1 hit). Date defaults to today; pass YYYY-MM-DD "
        "to backfill."
    )
    parameters = {
        "type": "object",
        "properties": {
            "habit_name": {
                "type": "string",
                "description": (
                    "Habit to log (case-insensitive prefix match; e.g. 'gym' "
                    "matches 'went to gym')."
                ),
            },
            "value": {
                "type": "boolean",
                "description": (
                    "True = he did the thing (positive entry); False = he did "
                    "NOT (explicit no, breaks streak)."
                ),
            },
            "date": {
                "type": "string",
                "description": (
                    "Optional YYYY-MM-DD date. Defaults to today. Use to "
                    "backfill ('yesterday I went to gym')."
                ),
            },
        },
        "required": ["habit_name", "value"],
    }

    def execute(
        self,
        db=None,
        habit_name: str = "",
        value: bool = True,
        date: str | None = None,
        **kwargs,
    ) -> str:
        from datetime import date as _date
        from ..services import habit_service

        if db is None:
            return "(no db session)"
        name = (habit_name or "").strip()
        if not name:
            return "(habit_name required)"

        # Resolve. Try exact first, fall back to prefix.
        habit = habit_service.find_by_name(db, name)
        if not habit:
            matches = habit_service.find_by_name_fuzzy(db, name)
            if not matches:
                return f"(no habit matches '{name}'; ask Daniel to create it first in the dashboard)"
            if len(matches) > 1:
                names = ", ".join(f"'{m.name}'" for m in matches[:5])
                return f"(ambiguous — '{name}' matches multiple: {names})"
            habit = matches[0]

        day = _date.today()
        if date:
            try:
                y, m, d = date.split("-")
                day = _date(int(y), int(m), int(d))
            except Exception:
                return f"(invalid date '{date}'; use YYYY-MM-DD)"

        entry = habit_service.upsert_entry(db, habit.id, day, bool(value))
        if not entry:
            return "(failed to log)"
        verb = "logged ✓" if value else "logged ✗"
        streak = habit_service.compute_streak(db, habit.id)
        return f"{verb} '{habit.name}' on {day.isoformat()} — current streak {streak}"
