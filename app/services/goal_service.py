from sqlalchemy.orm import Session

from ..db.models import Goal, GoalStatus, GoalType


class GoalService:
    def create(self, title: str, db: Session, goal_type: GoalType = GoalType.ACHIEVE) -> Goal:
        goal = Goal(title=title, goal_type=goal_type)
        db.add(goal)
        db.commit()
        db.refresh(goal)
        return goal

    def update_latest(self, db: Session, **kwargs) -> None:
        goal = db.query(Goal).order_by(Goal.id.desc()).first()
        if goal:
            for k, v in kwargs.items():
                setattr(goal, k, v)
            db.commit()

    def get_active(self, db: Session) -> list[Goal]:
        return db.query(Goal).filter(Goal.status == GoalStatus.ACTIVE).order_by(Goal.id).all()

    def get_by_name(self, name: str, db: Session) -> Goal | None:
        return (
            db.query(Goal)
            .filter(Goal.title.ilike(f"%{name}%"))
            .order_by(Goal.id)
            .first()
        )

    def build_goal_context(self, db: Session) -> str:
        goals = self.get_active(db)
        if not goals:
            return ""
        lines = ["User's active goals:"]
        for g in goals:
            type_label = "AVOID" if g.goal_type == GoalType.AVOID else "ACHIEVE"
            lines.append(f"- [id:{g.id}] [{type_label}] {g.title}")
            if g.motivation:
                lines.append(f"  Why: {g.motivation}")
            if g.blocker:
                lines.append(f"  Blocker: {g.blocker}")
        return "\n".join(lines)

    def build_single_goal_context(self, goal: Goal, db: Session) -> str:
        type_label = "AVOID" if goal.goal_type == GoalType.AVOID else "ACHIEVE"
        lines = [
            f"Goal: {goal.title}",
            f"Type: {type_label}",
            f"Status: {goal.status.value}",
        ]
        if goal.motivation:
            lines.append(f"Why: {goal.motivation}")
        if goal.blocker:
            lines.append(f"Blocker: {goal.blocker}")
        return "\n".join(lines)


goal_service = GoalService()
