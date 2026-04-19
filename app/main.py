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
    Message,
    Note,
    PublicProfile,
    Space,
)
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
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
            ("conversations", "space_id", "INTEGER"),
            ("notes", "space_id", "INTEGER"),
            ("notes", "updated_at", "INTEGER"),
            ("notes", "last_opened_at", "INTEGER"),
            ("spaces", "emoji", "TEXT"),
            ("notes", "embedding", "TEXT"),
            ("notes", "is_public", "INTEGER"),
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
        model=body.model,
    )
    return {"content": content, "usage": usage, "intention": usage.get("intention") or ""}


@app.get("/debug/memories")
async def debug_memories():
    memories = memory_service.get_all()
    return [{"id": m.get("id"), "memory": m.get("memory")} for m in memories]


# ── Spaces ────────────────────────────────────────────────────────────────────


def _serialize_space(s: Space) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "emoji": s.emoji,
    }


@app.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    spaces = db.query(Space).order_by(Space.id).all()
    return [_serialize_space(s) for s in spaces]


@app.post("/spaces")
def create_space(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    space = Space(name=name)
    db.add(space)
    db.commit()
    db.refresh(space)
    return {"id": space.id, "name": space.name, "emoji": space.emoji}


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
    return _serialize_space(space)


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
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "last_opened_at": n.last_opened_at,
        "is_public": bool(n.is_public),
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
    if "is_public" in body:
        note.is_public = bool(body["is_public"])
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
        memory_service.add_memory(raw)
    except Exception:
        pass
    return {"ok": True, "facts_saved": 1}


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
    space_id: int | None = None,
    general: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Conversations sorted newest first.

    - general=True: return everything (no filter)
    - space_id set: filter by space
    """
    q = db.query(Conversation).filter(Conversation.source != "telegram")

    if not general and space_id is not None:
        q = q.filter(Conversation.space_id == space_id)

    items = [_serialize_conversation(c) for c in q.all()]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:limit]


# ── Feed ───────────────────────────────────────────────────────────────────────


@app.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    return _build_feed(db, general=True)



# ── Conversation endpoints ─────────────────────────────────────────────────────


@app.post("/conversations")
async def create_general_conversation(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(db=db, source="web", title=title)
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
    model = body.get("model") or None
    try:
        _, usage = Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
            model=model,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return {
        "messages": [_serialize_message(m) for m in msgs],
        "intention": usage.get("intention") or "",
        "tools_used": usage.get("tools_used") or [],
    }


@app.get("/health")
async def health():
    return {"message": "Health check"}


# ── Dashboard ──────────────────────────────────────────────────────────────────



@app.get("/dashboard")
def get_dashboard_stats(db: Session = Depends(get_db)):
    from datetime import date, datetime, timedelta
    import re

    from sqlalchemy import func as sqlfunc

    today = datetime.utcnow().date()
    week_ago = datetime.utcnow() - timedelta(days=7)

    notes_this_week = db.query(Note).filter(Note.updated_at >= week_ago).count()

    recent_notes = (
        db.query(Note)
        .order_by(sqlfunc.coalesce(Note.updated_at, Note.created_at).desc())
        .limit(8)
        .all()
    )

    # Streak: consecutive days with any activity (notes or conversations).
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

    # Gooni's Take — generated from recent note titles
    gooni_take = ""
    titled = [n for n in recent_notes if n.title and n.title.strip()]
    if titled:
        note_list = "\n".join(f"- {n.title.strip()}" for n in titled[:6])
        mem_ctx = memory_service.build_memory_context("recent activity notes writing")
        mem_block = f"\n\nMemory context:\n{mem_ctx}" if mem_ctx else ""
        prompt = (
            f"You are Gooni — Daniel's AI notebook assistant.\n"
            f"Write a single short paragraph (2-3 sentences) observing what Daniel has been working on "
            f"based on his recent notes. Be direct and specific — reference actual note titles. "
            f"No preamble, no sign-off.\n\n"
            f"Recent notes:\n{note_list}{mem_block}\n\nWrite the observation:"
        )
        try:
            gooni_take = llm_client.generate_simple_completion(prompt, max_tokens=120)
        except Exception:
            gooni_take = ""

    return {
        "notes_this_week": notes_this_week,
        "recent_notes": [_serialize_note(n) for n in recent_notes],
        "streak": streak,
        "gooni_take": gooni_take,
    }


# ── MCP endpoints ─────────────────────────────────────────────────────────────


@app.get("/mcp/context")
def mcp_get_context(q: str = "", db: Session = Depends(get_db)):
    """Return memory context for a query."""
    if not q.strip():
        return {"context": ""}
    context = memory_service.build_memory_context(q)
    return {"context": context}


@app.post("/mcp/memories")
def mcp_add_memory(body: dict):
    """Add a memory."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    memory_service.add_memory(content)
    return {"ok": True}


@app.get("/mcp/memories/search")
def mcp_search_memories(q: str, limit: int = 10):
    """Search memories by semantic similarity."""
    memories = memory_service.search(q, limit=limit)
    return [{"id": m.get("id"), "memory": m.get("memory")} for m in memories]


@app.patch("/mcp/memories/{memory_id}")
def mcp_edit_memory(memory_id: str, body: dict):
    """Update a memory by ID."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    try:
        memory_service.client.update(memory_id, data=content)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True, "id": memory_id}


@app.delete("/mcp/memories/{memory_id}")
def mcp_forget_memory(memory_id: str):
    """Delete a memory by ID."""
    memory_service.delete(memory_id)
    return {"ok": True, "id": memory_id}


@app.get("/mcp/notes/search")
def mcp_search_notes(q: str, limit: int = 5, db: Session = Depends(get_db)):
    """Search notes by semantic similarity to a query string."""
    related = note_service.search_by_query(q, limit, db)
    return [_serialize_note(n) for n in related]


# ── Public portfolio ────────────────────────────────────────────────────────────


def _strip_html(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", html or "").strip()


@app.get("/public/notes")
def get_public_notes(db: Session = Depends(get_db)):
    """Return all public notes with their space name, newest first. No auth."""
    rows = (
        db.query(Note, Space)
        .outerjoin(Space, Note.space_id == Space.id)
        .filter(Note.is_public == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    result = []
    for n, space in rows:
        excerpt = _strip_html(n.content or "")[:150]
        result.append({
            "id": n.id,
            "title": n.title,
            "space_name": space.name if space else None,
            "excerpt": excerpt,
            "updated_at": n.updated_at,
        })
    return result


@app.get("/public/notes/{note_id}")
def get_public_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single public note's full content. 404 if not public."""
    note = db.query(Note).filter(Note.id == note_id, Note.is_public == True).first()  # noqa: E712
    if not note:
        raise HTTPException(status_code=404, detail="Not found")
    space = db.query(Space).filter(Space.id == note.space_id).first() if note.space_id else None
    return {
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "space_name": space.name if space else None,
        "updated_at": note.updated_at,
    }


@app.get("/public/profile")
def get_public_profile(db: Session = Depends(get_db)):
    """Return the public bio."""
    profile = db.query(PublicProfile).first()
    return {"bio": profile.bio if profile else None}


@app.patch("/public/profile")
def update_public_profile(body: dict, db: Session = Depends(get_db)):
    """Save the public bio."""
    bio = body.get("bio", "")
    profile = db.query(PublicProfile).first()
    if profile:
        profile.bio = bio
    else:
        profile = PublicProfile(bio=bio)
        db.add(profile)
    db.commit()
    return {"ok": True}


