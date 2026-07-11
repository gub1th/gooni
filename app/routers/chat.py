
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.schemas import ChatRequest
from ..services.orchestrator import Orchestrator


router = APIRouter()


@router.post("/chat")
def chat(body: ChatRequest, db: Session = Depends(get_db)):
    # Plain `def` on purpose: handle_chat is synchronous (up to ~14 serial
    # OpenAI round-trips). Declared `async`, it would run ON the event loop
    # and freeze every other request for the whole turn. Sync route handlers
    # get run_in_threadpool'd by Starlette automatically — same pattern as
    # the sibling routes in conversations.py.
    content, usage = Orchestrator.handle_chat(
        body.content,
        db,
        image_url=body.image_url,
        source="web",
        entry_content=body.entry_content or "",
        model=body.model,
    )
    return {"content": content, "usage": usage, "intention": usage.get("intention") or ""}
