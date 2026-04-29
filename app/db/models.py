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
    UniqueConstraint,
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
    # JSON snapshot of what classify_note routed for this note's most recent
    # save. Mirrors the chat-side `signals` payload so the editor can render
    # the same "Routed:" disclosure as MessageBubble. Shape:
    #   {
    #     "feature_requests": [{"title": str, "list_item_id": int}],
    #     "memory_count": int,
    #     "memory_types": [str, ...],
    #     "classified_at": iso8601,
    #   }
    # Empty / null when no signals fired or note hasn't been classified yet.
    last_classify_signals = Column(Text, nullable=True)


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
    # Optional link to a top-level ListItem (focus) when the memory is
    # goal/aspiration-shaped. Re-pointed from the legacy `focuses` table
    # to `list_items` after the unified-item refactor.
    focus_id = Column(Integer, ForeignKey("list_items.id"), nullable=True)
    # Origin tracking — set when this memory was extracted from a note's
    # classify_note run. Lets the editor surface "this note created N
    # memories" disclosure. NULL for memories from chat or other paths.
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    is_active = Column(Boolean, nullable=False, default=True)
    superseded_by = Column(Integer, ForeignKey("memories.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class List(Base):
    """User-facing structured list. `type` drives small UI variations
    (todo / backlog / generic) but storage is uniform.

    Conceptually replaces:
      - TodoItem (the hardcoded "Todo list" — becomes a List(type=todo) row)
      - Lists feature (Notes with <ul><li> in space "Lists" — items move to ListItem rows)
      - Gooni Backlog Space (auto-logged feature requests become ListItem rows
        in List(type=backlog))
    """

    __tablename__ = "lists"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    # 'todo' | 'backlog' | 'generic'
    type = Column(String, nullable=False, default="generic", index=True)
    emoji = Column(String, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ListItem(Base):
    """A single item — the unified "thing to do" record. With:
      - `endgoal` set + no parent → renders as a focus (long-running goal)
      - `parent_id` set           → renders as a child step under its parent
      - both null                 → leaf todo
    `committed` is the boolean replacement for the old Focus.status enum:
    True = actively pursuing, False = parked.
    `subtitle` carries the "why" for backlog items.
    `source_note_id` links back to the Note that spawned this item.
    """

    __tablename__ = "list_items"

    id = Column(Integer, primary_key=True, index=True)
    list_id = Column(Integer, ForeignKey("lists.id"), nullable=False, index=True)
    parent_id = Column(Integer, ForeignKey("list_items.id"), nullable=True, index=True)
    text = Column(Text, nullable=False)
    subtitle = Column(Text, nullable=True)
    endgoal = Column(Text, nullable=True)
    committed = Column(Boolean, default=False, nullable=False)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    due_date = Column(DateTime, nullable=True)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class OAuthToken(Base):
    """Stored OAuth credentials for any third-party connector. Single-tenant
    Gooni: one row per provider. `provider` is the discriminator
    ("google_calendar", "github", ...). Some providers (GitHub OAuth Apps)
    don't expire access tokens; we store refresh_token = "" and
    expires_at = 0 in that case.
    """

    __tablename__ = "oauth_tokens"

    id = Column(Integer, primary_key=True)
    provider = Column(String, nullable=False, unique=True)
    access_token = Column(Text, nullable=False)
    # GitHub doesn't issue refresh tokens for non-rotating OAuth Apps.
    refresh_token = Column(Text, nullable=False, default="")
    # Unix seconds since epoch — easier to compare than tz-aware datetimes.
    # 0 means "no expiry" (e.g. GitHub).
    expires_at = Column(Integer, nullable=False, default=0)
    scope = Column(Text, nullable=True)
    # Display label: Google = email, GitHub = "@username".
    account_email = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TrackedRepo(Base):
    """A repo the user wants surfaced on the Dev Activity dashboard. The
    `provider` field is here so we can layer GitLab / Bitbucket on later
    without a schema change.
    """

    __tablename__ = "tracked_repos"
    __table_args__ = (
        UniqueConstraint("provider", "owner", "name", name="uq_tracked_repo"),
    )

    id = Column(Integer, primary_key=True)
    provider = Column(String, nullable=False, default="github")
    owner = Column(String, nullable=False)
    name = Column(String, nullable=False)
    added_at = Column(DateTime, default=datetime.utcnow, nullable=False)



