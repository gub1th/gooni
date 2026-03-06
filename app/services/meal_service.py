import json
from datetime import date, datetime, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session

from ..db.models import Meal, MealType


class MealService:
    def log_meal(
        self,
        meal_type: str,
        items: list,
        logged_date: date,
        db: Session,
    ) -> Meal:
        """Create a Meal row from items, compute totals, and add a feed note."""
        total_calories = sum(i.get("calories", 0) or 0 for i in items)
        total_protein = sum(i.get("protein", 0) or 0 for i in items)
        total_carbs = sum(i.get("carbs", 0) or 0 for i in items)
        total_fat = sum(i.get("fat", 0) or 0 for i in items)

        meal = Meal(
            meal_type=MealType(meal_type),
            logged_date=logged_date,
            total_calories=total_calories,
            total_protein=total_protein,
            total_carbs=total_carbs,
            total_fat=total_fat,
            items=json.dumps(items),
        )
        db.add(meal)
        db.commit()
        db.refresh(meal)
        return meal

    def get_daily_totals(self, logged_date: date, db: Session) -> dict:
        """Sum all macros for a given date across all meals, with per-meal breakdown."""
        day_start = datetime.combine(logged_date, datetime.min.time())
        day_end = day_start + timedelta(days=1)
        meals = (
            db.query(Meal)
            .filter(Meal.created_at >= day_start, Meal.created_at < day_end)
            .all()
        )
        totals = {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fat": 0.0}
        breakdown = []
        for m in meals:
            totals["calories"] += m.total_calories or 0
            totals["protein"] += m.total_protein or 0
            totals["carbs"] += m.total_carbs or 0
            totals["fat"] += m.total_fat or 0
            breakdown.append({
                "meal_type": m.meal_type.value,
                "calories": m.total_calories,
                "protein": m.total_protein,
                "carbs": m.total_carbs,
                "fat": m.total_fat,
                "items": json.loads(m.items) if m.items else [],
                "logged_at": m.created_at.isoformat() if m.created_at else None,
            })
        return {"date": str(logged_date), "totals": totals, "meals": breakdown}

    def get_meal_history(
        self, meal_type: str, db: Session, limit: int = 7
    ) -> List[Meal]:
        """Return recent meals of a given type."""
        return (
            db.query(Meal)
            .filter(Meal.meal_type == MealType(meal_type))
            .order_by(Meal.logged_date.desc(), Meal.created_at.desc())
            .limit(limit)
            .all()
        )


meal_service = MealService()
