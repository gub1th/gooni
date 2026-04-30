import hashlib
import hmac
import json
import os
import re
import time
from collections import defaultdict, deque

from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session, aliased

from .db.database import engine, get_db
from .db.database import SessionLocal
from .db.models import (  # noqa: F401 — triggers table creation
    Base,
    Conversation,
    Memory,
    Message,
    List as ListModel,
    ListItem,
    Note,
    PublicProfile,
    Space,
    Visit,
)
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
from .services.item_service import item_service
from .services.memory_service import memory_service
from .services.messaging import dispatch_inbound, imessage_channel, whatsapp_channel
from .services.note_service import note_service
from .services.orchestrator import Orchestrator


def _migrate_memories_legacy_schema(engine):
    """Reshape an older `memories` table (memory_type enum, goal_id FK,
    no context/updated_at) to the new shape. Preserves the 255-ish rows
    of pre-Mem0 episodic + typed memories via memories_legacy_backup.
    Idempotent: skips when schema is already current.
    """
    with engine.connect() as conn:
        existing_tables = {
            r[0]
            for r in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        if "memories" not in existing_tables:
            return
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(memories)"))]
        if "type" in cols and "context" in cols:
            return  # already on new schema
        if "memory_type" not in cols:
            return  # unknown legacy shape; bail rather than guess

        rows = list(
            conn.execute(
                text(
                    "SELECT id, memory_type, key, content, goal_id, embedding, "
                    "confidence, is_active, superseded_by, created_at "
                    "FROM memories"
                )
            )
        )
        if "memories_legacy_backup" not in existing_tables:
            conn.execute(
                text(
                    "CREATE TABLE memories_legacy_backup AS SELECT * FROM memories"
                )
            )
            print(f"Migration: backed up {len(rows)} memories to memories_legacy_backup")
        conn.execute(text("DROP TABLE memories"))
        conn.commit()

        engine._pending_memory_backfill = [
            {
                "id": r[0],
                "memory_type": r[1],
                "key": r[2],
                "content": r[3],
                "goal_id": r[4],
                "embedding": r[5],
                "confidence": r[6],
                "is_active": r[7],
                "superseded_by": r[8],
                "created_at": r[9],
            }
            for r in rows
        ]


def _backfill_memories(engine):
    """Re-insert legacy memory rows after the new table has been created.
    Maps memory_type → type (lowercased), goal_id → focus_id, and fills
    updated_at = created_at since the legacy schema didn't track it.
    """
    rows = getattr(engine, "_pending_memory_backfill", None)
    if not rows:
        return
    with engine.connect() as conn:
        for r in rows:
            mtype = (r["memory_type"] or "episode").lower()
            # Old enum values came in upper-case ("EPISODE", "FACT", etc.)
            conn.execute(
                text(
                    "INSERT INTO memories (id, type, key, content, context, "
                    "confidence, embedding, focus_id, is_active, superseded_by, "
                    "created_at, updated_at) VALUES "
                    "(:id, :type, :key, :content, NULL, :confidence, :embedding, "
                    ":focus_id, :is_active, :superseded_by, :created_at, :created_at)"
                ),
                {
                    "id": r["id"],
                    "type": mtype,
                    "key": r["key"],
                    "content": r["content"],
                    "confidence": r["confidence"] if r["confidence"] is not None else 0.8,
                    "embedding": r["embedding"],
                    "focus_id": r["goal_id"],  # old goal_id is now focus_id
                    "is_active": r["is_active"] if r["is_active"] is not None else 1,
                    "superseded_by": r["superseded_by"],
                    "created_at": r["created_at"],
                },
            )
        conn.commit()
        print(f"Migration: backfilled {len(rows)} memories onto new schema")
    engine._pending_memory_backfill = None


def _run_column_migrations(engine):
    """Add space_id to existing tables. Only runs ALTER if table exists but column is missing."""
    with engine.connect() as conn:
        existing_tables = {
            r[0]
            for r in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        # Rename legacy google_oauth_tokens → oauth_tokens (generic connector
        # store). Idempotent: skip if already renamed or if neither exists.
        if "google_oauth_tokens" in existing_tables and "oauth_tokens" not in existing_tables:
            conn.execute(text("ALTER TABLE google_oauth_tokens RENAME TO oauth_tokens"))
            print("Migration: renamed google_oauth_tokens → oauth_tokens")
            existing_tables.discard("google_oauth_tokens")
            existing_tables.add("oauth_tokens")
        # (table, col, sql_type)
        for table, col, col_type in [
            ("conversations", "space_id", "INTEGER"),
            ("notes", "space_id", "INTEGER"),
            ("notes", "updated_at", "INTEGER"),
            ("notes", "last_opened_at", "INTEGER"),
            ("spaces", "emoji", "TEXT"),
            ("notes", "embedding", "TEXT"),
            ("notes", "is_public", "INTEGER"),
            ("notes", "is_pinned", "INTEGER"),
            ("notes", "suggested_questions", "TEXT"),
            ("conversations", "topic_graph", "TEXT"),
            ("conversations", "summary", "TEXT"),
            ("messages", "feedback_for_message_id", "INTEGER"),
            ("messages", "is_feedback", "INTEGER"),
            ("messages", "trace", "TEXT"),
            ("notes", "classified_embedding", "TEXT"),
            ("notes", "backlog_note_id", "INTEGER"),
            ("notes", "last_classify_signals", "TEXT"),
            ("memories", "source_note_id", "INTEGER"),
            # ListItem unified-item refactor — adds focus/todo fields
            ("list_items", "parent_id", "INTEGER"),
            ("list_items", "endgoal", "TEXT"),
            ("list_items", "committed", "INTEGER"),
            ("list_items", "updated_at", "DATETIME"),
            ("list_items", "actionable", "INTEGER"),
            ("list_items", "is_primary", "INTEGER"),
            ("lists", "kind", "TEXT"),
        ]:
            if table not in existing_tables:
                continue  # fresh DB: create_all will add the column via model definition
            existing_cols = [
                r[1] for r in conn.execute(text(f"PRAGMA table_info({table})"))
            ]
            if col not in existing_cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"))
                print(f"Migration: added {table}.{col}")
                # Backfill NULLs to 0 for boolean-like columns so filters
                # on `column == False` still match existing rows.
                if table == "notes" and col in ("is_public", "is_pinned"):
                    conn.execute(text(f"UPDATE {table} SET {col} = 0 WHERE {col} IS NULL"))
                if table == "messages" and col == "is_feedback":
                    conn.execute(text(f"UPDATE {table} SET {col} = 0 WHERE {col} IS NULL"))
        # Even if the column already existed, catch any stragglers with NULL state
        # from a previous migration that ran before the backfill step existed.
        # Guarded: on a fresh DB the `notes` table doesn't exist yet — Base.metadata
        # .create_all() runs after this — so skip the backfill in that case.
        if "notes" in existing_tables:
            conn.execute(text("UPDATE notes SET is_pinned = 0 WHERE is_pinned IS NULL"))
            conn.execute(text("UPDATE notes SET is_public = 0 WHERE is_public IS NULL"))
        # Unified-item refactor: drop the legacy focuses / todo_items / todo_notes
        # tables (and the older focus_activities table). Existing data is wiped
        # per design — see plan focuses-todos-unified.md. Memory.focus_id rows
        # that pointed into the old `focuses` table are nulled so the new FK to
        # list_items doesn't complain.
        for legacy in ("focuses", "todo_items", "todo_notes", "focus_activities"):
            if legacy in existing_tables:
                conn.execute(text(f"DROP TABLE {legacy}"))
                print(f"Migration: dropped legacy table {legacy}")
        if "memories" in existing_tables:
            conn.execute(text("UPDATE memories SET focus_id = NULL"))
        # Backfill committed=0 on list_items so existing rows aren't NULL.
        if "list_items" in existing_tables:
            conn.execute(text("UPDATE list_items SET committed = 0 WHERE committed IS NULL"))
            conn.execute(text("UPDATE list_items SET actionable = 1 WHERE actionable IS NULL"))
            conn.execute(text("UPDATE list_items SET is_primary = 0 WHERE is_primary IS NULL"))
        if "lists" in existing_tables:
            conn.execute(text("UPDATE lists SET kind = 'tasks' WHERE kind IS NULL"))
        conn.commit()


# 1. Create spaces table first (so FK references are valid)
Base.metadata.create_all(bind=engine, tables=[Space.__table__])
# 2. Add space_id to any existing tables that predate this change. Also drops
#    the legacy focuses / todo_items / todo_notes tables (unified-item refactor)
#    and the older focus_activities table.
_run_column_migrations(engine)
# 3. Reshape the legacy memories table — drop + stash old rows so create_all
#    can make the new schema.
_migrate_memories_legacy_schema(engine)
# 4. Create remaining tables (they already have space_id in their model definition)
Base.metadata.create_all(bind=engine)
# 5. Restore legacy memory rows onto the new schema (no-op if no migration ran)
_backfill_memories(engine)


def _dedupe_singleton_lists(engine):
    """Older code paths could spawn duplicate canonical lists (focus, todo,
    backlog) under race conditions. Squash to one row per type — keep the
    lowest id, repoint items, delete the rest. Idempotent.
    """
    with engine.connect() as conn:
        existing = {
            r[0]
            for r in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        if "lists" not in existing or "list_items" not in existing:
            return
        for type_ in ("focus", "todo", "backlog"):
            rows = list(
                conn.execute(
                    text("SELECT id FROM lists WHERE type = :t ORDER BY id ASC"),
                    {"t": type_},
                )
            )
            if len(rows) <= 1:
                continue
            keep = rows[0][0]
            drop = [r[0] for r in rows[1:]]
            conn.execute(
                text(
                    "UPDATE list_items SET list_id = :keep "
                    "WHERE list_id IN :drop"
                ).bindparams(
                    bindparam("drop", expanding=True),
                ),
                {"keep": keep, "drop": drop},
            )
            conn.execute(
                text("DELETE FROM lists WHERE id IN :drop").bindparams(
                    bindparam("drop", expanding=True)
                ),
                {"drop": drop},
            )
            print(
                f"Migration: deduped {len(drop)} extra '{type_}' list(s) → kept id={keep}"
            )
        conn.commit()


_dedupe_singleton_lists(engine)

app = FastAPI()

_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth ───────────────────────────────────────────────────────────────────────

_AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "").strip()


def _expected_token() -> str:
    """Derive a stateless token from the configured password."""
    return hashlib.sha256(_AUTH_PASSWORD.encode()).hexdigest()


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Block non-public routes when AUTH_PASSWORD is set."""
    if not _AUTH_PASSWORD:
        return await call_next(request)

    path = request.url.path
    # Always allow: public read-only routes, auth endpoint, static assets, CORS preflight
    # Mutations on /public/* (e.g. PATCH /public/profile) still require the Bearer token.
    if (
        (path.startswith("/public") and request.method == "GET")
        or path == "/auth"
        # OAuth callback is hit by Google's redirect with no bearer; must be open.
        # The code value itself is the auth proof. `state` can carry a CSRF token.
        or path == "/auth/google/callback"
        or path == "/auth/github/callback"
        or path == "/healthz"
        or path.startswith("/assets")
        or path == "/"
        or request.method == "OPTIONS"
    ):
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if auth_header == f"Bearer {_expected_token()}":
        return await call_next(request)

    from fastapi.responses import JSONResponse
    return JSONResponse({"detail": "Unauthorized"}, status_code=401)


# ── Rate limiting ──────────────────────────────────────────────────────────────
# In-memory per-(IP, bucket) token limiter. Single-process only — fine for the
# current 1-machine Fly deploy but would need Redis if we scale horizontally.
# Rules:
#   - /auth           → 10/min per IP  (cap offline brute-force against the password)
#   - /chat, /embed   → 30/min per IP  (cap OpenAI cost-abuse)
#   - everything else → 300/min per IP (generic DoS backstop)

_RATE_BUCKETS: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_RATE_RULES: list[tuple[re.Pattern[str], str, int, int]] = [
    # (path regex, bucket name, max_requests, window_seconds)
    (re.compile(r"^/auth$"), "auth", 10, 60),
    (re.compile(r"^/chat(/|$)"), "chat", 30, 60),
    (re.compile(r"^/notes/\d+/(embed|memorize)$"), "embed", 30, 60),
    (re.compile(r"^/dashboard/take$"), "take", 30, 60),
]
_DEFAULT_BUCKET = ("default", 300, 60)


def _pick_bucket(path: str) -> tuple[str, int, int]:
    for pattern, name, limit, window in _RATE_RULES:
        if pattern.match(path):
            return (name, limit, window)
    return _DEFAULT_BUCKET


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # CORS preflight must never rate-limit — browsers retry immediately on 429
    # and can't attach Bearer tokens to OPTIONS. Healthz stays open for Fly probes.
    if request.method == "OPTIONS" or request.url.path == "/healthz":
        return await call_next(request)

    bucket_name, limit, window = _pick_bucket(request.url.path)
    ip = _client_ip(request) or "unknown"
    key = (ip, bucket_name)
    now = time.monotonic()
    cutoff = now - window

    q = _RATE_BUCKETS[key]
    while q and q[0] < cutoff:
        q.popleft()

    if len(q) >= limit:
        retry_after = max(1, int(q[0] + window - now))
        from fastapi.responses import JSONResponse
        return JSONResponse(
            {"detail": "Too many requests"},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    q.append(now)
    return await call_next(request)


# ── Visit logging ──────────────────────────────────────────────────────────────
# Logs every GET /public/* hit for unique-visitor counts. IPs are salted + hashed
# so we never store raw PII. Set VISIT_HASH_SALT in env to a long random string.

_VISIT_SALT = os.getenv("VISIT_HASH_SALT", "gooni-default-salt-please-change").encode()

_BOT_UA_RE = re.compile(
    r"bot|crawl|spider|scrape|slurp|ahrefs|semrush|dataprovider|"
    r"pingdom|uptime|monitor|curl|wget|python-requests|httpclient|"
    r"facebookexternalhit|slackbot|twitterbot|linkedinbot|discordbot|telegrambot|"
    r"headless|phantomjs|playwright|puppeteer",
    re.IGNORECASE,
)


def _client_ip(request: Request) -> str:
    """Extract the visitor's IP, respecting common reverse-proxy headers."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    return request.client.host if request.client else ""


def _hash_ip(ip: str) -> str:
    return hashlib.sha256(_VISIT_SALT + ip.encode()).hexdigest()[:16]


@app.middleware("http")
async def visit_logger(request: Request, call_next):
    """Record hits on /public/* for unique-visitor analytics.
    Runs AFTER the route (so we only log successful responses) and skips obvious bots.
    """
    response = await call_next(request)
    path = request.url.path
    if (
        request.method == "GET"
        and path.startswith("/public")
        and response.status_code < 400
    ):
        ua = request.headers.get("user-agent", "")
        if not _BOT_UA_RE.search(ua):
            ip = _client_ip(request)
            if ip:
                db = SessionLocal()
                try:
                    db.add(Visit(
                        ip_hash=_hash_ip(ip),
                        user_agent=ua[:500] or None,
                        path=path[:500],
                    ))
                    db.commit()
                except Exception:
                    db.rollback()
                finally:
                    db.close()
    return response


@app.get("/public/visits/count")
def get_public_visit_count(db: Session = Depends(get_db)):
    """Unique visitor count for the public site. Safe to expose — no PII, just a number."""
    from sqlalchemy import func as sqlfunc
    count = db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash))).scalar() or 0
    return {"unique_visitors": int(count)}


