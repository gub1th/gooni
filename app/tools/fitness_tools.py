from datetime import date, datetime

from .base import BaseTool
from ..services.meal_service import meal_service
from ..services.workout_service import workout_service


def _parse_date(date_str: str) -> date:
    return datetime.strptime(date_str, "%Y-%m-%d").date()


class LogMealTool(BaseTool):
    name = "log_meal"
    description = (
        "Log a meal with individual food items and their macros. "
        "Call this whenever the user mentions eating or drinking something."
    )
    parameters = {
        "type": "object",
        "properties": {
            "meal_type": {
                "type": "string",
                "enum": ["breakfast", "lunch", "dinner", "snack"],
                "description": "Type of meal",
            },
            "items": {
                "type": "array",
                "description": "Individual food items in the meal",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "calories": {"type": "number"},
                        "protein": {"type": "number"},
                        "carbs": {"type": "number"},
                        "fat": {"type": "number"},
                    },
                    "required": ["name", "calories", "protein"],
                },
            },
            "date": {
                "type": "string",
                "description": "Date in YYYY-MM-DD format",
            },
        },
        "required": ["meal_type", "items", "date"],
    }

    def execute(self, db=None, **kwargs) -> str:
        meal_type = kwargs["meal_type"]
        items = kwargs["items"]
        logged_date = _parse_date(kwargs["date"])

        meal = meal_service.log_meal(
            meal_type=meal_type,
            items=items,
            logged_date=logged_date,
            db=db,
        )
        return (
            f"Logged {meal_type}: {meal.total_calories:.0f} cal, "
            f"{meal.total_protein:.0f}g protein, "
            f"{meal.total_carbs:.0f}g carbs, "
            f"{meal.total_fat:.0f}g fat."
        )


class GetDailyMacrosTool(BaseTool):
    name = "get_daily_macros"
    description = (
        "Get total macros (calories, protein, carbs, fat) for a given date, "
        "broken down by meal. Use when the user asks about their nutrition for a day."
    )
    parameters = {
        "type": "object",
        "properties": {
            "date": {
                "type": "string",
                "description": "Date in YYYY-MM-DD format",
            },
        },
        "required": ["date"],
    }

    def execute(self, db=None, **kwargs) -> str:
        logged_date = _parse_date(kwargs["date"])
        data = meal_service.get_daily_totals(logged_date=logged_date, db=db)

        if not data["meals"]:
            return f"No meals logged for {kwargs['date']}."

        t = data["totals"]
        lines = [
            f"Totals for {kwargs['date']}: "
            f"{t['calories']:.0f} cal | {t['protein']:.0f}g P | "
            f"{t['carbs']:.0f}g C | {t['fat']:.0f}g F",
        ]
        for m in data["meals"]:
            lines.append(
                f"  {m['meal_type'].capitalize()}: "
                f"{(m['calories'] or 0):.0f} cal, {(m['protein'] or 0):.0f}g P"
            )
        return "\n".join(lines)


class LogWorkoutTool(BaseTool):
    name = "log_workout"
    description = (
        "Log a workout session with exercises, sets, reps, and weight. "
        "Call this immediately when the user mentions completing a workout."
    )
    parameters = {
        "type": "object",
        "properties": {
            "date": {
                "type": "string",
                "description": "Date in YYYY-MM-DD format",
            },
            "exercises": {
                "type": "array",
                "description": "List of exercises performed",
                "items": {
                    "type": "object",
                    "properties": {
                        "exercise": {"type": "string"},
                        "sets": {"type": "integer"},
                        "reps": {"type": "integer"},
                        "weight": {"type": "number"},
                        "weight_unit": {"type": "string", "default": "lbs"},
                    },
                    "required": ["exercise"],
                },
            },
            "duration_minutes": {
                "type": "integer",
                "description": "Total workout duration in minutes (optional)",
            },
            "notes": {
                "type": "string",
                "description": "Any extra notes about the workout (optional)",
            },
        },
        "required": ["date", "exercises"],
    }

    def execute(self, db=None, **kwargs) -> str:
        workout_date = _parse_date(kwargs["date"])
        exercises = kwargs["exercises"]
        duration = kwargs.get("duration_minutes")
        notes = kwargs.get("notes")

        workout_service.log_workout(
            workout_date=workout_date,
            sets_data=exercises,
            db=db,
            duration=duration,
            notes=notes,
        )

        # Check for new PRs
        pr_messages = []
        for ex in exercises:
            name = ex.get("exercise", "")
            weight = ex.get("weight")
            if not weight:
                continue
            pr = workout_service.get_pr(name, db)
            if pr and pr["weight"] == weight:
                pr_messages.append(f"New PR on {name}: {weight}{ex.get('weight_unit', 'lbs')}!")

        summary_parts = []
        for ex in exercises:
            name = ex.get("exercise", "?")
            s = ex.get("sets", "")
            r = ex.get("reps", "")
            w = ex.get("weight", "")
            unit = ex.get("weight_unit", "lbs")
            part = name
            if s and r:
                part += f" {s}×{r}"
            if w:
                part += f" @ {w}{unit}"
            summary_parts.append(part)

        result = f"Workout logged: {', '.join(summary_parts)}."
        if duration:
            result += f" Duration: {duration} min."
        if pr_messages:
            result += " " + " ".join(pr_messages)
        return result


class GetExerciseHistoryTool(BaseTool):
    name = "get_exercise_history"
    description = (
        "Get the last 5 sessions and all-time PR for a specific exercise. "
        "Use when the user asks about their progress or PR on an exercise."
    )
    parameters = {
        "type": "object",
        "properties": {
            "exercise": {
                "type": "string",
                "description": "Name of the exercise (e.g. 'bench press', 'squat')",
            },
        },
        "required": ["exercise"],
    }

    def execute(self, db=None, **kwargs) -> str:
        exercise = kwargs["exercise"]
        history = workout_service.get_exercise_history(exercise, db)
        pr = workout_service.get_pr(exercise, db)

        if not history:
            return f"No history found for {exercise}."

        lines = [f"{exercise} — last {len(history)} sessions:"]
        for h in history:
            s = h.get("sets", "")
            r = h.get("reps", "")
            w = h.get("weight", "")
            unit = h.get("weight_unit", "lbs")
            d = h.get("date", "")
            detail = f"{s}×{r}" if s and r else ""
            if w:
                detail += f" @ {w}{unit}"
            lines.append(f"  {d}: {detail}".rstrip())

        if pr:
            lines.append(
                f"PR: {pr['weight']}{pr['weight_unit']} "
                f"({pr['sets']}×{pr['reps']})"
            )
        return "\n".join(lines)
