import hashlib
import os
import re
import time
from collections import defaultdict, deque

from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .db.database import SessionLocal, engine
from .db.models import (
    Visit,
)


def _alembic_upgrade(engine):
    """Apply Alembic migrations on boot — walks the DB cursor in
    `alembic_version` forward to head. Fresh DBs (no `alembic_version`
    row yet) start from the baseline migration and walk every revision.

    Hardened recovery (post-PR #234 prod crash-loop):

    SQLite auto-commits DDL outside transactions, so a `CREATE TABLE`
    persists the second it runs — but Alembic's version-stamp UPDATE
    happens AFTER. If the process dies between (uncaught lifespan
    exception, OOM, etc.) the schema half-applies: tables exist but the
    cursor still points at the parent revision. Next boot tries to
    re-apply the same migration → `OperationalError: table already
    exists` → process exits → Fly restarts → crash loop.

    Recovery: catch the "already exists" class of OperationalErrors,
    log loudly, attempt to stamp the alembic cursor to head and
    re-attempt. If that also fails, log + continue boot anyway — let
    routes start so the app is at least diagnosable; broken schema
    will surface on first query rather than killing the process before
    logs flush.

    Hard schema failures (bad column type, missing FK target, etc.)
    still propagate — only the "already exists" branch is treated as
    self-recoverable.
    """
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.exc import OperationalError

    cfg = Config(str(Path(__file__).resolve().parent.parent / "alembic.ini"))
    try:
        command.upgrade(cfg, "head")
        return
    except OperationalError as e:
        msg = str(e).lower()
        already_exists = (
            "already exists" in msg or "duplicate column" in msg
        )
        if not already_exists:
            raise
        print(
            f"[alembic] half-applied state detected ({e.__class__.__name__}): "
            f"{str(e)[:160]}... attempting cursor stamp to head.",
            flush=True,
        )
    try:
        command.stamp(cfg, "head")
        print("[alembic] stamped to head — schema assumed current.", flush=True)
    except Exception as e:
        # Don't kill boot. Half-applied schema is usually still usable;
        # the app surfacing 500s on queries beats the entire process
        # crash-looping before logs can be read.
        print(
            f"[alembic] stamp recovery FAILED ({e.__class__.__name__}): "
            f"{str(e)[:160]} — booting anyway; schema may be inconsistent.",
            flush=True,
        )

_alembic_upgrade(engine)


# Background loops (daily nudge scheduler, backfills, watchdog, rollups,
# sweeper) live in app/background.py; the lifespan below just starts them.
import asyncio  # noqa: E402 — import after env load + model side-effects above
from datetime import datetime as _dt  # noqa: E402 — req-trace timing below

from contextlib import asynccontextmanager

from .common import _AUTH_PASSWORD, _expected_token
from . import background


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # One-shot backfill: flip any segment currently `not_yet` that has at
    # least one rating or step-feedback row to `pending`. Necessary because
    # `upsert_message_rating` only started bumping pending after PR #214;
    # segments rated before that landed are stuck not_yet despite real
    # reviewer input.
    try:
        from .services import eval_service
        db = SessionLocal()
        try:
            bumped = eval_service.backfill_pending_status(db)
            if bumped:
                print(f"[eval] pending backfill: {bumped} segments flipped", flush=True)
        finally:
            db.close()
    except Exception as e:
        print(f"[eval] pending backfill failed: {e}", flush=True)

    # Fly-revive handshake: if the prior process died mid-turn, the user
    # has WA messages with no assistant reply. Catch them up on boot
    # before scheduling other background work.
    try:
        from .services.fly_revive import catch_up_orphaned_messages
        revive_db = SessionLocal()
        try:
            orphans = catch_up_orphaned_messages(revive_db)
            print(f"[fly-revive] caught up {orphans} orphaned messages", flush=True)
        finally:
            revive_db.close()
    except Exception as e:
        print(f"[fly-revive] boot scan failed: {e}", flush=True)

    excerpt_task = asyncio.create_task(background._backfill_note_excerpts_loop())
    mem_task = asyncio.create_task(background._memory_watchdog_loop())
    try:
        yield
    finally:
        for t in (
            excerpt_task, mem_task,
        ):
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

app = FastAPI(lifespan=_lifespan)

_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth ───────────────────────────────────────────────────────────────────────


