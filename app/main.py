import json

from dotenv import load_dotenv

from fastapi import Depends, FastAPI
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import Base, Interaction, EpisodicMemory, UserProfileMemory
from .db.schemas import (
    InteractionCreate,
    InteractionResponse,
    MemoryCreate,
    MemoryResponse,
)
from .services import orchestrator

# Load environment variables from .env file
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


@app.post("/memories", response_model=MemoryResponse)
async def create_memory(memory: MemoryCreate, db: Session = Depends(get_db)):
    db_memory = EpisodicMemory(**memory.model_dump())
    db.add(db_memory)
    db.commit()
    db.refresh(db_memory)
    return db_memory


@app.get("/memories", response_model=list[MemoryResponse])
async def get_memories(db: Session = Depends(get_db)):
    memories = db.query(EpisodicMemory).order_by(EpisodicMemory.timestamp.desc()).all()
    return memories


@app.get("/debug/memories/profile")
async def debug_profile_memories(db: Session = Depends(get_db)):
    memories = db.query(UserProfileMemory).filter(
        UserProfileMemory.is_active
    ).order_by(UserProfileMemory.memory_type).all()
    return [
        {
            "id": m.id,
            "type": m.memory_type.value,
            "key": m.key,
            "value": m.value,
            "context": json.loads(m.context) if m.context else None,
            "confidence": m.confidence,
            "created_at": m.created_at,
            "updated_at": m.updated_at,
        }
        for m in memories
    ]


@app.get("/debug/memories/episodic")
async def debug_episodic_memories(db: Session = Depends(get_db)):
    memories = db.query(EpisodicMemory).order_by(EpisodicMemory.timestamp.desc()).all()
    return [
        {
            "id": m.id,
            "content": m.content,
            "extra": json.loads(m.extra) if m.extra else None,
            "timestamp": m.timestamp,
        }
        for m in memories
    ]


# health check
@app.get("/health")
async def health():
    return {"message": "Health check"}
