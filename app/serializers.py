"""Shared serializers + note/HTML helpers used across routers and main.

App-level (same dir as main.py): relative imports stay at main.py depth.
"""
import json
import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .db.models import (
    CapabilityFacet,
    Conversation,
    ListItem,
    List as ListModel,
    Message,
    Note,
    NoteComment,
    Reflection,
    Settings,
    Space,
)


def _serialize_list(lst: ListModel) -> dict:
    return {
        "id": lst.id,
        "name": lst.name,
        "type": lst.type,
        "kind": lst.kind or "tasks",
        "emoji": lst.emoji,
        "sort_order": lst.sort_order,
        "created_at": lst.created_at.isoformat() if lst.created_at else None,
    }


def _serialize_list_item(it: ListItem) -> dict:
    """Generic list item shape — focus / todo / backlog fields all moved
    to dedicated tables. See serialize_focus / serialize_todo /
    serialize_ticket in their respective services for those payloads.
    """
    return {
        "id": it.id,
        "list_id": it.list_id,
        "text": it.text,
        "subtitle": it.subtitle,
        "done": bool(it.done),
        "actionable": bool(it.actionable),
        "completed_at": it.completed_at.isoformat() if it.completed_at else None,
        "sort_order": it.sort_order,
        "source_note_id": it.source_note_id,
        "created_at": it.created_at.isoformat() if it.created_at else None,
    }


def _serialize_item(it) -> dict:
    """Polymorphic serializer used by the legacy /items routes that still
    accept "item id can be focus OR todo." Routes through the dedicated
    serializers in focus_service / todo_service.
    """
    from .services.focus_service import serialize_focus
    from .services.todo_service import serialize_todo
    from .db.models import Focus, Todo
    if isinstance(it, Focus):
        return serialize_focus(it)
    if isinstance(it, Todo):
        return serialize_todo(it)
    raise TypeError(f"_serialize_item: unexpected type {type(it).__name__}")


def _serialize_settings(s: Settings) -> dict:
    try:
        channels = json.loads(s.nudge_channels or '["telegram"]')
    except json.JSONDecodeError:
        channels = ["telegram"]
    return {
        "nudge_enabled": bool(s.nudge_enabled),
        "nudge_hour": int(s.nudge_hour),
        "nudge_minute": int(s.nudge_minute),
        "nudge_tz": s.nudge_tz or "America/Los_Angeles",
        "nudge_channels": channels,
        "nudge_last_sent_day": s.nudge_last_sent_day,
        "nudge_prompt": s.nudge_prompt or "",
    }


def _serialize_space(s: Space) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "emoji": s.emoji,
        "is_pinned": bool(s.is_pinned),
        "description": s.description,
        "cover_image_url": s.cover_image_url,
    }


_TAG_RE = re.compile(r"<[^>]+>")


_IMG_TAG_RE = re.compile(r"<img[^>]*>", re.IGNORECASE)


_WHITESPACE_RE = re.compile(r"\s+")


_EXTERNAL_IMG_SRC_RE = re.compile(
    r'<img[^>]+src=["\'](https?://[^"\']+)["\']', re.IGNORECASE
)


def _excerpt_from_html(html: str | None, limit: int = 240) -> str | None:
    """Cheap plain-text excerpt for list-view rendering. Drops <img> entirely
    so inline base64 image bodies never leave the server."""
    if not html:
        return None
    no_img = _IMG_TAG_RE.sub("", html)
    no_tags = _TAG_RE.sub(" ", no_img)
    text = _WHITESPACE_RE.sub(" ", no_tags).strip()
    if not text:
        return None
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return text[:limit]


def _strip_html_to_visible_text(html: str | None) -> str:
    """Visual-emptiness probe used by the empty-overwrite guard.

    Returns the visible text content of `html` after dropping tags +
    common entities. Crucially, an `<img>` tag counts as visible (it
    paints pixels even with no surrounding text) — we substitute a
    sentinel so an image-only note isn't classified as empty by the
    PATCH guard. TipTap's empty-doc string `<p></p>` strips to ""
    here, which is the whole point — that string is what was bypassing
    the prior `.strip()`-only check.
    """
    if not html:
        return ""
    # Treat any <img> as a visible token before stripping all tags. Same
    # spirit as `_excerpt_from_html` dropping inline base64 — but here we
    # need to know the image was THERE, not what its src was.
    with_img_marker = _IMG_TAG_RE.sub(" img ", html)
    no_tags = _TAG_RE.sub(" ", with_img_marker)
    text = _WHITESPACE_RE.sub(" ", no_tags).strip()
    return (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .strip()
    )


