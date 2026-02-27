from sqlalchemy import Column, DateTime, Integer, String, Text, Float, Boolean, Enum, ForeignKey
from sqlalchemy.sql import func
import enum

from .database import Base

class Interaction(Base):
    __tablename__ = "interactions"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String, nullable=False)  # "user" or "assistant"
    content = Column(Text, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())


class MemoryType(enum.Enum):
    PREFERENCE = "preference"
    GOAL = "goal"
    FACT = "fact"
    ROUTINE = "routine"
    CONSTRAINT = "constraint"


class UserProfileMemory(Base):
    __tablename__ = "user_profile_memories"

    id = Column(Integer, primary_key=True, index=True)
    memory_type = Column(Enum(MemoryType), nullable=False)
    key = Column(String, nullable=False, index=True)
    value = Column(Text, nullable=False)
    context = Column(Text, nullable=True)  # JSON string
    confidence = Column(Float, nullable=False, default=0.8)
    embedding = Column(Text, nullable=True)  # JSON string of vector
    is_active = Column(Boolean, nullable=False, default=True)
    superseded_by = Column(Integer, ForeignKey('user_profile_memories.id'), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EpisodicMemory(Base):
    __tablename__ = "episodic_memories"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)
    embedding = Column(Text, nullable=True)  # Store as JSON string
    extra = Column(Text, nullable=True)  # Store as JSON string (renamed from metadata)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())


class Todo(Base):
    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)
    is_done = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
