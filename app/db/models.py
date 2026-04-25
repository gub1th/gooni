from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
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
    # Cached topic-graph payload for the visualization toggle in GooniPanel.
    # JSON: {"message_count": int, "nodes": [...], "edges": [...]}.
    # Invalidated when message_count drifts from the cached value.
    topic_graph = Column(Text, nullable=True)


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
    # JSON-encoded list of probing questions Gooni would ask, plus the hash
    # of the content they were generated from. Schema:
    #   {"hash": "<sha1>", "questions": ["...", "..."]}
    # Cached so opening the note doesn't re-fire the LLM call.
    suggested_questions = Column(Text, nullable=True)


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


class TodoItem(Base):
    """A single todo. Lives in its own table so we can track per-item timestamps,
    sort order, and completion independently of any containing note.
    `sort_order` is a plain int — the item placed at the end of the list gets
    max(sort_order)+1. Drag-reorder issues a batch update. Gaps on delete are fine.
    """

    __tablename__ = "todo_items"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)
    done = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    due_date = Column(DateTime, nullable=True)


class TodoNote(Base):
    """Link between a TodoItem and a Note. Kept narrow (not a general
    entity-links system) so queries stay typed: `relation_type` is a small
    enum of concrete relationships. Today only "plan" is used — the note
    spawned when the user clicks the Plan button on a todo.
    """

    __tablename__ = "todo_notes"

    id = Column(Integer, primary_key=True, index=True)
    todo_id = Column(Integer, ForeignKey("todo_items.id"), nullable=False, index=True)
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=False, index=True)
    relation_type = Column(String, nullable=False, default="plan")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Focus(Base):
    """A long-running thing Daniel is working on. Has an endgoal description
    so Gooni knows what 'done' means. `last_activity_at` is rolled forward
    by the implicit matcher (notes/messages that mention the focus) and by
    explicit heartbeats. Status is a small string enum, consistent with
    other models in this codebase.
    """

    __tablename__ = "focuses"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    endgoal = Column(Text, nullable=False)
    # 'committed' | 'pending' | 'someday' | 'done'
    status = Column(String, nullable=False, default="committed")
    due_date = Column(DateTime, nullable=True)
    last_activity_at = Column(DateTime, nullable=True)
    # Cached embedding of name + endgoal so the matcher doesn't recompute
    # on every note save. Refreshed on create/update.
    embedding = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class FocusActivity(Base):
    """Append-only log of moments where a note or message touched a focus —
    either matched by the implicit similarity matcher or via an explicit
    heartbeat. Powers the 'haven't touched X in 5 days' check-in.
    """

    __tablename__ = "focus_activities"

    id = Column(Integer, primary_key=True, index=True)
    focus_id = Column(Integer, ForeignKey("focuses.id"), nullable=False, index=True)
    # 'note' | 'message' | 'manual_heartbeat'
    source_type = Column(String, nullable=False)
    source_id = Column(Integer, nullable=True)
    similarity = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class Suggestion(Base):
    """A daily-refreshed item Gooni surfaces to nudge Daniel out of his ruts.
    Two categories so far:
      'discovery' — intellectual: startups, books, articles, ideas to explore
      'whimsy'    — experiential: try a new restaurant, talk to a stranger,
                    do something out of comfort zone
    Generated in batches of 6 (3+3); refreshed at most once per 24h. The
    `dismissed` flag lets Daniel hide an item without losing the row, so
    we know not to regenerate it next cycle.
    """

    __tablename__ = "suggestions"

    id = Column(Integer, primary_key=True, index=True)
    category = Column(String, nullable=False, index=True)  # 'discovery'|'whimsy'
    title = Column(Text, nullable=False)
    body = Column(Text, nullable=False)
    source_url = Column(Text, nullable=True)
    generated_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    dismissed = Column(Boolean, default=False, nullable=False)


class GoogleOAuthToken(Base):
    """Stored OAuth credentials for the single Gooni user. One row max —
    the app is single-tenant. Refresh-token rotation replaces the values
    in place rather than appending. `provider` left as a column so we can
    support e.g. gmail later without a second table.
    """

    __tablename__ = "google_oauth_tokens"

    id = Column(Integer, primary_key=True)
    provider = Column(String, nullable=False, default="google_calendar", unique=True)
    access_token = Column(Text, nullable=False)
    refresh_token = Column(Text, nullable=False)
    # Unix seconds since epoch — easier to compare than tz-aware datetimes.
    expires_at = Column(Integer, nullable=False)
    scope = Column(Text, nullable=True)
    account_email = Column(Text, nullable=True)  # user's Google email for display
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)



