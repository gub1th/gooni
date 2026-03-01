from sqlalchemy.orm import Session

from ..db.models import Goal


class GoalService:
    def create(self, title: str, db: Session) -> Goal:
        goal = Goal(title=title)
        db.add(goal)
        db.commit()
        db.refresh(goal)
        return goal

    def update_latest(self, db: Session, **kwargs) -> None:
        """Update fields on the most recently created goal."""
        goal = db.query(Goal).order_by(Goal.id.desc()).first()
        if goal:
            for k, v in kwargs.items():
                setattr(goal, k, v)
            db.commit()

    def get_active(self, db: Session) -> list[Goal]:
        return db.query(Goal).filter(Goal.is_active == True).order_by(Goal.id).all()

    def build_goal_context(self, db: Session) -> str:
        goals = self.get_active(db)
        if not goals:
            return ""
        lines = ["User's goals:"]
        for g in goals:
            lines.append(f"- {g.title}")
            if g.motivation:
                lines.append(f"  Why: {g.motivation}")
            if g.blocker:
                lines.append(f"  Blocker: {g.blocker}")
        return "\n".join(lines)


goal_service = GoalService()
