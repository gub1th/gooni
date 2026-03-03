from datetime import date
from typing import List, Optional

from sqlalchemy.orm import Session

from ..db.models import Note, NoteOutcome


class NoteService:
    def create(
        self,
        content: str,
        db: Session,
        goal_id: Optional[int] = None,
        outcome: Optional[NoteOutcome] = None,
        log_date: Optional[date] = None,
        meta: Optional[str] = None,
    ) -> Note:
        note = Note(
            content=content,
            goal_id=goal_id,
            outcome=outcome,
            log_date=log_date or (date.today() if outcome is not None else None),
            meta=meta,
        )
        db.add(note)
        db.commit()
        db.refresh(note)
        return note

    def get_recent_for_goal(self, goal_id: int, limit: int, db: Session) -> List[Note]:
        return (
            db.query(Note)
            .filter(Note.goal_id == goal_id)
            .order_by(Note.created_at.desc())
            .limit(limit)
            .all()
        )

    def calculate_streak(self, goal_id: int, db: Session) -> dict:
        """Calculate current streak and totals for a goal."""
        logs = (
            db.query(Note)
            .filter(Note.goal_id == goal_id, Note.outcome.isnot(None))
            .order_by(Note.log_date.desc())
            .all()
        )
        if not logs:
            return {"current_streak": 0, "streak_outcome": None, "total_success": 0, "total_failure": 0}

        total_success = sum(1 for l in logs if l.outcome == NoteOutcome.SUCCESS)
        total_failure = sum(1 for l in logs if l.outcome == NoteOutcome.FAILURE)

        streak = 1
        streak_outcome = logs[0].outcome
        for i in range(1, len(logs)):
            if logs[i].outcome == streak_outcome:
                streak += 1
            else:
                break

        return {
            "current_streak": streak,
            "streak_outcome": streak_outcome.value if streak_outcome else None,
            "total_success": total_success,
            "total_failure": total_failure,
        }


note_service = NoteService()
