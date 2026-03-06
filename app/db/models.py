from sqlalchemy import Column, DateTime, Date, Integer, String, Text, Float, Boolean, Enum, ForeignKey
from sqlalchemy.sql import func
import enum

from .database import Base


class MealType(enum.Enum):
    BREAKFAST = "breakfast"
    LUNCH = "lunch"
    DINNER = "dinner"
    SNACK = "snack"


class Interaction(Base):
    __tablename__ = "interactions"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String, nullable=False)  # "user" or "assistant"
    content = Column(Text, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())


class GoalStatus(enum.Enum):
    ACTIVE = "active"
    COMPLETED = "completed"
    PAUSED = "paused"
    ABANDONED = "abandoned"


class GoalType(enum.Enum):
    ACHIEVE = "achieve"
    AVOID = "avoid"


class NoteOutcome(enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    NEUTRAL = "neutral"


class MemoryType(enum.Enum):
    PROFILE_FACT = "profile_fact"
    EPISODE = "episode"


class Goal(Base):
    __tablename__ = "goals"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(Text, nullable=False)
    goal_type = Column(Enum(GoalType), default=GoalType.ACHIEVE, nullable=False)
    status = Column(Enum(GoalStatus), default=GoalStatus.ACTIVE, nullable=False)
    motivation = Column(Text, nullable=True)
    blocker = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)
    goal_id = Column(Integer, ForeignKey("goals.id"), nullable=True)
    interaction_id = Column(Integer, ForeignKey("interactions.id"), nullable=True)
    outcome = Column(Enum(NoteOutcome), nullable=True)
    log_date = Column(Date, nullable=True)
    meta = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Meal(Base):
    __tablename__ = "meals"

    id = Column(Integer, primary_key=True, index=True)
    meal_type = Column(Enum(MealType), nullable=False)
    logged_date = Column(Date, nullable=False)
    total_calories = Column(Float, nullable=True)
    total_protein = Column(Float, nullable=True)
    total_carbs = Column(Float, nullable=True)
    total_fat = Column(Float, nullable=True)
    items = Column(Text, nullable=True)  # JSON array: [{name, calories, protein, carbs, fat}]
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Workout(Base):
    __tablename__ = "workouts"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False)
    duration_minutes = Column(Integer, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class WorkoutSet(Base):
    __tablename__ = "workout_sets"

    id = Column(Integer, primary_key=True, index=True)
    workout_id = Column(Integer, ForeignKey("workouts.id"), nullable=False)
    exercise = Column(String, nullable=False)  # normalized canonical name
    sets = Column(Integer, nullable=True)
    reps = Column(Integer, nullable=True)
    weight = Column(Float, nullable=True)
    weight_unit = Column(String, default="lbs")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Memory(Base):
    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    memory_type = Column(Enum(MemoryType), nullable=False)
    key = Column(String, nullable=True, index=True)
    content = Column(Text, nullable=False)
    goal_id = Column(Integer, ForeignKey("goals.id"), nullable=True)
    embedding = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    superseded_by = Column(Integer, ForeignKey("memories.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
