from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import gmail_service


router = APIRouter()


@router.get("/gmail/status")
def gmail_status(db: Session = Depends(get_db)):
    """Reuses the Calendar Google connection — see gmail_service.py."""
    return gmail_service.connection_status(db)


@router.get("/gmail/threads")
def gmail_threads(
    q: str | None = None,
    max_results: int = 20,
    page_token: str | None = None,
    db: Session = Depends(get_db),
):
    try:
        return gmail_service.list_threads(db, q=q, max_results=max_results, page_token=page_token)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {e}")


@router.get("/gmail/threads/{thread_id}")
def gmail_thread(thread_id: str, format: str = "metadata", db: Session = Depends(get_db)):
    try:
        return gmail_service.get_thread(db, thread_id, format=format)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {e}")


@router.get("/gmail/search")
def gmail_search(q: str, max_results: int = 20, db: Session = Depends(get_db)):
    if not q:
        raise HTTPException(status_code=400, detail="q is required")
    try:
        return gmail_service.search(db, q=q, max_results=max_results)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {e}")
