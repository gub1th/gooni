from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import deferred
from sqlalchemy.sql import func

from .database import Base


class Conversation(Base):
    """A session container for a back-and-forth with Claude."""

    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(Text, nullable=True)  # auto-generated short title
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
    # JSON-encoded embedding for the message text. Lazily populated by the
    # focus synthesizer on first read (messages are immutable post-create, so
    # cache never goes stale). Deferred so list/read queries don't hydrate
    # the ~31KB-per-row vector — same pattern as Note.embedding.
    embedding = deferred(Column(Text, nullable=True))
    # Ambient-loop v2 Slice 3 (glow): extract_signals found a promise-shaped
    # commitment in this user message. The log view renders a gutter dot;
    # Daniel promotes or dismisses. True is sticky (extractor verdict) —
    # the pending/promoted/dismissed lifecycle lives in signal_preview.
    has_actionable_signal = Column(Boolean, nullable=False, default=False)
    # JSON: {"signals": [<normalized promise-create signals>],
    #        "status": "pending"|"promoted"|"dismissed",
    #        "promise_ids": [..]}   (promise_ids set on promote — undo's target)
    signal_preview = Column(Text, nullable=True)


class ToolCall(Base):
    """Audit row for every chat tool invocation. Substrate for the anti-
    hallucination layer: an assistant claim "I added X to your list" only
    holds water if a matching ToolCall row exists with status=done. Also
    powers future ReAct loops by giving the orchestrator a queryable record
    of what already ran across turns.

    Lifecycle: row inserted just before tool.execute() with status='running'
    + started_at; updated after execute with status='done'/'failed',
    result_json, error, finished_at. message_id is backfilled by the
    orchestrator once the assistant Message row is created (NULL briefly
    during the LLM tool-use loop). conversation_id is set on insert so
    cross-turn queries can find in-flight rows before the message exists.
    """

    __tablename__ = "tool_calls"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(
        Integer, ForeignKey("conversations.id"), nullable=True, index=True
    )
    message_id = Column(
        Integer, ForeignKey("messages.id"), nullable=True, index=True
    )
    tool_name = Column(String, nullable=False, index=True)
    # Which surface invoked the tool: NULL/'chat' = the orchestrator's own
    # tool loop, 'mcp-stdio' = Claude Code, 'mcp-http' = the claude.ai remote
    # connector. Indexed because the question this column exists to answer —
    # "is this tool actually used, and by whom?" — is a group-by over it.
    # Nullable so every pre-existing chat row stays valid without a backfill.
    source = Column(String, nullable=True, index=True)
    args_json = Column(Text, nullable=True)
    # 'running' | 'done' | 'failed'. No 'pending' for v1 because we don't
    # have async tools yet — every call goes running → done|failed in the
    # same orchestrator turn. Reserve 'pending' for the future async path.
    status = Column(String, nullable=False, default="running", index=True)
    result_json = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(Text, nullable=True)
    content = Column(Text, nullable=True)
    # Plain-text preview computed from `content` on every save (HTML stripped,
    # <img> tags dropped, capped at 240 chars). Cached so list endpoints can
    # ship a row without re-running the regex on every request and without
    # exposing inline base64 image bodies. Backfilled lazily at startup.
    excerpt = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)
    last_opened_at = Column(DateTime, nullable=True)
    # JSON-serialised float list (~31KB per row for 1536-dim
    # text-embedding-3-small). Deferred so the column isn't hydrated by
    # default — every Note row would otherwise carry 31KB of vector data
    # through ORM materialisation just to be discarded by the response
    # serializer. Similarity paths (note_service, memory recall, classify
    # dedup) opt back in via tuple queries `db.query(Note.id, Note.embedding)`
    # or `options(undefer(Note.embedding))`.
    embedding = deferred(Column(Text, nullable=True))
    is_public = Column(Boolean, default=False, nullable=False)
    is_pinned = Column(Boolean, default=False, nullable=False)
    # Separate from is_pinned (sidebar). Pins this note to the top of the
    # /public page as a hero card. Independent of is_pinned so a note can
    # be a public-page hero without crowding the owner's working sidebar.
    is_public_pinned = Column(Boolean, default=False, nullable=False)
    # User-marked "I intend to publish this" flag. Surfaces in the sidebar's
    # DRAFTS section so in-progress posts have a fast path back; independent
    # of is_pinned (a draft can also be pinned). Auto-clears when the note
    # flips to public — once it ships, it's no longer a draft.
    is_draft = Column(Boolean, default=False, nullable=False)
    # Optional Notion-style note icon — single emoji OR a "lucide:<name>"
    # reference (same encoding Space.emoji uses, see SpaceIcon). Null =
    # no icon (Gooni's default). Stored as Text so we can switch
    # encodings later without a migration.
    icon = Column(Text, nullable=True)
    # Snapshot of the note's embedding at the moment the unified extractor
    # last classified its content. Used as the dedup gate for re-running
    # the classifier — if the live embedding has cosine ≥ ~0.92 vs this
    # snapshot, the meaning hasn't shifted enough to warrant another pass.
    # Deferred — only ever read inside `classify_note`'s dedup check.
    classified_embedding = deferred(Column(Text, nullable=True))
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
    # Free-form user/agent tags. JSON array of lowercase short strings
    # (e.g. ["from-claude", "feedback", "session-2026-05-17"]).
    # Stored as JSON text so a fast LIKE check can answer "does this note
    # carry tag X" without a join — sidebar filtering is the main use
    # case, and tag cardinality is low per-note (typically 1-3). When a
    # M2M `note_tags` table is needed (cross-cutting analytics across
    # the whole corpus) we can derive it from this column.
    tags = Column(Text, nullable=True)
    # The day this note is "about" — set ONLY for per-day "daily log" notes
    # (the log-matrix note column: "what happened on date X"). One daily note
    # per date, carried by the `daily` tag. Distinct from created_at because
    # you can edit or backfill a past day's note today. Null = an ordinary
    # note. Indexed so the matrix can pull a date-range of daily notes cheaply.
    log_date = Column(Date, nullable=True, index=True)
    # Placement of a "sticky note" on the ambient home canvas. JSON-as-text
    # of shape {"x": float, "y": float} where x/y are FRACTIONS of the
    # viewport (0..1) so a note parked on a big monitor lands in-frame on a
    # laptop too. Set only for stickies (carried by the `sticky` tag); null
    # for every other note. Text (not a JSON column) so the placement shape
    # can grow (pinned?, color?) without a migration.
    home_pos = Column(Text, nullable=True)
    # The subject this note belongs to (focus convergence, 2026-08-08). A real
    # FK, NOT a tag: `tags` are free-text strings with no identity, and Topic
    # carries a decay curve anchored to `last_touched` — computing that by
    # LIKE-matching a JSON column would be both slow and wrong the moment a
    # topic is renamed. Tags stay for every other kind of grouping.
    #
    # Set on the two focus-derived note subtypes (`thought`, `thought-batch`)
    # and free for ordinary notes to adopt. Null = ungrouped, the common case.
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True, index=True)


