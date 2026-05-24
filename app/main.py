import hashlib
import hmac
import json
import os
import re
import time
from collections import defaultdict, deque

from dotenv import load_dotenv

load_dotenv()  # must run before any service imports that read env vars

from typing import Optional
from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from .db.database import engine, get_db
from .db.database import SessionLocal
from .db.models import (
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
from .db.schemas import ChatRequest
from .llm.client import llm_client
from .services.conversation_service import conversation_service
from .services.item_service import item_service
from .services.memory_service import memory_service
from .services.messaging import (
    dispatch_inbound,
    imessage_channel,
    telegram_channel,
    whatsapp_channel,
)
from .services.note_service import note_service
from .services.orchestrator import Orchestrator
from .services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
    compose_message as compose_nudge_message,
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

# ── Daily nudge scheduler ─────────────────────────────────────────────────────
#
# Lives in the FastAPI process (single source of truth) and replaces the
# old loop in scripts/telegram_bot.py. Why FastAPI:
#   1. The bot polling script restarts more often (deploys, polling timeouts);
#      FastAPI is the long-lived API server, so the schedule survives better.
#   2. Settings + idempotency are DB-backed, and FastAPI owns the DB session
#      lifecycle. The bot would still need to call back here.
#   3. WhatsApp send already goes through httpx — no python-telegram-bot
#      dependency needed in this process.
#
# Scheduling uses zoneinfo + Settings.nudge_tz so 9:00 means 9:00 *in Daniel's
# timezone* regardless of where the Fly machine clock is set. Idempotency:
# write Settings.nudge_last_sent_day before fan-out — kills double-send even
# if Fly scales to 2 machines.

import asyncio  # noqa: E402 — import after env load + model side-effects above
from datetime import datetime as _dt, timedelta as _td  # noqa: E402

try:
    from zoneinfo import ZoneInfo  # py3.9+
except ImportError:  # pragma: no cover — Fly runs 3.11
    ZoneInfo = None  # type: ignore

from .deps import _fire_nudge_once, _next_fire, _settings_row
from .serializers import _excerpt_from_html
from .common import _AUTH_PASSWORD, _expected_token


async def _proactive_nudge_loop():
    """Single tick driving every proactive surface: sleep callout +
    debounced whoop ping. Runs every 60s so the whoop debouncer has
    minute-level resolution while the sleep callout stays cheap. All
    decision logic lives in proactive_nudge; this loop just calls the
    checks and fails open. Renamed from `_sleep_nudge_loop` once the
    whoop debouncer landed."""
    # Stagger past boot so we don't race the alembic upgrade.
    await asyncio.sleep(30)
    while True:
        try:
            from .services.proactive_nudge import (
                maybe_fire_sleep_nudge,
                process_pending_whoop_nudge,
            )
            db = SessionLocal()
            try:
                process_pending_whoop_nudge(db)
                maybe_fire_sleep_nudge(db)
            finally:
                db.close()
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[proactive_nudge] tick error (ignored): {e}")
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            return

async def _nudge_loop():
    """Sleep until the next configured fire time, then fire. Re-reads Settings
    every iteration so a UI change to nudge_hour/minute/tz takes effect on the
    next loop without restarting the process."""
    while True:
        try:
            db = SessionLocal()
            try:
                s = _settings_row(db)
                enabled = s.nudge_enabled
                hour = s.nudge_hour
                minute = s.nudge_minute
                tz_name = s.nudge_tz or "America/Los_Angeles"
            finally:
                db.close()
            if not enabled:
                # Re-check every 5 min so toggling on in the UI doesn't take
                # 24h to take effect.
                await asyncio.sleep(300)
                continue
            now = _dt.now(ZoneInfo(tz_name) if ZoneInfo else None)
            target = _next_fire(now, hour, minute, tz_name)
            wait = max(1.0, (target - now).total_seconds())
            await asyncio.sleep(wait)
            await _fire_nudge_once()
            # Buffer past the firing minute so we don't immediately recompute
            # "next 9:00" as today again on a clock still at 09:00:00.
            await asyncio.sleep(70)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[nudge] loop error: {e}")
            await asyncio.sleep(60)

from contextlib import asynccontextmanager  # noqa: E402


async def _backfill_list_item_embeddings_loop():
    """One-shot lazy backfill: list_items rows that predate the embedding
    column have NULL embeddings, so similarity search ignores them. Walk
    the table in small batches at startup until none remain. Sleeps between
    batches so we don't block the event loop or burn the OpenAI quota in
    one shot."""
    from .services.list_service import list_service

    await asyncio.sleep(5)  # let HTTP server bind first
    while True:
        db = SessionLocal()
        try:
            wrote = list_service.backfill_missing_embeddings(db, limit=25)
        except Exception as e:
            print(f"List embedding backfill error: {e}")
            wrote = 0
        finally:
            db.close()
        if wrote == 0:
            return
        print(f"List embedding backfill: embedded {wrote} item(s)")
        await asyncio.sleep(2)

async def _backfill_note_excerpts_loop():
    """One-shot lazy backfill of the new `notes.excerpt` column. Old rows
    have NULL excerpt, so list endpoints would render blank previews until
    the user re-saves each one. Walk the table in small batches at startup
    until none remain. Pure regex (no LLM / network), so this can run hot."""
    await asyncio.sleep(3)  # let HTTP server bind first
    while True:
        db = SessionLocal()
        wrote = 0
        try:
            rows = (
                db.query(Note)
                .filter(Note.excerpt.is_(None))
                .filter(Note.content.isnot(None))
                .limit(50)
                .all()
            )
            if not rows:
                return
            for n in rows:
                # Stamp "" when extraction yields None (e.g. <p></p> or
                # image-only bodies). Otherwise the IS NULL filter re-selects
                # the same rows forever, hot-spinning the loop and slowly
                # exhausting the 512MB Fly machine until OOM.
                n.excerpt = _excerpt_from_html(n.content) or ""
                wrote += 1
            db.commit()
        except Exception as e:
            print(f"Note excerpt backfill error: {e}")
            db.rollback()
            return
        finally:
            db.close()
        if wrote:
            print(f"Note excerpt backfill: stamped {wrote} row(s)")
        await asyncio.sleep(0.5)

def _read_meminfo_kb(key: str) -> int:
    """Read a single field from /proc/meminfo as kB. Returns -1 on miss."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith(f"{key}:"):
                    return int(line.split()[1])
    except Exception:
        pass
    return -1

def _scan_python_processes() -> list[tuple[str, int, int]]:
    """Walk /proc and return (label, pid, rss_kb) for every process whose
    cmdline mentions python or uvicorn. Used by the watchdog so we can see
    the Telegram bot's RSS without standing up a second watchdog inside
    that process. Quietly skips procs we can't read."""
    import glob as _glob
    out: list[tuple[str, int, int]] = []
    for d in _glob.glob("/proc/[0-9]*"):
        try:
            with open(d + "/cmdline") as f:
                cmd = f.read().replace("\x00", " ").strip()
            if not cmd:
                continue
            if "python" not in cmd and "uvicorn" not in cmd:
                continue
            pid = int(d.rsplit("/", 1)[-1])
            with open(d + "/status") as f:
                rss = -1
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1])
                        break
            # Short label so log lines stay scannable.
            if "uvicorn" in cmd:
                label = "uvicorn"
            elif "telegram_bot" in cmd:
                label = "tgbot"
            else:
                label = "py"
            out.append((label, pid, rss))
        except Exception:
            continue
    out.sort(key=lambda r: -r[2])
    return out

