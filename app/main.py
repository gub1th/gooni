from dotenv import load_dotenv

from fastapi import Depends, FastAPI
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import Base, Interaction, Memory, Note  # noqa: F401 — triggers table creation
from .db.schemas import InteractionCreate, InteractionResponse
from .services import orchestrator
from .services.memory_service import memory_service

load_dotenv()

Base.metadata.create_all(bind=engine)

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.post("/chat")
async def chat(interaction: InteractionCreate, db: Session = Depends(get_db)):
    content, usage = orchestrator.handle_chat(interaction.content, db)
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


@app.get("/health")
async def health():
    return {"message": "Health check"}
