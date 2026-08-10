
import inspect
import json as _json
import logging
from pathlib import Path as _Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Note,
    PublicProfile,
)

from ..serializers import (
    _notes_order, _parse_tags
)
from ..common import (
    _unique_viewers_for_note
)


log = logging.getLogger(__name__)

router = APIRouter()


#: Repo root. This file is `app/routers/public.py`, so the root is THREE
#: `.parent`s up. It was two, which resolved to `<repo>/app` — a directory that
#: has never contained `.mcp.json` or `mcp_servers/`, so both reads missed and
#: both misses were swallowed by `except Exception: pass`.
_REPO_ROOT = _Path(__file__).resolve().parent.parent.parent


def _mcp_servers_snapshot() -> list[dict]:
    """Servers from the MCP client config, with every secret-bearing field
    reduced: absolute paths → basenames, env values dropped (keys only).

    `.mcp.json` is per-machine and gitignored, so it is absent from the image;
    `.mcp.json.example` is the committed template and is what prod actually has.
    Falling back to it keeps the public showcase truthful on Fly — the example
    describes the same server wiring, and being a committed template it holds
    placeholders rather than secrets.
    """
    for candidate in (_REPO_ROOT / ".mcp.json", _REPO_ROOT / ".mcp.json.example"):
        if not candidate.exists():
            continue
        # A malformed config is worth a log line: this route renders a public
        # page, so it must not 500, but the previous silent `pass` is how an
        # empty showcase went unnoticed for months.
        try:
            raw = _json.loads(candidate.read_text())
        except (OSError, ValueError):
            log.exception("public/mcp: could not read %s", candidate)
            continue
        out: list[dict] = []
        for name, scfg in (raw.get("mcpServers") or {}).items():
            command = scfg.get("command", "")
            args = scfg.get("args") or []
            env = scfg.get("env") or {}
            out.append({
                "name": name,
                "command": _Path(command).name if command else "",
                "script": _Path(args[0]).name if args else None,
                "env_keys": list(env.keys()),
            })
        return out
    log.error(
        "public/mcp: neither .mcp.json nor .mcp.json.example under %s — "
        "the public MCP showcase will render with no servers",
        _REPO_ROOT,
    )
    return []


def _mcp_tools_snapshot() -> list[dict]:
    """Tools read from the live registry, not parsed out of a file.

    This used to AST-walk `mcp_servers/server.py` for `@mcp.tool()` functions.
    That file defined 25 of them until the MCP convergence (#465) moved every
    tool into `app.mcp_surface.tools` and left the server as 48 lines of
    transport wiring with zero decorators — so the walk would now find nothing
    even from the correct path. Reading `ALL_TOOLS` is the same source the three
    transports register from, so the showcase cannot drift from the surface it
    describes.
    """
    from ..mcp_surface.tools import ALL_TOOLS, STDIO_TOOLS

    out: list[dict] = []
    for name in STDIO_TOOLS:
        fn = ALL_TOOLS[name]
        params = []
        for param in inspect.signature(fn).parameters.values():
            if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
                continue
            params.append({
                "name": param.name,
                "required": param.default is inspect.Parameter.empty,
            })
        doc = inspect.getdoc(fn) or ""
        # First paragraph only — keeps the public surface tidy.
        short = doc.split("\n\n", 1)[0].strip().replace("\n", " ")
        out.append({"name": name, "params": params, "description": short})
    return out


@router.get("/public/mcp")
def get_public_mcp_config():
    """Sanitized snapshot of the project's MCP setup — servers (from the MCP
    client config) + tools (from the live `app.mcp_surface.tools` registry).
    Dynamic: add a tool to the registry and this endpoint reflects it on the
    next request. No secrets returned — absolute paths are reduced to
    basenames, env values stripped (keys only)."""
    return {"servers": _mcp_servers_snapshot(), "tools": _mcp_tools_snapshot()}


def _strip_html(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", html or "").strip()


def _read_time_min(html: str) -> int:
    import re
    text = re.sub(r"\s+", " ", _strip_html(html)).strip()
    return max(1, -(-len(text) // 1000))


@router.get("/public/notes")
def get_public_notes(db: Session = Depends(get_db)):
    """Return all public notes. Public-pinned first, then newest. No
    auth. Slice 6: Spaces died — tags carry the grouping signal; the FE
    renders the first tag where it used to show a space name."""
    rows = (
        db.query(Note)
        .filter(Note.is_public == True)  # noqa: E712
        .order_by(Note.is_public_pinned.desc(), _notes_order())
        .all()
    )
    result = []
    for n in rows:
        excerpt = _strip_html(n.content or "")[:150]
        tags = _parse_tags(n.tags)
        result.append({
            "id": n.id,
            "title": n.title,
            "space_name": tags[0] if tags else None,
            "tags": tags,
            "excerpt": excerpt,
            "updated_at": n.updated_at,
            "read_time_minutes": _read_time_min(n.content or ""),
            "is_public_pinned": bool(n.is_public_pinned),
        })
    return result


@router.get("/public/notes/{note_id}")
def get_public_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single public note's full content. 404 if not public."""
    note = db.query(Note).filter(Note.id == note_id, Note.is_public == True).first()  # noqa: E712
    if not note:
        raise HTTPException(status_code=404, detail="Not found")
    tags = _parse_tags(note.tags)
    return {
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "space_name": tags[0] if tags else None,
        "tags": tags,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
        "unique_viewers": _unique_viewers_for_note(db, note.id),
    }


@router.get("/public/notes/{note_id}/comments")
def get_public_note_comments(note_id: int, db: Session = Depends(get_db)):
    """NoteComment died in the Slice 6 nuke. Kept as an empty-list stub so
    the public page's comment fetch degrades silently instead of 404ing."""
    note = db.query(Note).filter(Note.id == note_id, Note.is_public == True).first()  # noqa: E712
    if not note:
        raise HTTPException(status_code=404, detail="Not found")
    return []


@router.get("/public/profile")
def get_public_profile(db: Session = Depends(get_db)):
    """Return the public bio + avatar + stats."""
    from sqlalchemy import func as sqlfunc
    profile = db.query(PublicProfile).first()
    note_count = db.query(Note).count()
    last_active = db.query(sqlfunc.max(Note.updated_at)).scalar()
    return {
        "bio": profile.bio if profile else None,
        "avatar_url": profile.avatar_url if profile else None,
        "note_count": note_count,
        "last_active": last_active.isoformat() if last_active else None,
    }


@router.patch("/public/profile")
def update_public_profile(body: dict, db: Session = Depends(get_db)):
    """Save bio and/or avatar_url. Either field is optional in the body —
    PATCH semantics: only the keys present overwrite. Pass `avatar_url: null`
    to clear the avatar back to the goofy default.
    """
    profile = db.query(PublicProfile).first()
    if not profile:
        profile = PublicProfile()
        db.add(profile)
    if "bio" in body:
        profile.bio = body.get("bio") or ""
    if "avatar_url" in body:
        v = body.get("avatar_url")
        profile.avatar_url = v if isinstance(v, str) and v.strip() else None
    db.commit()
    return {"ok": True}