async def _memory_watchdog_loop():
    """Periodically log RSS + run gc.collect(). Three jobs:
    1. Diagnostic for uvicorn — gen-2 collect + own RSS, every 5 min.
    2. System-wide visibility — log MemAvailable + per-process RSS for
       every python/uvicorn process so we can see who's actually growing.
       Without this the bot at ~95MB was invisible to us; the only signal
       was "machine OOM'd, but uvicorn was flat."
    3. Band-aid — gc.collect() inside uvicorn forces gen-2 collection
       sooner than CPython's default thresholds, which are tuned for
       desktop heaps and let cyclic refs sit on a small server until
       kernel-OOM forces them out.
    Cheap (a few /proc reads + one collect every 5 min)."""
    import gc as _gc
    while True:
        await asyncio.sleep(300)
        try:
            collected = _gc.collect()
            self_rss = -1
            try:
                with open("/proc/self/status") as f:
                    self_rss = next(
                        (int(ln.split()[1]) for ln in f if ln.startswith("VmRSS:")),
                        -1,
                    )
            except Exception:
                pass
            mem_available = _read_meminfo_kb("MemAvailable")
            mem_total = _read_meminfo_kb("MemTotal")
            procs = _scan_python_processes()
            proc_str = " ".join(f"{label}({pid})={rss}" for label, pid, rss in procs)
            print(
                f"[mem] rss={self_rss}kB gc_collected={collected} "
                f"mem_available={mem_available}kB mem_total={mem_total}kB "
                f"procs[{proc_str}]",
                flush=True,
            )
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[mem] watchdog error: {e}", flush=True)

