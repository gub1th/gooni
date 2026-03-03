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

    def set_status(self, goal_id: int, status: GoalStatus, db: Session) -> bool:
        goal = db.query(Goal).filter(Goal.id == goal_id).first()
        if not goal:
            return False
        goal.status = status
        db.commit()
        return True

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
        from .note_service import note_service

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

        streak = note_service.calculate_streak(goal.id, db)
        if streak["current_streak"] > 0:
            lines.append(
                f"Streak: {streak['current_streak']} day(s) of {streak['streak_outcome']} "
                f"({streak['total_success']} success / {streak['total_failure']} failure total)"
            )

        recent = note_service.get_recent_for_goal(goal.id, 5, db)
        if recent:
            lines.append("Recent notes:")
            for n in recent:
                ts = n.created_at.strftime("%m/%d") if n.created_at else "?"
                outcome_str = f" [{n.outcome.value.upper()}]" if n.outcome else ""
                lines.append(f"  [{ts}]{outcome_str} {n.content[:120]}")

        return "\n".join(lines)


goal_service = GoalService()
