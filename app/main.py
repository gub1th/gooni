import json
import os

from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import (  # noqa: F401 — triggers table creation
    Base,
    Conversation,
    Goal,
    GoalStatus,
    GoalType,
    Memory,
    MemoryType,
    Message,
    Note,
    Space,
)
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
from .services.goal_service import goal_service
from .services.memory_service import memory_service
from .services.note_service import note_service
from .services.orchestrator import Orchestrator


def _run_column_migrations(engine):
    """Add space_id to existing tables. Only runs ALTER if table exists but column is missing."""
    with engine.connect() as conn:
        existing_tables = {
            r[0]
            for r in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        # (table, col, sql_type)
        for table, col, col_type in [
            ("goals", "space_id", "INTEGER"),
            ("goals", "milestones", "TEXT"),
            ("conversations", "space_id", "INTEGER"),
            ("notes", "space_id", "INTEGER"),
            ("notes", "updated_at", "INTEGER"),
            ("notes", "last_opened_at", "INTEGER"),
            ("notes", "goal_id", "INTEGER"),
            ("spaces", "emoji", "TEXT"),
            ("notes", "embedding", "TEXT"),
        ]:
            if table not in existing_tables:
                continue  # fresh DB: create_all will add the column via model definition
            existing_cols = [
                r[1] for r in conn.execute(text(f"PRAGMA table_info({table})"))
            ]
            if col not in existing_cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                print(f"Migration: added {table}.{col}")
        conn.commit()


# 1. Create spaces table first (so FK references are valid)
Base.metadata.create_all(bind=engine, tables=[Space.__table__])
# 2. Add space_id to any existing tables that predate this change
_run_column_migrations(engine)
# 3. Create remaining tables (they already have space_id in their model definition)
Base.metadata.create_all(bind=engine)

app = FastAPI()

_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.post("/chat/intention")
async def infer_intention(body: dict, db: Session = Depends(get_db)):
    """Fast endpoint: infer user intention without running the full chat pipeline."""
    content = body.get("content", "").strip()
    conversation_id = body.get("conversation_id")
    if not content:
        return {"intention": ""}
    recent_history = []
    if conversation_id:
        msgs = conversation_service.get_recent_messages(conversation_id, limit=6, db=db)
        recent_history = [{"role": m.role, "content": m.content} for m in msgs]
    intention = llm_client.generate_intention_context(content, recent_history)
    return {"intention": intention}


@app.post("/chat")
async def chat(body: ChatRequest, db: Session = Depends(get_db)):
    content, usage = Orchestrator.handle_chat(
        body.content,
        db,
        image_url=body.image_url,
        source="web",
        entry_content=body.entry_content or "",
    )
    return {"content": content, "usage": usage, "intention": usage.get("intention") or ""}


@app.get("/debug/memories")
async def debug_memories(db: Session = Depends(get_db)):
    memories = memory_service.get_all_active(db)
    return [
        {
            "id": m.id,
            "type": m.memory_type.value,
            "key": m.key,
            "content": m.content,
            "goal_id": m.goal_id,
            "confidence": m.confidence,
            "created_at": m.created_at,
        }
        for m in memories
    ]


def _serialize_goal(g: Goal) -> dict:
    return {
        "id": g.id,
        "title": g.title,
        "goal_type": g.goal_type.value,
        "status": g.status.value,
        "motivation": g.motivation,
        "blocker": g.blocker,
        "milestones": json.loads(g.milestones) if g.milestones else [],
    }


@app.get("/goals")
def get_goals(db: Session = Depends(get_db)):
    goals = goal_service.get_active(db)
    return [_serialize_goal(g) for g in goals]


@app.post("/goals")
def create_goal(body: dict, db: Session = Depends(get_db)):
    title = body.get("title", "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    goal_type_str = body.get("goal_type", "achieve")
    motivation = body.get("motivation", None)
    goal = Goal(
        title=title,
        goal_type=GoalType(goal_type_str),
        status=GoalStatus.ACTIVE,
        motivation=motivation,
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return _serialize_goal(goal)


@app.patch("/goals/{goal_id}")
def update_goal(goal_id: int, body: dict, db: Session = Depends(get_db)):
    goal = db.query(Goal).filter(Goal.id == goal_id).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Goal not found")
    if "title" in body:
        goal.title = body["title"]
    if "motivation" in body:
        goal.motivation = body["motivation"]
    if "blocker" in body:
        goal.blocker = body["blocker"]
    if "status" in body:
        goal.status = GoalStatus(body["status"])
    if "milestones" in body:
        goal.milestones = json.dumps(body["milestones"])
    db.commit()
    db.refresh(goal)
    return _serialize_goal(goal)


@app.delete("/goals/{goal_id}")
def delete_goal(goal_id: int, db: Session = Depends(get_db)):
    goal = db.query(Goal).filter(Goal.id == goal_id).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Goal not found")
    db.query(Note).filter(Note.goal_id == goal_id).update({"goal_id": None})
    db.delete(goal)
    db.commit()
    return {"ok": True}


@app.get("/goals/{goal_id}/notes")
def get_goal_notes(goal_id: int, db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .filter(Note.goal_id == goal_id)
        .order_by(Note.updated_at.desc())
        .all()
    )
    return [_serialize_note(n) for n in notes]


# ── Spaces ────────────────────────────────────────────────────────────────────


def _serialize_space(s: Space, db: Session) -> dict:
    goal = (
        db.query(Goal)
        .filter(Goal.space_id == s.id, Goal.status == GoalStatus.ACTIVE)
        .first()
    )
    return {
        "id": s.id,
        "name": s.name,
        "emoji": s.emoji,
        "goal_id": goal.id if goal else None,
    }


@app.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    spaces = db.query(Space).order_by(Space.id).all()
    space_ids = [s.id for s in spaces]
    active_goals = (
        db.query(Goal)
        .filter(Goal.space_id.in_(space_ids), Goal.status == GoalStatus.ACTIVE)
        .all()
    )
    goal_by_space = {g.space_id: g.id for g in active_goals}
    return [
        {
            "id": s.id,
            "name": s.name,
            "emoji": s.emoji,
            "goal_id": goal_by_space.get(s.id),
        }
        for s in spaces
    ]


@app.post("/spaces")
def create_space(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    space = Space(name=name)
    db.add(space)
    db.commit()
    db.refresh(space)
    return {"id": space.id, "name": space.name, "emoji": space.emoji, "goal_id": None}


@app.patch("/spaces/{space_id}")
def update_space(space_id: int, body: dict, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    if "name" in body:
        name = body["name"].strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        space.name = name
    if "emoji" in body:
        space.emoji = body["emoji"] or None
    db.commit()
    db.refresh(space)
    return _serialize_space(space, db)


@app.delete("/spaces/{space_id}")
def delete_space(space_id: int, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    db.query(Note).filter(Note.space_id == space_id).delete()
    db.delete(space)
    db.commit()
    return {"ok": True}


# ── Notes ─────────────────────────────────────────────────────────────────────


def _serialize_note(n: Note) -> dict:
    return {
        "id": n.id,
        "title": n.title,
        "content": n.content,
        "space_id": n.space_id,
        "goal_id": n.goal_id,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "last_opened_at": n.last_opened_at,
    }


def _notes_order():
    from sqlalchemy import func

    return func.coalesce(Note.updated_at, Note.created_at).desc()


@app.get("/spaces/{space_id}/notes")
def get_space_notes(space_id: str, db: Session = Depends(get_db)):
    if space_id == "general":
        notes = db.query(Note).order_by(_notes_order()).all()
    else:
        notes = (
            db.query(Note)
            .filter(Note.space_id == int(space_id))
            .order_by(_notes_order())
            .all()
        )
    return [_serialize_note(n) for n in notes]


@app.get("/notes")
def get_general_notes(db: Session = Depends(get_db)):
    notes = (
        db.query(Note).filter(Note.space_id.is_(None)).order_by(_notes_order()).all()
    )
    return [_serialize_note(n) for n in notes]


@app.get("/notes/recent")
def get_recent_notes(limit: int = 5, db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .order_by(_notes_order())
        .limit(limit)
        .all()
    )
    return [_serialize_note(n) for n in notes]


@app.post("/spaces/{space_id}/notes")
def create_space_note(space_id: str, body: dict, db: Session = Depends(get_db)):
    from datetime import datetime

    numeric_id = None if space_id == "general" else int(space_id)
    note = Note(
        title=body.get("title") or "",
        content=body.get("content") or "",
        space_id=numeric_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.post("/notes")
def create_general_note(body: dict, db: Session = Depends(get_db)):
    from datetime import datetime

    note = Note(
        title=body.get("title") or "",
        content=body.get("content") or "",
        space_id=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.patch("/notes/{note_id}")
def update_note(
    note_id: int,
    body: dict,
    db: Session = Depends(get_db),
):
    from datetime import datetime

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if "title" in body:
        note.title = body["title"]
    if "content" in body:
        note.content = body["content"]
    if "title" in body or "content" in body:
        note.updated_at = datetime.utcnow()
    if "space_id" in body:
        sid = body["space_id"]
        note.space_id = None if (sid is None or sid == "general") else int(sid)
    if "goal_id" in body:
        gid = body["goal_id"]
        note.goal_id = None if gid is None else int(gid)
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.post("/notes/{note_id}/embed")
def embed_note(note_id: int, db: Session = Depends(get_db)):
    """Generate embedding for a note and check for space suggestion.
    Called on blur (not on every save) to avoid wasteful API calls.
    """
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note_service.update_embedding(note_id)  # opens/closes its own session
    db.expire_all()  # invalidate cache so suggest_space sees fresh embedding
    suggestion = note_service.suggest_space(note_id, db)
    return {"ok": True, **suggestion}


@app.post("/notes/{note_id}/touch")
def touch_note(note_id: int, db: Session = Depends(get_db)):
    """Update last_opened_at. Called whenever a note is selected."""
    from datetime import datetime

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note.last_opened_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.post("/notes/{note_id}/memorize")
def memorize_note(note_id: int, db: Session = Depends(get_db)):
    """Extract facts from a note when the user leaves it.
    Note embeddings are handled by the PATCH endpoint background task —
    we no longer create Memory episodes from notes (episodes are for chat only).
    """
    import re

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    raw = re.sub(r"<[^>]+>", " ", note.content or "").strip()
    if len(raw) <= 10:
        return {"ok": True, "facts_saved": 0}
    try:
        facts = llm_client.extract_facts(raw)
        for fact in facts:
            memory_service.upsert_memory(fact, db)
    except Exception:
        facts = []
    return {"ok": True, "facts_saved": len(facts)}


@app.delete("/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    db.delete(note)
    db.commit()
    return {"ok": True}


@app.get("/notes/{note_id}/related")
def get_related_notes(note_id: int, limit: int = 5, db: Session = Depends(get_db)):
    """Return notes similar to the given note, ranked by embedding cosine similarity."""
    related = note_service.get_related(note_id, limit, db)
    return [_serialize_note(n) for n in related]


# ── Serializers ────────────────────────────────────────────────────────────────


def _serialize_conversation(c: Conversation) -> dict:
    return {
        "id": c.id,
        "type": "conversation",
        "title": c.title,
        "summary": c.summary,
        "goal_id": c.goal_id,
        "space_id": c.space_id,
        "source": c.source,
        "created_at": c.created_at,
    }


def _serialize_message(m: Message) -> dict:
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "role": m.role,
        "content": m.content,
        "created_at": m.created_at,
    }


def _build_feed(
    db: Session,
    goal_id: int | None = None,
    space_id: int | None = None,
    general: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Conversations sorted newest first.

    - general=True: return everything (no filter)
    - space_id set: filter by space
    - goal_id set: filter by goal (legacy)
    """
    q = db.query(Conversation).filter(Conversation.source != "telegram")

    if not general:
        if space_id is not None:
            q = q.filter(Conversation.space_id == space_id)
        elif goal_id is not None:
            q = q.filter(Conversation.goal_id == goal_id)

    items = [_serialize_conversation(c) for c in q.all()]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:limit]


# ── Feed ───────────────────────────────────────────────────────────────────────


@app.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    return _build_feed(db, general=True)


@app.get("/goals/{goal_id}/feed")
def get_goal_feed(goal_id: int, db: Session = Depends(get_db)):
    return _build_feed(db, goal_id=goal_id)


@app.get("/spaces/{space_id}/feed")
def get_space_feed(space_id: str, db: Session = Depends(get_db)):
    if space_id == "general":
        return _build_feed(db, general=True)
    return _build_feed(db, space_id=int(space_id))


# ── Conversation endpoints ─────────────────────────────────────────────────────


@app.post("/conversations")
async def create_general_conversation(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(db=db, goal_id=None, source="web", title=title)
    return _serialize_conversation(conv)


@app.post("/spaces/{space_id}/conversations")
async def create_space_conversation(
    space_id: str, body: dict, db: Session = Depends(get_db)
):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    numeric_id = None if space_id == "general" else int(space_id)
    goal = (
        db.query(Goal).filter(Goal.space_id == numeric_id).first()
        if numeric_id
        else None
    )
    conv = Conversation(
        title=title,
        source="web",
        space_id=numeric_id,
        goal_id=goal.id if goal else None,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return _serialize_conversation(conv)


@app.get("/conversations/{conversation_id}/messages")
def get_conversation_messages(conversation_id: int, db: Session = Depends(get_db)):
    msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in msgs]


@app.post("/conversations/{conversation_id}/seed")
def seed_conversation(conversation_id: int, body: dict, db: Session = Depends(get_db)):
    """Entry content becomes the first user message; Orchestrator generates Claude's reply."""
    entry_content = body.get("entry_content", "").strip()
    if not entry_content:
        return []
    try:
        Orchestrator.handle_chat(entry_content, db, conversation_id=conversation_id)
        msgs = conversation_service.get_messages(conversation_id, db)
        return [_serialize_message(m) for m in msgs]
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/conversations/{conversation_id}/messages")
def send_conversation_message(
    conversation_id: int, body: dict, db: Session = Depends(get_db)
):
    """Send a user message; returns full thread after Claude replies."""
    user_content = body.get("content", "").strip()
    if not user_content:
        raise HTTPException(status_code=400, detail="content is required")
    entry_content = body.get("entry_content", "")
    try:
        _, usage = Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return {
        "messages": [_serialize_message(m) for m in msgs],
        "intention": usage.get("intention") or "",
    }


@app.get("/health")
async def health():
    return {"message": "Health check"}


# ── Dashboard ──────────────────────────────────────────────────────────────────


@app.get("/dashboard")
def get_dashboard_stats(db: Session = Depends(get_db)):
    from datetime import date, datetime, timedelta

    from sqlalchemy import func as sqlfunc

    today = datetime.utcnow().date()
    week_ago = datetime.utcnow() - timedelta(days=7)

    notes_this_week = db.query(Note).filter(Note.updated_at >= week_ago).count()

    active_goals = db.query(Goal).filter(Goal.status == GoalStatus.ACTIVE).all()

    recent_notes = (
        db.query(Note)
        .order_by(sqlfunc.coalesce(Note.updated_at, Note.created_at).desc())
        .limit(5)
        .all()
    )

    # Streak: consecutive days with any activity (notes or conversations).
    # Allows today OR yesterday as the starting point so the streak stays
    # alive at the start of a new day before the user has done anything yet.
    try:
        date_rows = db.execute(
            text(
                "SELECT DISTINCT d FROM ("
                "  SELECT date(updated_at) as d FROM notes WHERE updated_at IS NOT NULL"
                "  UNION"
                "  SELECT date(created_at) as d FROM messages WHERE role = 'user' AND created_at IS NOT NULL"
                ") ORDER BY d DESC LIMIT 30"
            )
        ).fetchall()
        streak = 0
        if date_rows:
            most_recent = date.fromisoformat(date_rows[0][0])
            if most_recent >= today - timedelta(days=1):
                for i, row in enumerate(date_rows):
                    if date.fromisoformat(row[0]) == most_recent - timedelta(days=i):
                        streak += 1
                    else:
                        break
    except Exception:
        streak = 0

    return {
        "notes_this_week": notes_this_week,
        "active_goals_count": len(active_goals),
        "active_goals": [
            {"id": g.id, "title": g.title, "goal_type": g.goal_type.value}
            for g in active_goals
        ],
        "recent_notes": [_serialize_note(n) for n in recent_notes],
        "streak": streak,
    }


# ── MCP endpoints ─────────────────────────────────────────────────────────────


@app.get("/mcp/context")
def mcp_get_context(q: str = "", db: Session = Depends(get_db)):
    """Return memory context for a query. Empty query returns preferences + goals only."""
    if not q.strip():
        preferences = (
            db.query(Memory)
            .filter(
                Memory.memory_type == MemoryType.PREFERENCE, Memory.is_active == True
            )
            .all()
        )
        active_goals = db.query(Goal).filter(Goal.status == GoalStatus.ACTIVE).all()
        parts = []
        if preferences:
            parts.append("User preferences (always apply these):")
            for m in preferences:
                parts.append(f"- {m.content}")
        if active_goals:
            parts.append("Active goals:")
            for g in active_goals:
                parts.append(f"- {g.title}")
        return {"context": "\n".join(parts)}
    context = memory_service.build_memory_context(q, db)
    return {"context": context}


@app.post("/mcp/memories")
def mcp_add_memory(body: dict, db: Session = Depends(get_db)):
    """Upsert a fact or preference memory."""
    key = body.get("key", "").strip()
    content = body.get("content", "").strip()
    mem_type = body.get("type", "fact")
    if not key or not content:
        raise HTTPException(status_code=400, detail="key and content are required")
    memory = memory_service.upsert_memory(
        {"key": key, "content": content, "type": mem_type}, db
    )
    return {
        "id": memory.id,
        "key": memory.key,
        "content": memory.content,
        "type": memory.memory_type.value,
    }


@app.get("/mcp/memories/search")
def mcp_search_memories(q: str, limit: int = 10, db: Session = Depends(get_db)):
    """Search active memories by semantic similarity."""
    memories = memory_service.search_similar(q, limit=limit, db=db)
    return [
        {"id": m.id, "key": m.key, "type": m.memory_type.value, "content": m.content}
        for m in memories
    ]


@app.patch("/mcp/memories/{key}")
def mcp_edit_memory(key: str, body: dict, db: Session = Depends(get_db)):
    """Edit memory content in-place (re-embeds, does not supersede)."""
    normalized = key.lower().replace(" ", "_")
    memory = (
        db.query(Memory)
        .filter(Memory.key == normalized, Memory.is_active == True)
        .first()
    )
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found")
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    memory.content = content
    embedding, _ = llm_client.generate_embedding(content)
    memory.embedding = json.dumps(embedding)
    db.commit()
    db.refresh(memory)
    return {
        "id": memory.id,
        "key": memory.key,
        "type": memory.memory_type.value,
        "content": memory.content,
    }


@app.delete("/mcp/memories/{key}")
def mcp_forget_memory(key: str, db: Session = Depends(get_db)):
    """Soft-delete a memory by key (sets is_active=False)."""
    normalized = key.lower().replace(" ", "_")
    memory = (
        db.query(Memory)
        .filter(Memory.key == normalized, Memory.is_active == True)
        .first()
    )
    if not memory:
        raise HTTPException(status_code=404, detail="Memory not found")
    memory.is_active = False
    db.commit()
    return {"ok": True, "key": normalized}


@app.get("/mcp/notes/search")
def mcp_search_notes(q: str, limit: int = 5, db: Session = Depends(get_db)):
    """Search notes by semantic similarity to a query string."""
    query_embedding, _ = llm_client.generate_embedding(q)
    if not query_embedding:
        return []
    candidates = db.query(Note).filter(Note.embedding.isnot(None)).all()
    scored = []
    for n in candidates:
        try:
            sim = memory_service._cosine_similarity(
                query_embedding, json.loads(n.embedding)
            )
            scored.append((n, sim))
        except Exception:
            pass
    scored.sort(key=lambda x: x[1], reverse=True)
    return [_serialize_note(n) for n, _ in scored[:limit]]


@app.get("/dashboard/insight")
def get_dashboard_insight(db: Session = Depends(get_db)):
    from datetime import datetime, timedelta

    week_ago = datetime.utcnow() - timedelta(days=7)
    notes_this_week = db.query(Note).filter(Note.updated_at >= week_ago).count()
    recent_notes = (
        db.query(Note)
        .filter(Note.title.isnot(None), Note.title != "")
        .order_by(Note.updated_at.desc())
        .limit(5)
        .all()
    )
    active_goals = db.query(Goal).filter(Goal.status == GoalStatus.ACTIVE).all()

    parts = [f"Notes written this week: {notes_this_week}"]
    if recent_notes:
        parts.append(
            f"Recent note titles: {', '.join(n.title for n in recent_notes if n.title)}"
        )
    if active_goals:
        parts.append(f"Active goals: {', '.join(g.title for g in active_goals)}")
    context = "\n".join(parts)

    today_str = datetime.now().strftime("%A, %B %d, %Y")
    try:
        response = llm_client.client.chat.completions.create(
            model=llm_client.chat_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        f"You are Gooni. Today is {today_str}. "
                        "Write a brief 2-3 sentence daily briefing based on the user's recent activity. "
                        "Be specific and personal, not generic. Keep it under 60 words."
                    ),
                },
                {
                    "role": "user",
                    "content": f"My recent activity:\n{context}\n\nGive me my daily briefing.",
                },
            ],
            temperature=0.7,
            max_tokens=120,
        )
        insight = response.choices[0].message.content.strip()
    except Exception as e:
        print(f"Dashboard insight error: {e}")
        insight = None

    return {"insight": insight}