def _external_thumb_from_html(html: str | None) -> str | None:
    """Return the first <img src="..."> only when it points to an http(s)
    URL. Inline data: URLs are dropped — those are exactly the bytes we're
    trying to keep out of list payloads (see PR #134 OOM postmortem)."""
    if not html:
        return None
    m = _EXTERNAL_IMG_SRC_RE.search(html)
    return m.group(1) if m else None


def _note_excerpt(n: Note) -> str | None:
    """Return cached `Note.excerpt` if present, else compute on the fly.
    Pre-backfill rows have NULL excerpt — fall back so list endpoints don't
    return blank previews until the async backfill catches up."""
    cached = getattr(n, "excerpt", None)
    if cached is not None:
        return cached
    return _excerpt_from_html(n.content)


def _parse_tags(raw: str | None) -> list[str]:
    """Return the JSON-list of tags stored on a Note, falling back to an
    empty list when the column is null or malformed. Tag strings are
    normalized to lowercase elsewhere; this helper doesn't re-normalize."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(t) for t in parsed if isinstance(t, (str, int)) and str(t).strip()]


def _normalize_tags(values) -> list[str]:
    """Accept the wire shape (list[str]) and return a deduped, lowercased,
    sorted, length-capped tag list. Empty strings dropped. Used on every
    PATCH so the DB never ends up with whitespace-or-case duplicates."""
    if not isinstance(values, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        if not isinstance(v, (str, int)):
            continue
        # Tags are short labels — strip whitespace, lowercase, cap at 60
        # chars so a stray paste of an entire paragraph can't bloat the
        # JSON column.
        cleaned = str(v).strip().lower()[:60]
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def _serialize_note(n: Note) -> dict:
    # Parse the JSON signals snapshot so the frontend gets a structured
    # object, not a string blob. None when classify_note hasn't run yet.
    signals = None
    if n.last_classify_signals:
        try:
            signals = json.loads(n.last_classify_signals)
        except (ValueError, TypeError):
            signals = None
    return {
        "id": n.id,
        "title": n.title,
        "content": n.content,
        "excerpt": _note_excerpt(n),
        "space_id": n.space_id,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "last_opened_at": n.last_opened_at,
        "is_public": bool(n.is_public),
        "is_pinned": bool(n.is_pinned),
        "is_public_pinned": bool(getattr(n, "is_public_pinned", False)),
        "is_draft": bool(getattr(n, "is_draft", False)),
        # Snapshot of what classify_note routed for this note's most recent
        # save. Drives the "Routed:" disclosure under the title — same shape
        # as the chat bubble so Daniel sees memory writes + backlog items
        # as soon as the async classifier finishes.
        "classify_signals": signals,
        "parent_note_id": n.parent_note_id,
        "excerpt_anchor": n.excerpt_anchor,
        "tags": _parse_tags(n.tags),
        "status": getattr(n, "status", "unprocessed") or "unprocessed",
        "icon": getattr(n, "icon", None),
    }


def _serialize_note_lite(n: Note) -> dict:
    """List-view shape — no full body. Drops `content` to keep notes-list
    payloads bounded (PR #134 shipped inline base64 images through every
    list endpoint and OOM'd Fly). Editor still pulls the full body via
    GET /notes/{id} on click. `excerpt` is the cached preview column;
    `thumb_src` is non-null only for external image URLs (post-R2)."""
    return {
        "id": n.id,
        "title": n.title,
        "content": None,
        "excerpt": _note_excerpt(n),
        "thumb_src": _external_thumb_from_html(n.content),
        "space_id": n.space_id,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "last_opened_at": n.last_opened_at,
        "is_public": bool(n.is_public),
        "is_pinned": bool(n.is_pinned),
        "is_public_pinned": bool(getattr(n, "is_public_pinned", False)),
        "is_draft": bool(getattr(n, "is_draft", False)),
        "classify_signals": None,
        "parent_note_id": n.parent_note_id,
        "excerpt_anchor": n.excerpt_anchor,
        "tags": _parse_tags(n.tags),
        "status": getattr(n, "status", "unprocessed") or "unprocessed",
    }


def _notes_order():
    from sqlalchemy import func

    return func.coalesce(Note.updated_at, Note.created_at).desc()


def _serialize_promise(p) -> dict:
    return {
        "id": p.id,
        "utterance": p.utterance,
        "summary": p.summary,
        "state": p.state,
        "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
        "slip_count": p.slip_count,
        "resolved_at": p.resolved_at.isoformat() if p.resolved_at else None,
        "source_message_id": p.source_message_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _serialize_comment(c: NoteComment) -> dict:
    return {
        "id": c.id,
        "note_id": c.note_id,
        "author": c.author,
        "content": c.content,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


_REACTION_TARGETS = ("note", "comment")


_REACTION_MAX_EMOJI_LEN = 32


_REACTION_MAX_REACTOR_LEN = 80


def _validate_reaction_target(target_type: str, target_id: int, db: Session) -> None:
    if target_type not in _REACTION_TARGETS:
        raise HTTPException(status_code=400, detail=f"target_type must be one of {_REACTION_TARGETS}")
    if target_type == "note":
        exists = db.query(Note.id).filter(Note.id == target_id).first()
    else:
        exists = db.query(NoteComment.id).filter(NoteComment.id == target_id).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"{target_type} {target_id} not found")


def _serialize_reactions(rows, viewer_reactor_id: str | None) -> list[dict]:
    """Group raw rows into per-emoji buckets with count + reacted_by_me.
    Sorted by count desc so the most-reacted emoji floats left."""
    buckets: dict[str, dict] = {}
    for r in rows:
        b = buckets.setdefault(r.emoji, {"emoji": r.emoji, "count": 0, "reacted_by_me": False})
        b["count"] += 1
        if viewer_reactor_id and r.reactor_id == viewer_reactor_id:
            b["reacted_by_me"] = True
    return sorted(buckets.values(), key=lambda b: (-b["count"], b["emoji"]))


def _serialize_conversation(c: Conversation) -> dict:
    return {
        "id": c.id,
        "type": "conversation",
        "title": c.title,
        "summary": c.summary,
        "space_id": c.space_id,
        "source": c.source,
        "created_at": c.created_at,
    }


def _serialize_message(m: Message) -> dict:
    parsed_trace = None
    if m.trace:
        try:
            parsed_trace = json.loads(m.trace)
        except (ValueError, TypeError):
            parsed_trace = None
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "role": m.role,
        "content": m.content,
        "created_at": m.created_at,
        "trace": parsed_trace,
    }


def _serialize_capability_facet(f: CapabilityFacet) -> dict:
    return {
        "id": f.id,
        "layer": f.layer,
        "facet_key": f.facet_key,
        "facet_text": f.facet_text,
        "status": f.status,
        "source": f.source,
        "evidence_json": f.evidence_json,
        "last_verified_at": f.last_verified_at.isoformat() if f.last_verified_at else None,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _serialize_reflection(r: Reflection) -> dict:
    return {
        "id": r.id,
        "message_id": r.message_id,
        "conversation_id": r.conversation_id,
        "user_critique_present": bool(r.user_critique_present),
        "critique_summary": r.critique_summary,
        "action_vs_described": r.action_vs_described,
        "gap_exposed": r.gap_exposed,
        "proposed_self_fix": r.proposed_self_fix,
        "severity": r.severity,
        "model": r.model,
        "kind": getattr(r, "kind", "turn"),
        "prev_reflection_id": getattr(r, "prev_reflection_id", None),
        "score": getattr(r, "score", None),
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _memory_to_dashboard(m) -> dict:
    """Full row shape for the dashboard table. Skips embedding (huge JSON
    string) since the table never displays it."""
    return {
        "id": m.id,
        "type": m.type,
        "key": m.key,
        "content": m.content,
        "confidence": m.confidence,
        "is_active": bool(m.is_active),
        "superseded_by": m.superseded_by,
        "focus_id": m.focus_id,
        "retrieval_count": m.retrieval_count,
        "last_retrieved_at": m.last_retrieved_at.isoformat() if m.last_retrieved_at else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }
