
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.schemas import ChatRequest
from ..services.orchestrator import Orchestrator


router = APIRouter()


@router.post("/chat")
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
