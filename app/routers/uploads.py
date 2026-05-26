
from typing import Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Attachment,
    Note,
    Todo,
)



router = APIRouter()


_MAX_UPLOAD_BYTES = 10 * 1024 * 1024


_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024


_ALLOWED_IMAGE_PREFIX = "image/"


@router.post("/uploads/image")
async def upload_image_route(file: UploadFile = File(...)):
    """Upload a pasted/dropped image to Cloudflare R2 and return its public
    URL. Frontend rewrites <img src="data:..."> to this URL so note bodies
    stay tiny (see PR #134 OOM postmortem).

    Returns 503 when R2 isn't configured — frontend falls back to inline
    base64, so dev / un-provisioned envs still work, just with the old
    storage cost.
    """
    from ..services import image_storage

    # Validate cheap things (type, size) before checking R2 config — keeps
    # 415/413 responses honest even in dev environments where the route is
    # always going to 503 anyway. Route the misuse signal correctly.
    content_type = (file.content_type or "").lower()
    if not content_type.startswith(_ALLOWED_IMAGE_PREFIX):
        raise HTTPException(status_code=415, detail=f"unsupported content-type: {content_type}")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image too large: {len(data)} bytes (max {_MAX_UPLOAD_BYTES})",
        )

    if not image_storage.is_configured():
        raise HTTPException(
            status_code=503,
            detail="R2 image storage not configured (R2_ACCOUNT_ID etc unset)",
        )

    try:
        result = image_storage.upload_image(data, content_type, file.filename)
    except image_storage.R2NotConfigured as e:
        # Race between is_configured() and upload (env yanked mid-call).
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        # Surface a generic 502 — the underlying boto error message can leak
        # bucket / endpoint specifics. Logged separately for inspection.
        print(f"R2 upload failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="upload failed")

    return result


@router.post("/uploads/file")
async def upload_file_route(
    file: UploadFile = File(...),
    note_id: Optional[int] = Form(None),
    todo_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload an arbitrary file (PDF, doc, archive, etc.) to R2 and return
    its public URL + metadata. Frontend inserts a TipTap `attachment` node
    carrying the URL/mime/filename so the note body itself is the source
    of truth for what's attached.

    When `note_id` OR `todo_id` is supplied we also persist an `attachments`
    row so the backend has a directory for later cleanup / listing (a row
    sets exactly one owner). Returns 503 when R2 isn't configured (frontend
    can decide whether to fall back)."""
    from ..services import image_storage

    content_type = (file.content_type or "application/octet-stream").lower()
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(data) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large: {len(data)} bytes (max {_MAX_ATTACHMENT_BYTES})",
        )

    if not image_storage.is_configured():
        raise HTTPException(
            status_code=503,
            detail="R2 storage not configured (R2_ACCOUNT_ID etc unset)",
        )

    try:
        result = image_storage.upload_file(data, content_type, file.filename)
    except image_storage.R2NotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        print(f"R2 upload failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="upload failed")

    filename = (file.filename or "").strip() or f"attachment.{result['ext']}"
    payload = {
        "url": result["url"],
        "key": result["key"],
        "filename": filename,
        "mime_type": content_type,
        "size_bytes": len(data),
    }

    # Persist an attachments row when an owner is supplied. Exactly one of
    # note_id / todo_id is expected; todo_id wins if both are passed. A
    # missing/unknown owner doesn't fail the upload — the bytes are already
    # in R2, so we just skip the DB row and let the caller proceed.
    owner_note_id: Optional[int] = None
    owner_todo_id: Optional[int] = None
    if todo_id is not None:
        if db.query(Todo).filter(Todo.id == todo_id).first() is not None:
            owner_todo_id = todo_id
    elif note_id is not None:
        if db.query(Note).filter(Note.id == note_id).first() is not None:
            owner_note_id = note_id

    if owner_note_id is not None or owner_todo_id is not None:
        row = Attachment(
            note_id=owner_note_id,
            todo_id=owner_todo_id,
            filename=filename,
            mime_type=content_type,
            size_bytes=len(data),
            storage_key=result["key"],
            public_url=result["url"],
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        payload["attachment_id"] = row.id
    elif note_id is not None or todo_id is not None:
        # Owner was supplied but not found — keep the bytes, skip the row.
        payload["attachment_id"] = None

    return payload


@router.get("/uploads/og")
async def fetch_og_metadata(url: str):
    """Fetch an HTML page and extract Open Graph / basic meta tags so the
    frontend can render a Confluence-style link card without exposing
    Gooni's IP to direct page fetches in the browser.

    No DB row — caller's TipTap LinkCard node persists the metadata
    inline in the note body. Network errors / non-HTML responses degrade
    gracefully to {url, title: url} so insertion still succeeds.
    """
    import httpx
    from urllib.parse import urlparse
    from bs4 import BeautifulSoup

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="only http(s) URLs supported")

    headers = {
        # Some sites (Twitter/X, LinkedIn) gate OG tags behind a UA check —
        # plain httpx UA gets a redirect to a login page. Pretend to be a
        # browser bot so we land on the public OG-tagged HTML.
        "User-Agent": "Mozilla/5.0 (compatible; GooniLinkPreview/1.0)",
        "Accept": "text/html,application/xhtml+xml",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as e:
        return {"url": url, "title": url, "description": None, "image": None, "site_name": parsed.netloc, "fetch_error": f"{type(e).__name__}"}

    ctype = (resp.headers.get("content-type") or "").lower()
    if "html" not in ctype:
        return {"url": url, "title": url, "description": None, "image": None, "site_name": parsed.netloc, "fetch_error": f"non-html content-type: {ctype}"}

    soup = BeautifulSoup(resp.text, "html.parser")

    def _meta(name: str) -> str | None:
        # Match both <meta property="og:title"> and <meta name="og:title">.
        for attr in ("property", "name"):
            tag = soup.find("meta", attrs={attr: name})
            if tag and tag.get("content"):
                v = tag["content"].strip()
                if v:
                    return v
        return None

    title = _meta("og:title") or (soup.title.text.strip() if soup.title and soup.title.text else url)
    description = _meta("og:description") or _meta("description")
    image = _meta("og:image") or _meta("twitter:image")
    site_name = _meta("og:site_name") or parsed.netloc

    # Resolve protocol-relative / relative og:image URLs against the
    # destination origin so the frontend can render them without further
    # rewriting. Plain absolute URLs pass through unchanged.
    if image:
        if image.startswith("//"):
            image = f"{parsed.scheme}:{image}"
        elif image.startswith("/"):
            image = f"{parsed.scheme}://{parsed.netloc}{image}"

    return {
        "url": str(resp.url),
        "title": (title or url)[:300],
        "description": (description or "")[:400] if description else None,
        "image": image,
        "site_name": site_name,
    }


@router.get("/notes/{note_id}/attachments")
def list_note_attachments(note_id: int, db: Session = Depends(get_db)):
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    rows = (
        db.query(Attachment)
        .filter(Attachment.note_id == note_id)
        .order_by(Attachment.created_at.asc(), Attachment.id.asc())
        .all()
    )
    return [
        {
            "id": a.id,
            "filename": a.filename,
            "mime_type": a.mime_type,
            "size_bytes": a.size_bytes,
            "url": a.public_url,
            "created_at": a.created_at,
        }
        for a in rows
    ]


@router.get("/todos/{todo_id}/attachments")
def list_todo_attachments(todo_id: int, db: Session = Depends(get_db)):
    if not db.query(Todo).filter(Todo.id == todo_id).first():
        raise HTTPException(status_code=404, detail="Todo not found")
    rows = (
        db.query(Attachment)
        .filter(Attachment.todo_id == todo_id)
        .order_by(Attachment.created_at.asc(), Attachment.id.asc())
        .all()
    )
    return [
        {
            "id": a.id,
            "filename": a.filename,
            "mime_type": a.mime_type,
            "size_bytes": a.size_bytes,
            "url": a.public_url,
            "created_at": a.created_at,
        }
        for a in rows
    ]


@router.delete("/attachments/{attachment_id}")
def delete_attachment(attachment_id: int, db: Session = Depends(get_db)):
    """Remove the DB row only — leaves the R2 object behind. A future
    sweeper can reconcile orphan keys against the table."""
    row = db.query(Attachment).filter(Attachment.id == attachment_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    db.delete(row)
    db.commit()
    return {"ok": True}