@app.get("/public/mcp")
def get_public_mcp_config():
    """Sanitized snapshot of the project's MCP setup — servers (from .mcp.json) + tools
    (parsed from mcp/server.py via AST). Dynamic: edit the config or add a @mcp.tool() and
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

    # 2) AST-walk mcp/server.py for @mcp.tool() decorated functions
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
    server_py = repo_root / "mcp" / "server.py"
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


@app.get("/visits/summary")
def get_visits_summary(db: Session = Depends(get_db)):
    """Unique-visitor stats for /public/*. Auth-gated (not a /public route)."""
    from datetime import datetime, timedelta
    from sqlalchemy import func as sqlfunc

    week_ago = datetime.utcnow() - timedelta(days=7)
    total_visits = db.query(Visit).count()
    unique_visitors = db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash))).scalar() or 0
    weekly_unique = (
        db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash)))
        .filter(Visit.created_at >= week_ago)
        .scalar()
        or 0
    )
    top_paths = (
        db.query(Visit.path, sqlfunc.count(Visit.id).label("c"))
        .group_by(Visit.path)
        .order_by(sqlfunc.count(Visit.id).desc())
        .limit(5)
        .all()
    )
    recent = (
        db.query(Visit)
        .order_by(Visit.created_at.desc())
        .limit(10)
        .all()
    )
    return {
        "total_visits": total_visits,
        "unique_visitors": unique_visitors,
        "weekly_unique_visitors": weekly_unique,
        "top_paths": [{"path": p, "count": c} for (p, c) in top_paths],
        "recent": [
            {
                "ip_hash": v.ip_hash,
                "path": v.path,
                "user_agent": (v.user_agent or "")[:80],
                "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in recent
        ],
    }


# ── Lists (unified) ──────────────────────────────────────────────────────────


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
    return {
        "id": it.id,
        "list_id": it.list_id,
        "text": it.text,
        "subtitle": it.subtitle,
        "done": bool(it.done),
        "actionable": bool(it.actionable),
        "is_primary": bool(it.is_primary),
        "completed_at": it.completed_at.isoformat() if it.completed_at else None,
        "sort_order": it.sort_order,
        "due_date": it.due_date.isoformat() if it.due_date else None,
        "source_note_id": it.source_note_id,
        "created_at": it.created_at.isoformat() if it.created_at else None,
    }


@app.get("/lists")
def get_lists(db: Session = Depends(get_db)):
    from .services.list_service import list_service
    return [_serialize_list(lst) for lst in list_service.get_all_lists(db)]


@app.get("/lists/{list_id}")
def get_list(list_id: int, db: Session = Depends(get_db)):
    from .services.list_service import list_service
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    items = list_service.get_items(list_id, db)
    return {
        **_serialize_list(lst),
        "items": [_serialize_list_item(it) for it in items],
    }


@app.post("/lists")
def create_list(body: dict, db: Session = Depends(get_db)):
    from .services.list_service import list_service
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    type_ = body.get("type") or "generic"
    if type_ not in ("todo", "backlog", "generic"):
        raise HTTPException(status_code=400, detail="type must be todo|backlog|generic")
    emoji = body.get("emoji")
    lst = list_service.get_or_create_list(name, type_, emoji, db)
    return _serialize_list(lst)


@app.patch("/lists/{list_id}")
def update_list(list_id: int, body: dict, db: Session = Depends(get_db)):
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        lst.name = name
    if "emoji" in body:
        emoji = body.get("emoji")
        lst.emoji = emoji if emoji else None
    if "kind" in body:
        kind = body.get("kind")
        if kind not in ("tasks", "ideas"):
            raise HTTPException(status_code=400, detail="kind must be tasks|ideas")
        lst.kind = kind
    db.commit()
    db.refresh(lst)
    return _serialize_list(lst)


@app.delete("/lists/{list_id}")
def delete_list(list_id: int, db: Session = Depends(get_db)):
    """Cascade delete the list and all of its items."""
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    # Refuse to delete the canonical singletons — they're recreated on next
    # boot and break tools/orchestrator that look them up by type.
    if lst.type in ("todo", "backlog", "focus"):
        raise HTTPException(
            status_code=400,
            detail=f"cannot delete canonical {lst.type} list",
        )
    db.query(ListItem).filter(ListItem.list_id == list_id).delete(
        synchronize_session=False
    )
    db.delete(lst)
    db.commit()
    return {"ok": True}


@app.post("/lists/{list_id}/items")
def add_list_item(list_id: int, body: dict, db: Session = Depends(get_db)):
    from .services.list_service import list_service
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    actionable = body.get("actionable")
    item = list_service.add_item(
        list_id, text, db,
        subtitle=(body.get("subtitle") or None),
        source_note_id=body.get("source_note_id"),
        actionable=(True if actionable is None else bool(actionable)),
    )
    return _serialize_list_item(item)


@app.patch("/list-items/{item_id}")
def update_list_item(item_id: int, body: dict, db: Session = Depends(get_db)):
    from datetime import datetime
    from .services.list_service import list_service

    due_kwarg: dict = {}
    if "due_date" in body:
        raw = body["due_date"]
        if raw is None or raw == "":
            due_kwarg["due_date"] = None  # type: ignore[assignment]
        else:
            try:
                cleaned = raw[:-1] if isinstance(raw, str) and raw.endswith("Z") else raw
                due_kwarg["due_date"] = datetime.fromisoformat(cleaned)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="invalid due_date")

    item = list_service.update_item(
        item_id, db,
        text=body.get("text"),
        subtitle=body.get("subtitle"),
        done=body.get("done"),
        actionable=body.get("actionable"),
        is_primary=body.get("is_primary"),
        sort_order=body.get("sort_order"),
        **due_kwarg,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return _serialize_list_item(item)


@app.delete("/list-items/{item_id}")
def delete_list_item(item_id: int, db: Session = Depends(get_db)):
    from .services.list_service import list_service
    if not list_service.delete_item(item_id, db):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@app.post("/list-items/reorder")
def reorder_list_items(body: dict, db: Session = Depends(get_db)):
    """Batch sort_order update. Body: {ids: [item_id, item_id, ...]} in target order."""
    from .services.list_service import list_service
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list")
    list_service.reorder_items([int(i) for i in ids], db)
    return {"ok": True}


# ── Items (unified focus + todo) ─────────────────────────────────────────────


def _parse_optional_due(raw):
    from datetime import datetime as _dt
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="invalid due_date")
    cleaned = raw[:-1] if raw.endswith("Z") else raw
    try:
        return _dt.fromisoformat(cleaned)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid due_date")


@app.get("/items")
def items_tree(db: Session = Depends(get_db)):
    """Full tree: focuses (top-level w/ endgoal) + inbox (top-level todos),
    each with nested children + per-node progress + stale flag.
    """
    return item_service.list_tree(db)


@app.get("/items/today")
def items_today(db: Session = Depends(get_db)):
    """Open leaves due today, plus undated leaves under committed focuses,
    plus inbox todos. Each item carries its parent_chain for context.
    """
    return item_service.today(db)


@app.post("/items")
def items_create(body: dict, db: Session = Depends(get_db)):
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    parent_id = body.get("parent_id")
    endgoal = (body.get("endgoal") or "").strip() or None
    committed = bool(body.get("committed", False))
    due_date = _parse_optional_due(body.get("due_date"))
    try:
        item = item_service.create(
            db,
            text=text_val,
            parent_id=int(parent_id) if parent_id is not None else None,
            endgoal=endgoal,
            committed=committed,
            due_date=due_date,
            source_note_id=body.get("source_note_id"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _serialize_item(item)


@app.patch("/items/{item_id}")
def items_update(item_id: int, body: dict, db: Session = Depends(get_db)):
    patch: dict = {}
    if "text" in body:
        new_text = (body["text"] or "").strip()
        if new_text:
            patch["text"] = new_text
    if "endgoal" in body:
        eg = body["endgoal"]
        patch["endgoal"] = (eg or "").strip() or None if isinstance(eg, str) else None
    if "committed" in body:
        patch["committed"] = bool(body["committed"])
    if "done" in body:
        patch["done"] = bool(body["done"])
    if "due_date" in body:
        patch["due_date"] = _parse_optional_due(body["due_date"])
    if "subtitle" in body:
        patch["subtitle"] = body["subtitle"] or None
    if "sort_order" in body:
        patch["sort_order"] = int(body["sort_order"])
    if "parent_id" in body:
        patch["parent_id"] = (
            int(body["parent_id"]) if body["parent_id"] is not None else None
        )
    if "actionable" in body:
        patch["actionable"] = bool(body["actionable"])
    if "is_primary" in body:
        patch["is_primary"] = bool(body["is_primary"])
    item = item_service.update(db, item_id, **patch)
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return _serialize_item(item)


@app.delete("/items/{item_id}")
def items_delete(item_id: int, db: Session = Depends(get_db)):
    if not item_service.delete(db, item_id):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@app.post("/items/reorder")
def items_reorder(body: dict, db: Session = Depends(get_db)):
    ids = body.get("ids")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list")
    item_service.reorder(db, [int(i) for i in ids])
    return {"ok": True}


def _serialize_item(it: ListItem) -> dict:
    return {
        "id": it.id,
        "list_id": it.list_id,
        "parent_id": it.parent_id,
        "text": it.text,
        "subtitle": it.subtitle,
        "endgoal": it.endgoal,
        "committed": bool(it.committed),
        "actionable": bool(it.actionable),
        "is_primary": bool(it.is_primary),
        "done": bool(it.done),
        "due_date": it.due_date.isoformat() if it.due_date else None,
        "completed_at": it.completed_at.isoformat() if it.completed_at else None,
        "sort_order": it.sort_order,
        "source_note_id": it.source_note_id,
        "created_at": it.created_at.isoformat() if it.created_at else None,
        "updated_at": it.updated_at.isoformat() if it.updated_at else None,
    }


@app.post("/auth")
async def login(body: dict):
    """Exchange password for a token. Returns 401 if wrong."""
    if not _AUTH_PASSWORD:
        # Auth disabled — return a dummy token so the frontend still works
        return {"token": "dev"}
    if body.get("password") != _AUTH_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password")
    return {"token": _expected_token()}


@app.get("/healthz")
async def root():
    return {"message": "ok"}


@app.post("/chat/intention")
async def infer_intention(body: dict, db: Session = Depends(get_db)):
    """Fast endpoint: infer user intention without running the full chat pipeline."""
    content = body.get("content", "").strip()
    conversation_id = body.get("conversation_id")
    if not content:
        return {"intention": ""}
    recent_history = []
    if conversation_id:
        msgs = conversation_service.get_recent_messages(conversation_id, limit=6, db=db)
        recent_history = [{"role": m.role, "content": m.content} for m in msgs]
    intention = llm_client.generate_intention_context(content, recent_history)
    return {"intention": intention}


@app.post("/chat")
async def chat(body: ChatRequest, db: Session = Depends(get_db)):
    content, usage = Orchestrator.handle_chat(
        body.content,
        db,
        image_url=body.image_url,
        source="web",
        entry_content=body.entry_content or "",
        model=body.model,
        mode=body.mode,
    )
    return {"content": content, "usage": usage, "intention": usage.get("intention") or ""}


# ── iMessage webhook (BlueBubbles) ────────────────────────────────────────────

@app.post("/webhooks/imessage")
async def imessage_webhook(
    payload: dict,
    x_secret: str | None = Header(None, alias="X-Secret"),
    db: Session = Depends(get_db),
):
    """Receive a BlueBubbles 'new-message' event, route it through the
    orchestrator, and POST a reply back via BlueBubbles. Auth: shared-secret
    header configured in BlueBubbles' webhook settings.

    Inbound events from the user's own Apple ID (i.e. messages Daniel sent FROM
    his Mac/iPhone) carry isFromMe=true on the BlueBubbles payload. We treat
    those as the user talking TO Gooni only when they originate from an
    allowlisted handle on the recipient side — i.e. Daniel iMessage'ing his own
    number from a different device. For now we drop isFromMe events to avoid
    feedback loops where Gooni's own outbound message triggers a webhook back.
    """
    expected = os.getenv("IMESSAGE_WEBHOOK_SECRET")
    if not expected or x_secret != expected:
        raise HTTPException(status_code=401, detail="bad secret")

    data = payload.get("data") or {}
    if data.get("isFromMe"):
        return {"ok": True, "skipped": "from_me"}

    handle = (data.get("handle") or {}).get("address") or ""
    text = data.get("text") or ""
    if not handle or not text:
        return {"ok": True, "skipped": "missing handle or text"}

    result = dispatch_inbound(imessage_channel, handle, text, db)
    if result is None:
        return {"ok": True, "skipped": "not_allowlisted"}
    _raw, formatted = result
    imessage_channel.send(handle, formatted)
    return {"ok": True}


# ── WhatsApp webhook (Meta Cloud API) ─────────────────────────────────────────

@app.get("/webhooks/whatsapp")
async def whatsapp_webhook_verify(request: Request):
    """Meta verification handshake. On webhook configuration save, Meta sends:

      GET /webhooks/whatsapp?hub.mode=subscribe
                            &hub.verify_token=<our shared secret>
                            &hub.challenge=<random string>

    We must echo `hub.challenge` as plain-text body with HTTP 200 if and only
    if the verify_token matches our env-configured one. Anything else → 403.
    """
    from fastapi.responses import PlainTextResponse
    expected = os.getenv("WHATSAPP_VERIFY_TOKEN")
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge") or ""
    if mode == "subscribe" and expected and token == expected:
        return PlainTextResponse(challenge, status_code=200)
    raise HTTPException(status_code=403, detail="verify failed")


def _verify_whatsapp_signature(raw_body: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256 verification. Header format: 'sha256=<hex>'.
    Computed as HMAC-SHA256(app_secret, raw_body). When app_secret isn't
    configured we accept everything (dev mode) but the allowlist still gates
    inbound — the cost of a stray forged event in that posture is at most a
    spammed conversation row, not auth bypass."""
    secret = os.getenv("WHATSAPP_APP_SECRET")
    if not secret:
        return True  # not configured; rely on allowlist + verify_token
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


@app.post("/webhooks/whatsapp")
async def whatsapp_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    db: Session = Depends(get_db),
):
    """Receive a WhatsApp Cloud API event.

    Meta delivers two kinds of events under `entry[].changes[].value`:
      - `messages`  — actual user-sent text/media (what we care about)
      - `statuses`  — delivery/read receipts for messages WE sent (ignore;
                      otherwise every reply triggers an echo and we'd loop)

    Auth layers (defense in depth):
      1. HMAC-SHA256 signature header (Meta-issued; verified against app secret)
      2. Allowlist on inbound `from` handle
      3. Skip non-text message types for v1
    """
    raw_body = await request.body()
    if not _verify_whatsapp_signature(raw_body, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="bad signature")

    try:
        payload = json.loads(raw_body or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid json")

    # Meta wraps each event in entry[].changes[]. There can be multiple, but
    # for a single inbound message it's typically one change with one message.
    entries = payload.get("entry") or []
    handled_any = False
    for entry in entries:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            messages = value.get("messages") or []
            if not messages:
                continue  # status update or other non-message event
            for msg in messages:
                if msg.get("type") != "text":
                    continue  # v1: text only
                sender = msg.get("from") or ""
                body = (msg.get("text") or {}).get("body") or ""
                if not sender or not body:
                    continue
                result = dispatch_inbound(whatsapp_channel, sender, body, db)
                if result is None:
                    continue  # not allowlisted; silent drop
                _raw, formatted = result
                whatsapp_channel.send(sender, formatted)
                handled_any = True
    return {"ok": True, "handled": handled_any}


# ── Spaces ────────────────────────────────────────────────────────────────────


def _serialize_space(s: Space) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "emoji": s.emoji,
    }


@app.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    spaces = db.query(Space).order_by(Space.id).all()
    return [_serialize_space(s) for s in spaces]


@app.post("/spaces")
def create_space(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    space = Space(name=name)
    db.add(space)
    db.commit()
    db.refresh(space)
    return {"id": space.id, "name": space.name, "emoji": space.emoji}


@app.patch("/spaces/{space_id}")
def update_space(space_id: int, body: dict, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    if "name" in body:
        name = body["name"].strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        space.name = name
    if "emoji" in body:
        space.emoji = body["emoji"] or None
    db.commit()
    db.refresh(space)
    return _serialize_space(space)


@app.delete("/spaces/{space_id}")
def delete_space(space_id: int, db: Session = Depends(get_db)):
    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    db.query(Note).filter(Note.space_id == space_id).delete()
    db.delete(space)
    db.commit()
    return {"ok": True}


# ── Notes ─────────────────────────────────────────────────────────────────────


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
        "space_id": n.space_id,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "last_opened_at": n.last_opened_at,
        "is_public": bool(n.is_public),
        "is_pinned": bool(n.is_pinned),
        # Snapshot of what classify_note routed for this note's most recent
        # save. Drives the "Routed:" disclosure under the title — same shape
        # as the chat bubble so Daniel sees memory writes + backlog items
        # as soon as the async classifier finishes.
        "classify_signals": signals,
    }


def _notes_order():
    from sqlalchemy import func

    return func.coalesce(Note.updated_at, Note.created_at).desc()


@app.get("/spaces/{space_id}/notes")
def get_space_notes(space_id: str, db: Session = Depends(get_db)):
    if space_id == "general":
        notes = db.query(Note).order_by(_notes_order()).all()
    else:
        notes = (
            db.query(Note)
            .filter(Note.space_id == int(space_id))
            .order_by(_notes_order())
            .all()
        )
    return [_serialize_note(n) for n in notes]


@app.get("/notes/recent")
def get_recent_notes(limit: int = 5, db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .order_by(_notes_order())
        .limit(limit)
        .all()
    )
    return [_serialize_note(n) for n in notes]


@app.post("/spaces/{space_id}/notes")
def create_space_note(space_id: str, body: dict, db: Session = Depends(get_db)):
    from datetime import datetime

    numeric_id = None if space_id == "general" else int(space_id)
    note = Note(
        title=body.get("title") or "",
        content=body.get("content") or "",
        space_id=numeric_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.patch("/notes/{note_id}")
def update_note(
    note_id: int,
    body: dict,
    db: Session = Depends(get_db),
):
    from datetime import datetime

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if "title" in body:
        note.title = body["title"]
    if "content" in body:
        note.content = body["content"]
    if "title" in body or "content" in body:
        note.updated_at = datetime.utcnow()
    if "space_id" in body:
        sid = body["space_id"]
        note.space_id = None if (sid is None or sid == "general") else int(sid)
    if "is_public" in body:
        note.is_public = bool(body["is_public"])
    if "is_pinned" in body:
        note.is_pinned = bool(body["is_pinned"])
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.get("/notes/pinned")
def get_pinned_notes(db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .filter(Note.is_pinned == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note(n) for n in notes]


@app.get("/notes/graph")
def notes_graph(db: Session = Depends(get_db)):
    """Semantic graph of all embedded notes.

    Nodes = notes with embeddings, sized by log(word_count+1).
    Edges = pairs with cosine similarity above a threshold — these are the
    "you've written related things" connections that drive the physics-based
    clustering on the frontend.

    Clustering labels are intentionally NOT computed here — let the frontend's
    force-directed layout surface clumps visually first; labels can be a
    follow-up that queries this endpoint + hits the LLM for cluster names.
    """
    import json
    import math
    import re as _re

    notes = (
        db.query(Note)
        .filter(Note.embedding.isnot(None))
        .all()
    )

    # Parse embeddings + build node metadata.
    vectors: list[list[float]] = []
    nodes: list[dict] = []
    for n in notes:
        try:
            v = json.loads(n.embedding)
            if not isinstance(v, list) or not v:
                continue
        except (ValueError, TypeError):
            continue
        # Word count for node size — strip HTML first.
        raw = (n.title or "") + " " + (n.content or "")
        raw = _re.sub(r"<[^>]+>", " ", raw)
        words = [w for w in raw.split() if w.strip()]
        word_count = len(words)
        vectors.append(v)
        nodes.append({
            "id": n.id,
            "title": (n.title or "").strip() or "(untitled)",
            "size": round(math.log2(word_count + 2), 3),
            "space_id": n.space_id,
        })

    if len(vectors) < 2:
        return {"nodes": nodes, "edges": []}

    # Pre-compute norms so the pairwise loop doesn't repeat work.
    norms = [math.sqrt(sum(x * x for x in v)) or 1.0 for v in vectors]

    # Cosine-similarity edges. Threshold is deliberately moderate (0.62) so
    # we get visible clusters without the hairball-of-edges problem.
    SIM_THRESHOLD = 0.62
    edges: list[dict] = []
    n_count = len(vectors)
    for i in range(n_count):
        vi = vectors[i]
        ni = norms[i]
        for j in range(i + 1, n_count):
            vj = vectors[j]
            nj = norms[j]
            # Inner loop hot path — dimension is uniform, zip is fast enough
            # for ~200 notes; switch to numpy if this ever feels slow.
            dot = 0.0
            for a, b in zip(vi, vj):
                dot += a * b
            sim = dot / (ni * nj)
            if sim >= SIM_THRESHOLD:
                edges.append({
                    "from": nodes[i]["id"],
                    "to": nodes[j]["id"],
                    "weight": round(sim, 3),
                })

    return {"nodes": nodes, "edges": edges}


@app.post("/notes/cleanup")
def cleanup_empty_notes(db: Session = Depends(get_db)):
    """Delete notes whose plaintext content is < 6 chars and title is empty.
    Used by the 'Clean Inbox' button — these are typically accidental creates.
    Pinned notes are always preserved.
    """
    import re

    def _plaintext_len(html: str | None) -> int:
        if not html:
            return 0
        # strip tags, collapse whitespace
        text_only = re.sub(r"<[^>]+>", " ", html)
        text_only = re.sub(r"\s+", " ", text_only).strip()
        return len(text_only)

    # Treat NULL is_pinned as not-pinned (happens on freshly-migrated rows).
    candidates = (
        db.query(Note)
        .filter((Note.is_pinned == False) | (Note.is_pinned.is_(None)))  # noqa: E712
        .all()
    )
    deleted_ids = []
    for n in candidates:
        title_empty = not (n.title or "").strip()
        if title_empty and _plaintext_len(n.content) < 6:
            deleted_ids.append(n.id)
            db.delete(n)
    db.commit()
    return {"deleted": len(deleted_ids), "ids": deleted_ids}


@app.post("/notes/{note_id}/embed")
def embed_note(note_id: int, db: Session = Depends(get_db)):
    """Generate embedding for a note and check for space suggestion.
    Called on blur (not on every save) to avoid wasteful API calls.
    Also runs the focus-activity matcher so focuses get heartbeats from
    note writing without an explicit FK linkage. Kicks the unified
    classifier off-thread so notes about Gooni gaps land in the Backlog
    space without blocking the response.
    """
    import threading

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note_service.update_embedding(note_id)  # opens/closes its own session
    db.expire_all()  # invalidate cache so suggest_space sees fresh embedding
    suggestion = note_service.suggest_space(note_id, db)

    # Unified extractor: runs in a daemon thread so the embed endpoint
    # returns fast. Internally dedup-gates via `Note.classified_embedding`
    # so trivial edits don't make duplicate Backlog rows.
    from .services.note_service import classify_note
    threading.Thread(
        target=classify_note,
        args=(note_id,),
        daemon=True,
    ).start()

    return {"ok": True, **suggestion}


@app.post("/notes/{note_id}/suggest-questions")
def suggest_note_questions(note_id: int, db: Session = Depends(get_db)):
    """Generate 3-5 probing questions Gooni would ask about this note. Cached
    on the note row keyed by content hash — so re-opening the editor doesn't
    re-fire the LLM call. Bails empty for short or empty notes.
    """
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    plaintext = note_service._strip_html(note.content or "")
    title = (note.title or "").strip()
    raw = (title + "\n" + plaintext).strip()
    # Below ~200 chars there isn't enough surface for sharp questions.
    if len(plaintext) < 200:
        return {"questions": []}

    content_hash = hashlib.sha1(raw.encode("utf-8")).hexdigest()
    if note.suggested_questions:
        try:
            cached = json.loads(note.suggested_questions)
            if cached.get("hash") == content_hash:
                return {"questions": cached.get("questions") or []}
        except json.JSONDecodeError:
            pass  # corrupt cache → regenerate

    prompt = (
        "Daniel just wrote this note. Generate 3-5 probing questions a sharp "
        "friend would ask to push his thinking — questions that surface "
        "assumptions, force tradeoffs, or reveal what's missing. One per "
        "line. No numbering, no preamble, no quotes around questions.\n\n"
        f"Title: {title}\n\nContent: {plaintext[:3000]}"
    )
    try:
        raw_out = llm_client.generate_simple_completion(prompt, max_tokens=300)
    except Exception as e:
        print(f"suggest-questions LLM error: {e}")
        return {"questions": []}

    questions = [
        line.strip().lstrip("-•0123456789. ").strip()
        for line in (raw_out or "").splitlines()
        if line.strip()
    ]
    questions = [q for q in questions if len(q) > 10][:5]

    note.suggested_questions = json.dumps({"hash": content_hash, "questions": questions})
    db.commit()
    return {"questions": questions}


@app.post("/notes/{note_id}/touch")
def touch_note(note_id: int, db: Session = Depends(get_db)):
    """Update last_opened_at. Called whenever a note is selected."""
    from datetime import datetime

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note.last_opened_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.post("/notes/{note_id}/memorize")
def memorize_note(note_id: int, db: Session = Depends(get_db)):
    """Extract facts from a note when the user leaves it.
    Note embeddings are handled by the PATCH endpoint background task —
    we no longer create Memory episodes from notes (episodes are for chat only).
    """
    import re

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    raw = re.sub(r"<[^>]+>", " ", note.content or "").strip()
    if len(raw) <= 10:
        return {"ok": True, "facts_saved": 0}
    try:
        memory_service.add_memory(raw, type="episode", db=db)
    except Exception:
        pass
    return {"ok": True, "facts_saved": 1}


@app.delete("/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    db.delete(note)
    db.commit()
    return {"ok": True}


@app.get("/notes/{note_id}/related")
def get_related_notes(note_id: int, limit: int = 5, db: Session = Depends(get_db)):
    """Return notes similar to the given note, ranked by embedding cosine similarity."""
    related = note_service.get_related(note_id, limit, db)
    return [_serialize_note(n) for n in related]


# ── Serializers ────────────────────────────────────────────────────────────────


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


def _build_feed(
    db: Session,
    space_id: int | None = None,
    general: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Conversations sorted newest first.

    - general=True: return everything (no filter)
    - space_id set: filter by space
    """
    q = db.query(Conversation).filter(Conversation.source != "telegram")

    if not general and space_id is not None:
        q = q.filter(Conversation.space_id == space_id)

    items = [_serialize_conversation(c) for c in q.all()]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:limit]


# ── Feed ───────────────────────────────────────────────────────────────────────


@app.get("/feed")
def get_feed(db: Session = Depends(get_db)):
    return _build_feed(db, general=True)



# ── Conversation endpoints ─────────────────────────────────────────────────────


@app.post("/conversations")
async def create_general_conversation(body: dict, db: Session = Depends(get_db)):
    content = body.get("content", "")
    title = await llm_client.generate_title(content) if content.strip() else None
    conv = conversation_service.create(db=db, source="web", title=title)
    return _serialize_conversation(conv)



@app.get("/conversations/{conversation_id}/messages")
def get_conversation_messages(conversation_id: int, db: Session = Depends(get_db)):
    msgs = conversation_service.get_messages(conversation_id, db)
    return [_serialize_message(m) for m in msgs]


@app.post("/conversations/{conversation_id}/seed")
def seed_conversation(conversation_id: int, body: dict, db: Session = Depends(get_db)):
    """Entry content becomes the first user message; Orchestrator generates Claude's reply."""
    entry_content = body.get("entry_content", "").strip()
    if not entry_content:
        return []
    try:
        Orchestrator.handle_chat(entry_content, db, conversation_id=conversation_id)
        msgs = conversation_service.get_messages(conversation_id, db)
        return [_serialize_message(m) for m in msgs]
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/conversations/{conversation_id}/messages")
def send_conversation_message(
    conversation_id: int, body: dict, db: Session = Depends(get_db)
):
    """Send a user message; returns full thread after Claude replies."""
    user_content = body.get("content", "").strip()
    if not user_content:
        raise HTTPException(status_code=400, detail="content is required")
    entry_content = body.get("entry_content", "")
    model = body.get("model") or None
    mode = body.get("mode") or None
    try:
        _, usage = Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
            model=model,
            mode=mode,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return {
        "messages": [_serialize_message(m) for m in msgs],
        "intention": usage.get("intention") or "",
        "tools_used": usage.get("tools_used") or [],
    }


@app.get("/conversations/{conversation_id}/graph")
def get_conversation_graph(conversation_id: int, db: Session = Depends(get_db)):
    """Topic graph for the chat-flow visualization in GooniPanel. Cached on
    the conversation row by message count — a new turn invalidates."""
    return conversation_service.build_topic_graph(conversation_id, db)


@app.get("/health")
async def health():
    # Fly injects these env vars on every machine; useful to surface so the
    # dev-tools modal can show "what's actually deployed" without a dashboard hop.
    return {
        "message": "Health check",
        "fly": {
            "app": os.getenv("FLY_APP_NAME"),
            "machine_id": os.getenv("FLY_MACHINE_ID"),
            "machine_version": os.getenv("FLY_MACHINE_VERSION"),
            "region": os.getenv("FLY_REGION"),
            "image_ref": os.getenv("FLY_IMAGE_REF"),
            "release_version": os.getenv("FLY_RELEASE_VERSION"),
        },
    }


# ── Dashboard ──────────────────────────────────────────────────────────────────



@app.get("/dashboard")
def get_dashboard_stats(db: Session = Depends(get_db)):
    from datetime import date, datetime, timedelta
    import re

    from sqlalchemy import func as sqlfunc

    today = datetime.utcnow().date()
    week_ago = datetime.utcnow() - timedelta(days=7)
    two_weeks_ago = datetime.utcnow() - timedelta(days=14)

    notes_this_week = db.query(Note).filter(Note.updated_at >= week_ago).count()
    notes_last_week = (
        db.query(Note)
        .filter(Note.updated_at >= two_weeks_ago, Note.updated_at < week_ago)
        .count()
    )

    # Per-day note creation counts for the last 7 days (oldest first, index 6 = today)
    seven_days_ago = today - timedelta(days=6)
    try:
        day_rows = db.execute(
            text(
                "SELECT date(created_at) as d, COUNT(*) as c FROM notes "
                "WHERE created_at IS NOT NULL AND date(created_at) >= :start "
                "GROUP BY date(created_at)"
            ),
            {"start": seven_days_ago.isoformat()},
        ).fetchall()
        day_counts = {r[0]: r[1] for r in day_rows}
        notes_per_day = [
            day_counts.get((seven_days_ago + timedelta(days=i)).isoformat(), 0)
            for i in range(7)
        ]
    except Exception:
        notes_per_day = [0] * 7

    # Per-day activity (notes touched OR user messages sent) — matches streak semantics
    try:
        activity_rows = db.execute(
            text(
                "SELECT DISTINCT d FROM ("
                "  SELECT date(updated_at) as d FROM notes WHERE updated_at IS NOT NULL AND date(updated_at) >= :start"
                "  UNION"
                "  SELECT date(created_at) as d FROM messages WHERE role = 'user' AND created_at IS NOT NULL AND date(created_at) >= :start"
                ")"
            ),
            {"start": seven_days_ago.isoformat()},
        ).fetchall()
        active_days = {r[0] for r in activity_rows}
        activity_per_day = [
            1 if (seven_days_ago + timedelta(days=i)).isoformat() in active_days else 0
            for i in range(7)
        ]
    except Exception:
        activity_per_day = [0] * 7

    recent_notes = (
        db.query(Note)
        .order_by(sqlfunc.coalesce(Note.updated_at, Note.created_at).desc())
        .limit(20)
        .all()
    )

    # Streak: consecutive days with any activity (notes or conversations).
    try:
        date_rows = db.execute(
            text(
                "SELECT DISTINCT d FROM ("
                "  SELECT date(updated_at) as d FROM notes WHERE updated_at IS NOT NULL"
                "  UNION"
                "  SELECT date(created_at) as d FROM messages WHERE role = 'user' AND created_at IS NOT NULL"
                ") ORDER BY d DESC LIMIT 30"
            )
        ).fetchall()
        streak = 0
        if date_rows:
            most_recent = date.fromisoformat(date_rows[0][0])
            if most_recent >= today - timedelta(days=1):
                for i, row in enumerate(date_rows):
                    if date.fromisoformat(row[0]) == most_recent - timedelta(days=i):
                        streak += 1
                    else:
                        break
    except Exception:
        streak = 0

    return {
        "notes_this_week": notes_this_week,
        "notes_last_week": notes_last_week,
        "recent_notes": [_serialize_note(n) for n in recent_notes],
        "streak": streak,
        "notes_per_day": notes_per_day,
        "activity_per_day": activity_per_day,
    }


@app.get("/dashboard/take")
def get_gooni_take(db: Session = Depends(get_db)):
    """Gooni's Take — ONE tight sentence on Daniel's current focus thread.
    Recency-weighted: most-recent note marked, active focuses pulled in for
    long-arc context. Cached client-side; refresh button forces a fresh call.
    """
    from sqlalchemy import func as sqlfunc

    recent_notes = (
        db.query(Note)
        .order_by(sqlfunc.coalesce(Note.updated_at, Note.created_at).desc())
        .limit(8)
        .all()
    )
    top_notes = [n for n in recent_notes if (n.title and n.title.strip()) or (n.content and n.content.strip())][:5]

    def _plain(html: str | None) -> str:
        if not html:
            return ""
        t = re.sub(r"<[^>]+>", " ", html)
        t = re.sub(r"\s+", " ", t).strip()
        return t

    note_lines = []
    for i, n in enumerate(top_notes):
        title = (n.title or "").strip() or "Untitled"
        body = _plain(n.content)[:240]
        marker = "(MOST RECENT)" if i == 0 else ""
        note_lines.append(f"- {title} {marker}: {body}" if body else f"- {title} {marker}")
    note_block = "\n".join(note_lines) if note_lines else "(no notes yet)"

    focus_block = item_service.get_active_context(db) or "(no active focuses)"

    if not top_notes and focus_block.startswith("("):
        return {"take": ""}

    prompt = (
        "You are Gooni — Daniel's AI notebook companion.\n\n"
        "Write ONE sentence (max 25 words) describing what Daniel is focused on RIGHT NOW. "
        "Recent notes carry more weight than older ones. Find the dominant thread.\n\n"
        "Format options (pick what fits):\n"
        '  "Focus is on X."\n'
        '  "Split between X and Y."\n'
        '  "Mostly X, with some Y on the side."\n'
        '  "Heads-down on X this week."\n\n'
        "No preamble, no sign-off, no filler. Just the sentence.\n\n"
        f"Active focuses:\n{focus_block}\n\n"
        f"Recent notes (newest first):\n{note_block}\n\n"
        "Your one-sentence take:"
    )
    try:
        take = llm_client.generate_simple_completion(prompt, max_tokens=80)
        take = take.strip().strip('"').strip("'")
    except Exception:
        take = ""
    return {"take": take}


# ── MCP endpoints ─────────────────────────────────────────────────────────────


@app.get("/mcp/context")
def mcp_get_context(q: str = "", db: Session = Depends(get_db)):
    """Return memory context for a query."""
    if not q.strip():
        return {"context": ""}
    context = memory_service.build_memory_context(q, db=db)
    return {"context": context}


@app.post("/mcp/memories")
def mcp_add_memory(body: dict, db: Session = Depends(get_db)):
    """Add a memory directly (bypasses extraction). Used by MCP."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    memory_service.add_memory(content, db=db)
    return {"ok": True}


@app.get("/mcp/memories/search")
def mcp_search_memories(q: str, limit: int = 10, db: Session = Depends(get_db)):
    """Search memories by semantic similarity."""
    memories = memory_service.search(q, limit=limit, db=db)
    return [{"id": m.get("id"), "memory": m.get("memory")} for m in memories]


@app.patch("/mcp/memories/{memory_id}")
def mcp_edit_memory(memory_id: str, body: dict, db: Session = Depends(get_db)):
    """Update a memory by ID via supersede chain."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if not memory_service.update_memory(memory_id, content, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@app.delete("/mcp/memories/{memory_id}")
def mcp_forget_memory(memory_id: str, db: Session = Depends(get_db)):
    """Soft-delete a memory (is_active=False)."""
    if not memory_service.delete(memory_id, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@app.get("/mcp/notes/search")
def mcp_search_notes(q: str, limit: int = 5, db: Session = Depends(get_db)):
    """Search notes by semantic similarity to a query string."""
    related = note_service.search_by_query(q, limit, db)
    return [_serialize_note(n) for n in related]


# ── Memory dashboard endpoints ──────────────────────────────────────────────────
# Daniel's UI dashboard at /memories reads + edits memories. Separate from the
# /mcp/memories/* routes (which Claude Code consumes via MCP) so the two surfaces
# can evolve independently. All return full Memory rows, not the legacy "memory"
# alias used by Mem0-era callers.


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
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


@app.get("/memories")
def list_memories(
    type: str | None = None,
    q: str | None = None,
    include_inactive: bool = False,
    limit: int = 200,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """List memories for the dashboard. Filters by type (optional), text
    substring (optional), and active flag. Paged via limit/offset. Newest
    first."""
    from .db.models import Memory  # local to avoid circular at import time
    query = db.query(Memory)
    if not include_inactive:
        query = query.filter(Memory.is_active == True)  # noqa: E712
    if type:
        query = query.filter(Memory.type == type)
    if q:
        # Case-insensitive content substring match — cheap, works without FTS.
        query = query.filter(Memory.content.ilike(f"%{q}%"))
    total = query.count()
    rows = query.order_by(Memory.created_at.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "memories": [_memory_to_dashboard(m) for m in rows],
    }


@app.get("/memories/stats")
def memory_stats(db: Session = Depends(get_db)):
    """Counts per type for the dashboard header tabs."""
    from .db.models import Memory
    from sqlalchemy import func as sqlfunc
    rows = (
        db.query(Memory.type, sqlfunc.count(Memory.id))
        .filter(Memory.is_active == True)  # noqa: E712
        .group_by(Memory.type)
        .all()
    )
    return {
        "total": sum(c for _, c in rows),
        "by_type": {t: c for t, c in rows},
    }


@app.delete("/memories/{memory_id}")
def delete_memory(memory_id: int, db: Session = Depends(get_db)):
    """Soft-delete (is_active=False). Same as MCP forget."""
    if not memory_service.delete(memory_id, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


@app.patch("/memories/{memory_id}")
def edit_memory(memory_id: int, body: dict, db: Session = Depends(get_db)):
    """Update content via supersede chain (preserves audit history)."""
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if not memory_service.update_memory(memory_id, content, db=db):
        raise HTTPException(status_code=404, detail="memory not found")
    return {"ok": True, "id": memory_id}


# ── Chat audit ──────────────────────────────────────────────────────────────────


@app.get("/chat-audit")
def list_chat_audit(
    has_feedback_only: bool = False,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Audit feed: every assistant reply with any linked feedback inline.

    Each entry: assistant message + the user followup that was flagged as
    feedback (if any) + conversation context. Default returns all assistant
    replies, newest first. `has_feedback_only=true` filters to flagged ones.
    """
    from .db.models import Memory  # local to avoid circular at import time

    asst = aliased(Message)
    fb = aliased(Message)
    conv = aliased(Conversation)
    q = (
        db.query(asst, fb, conv)
        .outerjoin(
            fb,
            (fb.feedback_for_message_id == asst.id) & (fb.is_feedback == True),  # noqa: E712
        )
        .outerjoin(conv, conv.id == asst.conversation_id)
        .filter(asst.role == "assistant")
    )
    if has_feedback_only:
        q = q.filter(fb.id.isnot(None))
    total = q.count()
    rows = q.order_by(asst.id.desc()).offset(offset).limit(limit).all()

    # Top-level: every active feedback-derived preference. Surfaced separately
    # because we don't persist message↔memory links (avoids another schema
    # migration) — the audit UI uses this list to render dismiss buttons.
    active_feedback_prefs = (
        db.query(Memory)
        .filter(
            Memory.type == "preference",
            Memory.is_active == True,  # noqa: E712
            Memory.key.like("feedback__%"),
        )
        .order_by(Memory.id.desc())
        .all()
    )

    entries = []
    for asst_m, fb_m, conv_m in rows:
        feedback = None
        if fb_m is not None:
            feedback = {
                "id": fb_m.id,
                "content": fb_m.content,
                "created_at": fb_m.created_at.isoformat() if fb_m.created_at else None,
            }
        entries.append({
            "id": asst_m.id,
            "conversation_id": asst_m.conversation_id,
            "conversation_title": conv_m.title if conv_m else None,
            "conversation_source": conv_m.source if conv_m else None,
            "content": asst_m.content,
            "created_at": asst_m.created_at.isoformat() if asst_m.created_at else None,
            "feedback": feedback,
        })
    return {
        "total": total,
        "entries": entries,
        "active_rules": [
            {
                "memory_id": p.id,
                "rule": p.content,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in active_feedback_prefs
        ],
    }


# ── Public portfolio ────────────────────────────────────────────────────────────


def _strip_html(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", html or "").strip()


def _read_time_min(html: str) -> int:
    import re
    text = re.sub(r"\s+", " ", _strip_html(html)).strip()
    return max(1, -(-len(text) // 1000))


@app.get("/public/notes")
def get_public_notes(db: Session = Depends(get_db)):
    """Return all public notes with their space name, newest first. No auth."""
    rows = (
        db.query(Note, Space)
        .outerjoin(Space, Note.space_id == Space.id)
        .filter(Note.is_public == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    result = []
    for n, space in rows:
        excerpt = _strip_html(n.content or "")[:150]
        result.append({
            "id": n.id,
            "title": n.title,
            "space_name": space.name if space else None,
            "excerpt": excerpt,
            "updated_at": n.updated_at,
            "read_time_minutes": _read_time_min(n.content or ""),
        })
    return result


@app.get("/public/notes/{note_id}")
def get_public_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single public note's full content. 404 if not public."""
    note = db.query(Note).filter(Note.id == note_id, Note.is_public == True).first()  # noqa: E712
    if not note:
        raise HTTPException(status_code=404, detail="Not found")
    space = db.query(Space).filter(Space.id == note.space_id).first() if note.space_id else None
    return {
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "space_name": space.name if space else None,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


@app.get("/notes/{note_id}")
def get_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single note by ID."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return _serialize_note(note)


@app.get("/public/profile")
def get_public_profile(db: Session = Depends(get_db)):
    """Return the public bio + stats."""
    from sqlalchemy import func as sqlfunc
    profile = db.query(PublicProfile).first()
    note_count = db.query(Note).count()
    last_active = db.query(sqlfunc.max(Note.updated_at)).scalar()
    return {
        "bio": profile.bio if profile else None,
        "note_count": note_count,
        "last_active": last_active.isoformat() if last_active else None,
    }


@app.patch("/public/profile")
def update_public_profile(body: dict, db: Session = Depends(get_db)):
    """Save the public bio."""
    bio = body.get("bio", "")
    profile = db.query(PublicProfile).first()
    if profile:
        profile.bio = bio
    else:
        profile = PublicProfile(bio=bio)
        db.add(profile)
    db.commit()
    return {"ok": True}


# ── Google Calendar OAuth + Events ─────────────────────────────────────────────
# Single-tenant OAuth. See app/services/google_calendar.py for the setup
# requirements (Cloud Console project, client creds, redirect URIs).

from .services import google_calendar as gcal  # noqa: E402


@app.get("/auth/google/start")
def auth_google_start():
    """Kick off the OAuth flow. Returns the URL the frontend should
    window.open() — we return JSON instead of 302 so the frontend keeps
    control (shows a spinner, knows if env vars are missing, etc.).
    """
    if not gcal.is_configured():
        raise HTTPException(status_code=503, detail="Google OAuth env vars not set")
    return {"authorize_url": gcal.build_authorize_url()}


@app.get("/auth/google/callback")
def auth_google_callback(code: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    """Google redirects the user here with ?code=... — we exchange it for
    tokens, stash them, and redirect the browser back to the app. The
    frontend polls /auth/google/status to know connection state.
    """
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>Google OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = gcal.exchange_code_for_tokens(code)
        info = {}
        try:
            info = gcal.fetch_userinfo(tokens.get("access_token", ""))
        except Exception:
            pass
        gcal.save_tokens_from_exchange(db, tokens, account_email=info.get("email"))
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    # Auto-close the popup / redirect tab. Include a small inline script so
    # both flows (popup and full-page redirect) work.
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>Calendar connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>Google Calendar connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@app.get("/auth/google/status")
def auth_google_status(db: Session = Depends(get_db)):
    return gcal.connection_status(db)


@app.delete("/auth/google")
def auth_google_disconnect(db: Session = Depends(get_db)):
    disconnected = gcal.disconnect(db)
    return {"disconnected": disconnected}


@app.post("/calendar/events")
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


# ── GitHub OAuth + Dev Activity ────────────────────────────────────────────────

from .services import github as gh  # noqa: E402
from .db.models import TrackedRepo  # noqa: E402


@app.get("/auth/github/start")
def auth_github_start():
    if not gh.is_configured():
        raise HTTPException(status_code=503, detail="GitHub OAuth env vars not set")
    return {"authorize_url": gh.build_authorize_url()}


@app.get("/auth/github/callback")
def auth_github_callback(
    code: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>GitHub OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = gh.exchange_code_for_tokens(code)
        label = None
        try:
            info = gh.fetch_userinfo(tokens.get("access_token", ""))
            login = info.get("login")
            if login:
                label = f"@{login}"
        except Exception:
            pass
        gh.save_tokens_from_exchange(db, tokens, account_label=label)
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>GitHub connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>GitHub connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@app.get("/auth/github/status")
def auth_github_status(db: Session = Depends(get_db)):
    return gh.connection_status(db)


@app.delete("/auth/github")
def auth_github_disconnect(db: Session = Depends(get_db)):
    disconnected = gh.disconnect(db)
    return {"disconnected": disconnected}


@app.get("/integrations/github/repos")
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


@app.get("/integrations/github/tracked")
def github_list_tracked(db: Session = Depends(get_db)):
    rows = (
        db.query(TrackedRepo)
        .filter(TrackedRepo.provider == "github")
        .order_by(TrackedRepo.added_at.desc())
        .all()
    )
    return [{"owner": r.owner, "name": r.name, "added_at": r.added_at.isoformat()} for r in rows]


@app.post("/integrations/github/repos/{owner}/{name}")
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


@app.delete("/integrations/github/repos/{owner}/{name}")
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


@app.get("/dashboard/dev-activity")
def dashboard_dev_activity(db: Session = Depends(get_db)):
    """Per-repo dev activity (today, recent commits, streak) + aggregate
    streak and weekly LLM summary across all tracked repos.
    """
    from .services import dev_activity_service as das
    return das.dev_activity_service.build(db)
