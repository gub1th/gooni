from datetime import date, datetime, timedelta
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import Workout, WorkoutSet


class WorkoutService:
    def log_workout(
        self,
        workout_date: date,
        sets_data: list,
        db: Session,
        duration: Optional[int] = None,
        notes: Optional[str] = None,
    ) -> Workout:
        """Create Workout + WorkoutSet rows."""
        workout = Workout(date=workout_date, duration_minutes=duration, notes=notes)
        db.add(workout)
        db.flush()  # get workout.id

        for s in sets_data:
            ws = WorkoutSet(
                workout_id=workout.id,
                exercise=s.get("exercise", "Unknown"),
                sets=s.get("sets"),
                reps=s.get("reps"),
                weight=s.get("weight"),
                weight_unit=s.get("weight_unit", "lbs"),
            )
            db.add(ws)

        db.commit()
        db.refresh(workout)
        return workout

    def get_daily_workout(self, workout_date: date, db: Session) -> dict:
        """Return all workouts for a date with their sets."""
        # Filter by created_at date so "today" matches the feed (the AI sometimes
        # logs with the wrong date field, but created_at is always accurate).
        day_start = datetime.combine(workout_date, datetime.min.time())
        day_end = day_start + timedelta(days=1)
        workouts = (
            db.query(Workout)
            .filter(Workout.created_at >= day_start, Workout.created_at < day_end)
            .order_by(Workout.created_at)
            .all()
        )
        result = []
        total_sets = 0
        unique_exercises = set()
        total_duration = 0
        for w in workouts:
            sets = (
                db.query(WorkoutSet)
                .filter(WorkoutSet.workout_id == w.id)
                .order_by(WorkoutSet.created_at)
                .all()
            )
            for s in sets:
                unique_exercises.add(s.exercise.lower())
                if s.sets:
                    total_sets += s.sets
            total_duration += w.duration_minutes or 0
            result.append({
                "id": w.id,
                "duration_minutes": w.duration_minutes,
                "logged_at": w.created_at.isoformat() if w.created_at else None,
                "sets": [
                    {
                        "exercise": s.exercise,
                        "sets": s.sets,
                        "reps": s.reps,
                        "weight": s.weight,
                        "weight_unit": s.weight_unit,
                    }
                    for s in sets
                ],
            })
        return {
            "date": str(workout_date),
            "workouts": result,
            "total_exercises": len(unique_exercises),
            "total_sets": total_sets,
            "total_duration": total_duration or None,
        }

    def get_exercise_history(
        self, exercise: str, db: Session, limit: int = 5
    ) -> List[dict]:
        """Return last N sessions for an exercise (case-insensitive match)."""
        rows = (
            db.query(WorkoutSet)
            .filter(func.lower(WorkoutSet.exercise) == exercise.lower())
            .order_by(WorkoutSet.created_at.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "exercise": r.exercise,
                "sets": r.sets,
                "reps": r.reps,
                "weight": r.weight,
                "weight_unit": r.weight_unit,
                "date": str(r.created_at.date()) if r.created_at else None,
            }
            for r in rows
        ]

    def get_pr(self, exercise: str, db: Session) -> Optional[dict]:
        """Return the best (max weight) set ever logged for this exercise."""
        row = (
            db.query(WorkoutSet)
            .filter(
                func.lower(WorkoutSet.exercise) == exercise.lower(),
                WorkoutSet.weight.isnot(None),
            )
            .order_by(WorkoutSet.weight.desc())
            .first()
        )
        if not row:
            return None
        return {
            "exercise": row.exercise,
            "weight": row.weight,
            "weight_unit": row.weight_unit,
            "sets": row.sets,
            "reps": row.reps,
        }


workout_service = WorkoutService()
