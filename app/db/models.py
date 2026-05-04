from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
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
    # Structured trace of the steps the orchestrator took to produce this
    # assistant reply: intention text, memory recall, tool calls, etc.
    # JSON-encoded list[dict]; null on user messages or older assistant rows.
    # Schema: [{ "type": "intention" | "memory_recall" | "tool_call" | "reply",
    #            "label": str, "detail": str | None, "args": dict | None }]
    trace = Column(Text, nullable=True)


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
    # Set when this note was extracted out of a parent note via the
    # "↗ Extract to new note" BubbleMenu action. The parent's content keeps
    # a clickable chip (TipTap noteLink node) where the selection used to
    # be; `excerpt_anchor` is a short label (first ~40 chars of the
    # extracted text) shown on that chip so the parent stays readable.
    parent_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    excerpt_anchor = Column(Text, nullable=True)


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


class McpCall(Base):
    """Append-only log of HTTP requests originating from the Gooni MCP server.
    The MCP client tags itself with `X-Gooni-Source: mcp`; the auth middleware
    inserts a row per matched request. Surfaced as a dashboard "claude
    activity" stat — gives Daniel a glance at how active Claude has been
    against Gooni without depending on Claude Code internals.
    """

    __tablename__ = "mcp_calls"

    id = Column(Integer, primary_key=True, index=True)
    path = Column(Text, nullable=False)
    called_at = Column(DateTime, default=datetime.utcnow, index=True)


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
    # 'tasks' | 'ideas' — list-level kind. tasks = items render with a checkbox
    # and a done state; ideas = items render as bullets with no checkbox.
    # ListItem.actionable lingers in storage for back-compat but the UI now
    # derives this from the list's kind.
    kind = Column(String, nullable=False, default="tasks")
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
    # actionable=True → renders with checkbox (a thing to do).
    # actionable=False → renders as a bullet/idea (no toggle, no completion state).
    actionable = Column(Boolean, default=True, nullable=False)
    # Singleton: only one ListItem in the whole table can be is_primary=True.
    # The "primary focus" surfaced front-and-center on the dashboard. Service
    # enforces uniqueness.
    is_primary = Column(Boolean, default=False, nullable=False)
    # Focus engagement state — separate from `committed` so the UI can
    # distinguish "I'm pursuing this but stalled" (pending) from "actively
    # making progress" (committed) without drifting onto the stale auto-flag.
    # NULL on legacy rows; frontend falls back to deriving from `committed`.
    # Values: 'committed' | 'pending' | 'someday'.
    status = Column(String, nullable=True)
    # Time horizon — purely informational, drives a small badge on the
    # focuses dashboard. NULL = unspecified. Values: 'long_term' | 'sprint'
    # | 'medium'.
    scale = Column(String, nullable=True)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    due_date = Column(DateTime, nullable=True)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    # JSON-serialised float list. Generated on insert/edit from `text +
    # subtitle` so add_item can cosine-search existing items in the same list
    # for conflicts (near-duplicates). NULL on legacy rows; backfilled lazily
    # by a startup worker.
    embedding = Column(Text, nullable=True)
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


class GooniSnapshot(Base):
    """Daily reflection on Gooni + Daniel — one row per day. The raw_data JSON
    captures the inputs (commit list, DB counts, deltas vs prior snapshot) and
    `digest` holds the LLM-generated prose. Lazy-built on first read of the day
    so we don't need a cron.
    """

    __tablename__ = "gooni_snapshots"

    id = Column(Integer, primary_key=True)
    # Day key in YYYY-MM-DD form so we can dedupe/lookup without dealing with
    # tz-shifted DateTime comparisons.
    day = Column(String, unique=True, nullable=False, index=True)
    taken_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    raw_data = Column(Text, nullable=True)  # JSON string
    digest = Column(Text, nullable=True)


class Settings(Base):
    """Singleton row (id=1) holding user-level config that used to live in env.

    Daily nudge is the only consumer for now — but anything that needs runtime
    toggling without a redeploy belongs here. Schedule + channel list are the
    settable knobs; nudge_last_sent_day is the idempotency token (YYYY-MM-DD)
    that prevents two-process double-fire.
    """

    __tablename__ = "settings"

    id = Column(Integer, primary_key=True)  # always 1
    nudge_enabled = Column(Boolean, nullable=False, default=True)
    nudge_hour = Column(Integer, nullable=False, default=9)
    nudge_minute = Column(Integer, nullable=False, default=0)
    # IANA name, e.g. "America/Los_Angeles". Resolved via zoneinfo so the
    # schedule is wall-clock correct regardless of host timezone.
    nudge_tz = Column(String, nullable=False, default="America/Los_Angeles")
    # JSON list[str], e.g. ["telegram", "whatsapp"]. Empty list = no fanout.
    nudge_channels = Column(Text, nullable=False, default='["telegram"]')
    # YYYY-MM-DD in nudge_tz. Refuse to send a second time on the same date.
    nudge_last_sent_day = Column(String, nullable=True)
    # JSON dict {channel: {recipient: [ordered_todo_ids]}}. Persisted instead
    # of in-memory because FastAPI (sender) and the bot polling script
    # (reply-handler) run as separate processes.
    nudge_last_digests = Column(Text, nullable=False, default="{}")
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


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


