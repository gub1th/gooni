from sqlalchemy import Column, DateTime, Date, Integer, String, Text, Float, Boolean, Enum, ForeignKey
from sqlalchemy.sql import func
import enum

from .database import Base


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
    outcome = Column(Enum(NoteOutcome), nullable=True)
    log_date = Column(Date, nullable=True)
    meta = Column(Text, nullable=True)
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
