from dotenv import load_dotenv

from fastapi import Depends, FastAPI
from sqlalchemy.orm import Session

from .db.database import engine, get_db
from .db.models import Base, Interaction, Memory
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


@app.post("/chat", response_model=InteractionResponse)
async def chat(interaction: InteractionCreate, db: Session = Depends(get_db)):
    return orchestrator.handle_chat(interaction.content, db)


@app.get("/interactions", response_model=list[InteractionResponse])
async def get_interactions(db: Session = Depends(get_db)):
    interactions = db.query(Interaction).order_by(Interaction.timestamp.desc()).all()
    return interactions


@app.post("/memories", response_model=MemoryResponse)
async def create_memory(memory: MemoryCreate, db: Session = Depends(get_db)):
    db_memory = Memory(**memory.model_dump())
    db.add(db_memory)
    db.commit()
    db.refresh(db_memory)
    return db_memory


@app.get("/memories", response_model=list[MemoryResponse])
async def get_memories(db: Session = Depends(get_db)):
    memories = db.query(Memory).order_by(Memory.timestamp.desc()).all()
    return memories


# health check
@app.get("/health")
async def health():
    return {"message": "Health check"}