async def _capability_telemetry_loop():
    """Daily rollup of ToolCall audit → CapabilityFacet.status transitions.

    Sleep to the next 03:00 in nudge_tz, then run capability_service
    telemetry. Idempotency via Settings.capability_telemetry_last_run_day
    (YYYY-MM-DD in nudge_tz) so a Fly horizontal-scale race can't double-run.
    Loop survives errors by sleeping a minute and retrying.
    """
    from .services.capability_service import capability_service
    while True:
        try:
            db = SessionLocal()
            try:
                s = _settings_row(db)
                tz_name = s.nudge_tz or "America/Los_Angeles"
                last_run = s.capability_telemetry_last_run_day
            finally:
                db.close()
            now = _dt.now(ZoneInfo(tz_name) if ZoneInfo else None)
            target = _next_fire(now, hour=3, minute=0, tz_name=tz_name)
            wait = max(1.0, (target - now).total_seconds())
            await asyncio.sleep(wait)
            # Idempotency check after wakeup: re-read in case another machine
            # already wrote today's token.
            db = SessionLocal()
            try:
                s = _settings_row(db)
                today_str = _dt.now(
                    ZoneInfo(tz_name) if ZoneInfo else None
                ).strftime("%Y-%m-%d")
                if s.capability_telemetry_last_run_day == today_str:
                    await asyncio.sleep(70)
                    continue
                s.capability_telemetry_last_run_day = today_str
                db.commit()
                result = capability_service.run_telemetry_rollup(db)
                print(f"[capability] telemetry: {result}", flush=True)
            finally:
                db.close()
            await asyncio.sleep(70)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[capability] loop error: {e}", flush=True)
            await asyncio.sleep(60)

async def _urgency_rollup_loop():
    """Nightly recompute of backlog ticket urgency_score from
    friction_events. Fires at 03:30 local — staggered 30min after the
    capability_telemetry_loop's 03:00 to avoid double-writing the same
    rows in adjacent passes.

    G2 self-PM: keeps urgency_score honest even when no fresh friction
    fires (synchronous bump in log_friction handles real-time, but
    decay-based ranking shifts daily without new events).
    """
    from .services.backlog_service import backlog_service
    while True:
        try:
            db = SessionLocal()
            try:
                s = _settings_row(db)
                tz_name = s.nudge_tz or "America/Los_Angeles"
            finally:
                db.close()
            now = _dt.now(ZoneInfo(tz_name) if ZoneInfo else None)
            target = _next_fire(now, hour=3, minute=30, tz_name=tz_name)
            wait = max(1.0, (target - now).total_seconds())
            await asyncio.sleep(wait)
            db = SessionLocal()
            try:
                result = backlog_service.recompute_all_urgency(db)
                print(f"[urgency-rollup] {result}", flush=True)
            finally:
                db.close()
            await asyncio.sleep(70)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[urgency-rollup] loop error: {e}", flush=True)
            await asyncio.sleep(60)