def _self_rss_kb() -> int:
    """Read VmRSS from /proc/self/status. Returns -1 on non-Linux or read
    failure (dev macOS). Cheap: a single fopen + linear scan of ~50 lines."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except Exception:
        pass
    return -1


# Threshold knobs for the per-request memory trace below. Picked from
# observed OOM behavior: the kill happened at ~318MB anon-rss starting from
# a 183MB sample, so the offending request was ~135MB. We want to flag
# anything that allocates >20MB in a single request — anything below that
# is normal request churn. Absolute floor at 250MB so a steady-state climb
# to "near the cliff" surfaces even if no individual request crosses the
# delta threshold.
_REQ_RSS_DELTA_FLAG_KB = 20 * 1024  # 20 MB
_REQ_RSS_ABS_FLAG_KB = 250 * 1024   # 250 MB
_REQ_TRACE_LOGGED = False  # set true once we've logged at least one [req]


@app.middleware("http")
async def memory_trace_middleware(request: Request, call_next):
    """Snapshot RSS before/after each request and log the ones that move
    the needle. Goal: attribute the next OOM spike to a specific endpoint
    instead of guessing.

    A request is "interesting" when EITHER the delta (rss_after - rss_before)
    exceeds _REQ_RSS_DELTA_FLAG_KB, OR rss_after exceeds _REQ_RSS_ABS_FLAG_KB.
    Everything else stays out of logs to keep the signal-to-noise sane.

    No /proc on macOS dev — rss_before/_after come back -1 and the filter
    falls through to "always log" mode for the first request after boot
    (so we know the trace is wired). Cheap: one /proc read on entry,
    one on exit. ~50 µs each."""
    rss_before = _self_rss_kb()
    t0 = _dt.now()
    response = await call_next(request)
    rss_after = _self_rss_kb()
    elapsed_ms = int((_dt.now() - t0).total_seconds() * 1000)

    delta = rss_after - rss_before if (rss_before > 0 and rss_after > 0) else 0
    interesting = (
        delta >= _REQ_RSS_DELTA_FLAG_KB
        or rss_after >= _REQ_RSS_ABS_FLAG_KB
    )
    global _REQ_TRACE_LOGGED
    if interesting or not _REQ_TRACE_LOGGED:
        _REQ_TRACE_LOGGED = True
        path = request.url.path[:120]
        method = request.method
        status = getattr(response, "status_code", "?")
        print(
            f"[req] {method} {path} status={status} dur={elapsed_ms}ms "
            f"rss_before={rss_before}kB rss_after={rss_after}kB delta={delta}kB",
            flush=True,
        )
    return response

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Block non-public routes when AUTH_PASSWORD is set."""
    if not _AUTH_PASSWORD:
        return await call_next(request)

    path = request.url.path
    # Always allow: public read-only routes, auth endpoint, static assets, CORS preflight
    # Mutations on /public/* (e.g. PATCH /public/profile) still require the Bearer token.
    # Webhook routes bypass Bearer auth — the calling third party (Meta,
    # BlueBubbles, etc) has no way to attach our Bearer token. Each webhook
    # route enforces its own auth (signature verification, verify_token,
    # shared-secret header) at the handler level.
    if (
        (path.startswith("/public") and request.method == "GET")
        or path == "/auth"
        # OAuth callback is hit by Google's redirect with no bearer; must be open.
        # The code value itself is the auth proof. `state` can carry a CSRF token.
        or path == "/auth/google/callback"
        or path == "/auth/github/callback"
        or path == "/auth/whoop/callback"
        # Whoop webhooks carry their own HMAC signature; password gate
        # would 401 before signature check runs.
        or path == "/webhooks/whoop"
        or path == "/healthz"
        or path.startswith("/assets")
        or path.startswith("/webhooks/")
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

# Only real public PAGE-content fetches count as a visit: the index list
# (`/public/notes`) and a note detail (`/public/notes/<id>`). Everything else
# the SPA fires per page load (`/public/profile`, `/public/visits/count`,
# `.../comments`, `/public/og`) is meta noise that used to pad the count —
# and fetching `/public/visits/count` was literally self-counting.
_VISIT_PATH_RE = re.compile(r"^/public/notes(?:/\d+)?$")


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
    """Record real page views on /public for unique-visitor analytics.

    Counts only content-page fetches (index list + note detail), skips the
    SPA's meta/data fetches, the owner (anyone carrying the valid auth token),
    and obvious bots. Dedups to one row per (ip_hash, path, day) so refreshes
    don't inflate totals. Unique visitors = COUNT(DISTINCT ip_hash).
    """
    response = await call_next(request)
    path = request.url.path
    if (
        request.method == "GET"
        and _VISIT_PATH_RE.match(path)
        and response.status_code < 400
    ):
        # Owner self-exclude: a valid Bearer token means it's Daniel (the
        # public site shares localStorage with the authed app, so apiFetch
        # attaches the token on /public when he's logged in). No marker = visitor.
        is_owner = (
            bool(_AUTH_PASSWORD)
            and request.headers.get("Authorization", "") == f"Bearer {_expected_token()}"
        )
        ua = request.headers.get("user-agent", "")
        if not is_owner and not _BOT_UA_RE.search(ua):
            ip = _client_ip(request)
            if ip:
                from datetime import datetime, time as _time
                ip_hash = _hash_ip(ip)
                day_start = datetime.combine(datetime.utcnow().date(), _time.min)
                db = SessionLocal()
                try:
                    already = (
                        db.query(Visit.id)
                        .filter(
                            Visit.ip_hash == ip_hash,
                            Visit.path == path,
                            Visit.created_at >= day_start,
                        )
                        .first()
                    )
                    if not already:
                        db.add(Visit(
                            ip_hash=ip_hash,
                            user_agent=ua[:500] or None,
                            path=path[:500],
                        ))
                        db.commit()
                except Exception:
                    db.rollback()
                finally:
                    db.close()
    return response


# ── Routers ────────────────────────────────────────────────────────────────────
# Domain routers live in app/routers/. Each owns one URL-prefix group.
import importlib
from .routers import ROUTER_MODULES

for _mod_name in ROUTER_MODULES:
    _mod = importlib.import_module(f".routers.{_mod_name}", __package__)
    app.include_router(_mod.router)
