"""Shared serializers + note/HTML helpers used across routers and main.

App-level (same dir as main.py): relative imports stay at main.py depth.
"""
import json
import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .db.models import (
    Conversation,
    Message,
    Note,
    Reflection,
    Settings,
)


def _serialize_settings(s: Settings) -> dict:
    return {
        # Legacy name; the app-wide canonical timezone (local_today reads it).
        "nudge_tz": s.nudge_tz or "America/Los_Angeles",
        "overlay_anchor_note_id": s.overlay_anchor_note_id,
        "overlay_whoop_keys": _safe_json_list(s.overlay_whoop_keys),
    }


def _safe_json_list(raw) -> list:
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except (TypeError, ValueError):
        return []


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
        "icon": getattr(n, "icon", None),
        "log_date": n.log_date.isoformat() if getattr(n, "log_date", None) else None,
        "home_pos": _parse_home_pos(getattr(n, "home_pos", None)),
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
        "log_date": n.log_date.isoformat() if getattr(n, "log_date", None) else None,
        "home_pos": _parse_home_pos(getattr(n, "home_pos", None)),
    }


def _parse_home_pos(raw):
    """Decode the JSON-as-text sticky placement into {"x","y"} (viewport
    fractions) + optional {"w","h"} (px size). Returns None for non-stickies
    or garbage."""
    if not raw:
        return None
    try:
        v = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(v, dict) or "x" not in v or "y" not in v:
        return None
    try:
        out = {"x": float(v["x"]), "y": float(v["y"])}
        for k in ("w", "h"):
            if v.get(k) is not None:
                out[k] = float(v[k])
        return out
    except (TypeError, ValueError):
        return None


def _notes_order():
    from sqlalchemy import func

    return func.coalesce(Note.updated_at, Note.created_at).desc()


def _serialize_promise(p) -> dict:
    return {
        "id": p.id,
        "utterance": p.utterance,
        "summary": p.summary,
        "state": p.state,
        "cadence": p.cadence or "once",
        "cadence_target": p.cadence_target,
        "is_important": bool(p.is_important),
        "parent_promise_id": p.parent_promise_id,
        "inferred_due": p.inferred_due.isoformat() if p.inferred_due else None,
        "slip_count": p.slip_count,
        "resolved_at": p.resolved_at.isoformat() if p.resolved_at else None,
        "source_message_id": p.source_message_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }








def _serialize_conversation(c: Conversation) -> dict:
    return {
        "id": c.id,
        "type": "conversation",
        "title": c.title,
        "summary": c.summary,
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
    preview = None
    if m.signal_preview:
        try:
            preview = json.loads(m.signal_preview)
        except (ValueError, TypeError):
            preview = None
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "role": m.role,
        "content": m.content,
        "created_at": m.created_at,
        "trace": parsed_trace,
        "has_actionable_signal": bool(m.has_actionable_signal),
        "signal_preview": preview,
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
        "retrieval_count": m.retrieval_count,
        "last_retrieved_at": m.last_retrieved_at.isoformat() if m.last_retrieved_at else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
        # Provenance ids (raw). The /memories router resolves these into a
        # displayable `source` object; kept here so MCP/other callers see them.
        "source_note_id": m.source_note_id,
        "source_message_id": m.source_message_id,
    }