async def _todo_soft_delete_sweeper_loop():
    """Hourly hard-purge of soft-deleted todos past the 24h undo window.

    G1 groom-mutation: chat-side delete/merge/rename soft-deletes via
    `Todo.deleted_at`. This sweeper hard-removes anything past the TTL
    so the table doesn't grow tombstones forever. Hourly cadence keeps
    the window tight enough that the undo runway stays honest (matches
    `SOFT_DELETE_TTL_HOURS` semantics).
    """
    from .services.todo_service import todo_service
    while True:
        try:
            await asyncio.sleep(3600)  # 1 hour
            db = SessionLocal()
            try:
                purged = todo_service.purge_old_deleted(db)
                if purged:
                    print(f"[todo-sweeper] purged {purged} stale tombstones", flush=True)
            finally:
                db.close()
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[todo-sweeper] loop error: {e}", flush=True)
            await asyncio.sleep(60)

@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Boot-time mechanical capability scan — populates the facet table
    # from the live tool registry + FastAPI routes + messaging channels.
    # Idempotent + source-hash short-circuited so it's cheap to re-run on
    # every uvicorn restart. Negative-polarity facet seed runs alongside
    # so the "I cannot:" block in the prompt is populated from boot.
    try:
        from .services.capability_service import capability_service
        db = SessionLocal()
        try:
            result = capability_service.refresh_mechanical_layer(db)
            print(f"[capability] boot scan: {result}", flush=True)
            try:
                seeded = capability_service.seed_negative_facets(db)
                if seeded:
                    print(f"[capability] seeded {seeded} negative facets", flush=True)
            except Exception as e:
                # Pre-G1 dev DBs may not have the polarity column yet (the
                # migration is inspector-guarded against missing columns
                # both ways). Don't crash boot — just log.
                print(f"[capability] negative seed skipped: {e}", flush=True)
        finally:
            db.close()
    except Exception as e:
        print(f"[capability] boot scan failed: {e}", flush=True)

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

    nudge_task = asyncio.create_task(_nudge_loop())
    backfill_task = asyncio.create_task(_backfill_list_item_embeddings_loop())
    excerpt_task = asyncio.create_task(_backfill_note_excerpts_loop())
    mem_task = asyncio.create_task(_memory_watchdog_loop())
    capability_task = asyncio.create_task(_capability_telemetry_loop())
    todo_sweeper_task = asyncio.create_task(_todo_soft_delete_sweeper_loop())
    urgency_task = asyncio.create_task(_urgency_rollup_loop())
    sleep_nudge_task = asyncio.create_task(_proactive_nudge_loop())
    try:
        yield
    finally:
        for t in (
            nudge_task, backfill_task, excerpt_task, mem_task, capability_task,
            todo_sweeper_task, urgency_task, sleep_nudge_task,
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
async def mcp_logger(request: Request, call_next):
    """Log calls originating from the Gooni MCP server (mcp/server.py tags
    every outbound request with `X-Gooni-Source: mcp`). Surfaces as a
    "claude activity" stat on the dashboard. Logs after the route so we
    only count successful calls — failed auth / 4xx / 5xx don't pad the
    count.
    """
    response = await call_next(request)
    if (
        request.headers.get("x-gooni-source", "").lower() == "mcp"
        and response.status_code < 400
    ):
        db = SessionLocal()
        try:
            db.add(McpCall(path=request.url.path[:500]))
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"[mcp_logger] failed to log call {request.url.path}: {e}", flush=True)
        finally:
            db.close()
    return response


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


# ── Routers ────────────────────────────────────────────────────────────────────
# Domain routers live in app/routers/. Each owns one URL-prefix group.
import importlib
from .routers import ROUTER_MODULES

for _mod_name in ROUTER_MODULES:
    _mod = importlib.import_module(f".routers.{_mod_name}", __package__)
    app.include_router(_mod.router)
