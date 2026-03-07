from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import (  # noqa: F401 — triggers table creation
    Base,
    Conversation,
    Meal,
    Memory,
    Message,
    Note,
    Workout,
    WorkoutSet,
)
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
from .services.goal_service import goal_service
from .services.meal_service import meal_service
from .services.memory_service import memory_service
from .services.note_service import note_service
from .services.orchestrator import Orchestrator
from .services.workout_service import workout_service

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
        body.content, db, image_url=body.image_url
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
    return {"id": goal.id, "title": goal.title, "goal_type": goal.goal_type.value, "streak": 0, "last_7_days": [False] * 7}


@app.get("/goals")
def get_goals(db: Session = Depends(get_db)):
    goals = goal_service.get_active(db)
    result = []
    for g in goals:
        streak = note_service.calculate_streak(g.id, db)
        days = note_service.get_last_7_days(g.id, db)
        result.append(
            {
                "id": g.id,
                "title": g.title,
                "goal_type": g.goal_type.value,
                "streak": streak["current_streak"],
                "last_7_days": days,
            }
        )
    return result


# ── Serializers ────────────────────────────────────────────────────────────────


def _serialize_note(n: Note) -> dict:
    return {
        "id": n.id,
        "type": "note",
        "content": n.content,
        "title": n.title,
        "goal_id": n.goal_id,
        "outcome": n.outcome.value if n.outcome else None,
        "created_at": n.created_at,
    }


def _serialize_conversation(c: Conversation) -> dict:
    return {
        "id": c.id,
        "type": "conversation",
        "title": c.title,
        "summary": c.summary,
        "goal_id": c.goal_id,
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
    db: Session, goal_id: int | None = None, limit: int = 100
) -> list[dict]:
    """Merge Notes + Conversations for a space, sorted newest first."""
    notes_q = db.query(Note)
    convs_q = db.query(Conversation)
    if goal_id is not None:
        notes_q = notes_q.filter(Note.goal_id == goal_id)
        convs_q = convs_q.filter(Conversation.goal_id == goal_id)
    else:
        notes_q = notes_q.filter(Note.goal_id.is_(None))
        convs_q = convs_q.filter(Conversation.goal_id.is_(None))

    items = [_serialize_note(n) for n in notes_q.all()] + [
        _serialize_conversation(c) for c in convs_q.all()
    ]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:limit]


# ── Feed ───────────────────────────────────────────────────────────────────────


@app.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    """General feed: notes + conversations with no goal_id."""
    return _build_feed(db, goal_id=None)


@app.get("/goals/{goal_id}/feed")
def get_goal_feed(goal_id: int, db: Session = Depends(get_db)):
    return _build_feed(db, goal_id=goal_id)


# ── Note endpoints ─────────────────────────────────────────────────────────────


@app.post("/notes")
async def create_general_note(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    note = note_service.create(content=content, db=db, goal_id=None, title=title)
    return _serialize_note(note)


@app.post("/goals/{goal_id}/notes")
async def create_goal_note(goal_id: int, body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    note = note_service.create(content=content, db=db, goal_id=goal_id, title=title)
    return _serialize_note(note)


@app.patch("/notes/{note_id}")
def update_note(note_id: int, body: dict, db: Session = Depends(get_db)):
    try:
        note = note_service.update(note_id, body.get("content", ""), db)
        return _serialize_note(note)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Conversation endpoints ─────────────────────────────────────────────────────


@app.post("/conversations")
async def create_general_conversation(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(db=db, goal_id=None, source="web", title=title)
    return _serialize_conversation(conv)


@app.post("/goals/{goal_id}/conversations")
async def create_goal_conversation(
    goal_id: int, body: dict, db: Session = Depends(get_db)
):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(
        db=db, goal_id=goal_id, source="web", title=title
    )
    return _serialize_conversation(conv)


@app.post("/conversations/{conversation_id}/seed")
async def seed_conversation(
    conversation_id: int, body: dict, db: Session = Depends(get_db)
):
    """Claude opens a conversation unprompted — no user message stored."""
    goal_id = body.get("goal_id")
    entry_content = body.get("entry_content", "")
    goal_context = ""
    if goal_id:
        goals = goal_service.get_active(db)
        goal = next((g for g in goals if g.id == goal_id), None)
        if goal:
            goal_context = goal_service.build_single_goal_context(goal, db)
    try:
        assistant_msg = await conversation_service.seed(
            conversation_id, goal_context, db, entry_content=entry_content
        )
        return [_serialize_message(assistant_msg)]
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/conversations/{conversation_id}/messages")
def get_conversation_messages(conversation_id: int, db: Session = Depends(get_db)):
    msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in msgs]


@app.post("/conversations/{conversation_id}/messages")
async def send_conversation_message(
    conversation_id: int, body: dict, db: Session = Depends(get_db)
):
    """Send a user message in a conversation. Returns all messages in the thread."""
    user_content = body.get("content", "").strip()
    if not user_content:
        raise HTTPException(status_code=400, detail="content is required")
    goal_id = body.get("goal_id")
    entry_content = body.get("entry_content", "")
    goal_context = ""
    if goal_id:
        goals = goal_service.get_active(db)
        goal = next((g for g in goals if g.id == goal_id), None)
        if goal:
            goal_context = goal_service.build_single_goal_context(goal, db)
    await conversation_service.chat(
        conversation_id, user_content, goal_context, db, entry_content=entry_content
    )
    all_msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in all_msgs]


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
