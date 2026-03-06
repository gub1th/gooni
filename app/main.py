from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import (  # noqa: F401 — triggers table creation
    Base,
    Interaction,
    Meal,
    Memory,
    Note,
    Workout,
    WorkoutSet,
)
from .db.schemas import InteractionCreate, InteractionResponse
from .services.goal_service import goal_service
from .services.meal_service import meal_service
from .services.workout_service import workout_service
from .services.memory_service import memory_service
from .services.note_service import note_service
from .services.orchestrator import Orchestrator

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
async def chat(interaction: InteractionCreate, db: Session = Depends(get_db)):
    content, usage = Orchestrator.handle_chat(interaction.content, db)
    return {"content": content, "usage": usage}


@app.get("/interactions", response_model=list[InteractionResponse])
async def get_interactions(db: Session = Depends(get_db)):
    interactions = db.query(Interaction).order_by(Interaction.timestamp.desc()).all()
    return interactions


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


@app.get("/debug/notes")
async def debug_notes(db: Session = Depends(get_db)):
    notes = db.query(Note).order_by(Note.created_at.desc()).limit(50).all()
    return [
        {
            "id": n.id,
            "content": n.content,
            "goal_id": n.goal_id,
            "outcome": n.outcome.value if n.outcome else None,
            "log_date": n.log_date,
            "created_at": n.created_at,
        }
        for n in notes
    ]


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


@app.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    notes = db.query(Note).order_by(Note.created_at.desc()).limit(100).all()
    return [
        {
            "id": n.id,
            "content": n.content,
            "goal_id": n.goal_id,
            "outcome": n.outcome.value if n.outcome else None,
            "created_at": n.created_at,
        }
        for n in notes
    ]


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