class EvalSegment(Base):
    """An evaluable slice of a Conversation. Web sources have one segment per
    conversation (gap-bounded upstream by find_or_create_session); bot sources
    (telegram/whatsapp/imessage) reuse a single persistent conversation, so we
    slice them on demand by message gap (> EVAL_GAP_HOURS).

    Computed-on-demand and cached: the segmenter rebuilds rows when message
    counts drift. Eval state (status / rating / comment / dispatched_to_cc_at)
    is stored here, not on Conversation, so a single bot conversation can have
    independent ratings per segment.
    """

    __tablename__ = "eval_segments"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=False, index=True)
    # Inclusive bounds. start_message_id can be the first user message in the
    # window; end_message_id the last assistant or user message.
    start_message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    end_message_id = Column(Integer, ForeignKey("messages.id"), nullable=False)
    last_message_at = Column(DateTime(timezone=True), nullable=False, index=True)
    message_count = Column(Integer, nullable=False, default=0)
    # 'not_yet' (no human review) | 'pending' (started) | 'done'
    eval_status = Column(String, nullable=False, default="not_yet", index=True)
    # 1 = bad, 2 = meh, 3 = good. Null until reviewer scores.
    overall_rating = Column(Integer, nullable=True)
    overall_comment = Column(Text, nullable=True)
    # Stamped when the reviewer hits "Dispatch to Claude Code". Bundles the
    # eval into a Claude Code space note + a backlog list item.
    dispatched_to_cc_at = Column(DateTime(timezone=True), nullable=True)
    dispatched_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    # When the segmenter last rebuilt this row. Used to invalidate when the
    # underlying conversation grows past the cached message_count.
    computed_at = Column(DateTime(timezone=True), server_default=func.now())


class ClaudeUsageTurn(Base):
    """One assistant turn from a Claude Code session.

    Pushed by the local uploader script (scripts/upload_claude_usage.py)
    walking ~/.claude/projects/**/*.jsonl on Daniel's laptop and POSTing
    to /dashboard/claude-usage/ingest. Lets prod show stats without
    needing the JSONL files mounted on Fly.

    Idempotent on (session_id, ts) — re-uploading the same window is
    safe; UNIQUE constraint drops dupes server-side.
    """

    __tablename__ = "claude_usage_turns"
    __table_args__ = (
        UniqueConstraint("session_id", "ts", name="uq_claude_usage_turn_session_ts"),
    )

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, nullable=False, index=True)
    ts = Column(DateTime(timezone=True), nullable=False, index=True)
    model = Column(String, nullable=False)
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    cache_read_tokens = Column(Integer, nullable=False, default=0)
    cache_creation_tokens = Column(Integer, nullable=False, default=0)
    ingested_at = Column(DateTime(timezone=True), server_default=func.now())


class EvalStepFeedback(Base):
    """A reviewer's flag on a single trace step inside an assistant message.
    Many feedbacks per message — one per (message_id, step_key, step_index)
    pair. step_index disambiguates when a single message has multiple steps
    of the same type (e.g. two tool_call entries in one trace).
    """

    __tablename__ = "eval_step_feedback"
    __table_args__ = (
        UniqueConstraint("message_id", "step_key", "step_index", name="uq_eval_step_feedback"),
    )

    id = Column(Integer, primary_key=True, index=True)
    segment_id = Column(Integer, ForeignKey("eval_segments.id"), nullable=False, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False, index=True)
    # Step type from the trace list — e.g. 'intent', 'memory_recall',
    # 'master_prompt', 'extracted_signals', 'memories_applied', 'tool_call'.
    # Free-form so new step types can be flagged without a migration.
    step_key = Column(String, nullable=False)
    # Position in the trace list for the message — needed when a message has
    # multiple steps of the same key.
    step_index = Column(Integer, nullable=False, default=0)
    # 1 = bad, 2 = meh, 3 = good
    rating = Column(Integer, nullable=False)
    comment = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now())


class WhoopSnapshot(Base):
    """One row per day. Cached pull from Whoop's `recovery + cycle + sleep`
    endpoints so the dashboard / daily-nudge surfaces don't hit the Whoop
    API on every render. Idempotent on `date` — re-fetching just overwrites.
    """

    __tablename__ = "whoop_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, unique=True, index=True)

    # Recovery (0–100). The headline number Whoop shows in-app.
    recovery_score = Column(Integer, nullable=True)
    # Heart rate variability (RMSSD), in milliseconds.
    hrv_rmssd_ms = Column(Float, nullable=True)
    # Resting heart rate, beats per minute.
    resting_hr = Column(Integer, nullable=True)

    # Daily strain (0–21 scale on Whoop).
    strain = Column(Float, nullable=True)

    # Total sleep in minutes (in-bed time, matches Whoop's `total_in_bed_time`).
    sleep_minutes = Column(Integer, nullable=True)
    # Sleep performance percentage (0–100).
    sleep_performance_pct = Column(Float, nullable=True)

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)



