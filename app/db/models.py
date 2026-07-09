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


class Space(Base):
    """A container for organizing notes and conversations.

    Distinct from `Focus`: a space is an evergreen container ("Journal",
    "Dev", "Claude Code") — no endgoal, no drift detection. Focus is
    time-bound commitment. Notes live in a space; they can also link to
    a focus. See discussion note "Discussion: converge spaces + focuses?"
    for why we kept them separate.
    """

    __tablename__ = "spaces"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    emoji = Column(String, nullable=True)
    # Pinned spaces sort to the top of the sidebar — same UX shape as the
    # per-note pin. Default false so existing rows continue to sort by
    # whatever the list endpoint orders by.
    is_pinned = Column(Boolean, default=False, nullable=False, server_default="0")
    # User-written prose about what this space is for. Renders in the
    # space-view header so Daniel can give Journal / Dev / Claude Code
    # actual identity beyond a name + emoji. Markdown/HTML allowed —
    # sanitized at render time same as note content.
    description = Column(Text, nullable=True)
    # R2 URL for an optional cover image. Used as a banner / page-header
    # background tint in the space view. Nullable — most spaces will
    # never set one. Same R2 path as note attachments / public profile
    # avatars.
    cover_image_url = Column(Text, nullable=True)
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
    space_id = Column(Integer, ForeignKey("spaces.id"), nullable=True)
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
    # Session-summary notes (PR-4): the 5am batch writes one Note per
    # processed session with note_type='session_summary'. Null for normal
    # notes. session_start/end bound the source window; message_count is the
    # raw count. The desktop review (PR-5) queries by note_type.
    note_type = Column(String, nullable=True, index=True)  # None | 'session_summary'
    session_start = Column(DateTime, nullable=True)
    session_end = Column(DateTime, nullable=True)
    message_count = Column(Integer, nullable=True)
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
    # Graduation lifecycle for the primitive-model redraw. Every Note
    # starts as `unprocessed` — captured but uncommitted intent. Becomes
    # `graduated` once it spawns a Promise / Todo / Habit / Focus (or is
    # otherwise turned into structured action; tracked via derives_from
    # edges back to the source note). `archived` is a manual tombstone
    # for notes that never need to graduate. The synthesizer reads only
    # `unprocessed` rows for focus-candidate clustering so a graduated
    # note doesn't get re-surfaced as a stale prompt.
    status = Column(
        String, nullable=False, default="unprocessed",
        server_default="unprocessed", index=True,
    )


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
    # Optional link to a Focus when the memory is goal/aspiration-shaped.
    # Re-pointed from list_items.id back to focuses.id after the focus /
    # todo / backlog extraction.
    focus_id = Column(Integer, ForeignKey("focuses.id"), nullable=True)
    # Origin tracking — set when this memory was extracted from a note's
    # classify_note run. Lets the editor surface "this note created N
    # memories" disclosure. NULL for memories from chat or other paths.
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
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
    """Generic list row — text + done + sort_order, nothing more.

    After the focus / todo / backlog extraction, `list_items` is back to
    its original purpose: arbitrary user-defined lists (shopping, notes
    bullets, etc.). Focus-shaped fields live in `focuses`, todo-shaped
    fields in `todos`, backlog-shaped fields in `backlog_tickets`.
    """

    __tablename__ = "list_items"

    id = Column(Integer, primary_key=True, index=True)
    list_id = Column(Integer, ForeignKey("lists.id"), nullable=False, index=True)
    parent_id = Column(Integer, ForeignKey("list_items.id"), nullable=True, index=True)
    text = Column(Text, nullable=False)
    subtitle = Column(Text, nullable=True)
    # actionable=True → renders with checkbox (a thing to do).
    # actionable=False → renders as a bullet/idea (no toggle, no completion state).
    actionable = Column(Boolean, default=True, nullable=False)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    # JSON-serialised float list. Generated on insert/edit from `text +
    # subtitle` so add_item can cosine-search existing items in the same
    # list for conflicts. Deferred — ~31KB per row, never read by tree
    # or list-render paths.
    embedding = deferred(Column(Text, nullable=True))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class Focus(Base):
    """Long-running commitment. Theme-shaped (e.g. "Ship the dashboard
    revamp", "Get fit") with optional health/confidence telemetry. After
    the dashboard-revamp PR, primary moved to Todo — focuses no longer
    carry is_primary. Each focus has a `color` for the dot system that
    visually links it to its child todos on the dashboard.

    A focus has many todos via the `todos.focus_id` FK (a todo links to
    at most one focus — the legacy `focus_todo_links` M2M was dropped
    when the dashboard revamp landed).
    """

    __tablename__ = "focuses"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)
    subtitle = Column(Text, nullable=True)
    endgoal = Column(Text, nullable=True)
    committed = Column(Boolean, default=False, nullable=False)
    # Color hex (e.g. "#22C55E") for the dot rendered on this focus's
    # card and on every linked todo. Auto-assigned from a 10-color
    # palette in focus_service.create when the caller doesn't supply
    # one. Wraps after 10 focuses.
    color = Column(String, nullable=True)
    # Engagement state: 'committed' | 'someday'. Mirrors `committed` —
    # kept for richer UI labelling.
    status = Column(String, nullable=True)
    # Pace bucket: 'quick' | 'slow' (legacy data may have NULL).
    scale = Column(String, nullable=True)
    # Health 0..100 + reporter confidence 0..100, both nullable. UI shows
    # neutral dot when either is null OR confidence < 35.
    health = Column(Integer, nullable=True)
    confidence = Column(Integer, nullable=True)
    # Wall-clock window. Quick focuses default to (now, midnight tonight).
    start_at = Column(DateTime, nullable=True)
    end_at = Column(DateTime, nullable=True)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    # JSON-serialised embedding for cosine similarity (conflict detection
    # when adding focuses). Deferred — ~31KB per row.
    embedding = deferred(Column(Text, nullable=True))

    # --- Drift / hybrid-binding columns (added by the focus-drift PR) ---
    # initial_signature: centroid of the cluster's evidence at promotion
    # time, frozen forever. current_signature: weighted-mean updated on
    # every successful bind during a synth run. Drift = the cosine
    # distance between these two — when it crosses 0.65, the focus is
    # flagged for rename/fork. Same deferred pattern as `embedding` to
    # keep list endpoints from hydrating the vectors.
    initial_signature = deferred(Column(Text, nullable=True))
    current_signature = deferred(Column(Text, nullable=True))
    # JSON snapshot of the cluster bound to this focus on the last synth
    # run (list of {kind, id, snippet}). Refreshed every successful bind.
    current_evidence_json = Column(Text, nullable=True)
    last_seen_in_synth = Column(DateTime, nullable=True)
    # Consecutive synth runs where no cluster bound to this focus. After
    # MISSED_RUN_DORMANCY_THRESHOLD (default 3), the binding pass flips
    # status='dormant' — not deleted, just demoted.
    missed_run_count = Column(Integer, default=0, nullable=False)
    # When the drift score (1 - cos(initial, current)) first crossed the
    # warning threshold. Cleared on rename. Surfaces in UI as a "rename
    # or fork?" prompt.
    drift_flagged_at = Column(DateTime, nullable=True)
    # Forward link back to the FocusCandidate row this focus was promoted
    # from. Lets us walk the audit trail without joining backward.
    promoted_from_candidate_id = Column(
        Integer, ForeignKey("focus_candidates.id"), nullable=True
    )
    # Set when this focus was forked from a prior one — lineage chain.
    # The old focus carries status='evolved' + the new focus carries this
    # pointer back. Walks the chain so the UI can render breadcrumbs.
    evolved_from_focus_id = Column(
        Integer, ForeignKey("focuses.id"), nullable=True
    )

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class FocusCandidate(Base):
    """Proposed focus surfaced by the synthesizer. Lives in 'proposed'
    state until Daniel promotes (→ creates Focus row) or dismisses it.

    Why a separate table from Focus: candidates are pre-curation noise +
    signal mixed. Most surface a few times then never again; some grow
    seen_count as the synthesizer keeps re-emitting them; a small
    fraction get promoted. Persisting them lets the synthesizer dedup
    on re-emission and lets Daniel review without losing context, but
    we never want them mixed into the real Focus list.

    cluster_signature is sha256 of sorted "{kind}#{id}" item pairs —
    deterministic per cluster shape, so repeat synth runs that produce
    the same cluster upsert the same row (bump seen_count) instead of
    spawning duplicates. If items shift, the sig changes and a new
    candidate spawns.
    """

    __tablename__ = "focus_candidates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    endgoal = Column(Text, nullable=True)
    # 'focus' for v1 — only focus-shaped clusters get persisted.
    # State + noise stay ephemeral in the synth output.
    category = Column(String, nullable=False, default="focus")
    confidence = Column(Float, nullable=False, default=0.0)
    reasoning = Column(Text, nullable=True)
    # sha256 hex of sorted "{kind}#{id}" items. Indexed unique — same
    # cluster shape across runs upserts the same row.
    cluster_signature = Column(String, nullable=False, unique=True, index=True)
    # JSON list of {kind, id, snippet}. Snapshot of the cluster's items
    # at the time of last sighting. Refreshed every time we re-sight.
    evidence_json = Column(Text, nullable=False)
    # JSON-encoded centroid vector. Deferred — same pattern as
    # Note.embedding. Needed for future binding-to-existing-Focus pass.
    centroid_embedding = deferred(Column(Text, nullable=True))
    # If this candidate came from a sub-cluster under a parent
    # candidate, link back. Top-level candidates leave this null.
    parent_candidate_id = Column(
        Integer, ForeignKey("focus_candidates.id"), nullable=True, index=True
    )
    # Lifecycle: 'proposed' | 'promoted' | 'dismissed'.
    status = Column(String, nullable=False, default="proposed", index=True)
    promoted_focus_id = Column(
        Integer, ForeignKey("focuses.id"), nullable=True, index=True
    )
    promoted_at = Column(DateTime, nullable=True)
    dismissed_at = Column(DateTime, nullable=True)
    first_seen_in_synth = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_in_synth = Column(DateTime, default=datetime.utcnow, nullable=False)
    seen_count = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class Todo(Base):
    """Actionable item Daniel is doing or about to do. After the
    dashboard-revamp PR, todos carry a 3-state enum (`not_yet` | `doing`
    | `done`), an optional `focus_id` FK (legacy M2M `focus_todo_links`
    dropped — one todo links to at most one focus), and an `is_primary`
    singleton flag (only one Todo across the table can have
    is_primary=True; primary moved here from Focus).
    """

    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)
    subtitle = Column(Text, nullable=True)
    # 3-state enum. Default 'not_yet' on creation. UI cycles via two
    # checkbox clicks: not_yet → doing → done. The `done` boolean is
    # kept in sync (state == 'done' ↔ done == True) so legacy callers
    # that read `done` keep working without porting.
    state = Column(String, nullable=False, default="not_yet", index=True)
    # Optional FK back to a focus — visualised as a color dot on the
    # todo. NULL means "free-floating todo" (groceries, calls, etc).
    focus_id = Column(Integer, ForeignKey("focuses.id"), nullable=True, index=True)
    # Singleton across the whole table. Service enforces the invariant.
    is_primary = Column(Boolean, default=False, nullable=False)
    due_date = Column(DateTime, nullable=True, index=True)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    embedding = deferred(Column(Text, nullable=True))
    # Soft-delete tombstone. NULL = live row. NOT NULL = deleted at that
    # time; lifespan sweeper hard-purges anything past 24h. All read
    # paths in todo_service filter `deleted_at IS NULL` so soft-deleted
    # rows are invisible to UI + chat. The undo window is the gap between
    # soft-delete and sweep.
    deleted_at = Column(DateTime, nullable=True, index=True)
    # G3.5 Todo Continuity: short inline outcome text captured when this
    # todo closes. Optional — most closes have nothing to say. For longer
    # outcomes, callers write a Note + wire an `outcome_of` edge instead.
    # Sits next to the lineage edges (kind='spawned_from') that link this
    # todo to its parents/children in the `edges` table.
    closure_note = Column(Text, nullable=True)
    # G3 recurrence counter. On create, todo_service cosine-matches the
    # new text against open todos at ≥0.85; on match it bumps the
    # existing row's mention_count + last_mentioned_at + appends the
    # timestamp to mention_history INSTEAD of inserting a duplicate.
    # Drives accountability tone: at mention_count ≥3 the ack composer
    # switches from neutral ("noted") to confrontational Alfred voice
    # ("third mention. tonight or kill it.") — silence isn't helping.
    mention_count = Column(Integer, nullable=False, default=1)
    last_mentioned_at = Column(DateTime, nullable=True, index=True)
    # JSON array of ISO timestamps — full audit of every utterance that
    # re-mentioned this todo. Kept so Gooni can cite specifics ("you
    # talked about this Tue, Thu, and Sun"). Nullable: legacy rows
    # don't get backfilled to keep the migration cheap.
    mention_history = Column(Text, nullable=True)
    # Procrastination nudge (PR-6). doing_started_at is stamped when the
    # todo flips INTO state='doing' (cleared when it leaves). The proactive
    # loop pings if a todo sits in 'doing' past the stale threshold;
    # last_nudge_sent_at debounces so it doesn't nag more than once per
    # window.
    doing_started_at = Column(DateTime, nullable=True)
    last_nudge_sent_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class BacklogTicket(Base):
    """Engineering backlog ticket — Jira-style board state + PR pointer.

    Was a polymorphic ListItem in a `type='backlog'` list; now its own
    table with the two fields that actually matter for backlog
    (board_status + pr_url) instead of dragging through unused focus /
    todo fields.
    """

    __tablename__ = "backlog_tickets"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)
    subtitle = Column(Text, nullable=True)
    # 'not_yet' | 'doing' | 'done' (aligned with Todo.state in the
    # dashboard revamp; was 'todo' | 'in_progress' | 'done' pre-revamp,
    # remapped in migration). Truth table for board column:
    #   done=True → Done column (regardless of board_status)
    #   done=False + board_status='doing' → In Progress
    #   otherwise → Todo column
    board_status = Column(String, nullable=True)
    pr_url = Column(Text, nullable=True)
    # Free-form ticket body — context, design notes, follow-up scratch.
    # subtitle stays as the one-line tagline; notes is the multi-line story.
    notes = Column(Text, nullable=True)
    # Singleton across the whole table — only one ticket can be the
    # "north star" pinned to the dashboard banner. Mirrors Todo.is_primary
    # singleton pattern; service layer enforces the invariant. Auto-clears
    # when the ticket is marked done.
    is_primary = Column(Boolean, default=False, nullable=False)
    # G2 self-PM: workflow blast-radius score (1=one-off annoyance, 5=blocks
    # daily-driver claim). LLM scores at create time via feature_request_tool;
    # surfaces in urgency calculation + severity-aware acks. Nullable for
    # legacy tickets that predate scoring.
    blast_radius = Column(Integer, nullable=True)
    # Computed urgency_score = friction_count_30d × blast_radius × recency
    # weight. Recomputed nightly by lifespan rollup; can also be bumped
    # synchronously when a fresh friction_event fires. Nullable so unscored
    # tickets sort naturally to the bottom of urgency lists.
    urgency_score = Column(Float, nullable=True, index=True)
    # Timestamp of the most-recent friction_event tied to this ticket.
    # Drives recency weighting + the "currently hitting workflow" surface.
    last_friction_at = Column(DateTime, nullable=True, index=True)
    # Free-text agent attribution. Set when an autonomous worker (e.g.
    # Claude Code) picks up the ticket so the board surfaces a "🤖 claude
    # picked up" pill while it's actively being driven. Auto-cleared when
    # the ticket flips to done — the pill is for live work only.
    claimed_by = Column(String, nullable=True)
    # Set when this ticket has been promoted into Daniel's todo list.
    # Promote = create a Todo with focus_id null, link it here. Demote =
    # delete the linked Todo, clear this column. When the linked todo's
    # state flips to 'done', the ticket auto-marks done too.
    todo_id = Column(Integer, ForeignKey("todos.id"), nullable=True, index=True)
    done = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    source_note_id = Column(Integer, ForeignKey("notes.id"), nullable=True)
    embedding = deferred(Column(Text, nullable=True))
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
    # User-editable instruction Daniel writes for the daily digest. The LLM
    # gets this verbatim plus today's todos/focuses data and produces the
    # outgoing chat message. Empty string = use the bundled default.
    nudge_prompt = Column(Text, nullable=False, default="")
    # YYYY-MM-DD idempotency token for the daily capability-telemetry rollup
    # (same shape as nudge_last_sent_day). Prevents double-fire when Fly
    # scales horizontally — the loop checks this before doing work.
    capability_telemetry_last_run_day = Column(String, nullable=True)
    # Proactive nudges (phase 0). Each column is the idempotency token
    # for one trigger; the proactive_nudge_service refuses to re-fire on
    # the same value.
    #   last_whoop_nudge_source_ts: WhoopSnapshot.source_updated_at the
    #     last time we pinged about whoop. Fresh source_updated_at → new
    #     ping; same → skip.
    #   last_sleep_nudge_day: YYYY-MM-DD in sleep_cutoff_tz. One sleep
    #     ping per night max.
    #   sleep_cutoff_hour: local hour at which "you're up too late"
    #     triggers fire. 1 = past 1am. NULL → defaults to 1 in code.
    last_whoop_nudge_source_ts = Column(DateTime, nullable=True)
    last_sleep_nudge_day = Column(String, nullable=True)
    sleep_cutoff_hour = Column(Integer, nullable=True)
    # Whoop debounce — fixes the dup-ping race where recovery + cycle +
    # sleep webhooks fire within seconds, each passing the idempotency
    # check BEFORE any of them commits. Instead of firing on the spot,
    # `maybe_fire_whoop_nudge` writes the candidate snapshot's source_ts
    # here and stamps `pending_set_at`. A lifespan tick fires the pending
    # ping only after `pending_set_at` has been stable for ≥3 min, so
    # bursts collapse to one ping carrying the LATEST snapshot's data.
    whoop_nudge_pending_source_ts = Column(DateTime, nullable=True)
    whoop_nudge_pending_set_at = Column(DateTime, nullable=True)
    # 5am batch processor idempotency stamp (YYYY-MM-DD in nudge_tz). Mirrors
    # capability_telemetry_last_run_day — kills a double-run if Fly scales out.
    batch_last_run_day = Column(String, nullable=True)
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
    # Actual bed/wake timestamps from Whoop's sleep session. Naive UTC.
    # Lets Gooni answer "when did i sleep last night" instead of just
    # "how long". Nullable — older rows + days w/o a synced sleep
    # session leave these NULL.
    sleep_start_at = Column(DateTime, nullable=True)
    sleep_end_at = Column(DateTime, nullable=True)
    # Sleep efficiency = % of in-bed time that was actual sleep
    # (Whoop `score.sleep_efficiency_percentage`). Distinct from
    # sleep_performance_pct, which is Whoop's composite quality score.
    sleep_efficiency_pct = Column(Float, nullable=True)
    # Disturbance count — number of wakes during the night
    # (Whoop `score.stage_summary.disturbance_count`). High count =
    # fragmented sleep even when total duration is fine.
    sleep_disturbance_count = Column(Integer, nullable=True)

    # Newest `updated_at` across the upstream Whoop records (recovery /
    # cycle / sleep) this snapshot was rolled up from. Distinct from
    # `updated_at` below, which is "when we last cached the row" — that
    # said "updated now" right after a poll even when Daniel hadn't worn
    # his strap in 24h. Use this for the freshness UI.
    source_updated_at = Column(DateTime, nullable=True)

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LeetcodeSnapshot(Base):
    """One row per day. Cached pull from leetcode.com/graphql so the
    StatsView card + MCP `get_leetcode_activity` don't hit LeetCode on
    every render. Idempotent on `date` — re-fetching overwrites.
    """

    __tablename__ = "leetcode_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, unique=True, index=True)

    username = Column(String, nullable=False)

    # Activity counters derived from submission calendar.
    streak = Column(Integer, nullable=True)
    total_active_days = Column(Integer, nullable=True)
    today_count = Column(Integer, nullable=True)
    week_count = Column(Integer, nullable=True)

    # Cumulative solve totals.
    total_solved = Column(Integer, nullable=True)
    easy_solved = Column(Integer, nullable=True)
    medium_solved = Column(Integer, nullable=True)
    hard_solved = Column(Integer, nullable=True)
    ranking = Column(Integer, nullable=True)

    # Raw {unix_ts_string: count} payload for the heatmap (last 365d).
    calendar_json = Column(Text, nullable=True)

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class FocusSession(Base):
    """One row per focus-cam tracked work session. Aggregate metrics are
    populated when the session ends (STOP click, Ctrl+C, or process exit).
    Written by the standalone focus_cam.py process via raw sqlite3 — these
    SQLAlchemy declarations exist so Gooni's create_all() recognises the
    tables and so backend code can read sessions through the ORM.
    Sister tables: FocusSessionBucket (1Hz telemetry), FocusSessionEvent
    (discrete h2m/phone/stand/away events).
    """

    __tablename__ = "focus_sessions"

    id = Column(Integer, primary_key=True, index=True)
    started_at = Column(DateTime, nullable=False, index=True)
    ended_at = Column(DateTime, nullable=True)
    duration_sec = Column(Integer, nullable=True)
    # Per-sample aggregates (sample interval ~2s):
    presence_pct = Column(Float, nullable=True)
    eyes_on_pct = Column(Float, nullable=True)
    # Bucket-derived (1Hz):
    active_pct = Column(Float, nullable=True)
    engaged_pct = Column(Float, nullable=True)
    # Only populated when the user passed --focused-apps:
    app_focus_pct = Column(Float, nullable=True)
    focused_apps_input = Column(Text, nullable=True)  # raw CSV
    samples_total = Column(Integer, nullable=True)
    samples_focused = Column(Integer, nullable=True)
    hand_to_mouth_count = Column(Integer, nullable=True)
    phone_in_hand_count = Column(Integer, nullable=True)
    stand_count = Column(Integer, nullable=True)
    away_count = Column(Integer, nullable=True)
    note = Column(Text, nullable=True)  # optional freeform user note
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class FocusSessionBucket(Base):
    """1Hz telemetry buckets for a FocusSession. One row per session-second.
    Captures the frontmost app at that second + raw keyboard / mouse event
    counts. Granular enough to reconstruct the session timeline; coarse
    enough that 24/7 use stays under ~7MB/day."""

    __tablename__ = "focus_session_buckets"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(
        Integer,
        ForeignKey("focus_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ts = Column(DateTime, nullable=False)
    app = Column(Text, nullable=True)        # macOS frontmost app name
    keys = Column(Integer, nullable=False, default=0)
    mouse = Column(Integer, nullable=False, default=0)


class FocusSessionEvent(Base):
    """Discrete events fired during a session. `kind` is a small enum:
    'hand_to_mouth' | 'phone_in_hand' | 'stand' | 'away'. Inserted at the
    moment the event completes — stand/away are emitted on face-back-in-frame,
    h2m/phone are emitted when the hold ends and exceeded the min duration."""

    __tablename__ = "focus_session_events"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(
        Integer,
        ForeignKey("focus_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind = Column(String, nullable=False, index=True)
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime, nullable=True)
    duration_sec = Column(Integer, nullable=True)


class GooniTake(Base):
    """Daily LLM-generated takes on Daniel's state — one row per (day, kind).

    Two flavors today:
      - kind="focus" — one tight sentence on what Daniel is focused on RIGHT
        NOW. Inputs: recent notes + active focuses. Powers the dashboard pill.
      - kind="dev"   — one short paragraph on what Daniel shipped on Gooni
        today, derived from commits + PR titles across tracked repos. Powers
        the StatsView Dev-activity card.

    Idempotent on (day, kind): the daily endpoint upserts in place rather
    than appending so history stays one-row-per-day. Force-refresh
    regenerates and overwrites the same row. `created_at` records first
    generation; `updated_at` records last regeneration.

    `sources` is a free-form JSON blob holding whichever input ids the
    generator used (note ids, focus ids, commit shas, PR urls). Keeping it
    schemaless lets future kinds add new source types without a migration.

    `prompt_version` bumps when the prompt template or input set changes
    so future history UIs can filter rows from different prompt eras.
    """

    __tablename__ = "gooni_takes"
    __table_args__ = (
        UniqueConstraint("day", "kind", name="uq_gooni_takes_day_kind"),
    )

    id = Column(Integer, primary_key=True, index=True)
    day = Column(Date, nullable=False, index=True)
    kind = Column(String, nullable=False, index=True)
    take_text = Column(Text, nullable=False)
    model = Column(String, nullable=False)
    prompt_version = Column(String, nullable=False, default="v1")
    sources = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class NoteComment(Base):
    """Confluence-style comment thread under a note. One row per comment;
    no nesting/replies for now (kept flat to keep the UI a simple list).
    `author` is a free-text label ("daniel", "gooni", "claude") rather than
    a FK because Gooni is a single-user app — adding a User table just for
    this would be ceremony without payoff.
    """

    __tablename__ = "note_comments"

    id = Column(Integer, primary_key=True, index=True)
    note_id = Column(
        Integer,
        ForeignKey("notes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author = Column(String, nullable=False, default="daniel")
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Habit(Base):
    """Daily binary tracking. Each habit is a recurring yes/no question
    Daniel checks against per day ("went to gym", "stayed clean from
    vaping", "went to office"). Phrasing is ALWAYS positive — value=True
    means "I did the thing I said I would." `polarity` carries the
    underlying connotation so downstream surfaces can colour negative-
    framed habits differently or roll up "consecutive clean days"
    separately, without polluting the data model.

    Streak = consecutive value=True days from today (or yesterday if
    today is unlogged) walking backward. Missing entry breaks the streak;
    explicit value=False breaks the streak.
    """

    __tablename__ = "habits"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    # Hex color for the dot/cell rendering. Defaults set by service.
    color = Column(String, nullable=True)
    # 'positive' = "do the thing" (gym, church, office, write).
    # 'negative' = the underlying action is bad but phrasing is still
    # positive ("stayed clean from vaping" — value=True still means
    # the GOOD outcome). UI uses polarity to colour or label, never
    # to invert value semantics.
    polarity = Column(String, nullable=False, default="positive")
    # Soft-delete. Archived habits stay in DB for entry history but
    # don't render in the dashboard widget.
    archived_at = Column(DateTime, nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class HabitEntry(Base):
    """One row per (habit, date). Absence of a row = unknown / unlogged.
    Explicit False = "I did NOT do it." Explicit True = "I did it."
    Three visual states in the UI: empty cell, ✓, ✗.

    UNIQUE(habit_id, date) — date is a calendar Date, not DateTime,
    so timezones don't shift logging. The service writes today using
    the server's local-date interpretation.
    """

    __tablename__ = "habit_entries"

    id = Column(Integer, primary_key=True, index=True)
    habit_id = Column(
        Integer,
        ForeignKey("habits.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    date = Column(Date, nullable=False, index=True)
    value = Column(Boolean, nullable=False)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("habit_id", "date", name="uq_habit_entry_per_day"),
    )


class DailyMetric(Base):
    """Numeric daily fitness/body tracking — the substrate for the cut table.

    Deliberately standalone, NOT folded into Habit/HabitEntry: habits are
    boolean ("went to gym" → True/False), metrics are numeric (calories,
    protein, weight). Keeping them apart keeps the habit data model clean
    and means no migration risk on existing habit rows.

    Row semantics by metric_type:
      - calories / protein  — ADDITIVE within a day. Each meal Daniel logs
        = one row; the day's value is SUM(value). No UNIQUE constraint —
        multiple rows per (type, date) is the intended shape.
      - weight              — last-write-wins per day. Service reads the
        most-recent row's value (by created_at); we don't dedupe in the DB.
      - exercise            — presence sentinel. value=1.0; the real signal
        is `notes` (the workout label) + the paired `gym` HabitEntry that
        the fitness handler upserts alongside.

    Corrections ("actually that chicken was ~900 cal") overwrite the
    most-recent row for (type, today) in place — see
    daily_metric_service.update_most_recent.
    """

    __tablename__ = "daily_metrics"

    id = Column(Integer, primary_key=True, index=True)
    # 'calories' | 'protein' | 'weight' | 'exercise'
    metric_type = Column(String, nullable=False, index=True)
    value = Column(Float, nullable=False)
    # 'kcal' | 'g' | 'lb' | 'kg' | None (exercise carries no unit)
    unit = Column(String, nullable=True)
    date = Column(Date, nullable=False, index=True)
    # Raw input breadcrumb: the food string Daniel typed, the workout
    # label, or a correction trail. Never load-bearing for aggregation.
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        # Every read path (running total, cut table) filters on both
        # columns — composite index keeps the grouped SUMs cheap.
        Index("ix_daily_metrics_type_date", "metric_type", "date"),
    )


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


class FrictionEvent(Base):
    """G2 self-PM: a logged moment where Gooni hit a capability gap that
    interrupted Daniel's workflow. Each event ties to a BacklogTicket
    (creating one if no match found) so the same gap aggregates across
    sessions instead of stacking duplicate feature requests.

    Sources:
      - 'user_utterance'  — Daniel said "you can't X" / "isn't there a way
                            to Y" → extractor signal → log + maybe-create.
      - 'gooni_response'  — Gooni's own reply emitted "I can't" / "not yet
                            supported" → orchestrator post-hook regex →
                            log against nearest cosine-matched ticket.
      - 'tool_failure'    — a tool call returned a capability-gap error.
                            (reserved; not wired in v1.)
      - 'manual'          — Daniel manually flagged a friction via the
                            feature_request_tool with high blast_radius.

    blast_radius is a 1-5 score of workflow impact:
      1 = one-off annoyance (e.g., minor formatting)
      2 = blocks list/UI ergonomics
      3 = blocks a specific surface (e.g., voice capture)
      4 = blocks daily flow (multiple sessions affected)
      5 = blocks the daily-driver claim itself (e.g., todo grooming)

    Urgency aggregation: backlog_ticket.urgency_score = sum of recent
    friction_events × blast_radius × recency_decay. Surfaced in state_block
    so Gooni sees its own top blocker every turn.
    """

    __tablename__ = "friction_events"

    id = Column(Integer, primary_key=True, index=True)
    backlog_ticket_id = Column(
        Integer,
        ForeignKey("backlog_tickets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Optional FK back to the message that triggered the friction. Null
    # for boot-time seeds or manual flags. Indexed because state_block
    # queries "what fired in this conv" use it.
    message_id = Column(
        Integer,
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    blast_radius = Column(Integer, nullable=False)
    reason = Column(Text, nullable=True)
    source = Column(String, nullable=False, default="user_utterance")
    # 'user_utterance' | 'gooni_response' | 'tool_failure' | 'manual'
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


class CapabilityFacet(Base):
    """One row per discrete capability claim Gooni makes about itself.

    Layers:
      - mechanical    — tool / route / channel primitives derived from the
                        codebase. Auto-populated via boot-time introspection.
      - functional    — composed "what I can do for you" facets.
                        Human / PR-audit curated.
      - behavioral    — emergent patterns from reflection clustering
                        ("I keep defaulting to logging instead of acting").
      - architectural — model, runtime, memory window, ambient-sensing
                        status. Rarely changes; manual_seed source.

    Status transitions (idempotent, never destructive):
      claimed     — initial state from any source.
      verified    — ToolCall telemetry confirms recent successful invocations.
      unverified  — no successful invocations in 30d.
      broken      — >=3 failed invocations in 7d (evidence_json snapshots).
      removed     — boot scan no longer sees this tool/route in the registry.

    facet_key is a stable slug (e.g. "tool.add_note", "route.POST./focuses").
    UNIQUE on facet_key so all sources upsert against the same row.
    """

    __tablename__ = "capability_facets"

    id = Column(Integer, primary_key=True, index=True)
    layer = Column(String, nullable=False, index=True)
    # 'mechanical' | 'functional' | 'behavioral' | 'architectural'
    facet_key = Column(String, nullable=False, index=True)
    facet_text = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="claimed")
    # 'claimed' | 'verified' | 'unverified' | 'broken' | 'removed'
    source = Column(String, nullable=False)
    # 'code_introspection' | 'pr_audit' | 'reflection_cluster' |
    # 'manual_seed' | 'chat_tool_update'
    # Polarity flips facet rendering. 'positive' facets render under
    # "I can:" / "I tend to:" / "I am:" prefixes per layer. 'negative'
    # facets render under "I cannot:" — the load-bearing piece for
    # capability honesty (LLM knows its own gaps so it doesn't claim
    # capabilities it lacks). Default positive for backward compat.
    polarity = Column(
        String, nullable=False, default="positive", server_default="positive"
    )
    evidence_json = Column(Text, nullable=True)
    last_verified_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("facet_key", name="uq_capability_facet_key"),
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
    # G3.1: vague-promise flag. Set by `promise_complexity.needs_game_plan`
    # at create time. Doesn't gate the lifecycle (the promise is `active`
    # either way) — drives ack composition (Alfred sharp clarifier) and
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
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class Edge(Base):
    """Graph layer for semantic many-to-many links across entities.

    Existing FKs (Comment.note_id, Memory.source_note_id, Todo.focus_id,
    BacklogTicket.todo_id, etc) stay — those model OWNERSHIP. This table
    models semantic links where adding an FK column per relation would
    M²-explode the schema as new entities land. Promise is the first
    citizen; new entity types plug in for free.

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


class Attachment(Base):
    """File attached to a Note OR a Todo (PDF, doc, archive, etc.). Stored on
    R2; the DB row carries metadata + the public URL. Distinct from inline
    <img> figures, which live in note HTML.

    Owner is exactly one of note_id / todo_id (both nullable; each row sets
    one). A nullable FK per owner-kind keeps read paths trivial; if focuses /
    promises ever need attachments too, revisit a polymorphic owner then —
    one extra owner doesn't justify that rework yet."""

    __tablename__ = "attachments"

    id = Column(Integer, primary_key=True, index=True)
    note_id = Column(Integer, ForeignKey("notes.id"), nullable=True, index=True)
    todo_id = Column(Integer, ForeignKey("todos.id"), nullable=True, index=True)
    filename = Column(Text, nullable=False)
    mime_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    # R2 object key (e.g. "attachments/2026/05/17/abc123.pdf"). Kept so we
    # can later delete the underlying object if the note is deleted.
    storage_key = Column(Text, nullable=False)
    # Public R2 URL — what the frontend renders / downloads from.
    public_url = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Reaction(Base):
    """Confluence-style emoji reaction on a note or comment.

    Polymorphic on (target_type, target_id) — same row shape covers
    notes + comments + future surfaces (lists, etc) without a per-target
    join table explosion. UNIQUE constraint on
    (target_type, target_id, emoji, reactor_id) so a reactor can't
    double-react with the same emoji on the same target.

    reactor_id is a stable opaque string from the frontend (localStorage
    UUID for anonymous public viewers, or a real user id once auth lands).
    Not an FK — the backend doesn't know who the reactor is, just that
    they were consistent across requests. No PII.
    """

    __tablename__ = "reactions"

    id = Column(Integer, primary_key=True, index=True)
    # "note" | "comment". Kept flexible so we can add more targets without
    # migrating; validation happens at the route layer.
    target_type = Column(String, nullable=False)
    target_id = Column(Integer, nullable=False)
    emoji = Column(String, nullable=False)
    reactor_id = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "target_type", "target_id", "emoji", "reactor_id",
            name="uq_reaction_target_emoji_reactor",
        ),
        Index("ix_reactions_target", "target_type", "target_id"),
    )


