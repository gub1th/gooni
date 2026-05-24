
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..services import github as gh
from ..services import google_calendar as gcal
from ..db.models import TrackedRepo


router = APIRouter()


@router.post("/calendar/events")
def calendar_create_event(body: dict, db: Session = Depends(get_db)):
    """Create a Google Calendar event on the user's primary calendar.
    Body: { summary, start_iso, end_iso, description?, time_zone? }
    """
    summary = (body.get("summary") or "").strip()
    start_iso = body.get("start_iso")
    end_iso = body.get("end_iso")
    if not summary or not start_iso or not end_iso:
        raise HTTPException(status_code=400, detail="summary, start_iso, end_iso are required")
    try:
        event = gcal.create_event(
            db,
            summary=summary,
            start_iso=start_iso,
            end_iso=end_iso,
            description=body.get("description"),
            time_zone=body.get("time_zone"),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Calendar API error: {e}")
    return {
        "id": event.get("id"),
        "html_link": event.get("htmlLink"),
        "summary": event.get("summary"),
        "start": event.get("start"),
        "end": event.get("end"),
    }


@router.get("/integrations/github/repos")
def github_list_repos(db: Session = Depends(get_db)):
    """List repos the authenticated GitHub user can access. Returned shape
    is a thin slice — full GitHub repo objects are heavy.
    """
    try:
        repos = gh.list_user_repos(db)
    except RuntimeError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"GitHub API error: {e}")
    tracked_keys = {
        (r.owner, r.name)
        for r in db.query(TrackedRepo).filter(TrackedRepo.provider == "github").all()
    }
    return [
        {
            "owner": r["owner"]["login"],
            "name": r["name"],
            "full_name": r["full_name"],
            "description": r.get("description"),
            "private": r.get("private", False),
            "pushed_at": r.get("pushed_at"),
            "tracked": (r["owner"]["login"], r["name"]) in tracked_keys,
        }
        for r in repos
    ]


@router.get("/integrations/github/tracked")
def github_list_tracked(db: Session = Depends(get_db)):
    rows = (
        db.query(TrackedRepo)
        .filter(TrackedRepo.provider == "github")
        .order_by(TrackedRepo.added_at.desc())
        .all()
    )
    return [{"owner": r.owner, "name": r.name, "added_at": r.added_at.isoformat()} for r in rows]


@router.post("/integrations/github/repos/{owner}/{name}")
def github_track_repo(owner: str, name: str, db: Session = Depends(get_db)):
    existing = (
        db.query(TrackedRepo)
        .filter(
            TrackedRepo.provider == "github",
            TrackedRepo.owner == owner,
            TrackedRepo.name == name,
        )
        .first()
    )
    if existing:
        return {"tracked": True, "already": True}
    row = TrackedRepo(provider="github", owner=owner, name=name)
    db.add(row)
    db.commit()
    return {"tracked": True, "already": False}


@router.delete("/integrations/github/repos/{owner}/{name}")
def github_untrack_repo(owner: str, name: str, db: Session = Depends(get_db)):
    row = (
        db.query(TrackedRepo)
        .filter(
            TrackedRepo.provider == "github",
            TrackedRepo.owner == owner,
            TrackedRepo.name == name,
        )
        .first()
    )
    if not row:
        return {"tracked": False, "removed": False}
    db.delete(row)
    db.commit()
    return {"tracked": False, "removed": True}