class PublicProfile(Base):
    __tablename__ = "public_profile"

    id = Column(Integer, primary_key=True)
    bio = Column(Text, nullable=True)  # raw text/markdown, user-written
    # URL to a user-uploaded avatar (Cloudflare R2 image). NULL falls back to
    # the per-name "goofy emoji" default in the comments avatar renderer.
    avatar_url = Column(String, nullable=True)


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
      'fact'       — declarative facts about Daniel (incl. identity-shaped
                     aspirations like "wants to be a thoughtful engineer")
      'routine'    — habits + recurring patterns
      'constraint' — hard limits (allergies, schedule blockers, dealbreakers)
      'episode'    — free-form chat extract; no key, just embedded content

    NOTE: 'goal' was removed — action-shaped aspirations live in list_items
    (focuses) instead. Identity-shaped values fold into 'fact'.

    Updates use a supersede chain: when a fact contradicts an old one, the
    old row gets is_active=False and superseded_by=<new id>. Audit trail
    survives. The reconcile LLM step decides per candidate whether to ADD,
    UPDATE (supersede), DELETE (mark inactive), or NONE (boost confidence).
    """

    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    # 'preference' | 'fact' | 'routine' | 'constraint' | 'episode'
    type = Column(String, nullable=False, index=True)
    # snake_case slug for typed memories so we can lookup by key. NULL for episodes.
    key = Column(String, nullable=True, index=True)
    content = Column(Text, nullable=False)
    # JSON: {"time": str?, "location": str?, "scope": "global"|"contextual"}
    context = Column(Text, nullable=True)
    confidence = Column(Float, nullable=False, default=0.8)
    # JSON-serialized embedding vector for cosine search. Deferred —
    # memory_service queries `(Memory.id, Memory.embedding)` as a tuple
    # for retrieval, so the ORM doesn't hydrate ~31KB per row on every
    # Memory load (e.g. dashboard.recent_memories, /memories list).
    embedding = deferred(Column(Text, nullable=True))
    # Origin tracking — set when this memory was extracted from a note's
    # classify_note run. Lets the editor surface "this note created N
    # memories" disclosure. NULL for memories from chat or other paths.
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    # Chat-provenance twin of source_note_id: the user-utterance Message this
    # memory was extracted from. Mirrors Promise.source_message_id. NULL for
    # note-derived or pre-provenance memories. Together they let /memories
    # answer "where did this come from" for BOTH capture paths.
    source_message_id = Column(Integer, ForeignKey("messages.id"), nullable=True, index=True)
    is_active = Column(Boolean, nullable=False, default=True)
    superseded_by = Column(Integer, ForeignKey("memories.id"), nullable=True)
    # Retrieval tracking — bumped per turn for memories that survive cosine
    # gating (facts + episodes). Always-inject prefs are NOT counted: their
    # count would equal turn-count and carry no signal. Lets us answer
    # "which memories actually earn their slot" without mining traces.
    retrieval_count = Column(Integer, nullable=False, default=0)
    last_retrieved_at = Column(DateTime, nullable=True, index=True)
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


class Settings(Base):
    """Singleton row (id=1) holding user-level config that used to live in env.

    Anything that needs runtime toggling without a redeploy belongs here.
    (The daily-digest + proactive-nudge knobs died in the 2026-07
    proactiveness reset; `nudge_tz` survives because it became the app-wide
    canonical timezone.)
    """

    __tablename__ = "settings"

    id = Column(Integer, primary_key=True)  # always 1
    # IANA name, e.g. "America/Los_Angeles". Legacy column name — this is the
    # app-wide canonical timezone: local_today()/local_now() in common.py
    # resolve every user-facing calendar day against it.
    nudge_tz = Column(String, nullable=False, default="America/Los_Angeles")
    # Cut-table config (the fitness/cut dashboard). Limits drive the cell
    # red/green (cal green when ≤ limit, protein green when ≥ limit) and are
    # set via the Cal/Pro header popup. cut_start_date anchors the "Day N"
    # counter. Server-side (not localStorage) so chat/nudges can read the
    # limits later ("you're over your cal target, sir").
    cut_calorie_limit = Column(Integer, nullable=False, default=2100)
    cut_protein_limit = Column(Integer, nullable=False, default=170)
    cut_start_date = Column(String, nullable=True)  # YYYY-MM-DD
    # Ambient overlay (Slice 4). anchor = the single pinned Note the
    # overlay's anchor zone shows (Daniel's north-star doc). whoop_keys =
    # JSON list[str] of whoop-source Trackable names the whoop-select zone
    # renders (Daniel picks the metrics he actually reads; empty = zone
    # hidden). Server-side so the selection survives devices.
    overlay_anchor_note_id = Column(Integer, nullable=True)
    overlay_whoop_keys = Column(Text, nullable=False, default="[]")
    # focus-cam control + live state (a local webcam sidecar senses focus and
    # reports up; Gooni stores + serves via /focus/cam/*). Text-not-JSON so the
    # blob shape can grow without a migration (same convention as
    # overlay_whoop_keys / Note.home_pos). NULL → treat as {"control":"idle"}.
    # Shape: {control: idle|running, state: focused|distracted|away|paused|null,
    #         score: float|null, app: str|null, session_id: str|null, at: iso|null}.
    focus_cam = Column(Text, nullable=True)
    # Ambient display state — the SAME declarative reconcile-poll shape as
    # focus_cam, one level up: the UI/Shortcuts write a DESIRED state, the kiosk
    # polls GET /display and reconciles. Text-not-JSON for the same reason (the
    # blob grows without a migration). NULL → treat as {"desired": "rest"}.
    # Shape: {desired: deep_rest|rest|awake|dash, at: iso|null, source: str|null}.
    #   deep_rest — away from home (Shortcuts "left house"); dimmest, no data
    #   rest      — home, Gooni asleep on the desk
    #   awake     — Gooni up behind the desk, still no data
    #   dash      — the dashboard, summoned deliberately (desk button)
    display = Column(Text, nullable=True)
    # The proactive layer's runtime kill switch (see services/proactive_service).
    # Settings-not-env on purpose: this is the knob you want to reach in seconds
    # from the UI when the loop starts saying something stupid, and this table
    # exists for exactly "runtime toggling without a redeploy". The env var
    # GOONI_PROACTIVE_DISABLED still wins over it — a prod stop must not need a
    # database write. Defaults ON: a proactive layer nobody switches on is never
    # evaluated, which is the same non-feature with a better excuse.
    proactive_enabled = Column(Boolean, nullable=False, default=True)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )



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


class EvalMessageRating(Base):
    """Reviewer thumbs on a single assistant reply. One row per message.
    Step-level EvalStepFeedback is too narrow (a step can look fine while
    the reply is wrong) and segment overall is too coarse — per-message
    is the granularity that actually maps to "was this reply good?".
    """

    __tablename__ = "eval_message_ratings"

    id = Column(Integer, primary_key=True, index=True)
    segment_id = Column(Integer, ForeignKey("eval_segments.id"), nullable=False, index=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False, unique=True, index=True)
    # 1 = bad, 2 = meh, 3 = good. NULL allowed so reviewers can save a
    # standalone note without picking a thumbs (Daniel kept losing notes
    # when the Save button gated on rating). Caller must supply rating OR
    # comment — empty rows are rejected at the route layer.
    rating = Column(Integer, nullable=True)
    comment = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now())


class Trackable(Base):
    """Generic measurement definition — ambient-loop v2's Notion-tables
    primitive (Slice 2). One row per thing-Daniel-tracks: calories,
    protein, weight, weed, sleep score, leetcode streak, anything.
    Absorbs DailyMetric's hardcoded metric_type vocabulary and (Slice 5)
    the Whoop/Leetcode snapshot tables.

    `kind` fixes which TrackableEntry value column is live:
      boolean → value_boolean   (did/didn't: substances, exercise)
      numeric → value_numeric   (calories, weight)
      json    → value_json      (arbitrary payloads; schema_hint describes)
    `agg` fixes the per-day fold for pivots:
      sum  → additive within a day (calories, protein)
      last → newest entry wins (weight, substances, notes)
    Adding a new tracked thing = one INSERT. No migration.
    """

    __tablename__ = "trackables"

    id = Column(Integer, primary_key=True, index=True)
    # Lowercase-normalized, unique — service resolves by name so chat +
    # MCP + feeds converge on the same definition.
    name = Column(String, nullable=False, unique=True, index=True)
    # 'boolean' | 'numeric' | 'json'
    kind = Column(String, nullable=False, default="numeric")
    unit = Column(String, nullable=True)
    # Recurrence expectation, mirrors Promise cadence vocabulary. Purely
    # informational for the overlay's met/missed/pending render.
    cadence = Column(String, nullable=True)
    # Numeric goal (calorie limit, protein floor). Direction is semantic
    # (limit vs floor) — the consumer decides; deterministic either way.
    target = Column(Float, nullable=True)
    is_important = Column(Boolean, nullable=False, default=False)
    # 'sum' | 'last' — per-day fold rule for pivots.
    agg = Column(String, nullable=False, default="last")
    # JSON-text description of the value_json payload shape. A hint for
    # LLM/tool callers, NOT a validation constraint (runtime stays loose).
    schema_hint = Column(Text, nullable=True)
    # 'manual' | 'chat' | 'whoop' | 'leetcode' | 'github' | 'derived'
    source = Column(String, nullable=False, default="manual")
    # A commitment can carry its measurement instrument ("The Cut" owns
    # the weight Trackable).
    parent_promise_id = Column(
        Integer, ForeignKey("promises.id"), nullable=True, index=True
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class TrackableEntry(Base):
    """One value row for a Trackable on a calendar day. Sparse value
    columns by kind + a JSON overflow for arbitrary shapes. Multiple
    rows per (trackable, date) are legal — the pivot folds per the
    definition's `agg` rule (sum vs last), which is how additive
    calorie logging and last-wins weigh-ins share one table.
    """

    __tablename__ = "trackable_entries"

    id = Column(Integer, primary_key=True, index=True)
    trackable_id = Column(
        Integer, ForeignKey("trackables.id"), nullable=False, index=True
    )
    date = Column(Date, nullable=False, index=True)
    value_boolean = Column(Boolean, nullable=True)
    value_numeric = Column(Float, nullable=True)
    # JSON-text payload: labels ("gym — legs"), per-entry units, freeform
    # notes, or the whole value for kind=json trackables.
    value_json = Column(Text, nullable=True)
    # 'chat' | 'manual' | 'whoop' | 'leetcode' | 'migration' | ...
    source = Column(String, nullable=False, default="manual")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        # Every read path (pivot, running total) filters on both.
        Index("ix_trackable_entries_tid_date", "trackable_id", "date"),
    )


class WaProcessedId(Base):
    """Idempotency log for inbound WhatsApp messages.

    Meta's WhatsApp Cloud API redelivers any webhook delivery we don't 200-ack
    fast enough (their ceiling is ~20s; one chat turn through the orchestrator
    can take 30s+ on a slow LLM round-trip). Every retry carries the same
    `messages[i].id` (a stable `wamid.…` string). We insert it on first sight
    inside the HTTP handler — UNIQUE on `wamid` forces a clean dedup boundary
    so a parallel-arriving retry hits IntegrityError instead of double-firing
    the orchestrator.

    Rows are cheap and small; a tiny background sweep can age them out past
    24h if the table grows, but it isn't load-bearing for correctness.
    """

    __tablename__ = "wa_processed_ids"

    wamid = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class Reflection(Base):
    """Per-turn self-evaluation row. Written asynchronously after every
    assistant Message lands. The Reflexion pattern (Shinn et al.) — Gooni
    judges its own most recent reply against Daniel's intent + tool outcomes
    and surfaces gap_exposed / proposed_self_fix.

    Severity 1 = clean turn, 2 = notable, 3 = load-bearing. All rows persist
    (even severity 1) so the reflexion classifier itself stays eval-able.

    When severity >= 2 and gap_exposed is non-null, the gap text gets embedded
    and cosine-clustered against prior reflections. A cluster of >= 3 hits at
    similarity > 0.8 auto-promotes a behavioral CapabilityFacet — that's how
    Gooni learns persistent patterns about itself without nightly cron jobs.
    """

    __tablename__ = "reflections"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(
        Integer,
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    conversation_id = Column(
        Integer,
        ForeignKey("conversations.id"),
        nullable=False,
        index=True,
    )
    user_critique_present = Column(Boolean, nullable=False, default=False)
    critique_summary = Column(Text, nullable=True)
    action_vs_described = Column(String, nullable=False)
    # 'acted' | 'described' | 'mixed' | 'na'
    gap_exposed = Column(Text, nullable=True)
    gap_embedding = deferred(Column(Text, nullable=True))
    # json.dumps([float, ...]) — same convention as Note.embedding etc.
    proposed_self_fix = Column(Text, nullable=True)
    severity = Column(Integer, nullable=False, default=1)
    # 1 = clean, 2 = notable, 3 = load-bearing
    model = Column(String, nullable=False)
    # Discriminator. 'turn' = standard per-message reflection (the original
    # use case). 'conv_rollup' = an aggregated summary written by a periodic
    # rollup job that clusters recent turn-reflections in a conversation
    # into one paragraph of recurring patterns. Rollups inject INTO the
    # master prompt's capability block instead of raw turn reflections so
    # the prompt doesn't drift over time.
    kind = Column(String, nullable=False, default="turn", index=True)
    # FK to the prior Reflection in the same conversation. Lets each new
    # reflection see its own lineage during anti-redundancy checks ("am I
    # repeating the same gap_exposed as my predecessor?"). Nullable —
    # first reflection in a conv has no prior.
    prev_reflection_id = Column(
        Integer,
        ForeignKey("reflections.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 1-10 quality score derived from gap_dimension + severity (and other
    # signals as we add them). Nullable so legacy rows / parse-failed
    # reflections don't break aggregations. Higher = better turn.
    score = Column(Float, nullable=True)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


class Promise(Base):
    """A forward-looking commitment — THE actionable primitive post
    ambient-loop v2. Absorbs the old Todo (a Promise with cadence=once),
    Habit (cadence=daily / n_per_week / permanent_*), and eventually Focus
    (a Promise with children via parent_promise_id).

    Lifecycle: active → kept | broken. State transitions fire from chat
    ("did it" → kept, "not doing it" → broken), the dashboard PATCH, or
    time-anchored auto-broken when inferred_due passes unconfirmed.

    Cross-entity links (supports Focus, utters from Message) live in the
    `edges` table — Promise can semantically connect to many things and
    adding an FK column per relation would explode the schema. The one
    exception is parent_promise_id: parent-child nesting is 1-to-many
    ownership, so a self-FK is the right tool.
    """

    __tablename__ = "promises"

    id = Column(Integer, primary_key=True, index=True)
    # Ambient-loop v2: how often this commitment recurs.
    #   once           — one-shot ("ship the eval by friday")
    #   daily          — every day ("leetcode daily")
    #   n_per_week     — N times a week; N lives in cadence_target ("gym 6x/wk")
    #   permanent_do   — standing do-rule ("always stretch after runs")
    #   permanent_never— standing avoid-rule ("no weed")
    cadence = Column(String, nullable=False, default="once", index=True)
    # N for n_per_week; null for every other cadence.
    cadence_target = Column(Integer, nullable=True)
    # User-set importance flag ("that's important" in chat / star tap).
    # Deterministic overlay ranking input — never LLM-inferred.
    is_important = Column(Boolean, nullable=False, default=False)
    # Parent-child nesting: a Focus-shaped Promise owns child Promises
    # ("The Cut" owns the daily-calorie child). Nullable self-FK.
    parent_promise_id = Column(
        Integer, ForeignKey("promises.id"), nullable=True, index=True
    )
    # Verbatim quote of what Daniel said. Preserves his words for the
    # follow-up ("you said 'imma finish the video tonight' — still on?").
    utterance = Column(Text, nullable=False)
    # LLM-summarized one-line description for places where the raw
    # utterance is too long or needs scrubbing (dashboard cards, nudge
    # subject lines).
    summary = Column(Text, nullable=True)
    # Inferred deadline parsed from the utterance ("tonight" → today
    # 23:59 local; "this week" → +7 days from creation; null when no
    # time anchor is present).
    inferred_due = Column(DateTime, nullable=True)
    # G3.1: 3-state lifecycle — `active` | `kept` | `broken`. Earlier
    # `proposed` / `pending` / `abandoned` collapsed away (data migrated
    # in `43a0649e9e06`). Per Daniel: "you don't want to stall on a
    # promise. it's active, then kept or broken." Lock-in is gone.
    state = Column(String, nullable=False, default="active", index=True)
    # Vague-promise flag: once-cadence + no resolvable deadline, set
    # structurally at create time (the old promise_complexity regex died in
    # the post-sweep fixes). Doesn't gate the lifecycle (the promise is
    # `active` either way) — drives ack composition (sharp clarifier) and
    # future weekly digest stats ("X of N promises this week were vague,
    # you sharpened Y of them"). Sharpening happens when a follow-up
    # extract_signals turn refines the utterance and supersedes the
    # original — at that point this flag can be cleared.
    needs_clarification = Column(Boolean, nullable=False, default=False)
    # How many times Daniel has previously broken a near-identical
    # promise (cosine-matched against past broken promises at create
    # time). Drives slip-pattern memory without aggregation queries.
    slip_count = Column(Integer, nullable=False, default=0)
    # Timestamp when state flipped to a terminal (kept/broken/abandoned).
    # Null while pending.
    resolved_at = Column(DateTime, nullable=True)
    # FK to the Message that triggered creation. Ownership — every
    # promise has a single canonical source utterance, so FK is the
    # right tool. Cross-cutting many-to-many links live in `edges`.
    source_message_id = Column(
        Integer, ForeignKey("messages.id"), nullable=True, index=True
    )
    # Cached embedding for cosine matches against focuses (to wire
    # `supports` edges) and against historical broken promises (for
    # slip_count). Deferred — same pattern as Note.embedding so list
    # queries don't hydrate the ~31KB vector.
    embedding = deferred(Column(Text, nullable=True))
    # ── absorbed from Reminder (focus convergence, 2026-08-08) ───────────────
    # The person this is owed to. Null = owed to yourself, which is the common
    # case and renders without an "owed to" prefix. This is the one thing the
    # focus system's Reminder had that Promise couldn't express — a commitment
    # to another human ("owed to Yash · 6d") reads differently from one you
    # made to yourself, and the age meta only earns its place on the former.
    owed_to = Column(
        Integer, ForeignKey("focus_people.id"), nullable=True, index=True
    )
    # True when NOBODY chose this deadline — the service defaulted `inferred_due`
    # to today's local EOD so the row can be placed on the dashboard's
    # short-term/longer-term split (a dateless row lands in neither panel).
    #
    # Load-bearing, not bookkeeping: `auto_mark_overdue` must NEVER break a
    # defaulted due. Gooni inventing a deadline and then marking you broken for
    # missing it is the system lying about a commitment you never made. A stale
    # defaulted due rolls forward to today instead.
    due_is_default = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class Edge(Base):
    """Graph layer for semantic many-to-many links across entities.

    Ownership FKs (Memory.source_note_id, Note.parent_note_id, etc) stay —
    those model OWNERSHIP. This table models semantic links where adding an
    FK column per relation would M²-explode the schema as new entities land.
    Promise is the first citizen; new entity types plug in for free.

    Edge kinds (v1):
      'utters'        — Message → Promise   (source utterance)
      'supports'     — Promise → Focus      (this promise serves a focus)
      'closes'       — Promise → Todo       (promise fulfilled by completing todo)
      'derives_from' — generic provenance (e.g. Note → Promise via classify)
      'mentions'     — references without owning

    Uniqueness: (src_kind, src_id, dst_kind, dst_id, kind) — re-emit of
    the same link is idempotent. Indexes on (src_kind, src_id) and
    (dst_kind, dst_id) for both-direction traversal.
    """

    __tablename__ = "edges"

    id = Column(Integer, primary_key=True, index=True)
    src_kind = Column(String, nullable=False)
    src_id = Column(Integer, nullable=False)
    dst_kind = Column(String, nullable=False)
    dst_id = Column(Integer, nullable=False)
    kind = Column(String, nullable=False)
    # Optional confidence/strength on the link (0..1). Cosine similarity
    # for inferred edges, null for explicit user-authored ones.
    weight = Column(Float, nullable=True)
    # Arbitrary kind-specific metadata as JSON string.
    metadata_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "src_kind", "src_id", "dst_kind", "dst_id", "kind",
            name="uq_edges_endpoints_kind",
        ),
        Index("ix_edges_src", "src_kind", "src_id"),
        Index("ix_edges_dst", "dst_kind", "dst_id"),
    )


# ───────────────────────────────────────────────────────────────────────────
# Focus system (2026-07-23) — CONVERGED into the v2 primitives 2026-08-08
#
# The original design shipped a parallel primitive set alongside ambient-loop
# v2 so it could go out without entangling the chat pipeline. The duplication
# was accepted on purpose: Topic ≈ the nuked Focus/Space, Thought ≈ a
# lightweight Note, Reminder ≈ Promise.
#
# Six weeks of real writes made the cost concrete. Claude reached Gooni through
# TWO connectors — claude.ai's `/mcp` wrote focus tables, Claude Code's stdio
# server wrote v2 tables — and nothing linked them. By 2026-08-08 all four
# `reminders` rows in prod were verbatim duplicates of `promises` rows: mark
# one kept and the other stood active forever. No code copied them; the same
# commitment was simply written through both doors.
#
# So the focus primitives now map onto v2 (`focus_service` is the adapter, the
# same shape `daily_metric_service` has over Trackable):
#   Thought       → Note, tag `thought`, `parent_note_id` → its batch
#   ThoughtBatch  → Note, tag `thought-batch`, title = Claude's label
#   batch image   → Attachment (note-owned already)
#   Reminder      → Promise + `owed_to` + `due_is_default`
#   reminder.thought_id → Edge `derives_from`
#   Mention       → dropped (0 rows, no writer, no tool)
#
# SURVIVING focus tables: Topic (identity + a decay curve nothing else models)
# and Person (v2 has no person primitive at all). They are all that's left of
# the focus schema — `focus_service` reads Notes and Promises for everything
# else.
#
# The four absorbed tables are GONE (`b8f3d1c07a45`, the contract half). They
# survived one release, unread, so the backfill could be diffed in prod; that
# drop stamped a `converged_from_*` edge per source row first, which is what
# lets its downgrade rebuild them from the v2 side with their original ids —
# for every row whose stamped v2 destination is still there and still usable.
# A rollback after one of those was deleted comes back partial, and says so.
# ───────────────────────────────────────────────────────────────────────────


class Topic(Base):
    """A subject Daniel thinks about — replaces the old "focus area". Topics
    nest (parent_id self-FK → subtopics) and carry a *decaying* salience.

    Salience model (deterministic, no scheduled job):
      - `salience` is the STORED value, bumped on every write to the topic
        (a logged thought). Clamped to [0.01, 0.99] — never 0, so nothing
        ever fully disappears.
      - The DISPLAYED value is `salience × decay(now - last_touched)`, floored
        at 0.01. Computed on read in focus_service.decayed_salience — the
        column is never mutated by the passage of time, only by writes.
    Size on the dashboard = decayed salience; pulse = growth (recent bump).
    """

    __tablename__ = "topics"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    # Self-FK for subtopics. Null = a root topic.
    parent_id = Column(Integer, ForeignKey("topics.id"), nullable=True, index=True)
    # Stored salience in [0.01, 0.99]. Bumped on write, decayed on read.
    salience = Column(Float, nullable=False, default=0.3)
    # Last write to this topic (a logged thought). Anchors the decay curve.
    last_touched = Column(DateTime, default=datetime.utcnow, nullable=False)
    # Per-topic identity color (hex). NOT meaning — a permanently-red circle
    # becomes wallpaper. Stable per topic so Daniel learns where each lives.
    # Small addition beyond the specced table: lets the circle color persist
    # + be overridden rather than hashing it from the name each render.
    color = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Person(Base):
    """Someone Daniel mentions or owes something to. Scope discipline (plan):
    a table and a join, nothing more — no relationship graph, no contact sync,
    no interaction-frequency tracking. Staleness-for-people is a deferred v2."""

    __tablename__ = "focus_people"  # 'people' is a common reserved-ish name; prefix to be safe

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    # How Daniel knows them — "CMU club tennis". Free text.
    context = Column(Text, nullable=True)
    first_seen = Column(DateTime, default=datetime.utcnow, nullable=False)


class Attachment(Base):
    """File attached to a Note (PDF, doc, archive, etc.). Stored on R2; the
    DB row carries metadata + the public URL. Distinct from inline <img>
    figures, which live in note HTML. (Todo ownership died with Todo in the
    v2 nuke — note_id is the only owner now; if promises ever need
    attachments, add a nullable FK then.)"""

    __tablename__ = "attachments"

    id = Column(Integer, primary_key=True, index=True)
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    filename = Column(Text, nullable=False)
    mime_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    # R2 object key (e.g. "attachments/2026/05/17/abc123.pdf"). Kept so we
    # can later delete the underlying object if the note is deleted.
    storage_key = Column(Text, nullable=False)
    # Public R2 URL — what the frontend renders / downloads from.
    public_url = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class BrowserInterval(Base):
    """One stretch of browser attention: a single tab held focus from
    `started_at` to `ended_at`. Written by the Chrome extension sensor
    (`extension/`), which buffers locally and POSTs batches to
    /browser/intervals.

    RAW SENSOR DATA ONLY, and it STAYS that way: no Trackable, and no
    promise/topic column on the row. The attribution layer this table was kept
    clean for now exists (`app/services/focus_attribution.py`), and it reads
    these rows rather than writing to them — it overlaps them against the
    windows of a running focus session at READ time. Nothing may stamp a
    commitment here at ingest: the extension buffers and retries, so an
    interval measured at 14:30 legitimately arrives at 18:00 and would be filed
    against whatever was running then. See that module for the full argument.

    Privacy: the full URL is captured for EVERY host — the question this sensor
    exists to answer ("what was I distracted by?") dies with hostname-only data,
    and the primary use case's task identity lives in the path
    (leetcode.com/problems/<slug>/). The one thing that never lands here is
    credentials: the extension strips credential-bearing query params
    (token, code, secret, password, session, access_token…) before the URL is
    even buffered, and `browser_activity_service.scrub_url` re-runs that strip
    server-side as a backstop. Everything else in the query string survives on
    purpose — a YouTube video id lives in `?v=` and is exactly the identity the
    log needs.

    Idempotency: `client_id` is generated by the extension when the interval
    CLOSES and travels with it through every retry, so a redelivered batch
    (offline flush, browser restart mid-flush, a 500 the client retries) hits
    the UNIQUE index instead of double-counting attention. Same trick as
    WaProcessedId's `wamid`, one table over.
    """

    __tablename__ = "browser_intervals"

    id = Column(Integer, primary_key=True, index=True)
    # Client-generated stable id (UUID). UNIQUE = the dedup boundary.
    client_id = Column(String, nullable=False, unique=True, index=True)

    host = Column(String, nullable=False, index=True)
    # Full URL with credential-bearing query params scrubbed (see above).
    # `path` is split out so path-prefix queries ("/problems/…") don't have to
    # LIKE against the whole URL. Nullable only for defensiveness — a URL the
    # extension couldn't parse still yields a usable host row.
    path = Column(Text, nullable=True)
    url = Column(Text, nullable=True)
    title = Column(Text, nullable=True)

    # Naive UTC, matching the rest of the codebase's datetime storage.
    started_at = Column(DateTime, nullable=False, index=True)
    ended_at = Column(DateTime, nullable=False)
    # Recomputed server-side from started/ended — the client's arithmetic is
    # never trusted, only its clock readings.
    duration_sec = Column(Float, nullable=False)

    # Why the interval closed: tab_change | url_change | window_blur | idle |
    # locked | shutdown | truncated. `truncated` marks an interval closed at a
    # heartbeat rather than a real end event (browser killed mid-interval), so
    # downstream code can tell a measured span from a salvaged one.
    end_reason = Column(String, nullable=True)
    truncated = Column(Boolean, nullable=False, default=False)

    source = Column(String, nullable=False, default="chrome_extension", index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


Index("ix_browser_intervals_host_started", BrowserInterval.host, BrowserInterval.started_at)


class AppInterval(Base):
    """One stretch of DESKTOP attention: a single macOS application was
    frontmost from `started_at` to `ended_at`. Written by the Electron shell's
    frontmost-app sensor (`desktop/src/appfocus.js`), which buffers locally and
    POSTs batches to /app/intervals.

    The OS twin of BrowserInterval, and deliberately its OWN table rather than a
    `source` discriminator on that one. The two sensors share a shape, not a
    vocabulary: `host` is a hostname and `app` is an application name, and every
    existing browser read — the extension popup's per-host ranking, the SQL
    `summarize` fold, `GET /browser/intervals` — would have to grow a source
    filter it currently doesn't need, with a silent wrong answer (an app listed
    as a visited domain) as the cost of missing one. A table each keeps the
    browser reads exactly as honest as they were, and the shared parts —
    validation limits, the `client_id` idempotency boundary, the per-row
    SAVEPOINT insert — are shared as CODE (`interval_ingest.py`), which is the
    part worth not duplicating.

    RAW SENSOR DATA ONLY, same as BrowserInterval: not a Trackable, and no
    commitment stamped on the row. Surfacing an `opened <app>` row in the
    activity feed is presentation over this substrate, not attribution — no
    percentage, no judgement, no binding to a commitment. Binding to a
    commitment happens in `focus_attribution`, as a read-time overlap against
    focus-session windows, for the reasons in BrowserInterval's docstring.

    Privacy: the app NAME is what the OS reports as frontmost. `title` (the
    window title) is optional and is NOT collected by the shell today — the
    column exists because a window title is the only thing that could ever
    distinguish "Cursor on gooni" from "Cursor on something private", and that
    is a decision to make deliberately rather than a column to add in a panic.

    Idempotency: `client_id` is minted by the shell when the interval CLOSES and
    survives every retry — the same UNIQUE-index dedup boundary the browser
    sensor and WaProcessedId use.
    """

    __tablename__ = "app_intervals"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(String, nullable=False, unique=True, index=True)

    # Frontmost application name as the OS reports it, lowercased ("cursor",
    # "google chrome"). Lowercase because the Shortcuts device vocabulary is
    # lowercase (`event_service._norm`) and the two render side by side.
    app = Column(String, nullable=False, index=True)
    # Window title. Nullable and currently always NULL — see the class docstring.
    title = Column(Text, nullable=True)

    # Naive UTC, matching the rest of the codebase's datetime storage.
    started_at = Column(DateTime, nullable=False, index=True)
    ended_at = Column(DateTime, nullable=False)
    # Recomputed server-side from started/ended — the client's arithmetic is
    # never trusted, only its clock readings.
    duration_sec = Column(Float, nullable=False)

    # Why the interval closed: app_change | idle | locked | suspended |
    # shutdown | unobserved | truncated — the full set the shell can stamp
    # (`desktop/src/appfocus.js`) and the one `app_activity_service._END_REASONS`
    # accepts. `truncated` marks an interval closed at a heartbeat rather than a
    # real end event (the shell was killed, or the machine slept, mid-interval);
    # `unobserved` marks one the sensor closed itself because the frontmost
    # query went blind, which is a WEDGED sensor rather than a crash salvage.
    # Both carry the `truncated` flag, so this column is what tells them apart.
    end_reason = Column(String, nullable=True)
    truncated = Column(Boolean, nullable=False, default=False)

    source = Column(String, nullable=False, default="desktop_shell", index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


Index("ix_app_intervals_app_started", AppInterval.app, AppInterval.started_at)


class ProactiveObservation(Base):
    """One thing Gooni noticed while nobody was talking to it.

    The store behind the background proactive loop (`services/proactive_service`
    + `background._proactive_loop`): every ~15 minutes the loop folds the
    device sensors, the live focus session, the ranked action horizon and
    today's trackable status into one bounded context, makes ONE cheap model
    call, and — if the model finds something worth saying — writes a row here.
    `GET /proactive/current` serves the newest live one to the ambient home.

    A TABLE rather than a module-level dict, for three reasons, none of them
    about volume (this writes at most ~96 rows a day and usually far fewer):

      1. Fly restarts. A machine suspend mid-window would silently drop the
         observation AND the fact that Daniel had dismissed it, so the next
         tick would cheerfully surface the thing he just waved away.
      2. Dismissal has to outlive the row it dismissed. `_is_repeat` reads
         dismissed rows for a longer cooldown than live ones precisely so a
         dismissal means something; that read needs history.
      3. Tuning. The only way to answer "is the asymmetric-value rule actually
         holding?" is to look at what the loop said over a week — which is why
         `context_digest` stores the exact context the model was shown. Same
         instinct as the verify rail's ledger riding in the trace `meta`: a bad
         output should be debuggable without re-running the tick that made it.

    NOT written from a chat turn, ever. This is a separate background process
    and touching the orchestrator from here would put a model call on the
    request path the whole design exists to keep clear.
    """

    __tablename__ = "proactive_observations"

    id = Column(Integer, primary_key=True, index=True)

    # The line itself — one sentence, already clamped by the service. Rendered
    # verbatim wherever it goes; nothing downstream re-formats it.
    content = Column(Text, nullable=False)

    # WHERE it went. `ambient` = the display line (the default, and the only
    # channel `GET /proactive/current` serves). `whatsapp` = a silence-triggered
    # reach-out that was already delivered to Daniel's phone, recorded here so
    # the once-per-day rule has something durable to read and so both kinds of
    # unprompted output share one history.
    #
    # A whatsapp row is written ONLY after Meta accepts the send. That ordering
    # is the whole point: an idempotency stamp written before delivery burns the
    # day's one reach-out on a message that never arrived, which is precisely
    # the failure the 2026-06-10 nudge audit found (see WhatsAppCloudClient.
    # send_text's docstring).
    channel = Column(String, nullable=False, default="ambient", index=True)

    # Naive UTC, like every other datetime in this schema.
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    # When this stops being served. An observation is a claim about a MOMENT
    # ("25m on youtube, the review is due in 3h") and goes from useful to wrong
    # as that moment recedes, so it expires rather than waiting to be dismissed.
    expires_at = Column(DateTime, nullable=False, index=True)

    dismissed = Column(Boolean, nullable=False, default=False, index=True)
    # Kept separate from `dismissed` so the cooldown can be measured from the
    # dismissal rather than from creation — waving something away at the end of
    # its window should buy the same quiet as waving it away at the start.
    dismissed_at = Column(DateTime, nullable=True)

    # The rendered context block this observation was generated from, verbatim.
    # Debug/tuning only — nothing reads it back into a prompt.
    context_digest = Column(Text, nullable=True)
    # Which model produced it, so a cadence-wide quality shift is attributable
    # to a model swap rather than to the prompt.
    model = Column(String, nullable=True)
