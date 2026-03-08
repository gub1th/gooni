from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from datetime import datetime

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
    Meal,
    Memory,
    Message,
    Note,
    Space,
    Workout,
    WorkoutSet,
)
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
from .services.goal_service import goal_service
from .services.meal_service import meal_service
from .services.memory_service import memory_service
from .services.orchestrator import Orchestrator
from .services.workout_service import workout_service


def _run_column_migrations(engine):
    """Add space_id to existing tables. Only runs ALTER if table exists but column is missing."""
    with engine.connect() as conn:
        existing_tables = {
            r[0]
            for r in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        for table, col in [
            ("goals", "space_id"),
            ("conversations", "space_id"),
        ]:
            if table not in existing_tables:
                continue  # fresh DB: create_all will add the column via model definition
            existing_cols = [
                r[1] for r in conn.execute(text(f"PRAGMA table_info({table})"))
            ]
            if col not in existing_cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER"))
                print(f"Migration: added {table}.{col}")
        conn.commit()


# 1. Create spaces table first (so FK references are valid)
Base.metadata.create_all(bind=engine, tables=[Space.__table__])
# 2. Add space_id to any existing tables that predate this change
_run_column_migrations(engine)
# 3. Create remaining tables (they already have space_id in their model definition)
Base.metadata.create_all(bind=engine)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.post("/chat")
async def chat(body: ChatRequest, db: Session = Depends(get_db)):
    content, usage = Orchestrator.handle_chat(
        body.content, db, image_url=body.image_url, entry_content=body.entry_content or ""
    )
    return {"content": content, "usage": usage}


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


@app.post("/goals")
def create_goal(body: dict, db: Session = Depends(get_db)):
    title = body.get("title", "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    goal = goal_service.create(title=title, db=db)
    return {
        "id": goal.id,
        "title": goal.title,
        "goal_type": goal.goal_type.value,
    }


@app.get("/goals")
def get_goals(db: Session = Depends(get_db)):
    goals = goal_service.get_active(db)
    return [
        {
            "id": g.id,
            "title": g.title,
            "goal_type": g.goal_type.value,
        }
        for g in goals
    ]


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
        "goal_id": goal.id if goal else None,
    }


@app.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    spaces = db.query(Space).order_by(Space.id).all()
    return [_serialize_space(s, db) for s in spaces]


@app.post("/spaces")
def create_space(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    space = Space(name=name)
    db.add(space)
    db.commit()
    db.refresh(space)
    return {"id": space.id, "name": space.name, "goal_id": None}


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
        Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in msgs]


# ── Note endpoints ───────────────────────────────────────────────────────────


def _serialize_note(n: Note) -> dict:
    return {
        "id": n.id,
        "title": n.title,
        "content": n.content,
        "space_id": n.space_id,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


@app.get("/spaces/{space_id}/notes")
def get_space_notes(space_id: str, db: Session = Depends(get_db)):
    """List notes for space, sorted updated_at desc."""
    if space_id == "general":
        notes = db.query(Note).filter(Note.space_id.is_(None)).all()
    else:
        notes = db.query(Note).filter(Note.space_id == int(space_id)).all()

    notes.sort(key=lambda n: n.updated_at or n.created_at, reverse=True)
    return [_serialize_note(n) for n in notes]


@app.get("/notes")
def get_general_notes(db: Session = Depends(get_db)):
    """General notes (space_id IS NULL)."""
    notes = db.query(Note).filter(Note.space_id.is_(None)).all()
    notes.sort(key=lambda n: n.updated_at or n.created_at, reverse=True)
    return [_serialize_note(n) for n in notes]


@app.post("/spaces/{space_id}/notes")
async def create_space_note(space_id: str, body: dict, db: Session = Depends(get_db)):
    """Create note in space."""
    title = body.get("title")
    content = body.get("content")

    note = Note(
        title=title,
        content=content,
        space_id=None if space_id == "general" else int(space_id),
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    return _serialize_note(note)


@app.post("/notes")
async def create_general_note(body: dict, db: Session = Depends(get_db)):
    """Create general note."""
    title = body.get("title")
    content = body.get("content")

    note = Note(title=title, content=content, space_id=None)
    db.add(note)
    db.commit()
    db.refresh(note)

    return _serialize_note(note)


@app.patch("/notes/{note_id}")
def update_note(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Update note and embed content into memory."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    title = body.get("title", note.title)
    content = body.get("content", note.content)

    note.title = title
    note.content = content
    note.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(note)

    # Create memory episode if content is substantial
    if content and len(content) > 10:
        memory_service.create_episode(content, goal_id=None, db=db)

    return _serialize_note(note)


@app.delete("/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    """Delete note."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    db.delete(note)
    db.commit()
    return {"message": "Note deleted"}


# ── Workout / Macros ───────────────────────────────────────────────────────────


@app.get("/workout/today")
def get_workout_today(db: Session = Depends(get_db)):
    from datetime import date

    return workout_service.get_daily_workout(date.today(), db)


@app.get("/macros/today")
def get_macros_today(db: Session = Depends(get_db)):
    from datetime import date

    return meal_service.get_daily_totals(date.today(), db)


@app.get("/health")
async def health():
    return {"message": "Health check"}
