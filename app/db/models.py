from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.sql import func

from .database import Base


class Space(Base):
    """A container for organizing notes and conversations."""

    __tablename__ = "spaces"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    emoji = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Conversation(Base):
    """A session container for a back-and-forth with Claude."""

    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    space_id = Column(Integer, ForeignKey("spaces.id"), nullable=True)
    title = Column(Text, nullable=True)  # auto-generated short title
    summary = Column(Text, nullable=True)  # auto-generated after session ends
    source = Column(String, nullable=False, default="web")  # 'web' | 'telegram'
    last_message_at = Column(
        DateTime(timezone=True), nullable=True
    )  # for session lookup
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    """A single turn in a Conversation. Replaces the old Interaction model."""

    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False)
    role = Column(String, nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(Text, nullable=True)
    content = Column(Text, nullable=True)
    space_id = Column(Integer, ForeignKey("spaces.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)
    last_opened_at = Column(DateTime, nullable=True)
    embedding = Column(Text, nullable=True)  # JSON-serialised float list
    is_public = Column(Boolean, default=False, nullable=False)
    is_pinned = Column(Boolean, default=False, nullable=False)


class PublicProfile(Base):
    __tablename__ = "public_profile"

    id = Column(Integer, primary_key=True)
    bio = Column(Text, nullable=True)  # raw text/markdown, user-written


class Visit(Base):
    """Append-only log of hits on /public/* — for unique-visitor counts.
    IP is stored as a salted SHA-256 hash (first 16 hex chars) so we can't reverse it.
    """

    __tablename__ = "visits"

    id = Column(Integer, primary_key=True, index=True)
    ip_hash = Column(String, nullable=False, index=True)
    user_agent = Column(Text, nullable=True)
    path = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)



