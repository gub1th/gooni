
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


router = APIRouter()


@router.get("/public/mcp")
def get_public_mcp_config():
    """Sanitized snapshot of the project's MCP setup — servers (from .mcp.json) + tools
    (parsed from mcp_servers/server.py via AST). Dynamic: edit the config or add a @mcp.tool() and
    this endpoint reflects the change on next request. No secrets returned — absolute paths
    are reduced to basenames, env values stripped (keys only)."""
    import ast
    import json as _json
    from pathlib import Path as _Path

    repo_root = _Path(__file__).resolve().parent.parent

    # 1) Parse .mcp.json — redact paths and env values
    servers: list[dict] = []
    mcp_json = repo_root / ".mcp.json"
    if mcp_json.exists():
        try:
            raw = _json.loads(mcp_json.read_text())
            for name, scfg in (raw.get("mcpServers") or {}).items():
                command = scfg.get("command", "")
                args = scfg.get("args") or []
                env = scfg.get("env") or {}
                servers.append({
                    "name": name,
                    "command": _Path(command).name if command else "",
                    "script": _Path(args[0]).name if args else None,
                    "env_keys": list(env.keys()),
                })
        except Exception:
            pass

    # 2) AST-walk mcp_servers/server.py for @mcp.tool() decorated functions
    def _dec_name(dec) -> str:
        if isinstance(dec, ast.Name):
            return dec.id
        if isinstance(dec, ast.Attribute):
            base = _dec_name(dec.value)
            return f"{base}.{dec.attr}" if base else dec.attr
        if isinstance(dec, ast.Call):
            return _dec_name(dec.func)
        return ""

    tools: list[dict] = []
    server_py = repo_root / "mcp_servers" / "server.py"
    if server_py.exists():
        try:
            tree = ast.parse(server_py.read_text())
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    is_tool = any(_dec_name(d) == "mcp.tool" for d in node.decorator_list)
                    if not is_tool:
                        continue
                    params = []
                    defaults = node.args.defaults or []
                    default_start = len(node.args.args) - len(defaults)
                    for i, arg in enumerate(node.args.args):
                        has_default = i >= default_start
                        params.append({
                            "name": arg.arg,
                            "required": not has_default,
                        })
                    doc = ast.get_docstring(node) or ""
                    # Keep only the first paragraph — keeps the surface tidy
                    short = doc.split("\n\n", 1)[0].strip().replace("\n", " ")
                    tools.append({
                        "name": node.name,
                        "params": params,
                        "description": short,
                    })
        except Exception:
            pass

    return {"servers": servers, "tools": tools}


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
