import hashlib
import hmac
import json
import os
import re
import time

from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, Header, HTTPException, Request, UploadFile
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..db.database import engine, get_db, SessionLocal
from ..db.models import (
    Attachment,
    CapabilityFacet,
    Conversation,
    GooniTake,
    McpCall,
    Memory,
    Message,
    List as ListModel,
    ListItem,
    Note,
    NoteComment,
    PublicProfile,
    Reaction,
    Reflection,
    Settings,
    Space,
    Visit,
    WaProcessedId,
)
from ..db.schemas import ChatRequest
from ..llm.client import llm_client
from ..services.conversation_service import conversation_service
from ..services.item_service import item_service
from ..services.memory_service import memory_service
from ..services.messaging import (
    dispatch_inbound,
    imessage_channel,
    telegram_channel,
    whatsapp_channel,
)
from ..services.note_service import note_service
from ..services.orchestrator import Orchestrator
from ..services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
    compose_message as compose_nudge_message,
)

from ..serializers import (
    _TAG_RE, _IMG_TAG_RE, _WHITESPACE_RE, _EXTERNAL_IMG_SRC_RE, _REACTION_TARGETS, _REACTION_MAX_EMOJI_LEN, _REACTION_MAX_REACTOR_LEN, _excerpt_from_html, _strip_html_to_visible_text, _external_thumb_from_html, _note_excerpt, _parse_tags, _normalize_tags, _serialize_note, _serialize_note_lite, _notes_order, _serialize_list, _serialize_list_item, _serialize_item, _serialize_space, _serialize_settings, _serialize_promise, _serialize_comment, _validate_reaction_target, _serialize_reactions, _serialize_conversation, _serialize_message, _serialize_capability_facet, _serialize_reflection
)
from ..common import (
    _AUTH_PASSWORD, _expected_token, _parse_iso_date, _parse_optional_due, _parse_optional_dt, _validate_health, _validate_status, _validate_scale, _VALID_STATUS, _VALID_SCALE, _unique_viewers_for_note
)
from ..deps import _fire_nudge_once, _settings_row, _next_fire


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
    db: Session = Depends(get_db),
):
    """Upload an arbitrary file (PDF, doc, archive, etc.) to R2 and return
    its public URL + metadata. Frontend inserts a TipTap `attachment` node
    carrying the URL/mime/filename so the note body itself is the source
    of truth for what's attached.

    When `note_id` is supplied we also persist an `attachments` row so the
    backend has a directory for later cleanup / listing. v1 doesn't enforce
    a foreign-key match yet — the row is informational. Returns 503 when
    R2 isn't configured (frontend can decide whether to fall back)."""
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

    if note_id is not None:
        note = db.query(Note).filter(Note.id == note_id).first()
        if note is None:
            # Don't fail the upload — the bytes are already in R2. Just skip
            # the DB row and let the caller insert the node anyway.
            payload["attachment_id"] = None
        else:
            row = Attachment(
                note_id=note_id,
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
