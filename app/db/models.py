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
    # Rolling 200-word rollup of the conversation, refreshed every 15 messages.
    # Prepended to the recent-history window so long sessions don't lose
    # early context to the 10-message truncation.
    summary = Column(Text, nullable=True)
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
    # When set, this user message is feedback on the referenced assistant
    # message — the orchestrator's feedback detector flagged it. Used by the
    # audit page and to skip running normal reply generation on pure feedback.
    feedback_for_message_id = Column(
        Integer, ForeignKey("messages.id"), nullable=True
    )
    is_feedback = Column(Boolean, nullable=False, default=False)


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
    # Snapshot of the note's embedding at the moment the unified extractor
    # last classified its content. Used as the dedup gate for re-running
    # the classifier — if the live embedding has cosine ≥ ~0.92 vs this
    # snapshot, the meaning hasn't shifted enough to warrant another pass.
    classified_embedding = Column(Text, nullable=True)
    # FK back to a Note in the "Gooni Backlog" space when this note's
    # content triggered a feature_request. Drives the editor chip so
    # Daniel sees that the note actually fed the self-improvement loop.
    backlog_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)


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
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Suggestion(Base):
    """A daily-refreshed item Gooni surfaces to nudge Daniel out of his ruts.
    Three categories now:
      'read'    — content to consume (was 'discovery')
      'do'      — real-world action / comfort-zone breaker (was 'whimsy')
      'revisit' — surfaces one of Daniel's own past notes
    Generated as 3 items/day total (1 of each category); refreshed at most
    once per 24h. The `dismissed` flag lets Daniel hide an item without
    losing the row, so we know not to regenerate it next cycle. Old
    'discovery' / 'whimsy' rows from before the rename remain in the
    table; they're just filtered out of the daily view.
    """

    __tablename__ = "suggestions"

    id = Column(Integer, primary_key=True, index=True)
    category = Column(String, nullable=False, index=True)  # 'read'|'do'|'revisit'
    title = Column(Text, nullable=False)
    body = Column(Text, nullable=False)
    source_url = Column(Text, nullable=True)
    # For revisit items: link back to the original note so clicking the
    # card can deep-link Daniel into the editor.
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    generated_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    dismissed = Column(Boolean, default=False, nullable=False)


class SuggestionPrompt(Base):
    """Per-category user prompt that gets prepended (as PRIORITY) to the
    LLM generation prompt. Lets Daniel say "I want to see random AI
    startups" for the 'read' category, or "more outdoor activities" for
    'do'. One row per category (read|do|revisit). Empty / missing row
    means use the default prompt only.
    """

    __tablename__ = "suggestion_prompts"

    id = Column(Integer, primary_key=True, index=True)
    category = Column(String, nullable=False, unique=True, index=True)
    user_prompt = Column(Text, nullable=False, default="")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class Memory(Base):
    """Daniel's persistent knowledge of himself. Replaces the Mem0 hosted
    service with a local SQL store + LLM extraction + LLM reconciliation.

    Types:
      'preference' — stable likes/dislikes (always injected into prompt)
      'goal'       — long-running aspirations (linked to focus_id when relevant)
      'fact'       — declarative facts about Daniel
      'routine'    — habits + recurring patterns
      'constraint' — hard limits (allergies, schedule blockers, dealbreakers)
      'episode'    — free-form chat extract; no key, just embedded content

    Updates use a supersede chain: when a fact contradicts an old one, the
    old row gets is_active=False and superseded_by=<new id>. Audit trail
    survives. The reconcile LLM step decides per candidate whether to ADD,
    UPDATE (supersede), DELETE (mark inactive), or NONE (boost confidence).
    """

    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    # 'preference' | 'goal' | 'fact' | 'routine' | 'constraint' | 'episode'
    type = Column(String, nullable=False, index=True)
    # snake_case slug for typed memories so we can lookup by key. NULL for episodes.
    key = Column(String, nullable=True, index=True)
    content = Column(Text, nullable=False)
    # JSON: {"time": str?, "location": str?, "scope": "global"|"contextual"}
    context = Column(Text, nullable=True)
    confidence = Column(Float, nullable=False, default=0.8)
    # JSON-serialized embedding vector for cosine search.
    embedding = Column(Text, nullable=True)
    # Optional link to a Focus when the memory is goal/aspiration-shaped.
    focus_id = Column(Integer, ForeignKey("focuses.id"), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    superseded_by = Column(Integer, ForeignKey("memories.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


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



