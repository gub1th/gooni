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


def _settings_row(db: Session) -> Settings:
    """Singleton accessor. Mirrors todo_nudge._get_settings but local copy
    avoids a cross-module import cycle for the lifespan task."""
    s = db.query(Settings).filter(Settings.id == 1).first()
    if s is None:
        s = Settings(id=1)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def _next_fire(now: _dt, hour: int, minute: int, tz_name: str) -> _dt:
    """Compute the next wall-clock occurrence of HH:MM in tz_name. Returned
    as a tz-aware datetime so subtraction is unambiguous."""
    if ZoneInfo is None:
        # Naïve fallback: assume host is in the right tz. Should never hit
        # this on Fly (3.11) but keeps imports honest on older runtimes.
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += _td(days=1)
        return target
    tz = ZoneInfo(tz_name)
    now_tz = now.astimezone(tz) if now.tzinfo else now.replace(tzinfo=tz)
    target = now_tz.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now_tz:
        target += _td(days=1)
    return target


async def _fire_nudge_once(force: bool = False) -> dict:
    """Build + fan out the digest. Returns a small report dict for callers
    (the test endpoint surfaces it). `force=True` skips the same-day idempotency
    guard so Settings → "Send test now" always fires.
    """
    db = SessionLocal()
    try:
        s = _settings_row(db)
        tz_name = s.nudge_tz or "America/Los_Angeles"
        today_str = _dt.now(ZoneInfo(tz_name) if ZoneInfo else None).strftime("%Y-%m-%d")
        if not force and s.nudge_last_sent_day == today_str:
            return {"sent": False, "reason": "already sent today"}

        msg = compose_nudge_message(db)
        if msg is None:
            # No-news day — still stamp last_sent_day so we don't re-check
            # every minute (the loop sleeps to next-fire after this returns).
            if not force:
                s.nudge_last_sent_day = today_str
                db.commit()
            return {"sent": False, "reason": "no todos or focuses to mention"}

        try:
            channels = json.loads(s.nudge_channels or '["telegram"]')
        except json.JSONDecodeError:
            channels = ["telegram"]

        sent_to: list[str] = []
        skipped: list[str] = []

        if "telegram" in channels:
            for chat_id in telegram_channel.allowed_chat_ids:
                try:
                    formatted = telegram_channel.format_outbound(msg)
                    telegram_channel.send(str(chat_id), formatted)
                    sent_to.append(f"telegram:{chat_id}")
                except Exception as e:
                    print(f"[nudge] telegram send failed for {chat_id}: {e}")

        if "whatsapp" in channels:
            # WA Business API rejects freeform sends outside the 24h
            # customer-initiated window. Single-tenant Gooni: one conversation
            # row per source, so we approximate the window via the most recent
            # WA message timestamp. If silent for >24h, skip — user can DM
            # Gooni any random thing to reopen the window.
            from .db.models import Conversation as _Conv  # local import: tight scope
            cutoff = _dt.utcnow() - _td(hours=24)
            last_wa = (
                db.query(_Conv)
                .filter(_Conv.source == "whatsapp")
                .order_by(_Conv.last_message_at.desc())
                .first()
            )
            wa_open = bool(
                last_wa and last_wa.last_message_at and last_wa.last_message_at >= cutoff
            )
            for handle in sorted({h for h in whatsapp_channel._allowed}):  # type: ignore[attr-defined]
                if not wa_open:
                    skipped.append(f"whatsapp:{handle} (>24h silent — outside window)")
                    continue
                try:
                    formatted = whatsapp_channel.format_outbound(msg)
                    whatsapp_channel.send(handle, formatted)
                    sent_to.append(f"whatsapp:{handle}")
                except Exception as e:
                    print(f"[nudge] whatsapp send failed for {handle}: {e}")

        if not force and sent_to:
            s.nudge_last_sent_day = today_str
            db.commit()

        return {"sent": bool(sent_to), "to": sent_to, "skipped": skipped}
    finally:
        db.close()


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

_AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "").strip()


def _expected_token() -> str:
    """Derive a stateless token from the configured password."""
    return hashlib.sha256(_AUTH_PASSWORD.encode()).hexdigest()


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
    """Insert a list item.

    Conflict detection: by default we cosine-search existing items in the same
    list and return any near-duplicates as `conflicts: [{id, text, similarity,
    severity}]`. Caller decides how to surface them. Pass `skip_conflict_check`
    in the body to bypass the embed call (used by bulk imports / migrations).
    """
    from .services.list_service import (
        list_service,
        CONFLICT_HIGH,
    )
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    actionable = body.get("actionable")
    skip_check = bool(body.get("skip_conflict_check"))
    if skip_check:
        item = list_service.add_item(
            list_id, text, db,
            subtitle=(body.get("subtitle") or None),
            source_note_id=body.get("source_note_id"),
            actionable=(True if actionable is None else bool(actionable)),
        )
        return _serialize_list_item(item)
    item, conflicts = list_service.add_item_with_conflict_check(
        list_id, text, db,
        subtitle=(body.get("subtitle") or None),
        source_note_id=body.get("source_note_id"),
        actionable=(True if actionable is None else bool(actionable)),
    )
    return {
        **_serialize_list_item(item),
        "conflicts": [
            {
                "id": c.id,
                "text": c.text,
                "subtitle": c.subtitle,
                "similarity": round(sim, 3),
                "severity": "high" if sim >= CONFLICT_HIGH else "medium",
            }
            for c, sim in conflicts
        ],
    }


@app.post("/lists/{list_id}/similar")
def find_similar_list_items(list_id: int, body: dict, db: Session = Depends(get_db)):
    """Cosine-search items in a list against a query text. Read-only — does
    not mutate. Powers the MCP `find_similar_items` tool + future UI
    duplicate-warning surfaces."""
    from .services.list_service import list_service, CONFLICT_MEDIUM

    lst = db.query(ListModel).filter(ListModel.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="list not found")
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    try:
        threshold = float(body.get("threshold", CONFLICT_MEDIUM))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="threshold must be a number")
    try:
        limit = int(body.get("limit", 5))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="limit must be an int")
    matches = list_service.find_similar_in_list(
        list_id,
        text,
        db,
        subtitle=(body.get("subtitle") or None),
        threshold=threshold,
        limit=limit,
        include_done=bool(body.get("include_done")),
        exclude_item_id=body.get("exclude_item_id"),
    )
    return {
        "matches": [
            {
                "id": it.id,
                "text": it.text,
                "subtitle": it.subtitle,
                "done": bool(it.done),
                "similarity": round(sim, 3),
            }
            for it, sim in matches
        ],
    }


@app.patch("/list-items/{item_id}")
def update_list_item(item_id: int, body: dict, db: Session = Depends(get_db)):
    """Update a generic list_items row. After the focus/todo/backlog
    extraction, fields like is_primary / board_status / pr_url / due_date
    no longer live here — patch them via /focuses/{id}, /todos/{id}, or
    /backlog/tickets/{id} instead.
    """
    from .services.list_service import list_service

    item = list_service.update_item(
        item_id, db,
        text=body.get("text"),
        subtitle=body.get("subtitle"),
        done=body.get("done"),
        actionable=body.get("actionable"),
        sort_order=body.get("sort_order"),
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


# ── Backlog tickets — extracted from list_items into their own table ───────


@app.get("/backlog/tickets")
def backlog_list(
    include_done: bool = True,
    sort: str = "default",
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List backlog tickets. sort='default' = sort_order ASC (current
    behavior). sort='urgency' = G2 urgency-first ranking: open tickets
    with urgency_score desc, then non-scored open, then done. Caps at
    `limit` rows on urgency mode to avoid hauling the whole backlog."""
    from .services.backlog_service import backlog_service, serialize_ticket
    if sort == "urgency":
        # Use the dedicated query — only open + scored tickets, ranked.
        # Fall back to default-sorted remainder for context if include_done.
        scored = backlog_service.list_by_urgency(db, limit=limit)
        scored_ids = {t.id for t in scored}
        out = [serialize_ticket(t) for t in scored]
        # Append non-scored open tickets after the ranked ones so callers
        # paging through don't lose visibility of unscored work. Done
        # tickets only included when include_done=True.
        remainder = [
            t for t in backlog_service.list_all(db, include_done=include_done)
            if t.id not in scored_ids
        ]
        out.extend(serialize_ticket(t) for t in remainder)
        return out
    rows = backlog_service.list_all(db, include_done=include_done)
    return [serialize_ticket(t) for t in rows]


@app.post("/backlog/tickets")
def backlog_create(body: dict, db: Session = Depends(get_db)):
    """Create a backlog ticket. Mirrors /lists/{id}/items conflict
    detection: response carries `conflicts: [{id, text, similarity,
    severity}]` for near-duplicates already on the board, so a caller
    (MCP, FE) can prompt the user to merge instead of stacking dupes.
    Pass `skip_conflict_check: true` to bypass the embed scan (bulk
    imports / migrations).
    """
    from .services.backlog_service import backlog_service, serialize_ticket
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    ticket = backlog_service.create(
        db,
        text=text_val,
        subtitle=body.get("subtitle"),
        source_note_id=body.get("source_note_id"),
        board_status=body.get("board_status"),
        notes=body.get("notes"),
    )
    out = serialize_ticket(ticket)
    if not body.get("skip_conflict_check"):
        # Severity bands match list_service: 0.92+ = high (almost
        # certainly the same item), 0.85+ = medium, otherwise low.
        text_for_match = text_val
        if body.get("subtitle"):
            text_for_match = f"{text_val}\n{body.get('subtitle')}"
        matches = backlog_service.find_similar(
            db, text=text_for_match, threshold=0.78, limit=5,
        )
        conflicts = []
        for tk, sim in matches:
            if tk.id == ticket.id:
                continue
            severity = "high" if sim >= 0.92 else ("medium" if sim >= 0.85 else "low")
            conflicts.append({
                "id": tk.id, "text": tk.text,
                "similarity": round(sim, 3), "severity": severity,
            })
        if conflicts:
            out["conflicts"] = conflicts
    return out


@app.post("/backlog/tickets/similar")
def backlog_similar(body: dict, db: Session = Depends(get_db)):
    """Cosine-search backlog tickets without inserting. Body:
    {text, threshold?, limit?, include_done?}. Mirrors the
    /lists/{id}/similar shape so MCP find_similar_backlog can match
    find_similar_items's response contract.
    """
    from .services.backlog_service import backlog_service
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    threshold = float(body.get("threshold", 0.78))
    limit = int(body.get("limit", 5))
    include_done = bool(body.get("include_done", False))
    matches = backlog_service.find_similar(
        db, text=text_val, threshold=threshold, limit=limit,
    )
    out = []
    for tk, sim in matches:
        if not include_done and tk.done:
            continue
        out.append({
            "id": tk.id, "text": tk.text, "subtitle": tk.subtitle,
            "similarity": round(sim, 3),
            "board_status": tk.board_status,
            "done": bool(tk.done),
        })
    return {"matches": out}


@app.patch("/backlog/tickets/{ticket_id}")
def backlog_update(ticket_id: int, body: dict, db: Session = Depends(get_db)):
    from .services.backlog_service import backlog_service, serialize_ticket
    patch: dict = {}
    for key in (
        "text", "subtitle", "board_status", "pr_url", "done", "sort_order",
        "notes", "claimed_by",
    ):
        if key in body:
            patch[key] = body[key]
    ticket = backlog_service.update(db, ticket_id, **patch)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)


@app.delete("/backlog/tickets/{ticket_id}")
def backlog_delete(ticket_id: int, db: Session = Depends(get_db)):
    from .services.backlog_service import backlog_service
    if not backlog_service.delete(db, ticket_id):
        raise HTTPException(status_code=404, detail="ticket not found")
    return {"ok": True}


@app.get("/backlog/tickets/primary")
def backlog_get_primary(db: Session = Depends(get_db)):
    """Singleton dashboard north-star ticket — or null when nothing is
    pinned. Drives the PrimaryBacklogBanner on the dashboard."""
    from .services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.get_primary(db)
    return serialize_ticket(ticket) if ticket else None


@app.post("/backlog/tickets/{ticket_id}/promote-to-primary")
def backlog_promote_to_primary(ticket_id: int, db: Session = Depends(get_db)):
    """Pin this ticket as the singleton primary (banner anchor). Clears
    any previously-primary ticket atomically. Idempotent."""
    from .services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.promote_to_primary(db, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)


@app.post("/backlog/tickets/primary/clear")
def backlog_clear_primary(db: Session = Depends(get_db)):
    """Unpin whichever ticket currently holds primary. Returns the
    demoted ticket or null when nothing was pinned."""
    from .services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.clear_primary(db)
    return serialize_ticket(ticket) if ticket else None


@app.post("/backlog/tickets/{ticket_id}/promote")
def backlog_promote(ticket_id: int, db: Session = Depends(get_db)):
    """Create a Todo mirroring this ticket and link them via ticket.todo_id.
    Returns {ticket, todo}. Idempotent — re-promoting an already-linked
    ticket returns the existing pair."""
    from .services.backlog_service import backlog_service, serialize_ticket
    from .services.todo_service import serialize_todo
    result = backlog_service.promote(db, ticket_id)
    if result is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    ticket, todo = result
    return {"ticket": serialize_ticket(ticket), "todo": serialize_todo(todo)}


@app.post("/backlog/tickets/{ticket_id}/demote")
def backlog_demote(ticket_id: int, db: Session = Depends(get_db)):
    """Sever the ticket↔todo link by deleting the linked Todo and clearing
    ticket.todo_id. Backlog row stays."""
    from .services.backlog_service import backlog_service, serialize_ticket
    ticket = backlog_service.demote(db, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    return serialize_ticket(ticket)


# ── Habits (daily binary trackers + 7-day strip widget) ────────────────


def _parse_iso_date(s: str | None):
    """Parse YYYY-MM-DD. Returns None if missing/invalid (caller handles)."""
    if not s:
        return None
    from datetime import date as _date
    try:
        y, m, d = s.split("-")
        return _date(int(y), int(m), int(d))
    except Exception:
        return None


@app.get("/habits")
def habits_list(db: Session = Depends(get_db)):
    """Active habits w/ each habit's 7-day strip + current streak. Drives
    the dashboard widget. Sorted by sort_order, id."""
    from .services import habit_service
    rows = habit_service.list_active(db)
    return [
        habit_service.serialize_habit(h, include_derived=True, db=db)
        for h in rows
    ]


@app.post("/habits")
def habits_create(body: dict, db: Session = Depends(get_db)):
    """Create a habit. Body: {name, polarity?, color?}. Polarity
    defaults to 'positive'."""
    from .services import habit_service
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    polarity = body.get("polarity") or "positive"
    if polarity not in ("positive", "negative"):
        raise HTTPException(400, "polarity must be 'positive' or 'negative'")
    h = habit_service.create(
        db, name=name, polarity=polarity, color=body.get("color"),
    )
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@app.patch("/habits/{habit_id}")
def habits_patch(habit_id: int, body: dict, db: Session = Depends(get_db)):
    """Rename / recolor / archive. Body any of {name, color, polarity,
    sort_order, archived: bool}."""
    from .services import habit_service
    h = habit_service.update(db, habit_id, **body)
    if not h:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_habit(h, include_derived=True, db=db)


@app.delete("/habits/{habit_id}")
def habits_delete(habit_id: int, db: Session = Depends(get_db)):
    """Hard delete. Entries cascade."""
    from .services import habit_service
    ok = habit_service.delete(db, habit_id)
    if not ok:
        raise HTTPException(404, "habit not found")
    return {"deleted": True}


@app.put("/habits/{habit_id}/entries/{day}")
def habit_entry_upsert(
    habit_id: int, day: str, body: dict, db: Session = Depends(get_db),
):
    """Upsert one day's entry. Path `day` = YYYY-MM-DD. Body:
    {value: bool, note?: str}."""
    from .services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    if "value" not in body:
        raise HTTPException(400, "value required (bool)")
    e = habit_service.upsert_entry(
        db, habit_id, d, bool(body["value"]), note=body.get("note"),
    )
    if not e:
        raise HTTPException(404, "habit not found")
    return habit_service.serialize_entry(e)


@app.delete("/habits/{habit_id}/entries/{day}")
def habit_entry_unlog(
    habit_id: int, day: str, db: Session = Depends(get_db),
):
    """Delete one day's entry — reverts to unknown."""
    from .services import habit_service
    d = _parse_iso_date(day)
    if not d:
        raise HTTPException(400, "day must be YYYY-MM-DD")
    deleted = habit_service.unlog_entry(db, habit_id, d)
    return {"deleted": deleted}


# ── Dedicated focus + todo routes (cleaner FE consumption than /items) ─

@app.get("/focuses")
def focuses_list(db: Session = Depends(get_db)):
    """Active focuses with color + linked-todo progress for the dashboard
    focus cards. Returns the same shape as item_service.list_tree['focuses']
    but as a flat list."""
    from .services.focus_service import focus_service
    from .services.item_service import _focus_tree_node
    return [_focus_tree_node(db, f) for f in focus_service.list_active(db)]


@app.post("/focus-synthesis/run")
def focus_synthesis_run(body: dict | None = None, db: Session = Depends(get_db)):
    """Probe endpoint — runs the focus synthesizer over recent notes /
    todos / deduped facts / chat messages and returns candidate clusters
    as JSON. Does NOT persist anything; this is a quality probe.

    Body (all optional):
      {
        "include_kinds": ["note","todo","fact","message"],
        "threshold": float (cosine join floor, default 0.48),
        "merge_threshold": float (centroid-merge floor, default 0.62; set
            to 1.1 to disable the merge pass),
        "sub_threshold": float (tighter cosine for within-parent sub-cluster,
            default 0.62),
        "min_parent_for_subcluster": int (only parents this size or larger
            get sub-clustered; default 8, set to 9999 to disable),
        "min_sub_size": int (drop sub-clusters smaller than this; default 3),
        "min_cluster_size": int (default 3),
        "classify": bool (default true; false skips every per-cluster LLM call),
        "classify_model": str (override the classify model, e.g. "gpt-4o" for
            higher-fidelity comparison runs; defaults to the cheap classifier),
        "state_bind_sim": float (absolute cosine floor for state→focus binding;
            default 0.38, set to 1.1 to disable),
        "state_bind_margin": float (minimum gap best focus must beat runner-up
            by for the bind to take; default 0.10)
      }
    """
    from .services.focus_synthesizer import synthesize
    body = body or {}
    kwargs: dict = {}
    if "include_kinds" in body and body["include_kinds"]:
        kwargs["include_kinds"] = list(body["include_kinds"])
    if "threshold" in body and body["threshold"] is not None:
        kwargs["threshold"] = float(body["threshold"])
    if "merge_threshold" in body and body["merge_threshold"] is not None:
        kwargs["merge_threshold"] = float(body["merge_threshold"])
    if "sub_threshold" in body and body["sub_threshold"] is not None:
        kwargs["sub_threshold"] = float(body["sub_threshold"])
    if "min_parent_for_subcluster" in body and body["min_parent_for_subcluster"] is not None:
        kwargs["min_parent_for_subcluster"] = int(body["min_parent_for_subcluster"])
    if "min_sub_size" in body and body["min_sub_size"] is not None:
        kwargs["min_sub_size"] = int(body["min_sub_size"])
    if "min_cluster_size" in body and body["min_cluster_size"] is not None:
        kwargs["min_cluster_size"] = int(body["min_cluster_size"])
    if "classify" in body and body["classify"] is not None:
        kwargs["classify"] = bool(body["classify"])
    if "classify_model" in body and body["classify_model"]:
        kwargs["classify_model"] = str(body["classify_model"])
    if "state_bind_sim" in body and body["state_bind_sim"] is not None:
        kwargs["state_bind_sim"] = float(body["state_bind_sim"])
    if "state_bind_margin" in body and body["state_bind_margin"] is not None:
        kwargs["state_bind_margin"] = float(body["state_bind_margin"])
    return synthesize(db, **kwargs)


@app.post("/focus-candidates/run")
def focus_candidates_run(body: dict | None = None, db: Session = Depends(get_db)):
    """Run synthesizer → bind clusters to existing Focuses → persist
    the unbound focus-shaped clusters as candidates.

    Binding pass runs FIRST so clusters that match an existing Focus
    don't duplicate as candidates. Updates current_signature +
    evidence + last_seen_in_synth + missed_run_count on the bound
    Focus; flags drift; auto-marks dormant after DORMANCY_THRESHOLD
    consecutive missed runs.

    Same body shape as /focus-synthesis/run. Returns:
      {synth_stats, binding: {bound, dormant_focus_ids,
       newly_drifted_focus_ids}, persisted}
    """
    from .services.focus_synthesizer import synthesize
    from .services import focus_candidate_service
    from .services.focus_service import bind_to_clusters

    body = body or {}
    kwargs: dict = {}
    for key in (
        "include_kinds", "threshold", "merge_threshold", "sub_threshold",
        "min_parent_for_subcluster", "min_sub_size", "min_cluster_size",
        "classify", "classify_model", "state_bind_sim", "state_bind_margin",
    ):
        if key in body and body[key] is not None:
            kwargs[key] = body[key]

    out = synthesize(db, **kwargs)
    binding = bind_to_clusters(db, out)
    persisted = focus_candidate_service.persist_run(db, out)
    return {
        "synth_stats": out["stats"],
        "binding": binding,
        "persisted": persisted,
    }


@app.post("/focuses/{focus_id}/rename")
def focus_rename(
    focus_id: int, body: dict, db: Session = Depends(get_db),
):
    """User-driven rename for a drifted focus. Snaps initial_signature
    to current_signature so future drift re-bases from the new origin;
    clears drift_flagged_at. Body: {text?, endgoal?}.
    """
    from .services.focus_service import rename, serialize_focus
    f = rename(
        db, focus_id,
        text=body.get("text"),
        endgoal=body.get("endgoal"),
    )
    if not f:
        raise HTTPException(404, "focus not found")
    return serialize_focus(f, db=db)


@app.post("/focuses/{focus_id}/fork")
def focus_fork(
    focus_id: int, body: dict, db: Session = Depends(get_db),
):
    """Fork a drifted focus into a new lineage. Old focus is preserved
    with status='evolved'; new Focus inherits current_signature as its
    origin and links back via evolved_from_focus_id. Body:
    {new_text, new_endgoal?}.
    """
    from .services.focus_service import fork, serialize_focus
    new_text = (body.get("new_text") or "").strip()
    if not new_text:
        raise HTTPException(400, "new_text required")
    result = fork(
        db, focus_id,
        new_text=new_text,
        new_endgoal=body.get("new_endgoal"),
    )
    if not result:
        raise HTTPException(404, "focus not found")
    old, new = result
    return {
        "old_focus": serialize_focus(old, db=db),
        "new_focus": serialize_focus(new, db=db),
    }


@app.get("/focuses/{focus_id}")
def focus_get(focus_id: int, db: Session = Depends(get_db)):
    """Single-focus detail — includes the parsed bound-state evidence
    array (snippets of notes/todos/facts/messages currently bound to
    this focus). Heavier than the /focuses list endpoint; used by the
    dashboard drill-down modal.
    """
    from .services.focus_service import serialize_focus
    from .db.models import Focus
    import json as _json
    f = db.query(Focus).filter(Focus.id == focus_id).first()
    if not f:
        raise HTTPException(404, "focus not found")
    payload = serialize_focus(f, db=db)
    evidence: list = []
    if f.current_evidence_json:
        try:
            parsed = _json.loads(f.current_evidence_json)
            if isinstance(parsed, list):
                evidence = parsed
        except Exception:
            pass
    payload["evidence"] = evidence
    return payload


@app.post("/focuses/{focus_id}/reactivate")
def focus_reactivate(focus_id: int, db: Session = Depends(get_db)):
    """Bring a dormant focus back into the active pool. Clears
    missed_run_count + drift flag, sets status='committed'. Idempotent
    on already-active focuses (just resets the counters)."""
    from .services.focus_service import serialize_focus
    from .db.models import Focus
    f = db.query(Focus).filter(Focus.id == focus_id).first()
    if not f:
        raise HTTPException(404, "focus not found")
    f.status = "committed"
    f.committed = True
    f.missed_run_count = 0
    f.drift_flagged_at = None
    db.commit()
    db.refresh(f)
    return serialize_focus(f, db=db)


@app.get("/focus-candidates")
def focus_candidates_list(
    status: str | None = "proposed", db: Session = Depends(get_db)
):
    """List candidates, default filter status='proposed'. Pass
    status='' or status='all' to skip the filter.
    """
    from .services import focus_candidate_service
    filter_status: str | None = status
    if status in ("", "all"):
        filter_status = None
    rows = focus_candidate_service.list_candidates(db, status=filter_status)
    return [focus_candidate_service.serialize_candidate(r) for r in rows]


@app.post("/focus-candidates/{candidate_id}/promote")
def focus_candidates_promote(candidate_id: int, db: Session = Depends(get_db)):
    """Promote a candidate into a real Focus row. Idempotent on a
    candidate already promoted (returns the existing pair). Refuses
    candidates that are dismissed.
    """
    from .services import focus_candidate_service
    result = focus_candidate_service.promote(db, candidate_id)
    if not result:
        raise HTTPException(404, "candidate not found or not promotable")
    cand, focus = result
    return {
        "candidate": focus_candidate_service.serialize_candidate(cand),
        "focus_id": focus.id,
    }


@app.post("/focus-candidates/{candidate_id}/dismiss")
def focus_candidates_dismiss(candidate_id: int, db: Session = Depends(get_db)):
    from .services import focus_candidate_service
    cand = focus_candidate_service.dismiss(db, candidate_id)
    if not cand:
        raise HTTPException(404, "candidate not found or already settled")
    return focus_candidate_service.serialize_candidate(cand)


@app.get("/todos")
def todos_list(db: Session = Depends(get_db)):
    """Open + completed-today todos, grouped. Powers the todo list UI.

    G3.5: bundle now carries `chain_summary` — a per-todo-id map of
    lineage metadata so Surface C (chain indicators ↗N + "from:" line)
    can render without N+1 chain fetches. Shape:
      chain_summary[id] = {
        children_total: int,    # spawned_from edges pointing here
        children_done:  int,    # of which, how many are state=done
        parent_id:      int|null,
        parent_text:    str|null,
      }
    Computed in one query over the edges table; falls back to empty
    map if the query fails (Surface C just won't render indicators).
    """
    from .db.models import Edge, Todo as TodoModel
    from .services.todo_service import todo_service, serialize_todo

    open_rows = todo_service.list_open(db)
    done_today = todo_service.list_done_today(db)
    primary = todo_service.get_primary(db)

    # Pull every spawned_from edge in one shot. The set of todo ids we
    # care about = primary + open + done_today (plus their parents +
    # children — pull lazily via the parent_text lookup below).
    relevant_ids: set[int] = set()
    if primary is not None:
        relevant_ids.add(primary.id)
    for t in open_rows + done_today:
        relevant_ids.add(t.id)

    chain_summary: dict[int, dict] = {}
    try:
        # Edges where any relevant todo is on either side.
        edge_rows = (
            db.query(Edge)
            .filter(Edge.kind == "spawned_from")
            .filter(Edge.src_kind == "todo", Edge.dst_kind == "todo")
            .all()
        )

        # Build child→parent map + parent→children map.
        child_to_parent: dict[int, int] = {}
        parent_to_children: dict[int, list[int]] = {}
        for e in edge_rows:
            child_to_parent[e.src_id] = e.dst_id
            parent_to_children.setdefault(e.dst_id, []).append(e.src_id)

        # Hydrate any todo ids referenced as parent/child that aren't in
        # our visible set — needed for parent_text lookup + child-state
        # counting.
        extra_ids: set[int] = set()
        for cid, pid in child_to_parent.items():
            if cid in relevant_ids:
                extra_ids.add(pid)
        for pid, cids in parent_to_children.items():
            if pid in relevant_ids:
                extra_ids |= set(cids)
        all_ids = relevant_ids | extra_ids
        if all_ids:
            todo_lookup = {
                t.id: t
                for t in db.query(TodoModel)
                .filter(TodoModel.id.in_(all_ids))
                .all()
            }
        else:
            todo_lookup = {}

        for tid in relevant_ids:
            children = parent_to_children.get(tid, [])
            child_total = len(children)
            child_done = sum(
                1
                for cid in children
                if (todo_lookup.get(cid) and todo_lookup[cid].done)
            )
            parent_id = child_to_parent.get(tid)
            parent_text = (
                (todo_lookup.get(parent_id).text or "").strip()
                if parent_id and todo_lookup.get(parent_id)
                else None
            )
            if child_total > 0 or parent_id is not None:
                chain_summary[tid] = {
                    "children_total": child_total,
                    "children_done": child_done,
                    "parent_id": parent_id,
                    "parent_text": parent_text,
                }
    except Exception as e:
        print(f"[todos chain_summary] failed: {e}")
        chain_summary = {}

    return {
        "primary": serialize_todo(primary) if primary else None,
        "open": [serialize_todo(t) for t in open_rows if not t.is_primary],
        "done_today": [serialize_todo(t) for t in done_today],
        "chain_summary": chain_summary,
    }


@app.post("/todos")
def todos_create(body: dict, db: Session = Depends(get_db)):
    """Inline-create a todo. Body: {text, focus_id?, due_date?, subtitle?,
    state?}. The dashboard's "+" button hits this."""
    from .services.todo_service import todo_service, serialize_todo
    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    due_date = _parse_optional_due(body.get("due_date"))
    todo = todo_service.create(
        db,
        text=text_val,
        subtitle=body.get("subtitle"),
        due_date=due_date,
        focus_id=body.get("focus_id"),
        state=(body.get("state") or "not_yet"),
    )
    return serialize_todo(todo)


@app.patch("/todos/{todo_id}")
def todos_update(todo_id: int, body: dict, db: Session = Depends(get_db)):
    from .services.todo_service import todo_service, serialize_todo
    patch: dict = {}
    for key in ("text", "subtitle", "state", "focus_id", "is_primary", "sort_order", "done", "closure_note"):
        if key in body:
            patch[key] = body[key]
    if "due_date" in body:
        patch["due_date"] = _parse_optional_due(body["due_date"])
    try:
        t = todo_service.update(db, todo_id, **patch)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


@app.post("/todos/{todo_id}/cycle")
def todos_cycle(todo_id: int, db: Session = Depends(get_db)):
    """Two-click checkbox handler. Cycles state forward:
       not_yet → doing → done. From `done`, the FE opens a state-picker
       modal; cycle still bounces to not_yet for programmatic safety."""
    from .services.todo_service import todo_service, serialize_todo
    t = todo_service.cycle_state(db, todo_id)
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


@app.delete("/todos/{todo_id}")
def todos_delete(todo_id: int, db: Session = Depends(get_db)):
    """Soft-delete (G1). Stamps deleted_at; the row stays for 24h so
    `POST /todos/{id}/undelete` can restore. Hard-purge happens via the
    lifespan sweeper.
    """
    from .services.todo_service import todo_service
    if not todo_service.delete(db, todo_id):
        raise HTTPException(status_code=404, detail="todo not found")
    return {"ok": True, "soft_deleted": True}


@app.post("/todos/{todo_id}/undelete")
def todos_undelete(todo_id: int, db: Session = Depends(get_db)):
    """Reverse a soft-delete within the 24h window. 404 if row doesn't
    exist or wasn't deleted. 410 if the undo window has expired."""
    from .services.todo_service import todo_service, serialize_todo, SOFT_DELETE_TTL_HOURS
    t = todo_service.undelete(db, todo_id)
    if t is None:
        # Distinguish "no such tombstone" from "window expired" for the
        # caller — the latter is a 410 (gone) per HTTP semantics.
        raw = todo_service.get(db, todo_id, include_deleted=True)
        if raw is None:
            raise HTTPException(status_code=404, detail="todo not found")
        if raw.deleted_at is None:
            raise HTTPException(status_code=409, detail="todo is not deleted")
        raise HTTPException(
            status_code=410,
            detail=f"undo window expired ({SOFT_DELETE_TTL_HOURS}h)",
        )
    return serialize_todo(t)


@app.post("/todos/bulk-delete")
def todos_bulk_delete(payload: dict, db: Session = Depends(get_db)):
    """Soft-delete N todos in one call. Body: { ids: [int] }. Returns the
    ids actually soft-deleted (skips missing or already-deleted rows)."""
    from .services.todo_service import todo_service
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list):
        raise HTTPException(status_code=400, detail="ids must be a list of int")
    try:
        ids = [int(i) for i in raw_ids]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="ids must be a list of int")
    deleted = todo_service.bulk_soft_delete(db, ids)
    return {"deleted_ids": deleted, "count": len(deleted)}


@app.post("/todos/merge")
def todos_merge(payload: dict, db: Session = Depends(get_db)):
    """Merge N todos into one. Body: { primary_id: int, merged_ids: [int] }.
    Concats merged.text into primary.subtitle (newline-joined, `+ ` prefix),
    soft-deletes the merged rows. Primary's text is left alone."""
    from .services.todo_service import todo_service, serialize_todo
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid body")
    try:
        primary_id = int(payload.get("primary_id"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="primary_id required")
    raw_merged = payload.get("merged_ids") or []
    if not isinstance(raw_merged, list):
        raise HTTPException(status_code=400, detail="merged_ids must be a list")
    try:
        merged_ids = [int(i) for i in raw_merged]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="merged_ids must be int list")
    primary = todo_service.merge(db, primary_id, merged_ids)
    if primary is None:
        raise HTTPException(status_code=404, detail="primary todo not found")
    return serialize_todo(primary)


@app.post("/todos/{todo_id}/promote-to-primary")
def todos_promote_primary(todo_id: int, db: Session = Depends(get_db)):
    """Singleton: clears any other primary, sets this one. Idempotent."""
    from .services.todo_service import todo_service, serialize_todo
    t = todo_service.update(db, todo_id, is_primary=True)
    if t is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return serialize_todo(t)


# ── G3.5 Todo Continuity — close-with-outcome + chain + retroactive link ──────


@app.post("/todos/{todo_id}/close")
def todos_close(todo_id: int, payload: dict = Body(default={}), db: Session = Depends(get_db)):
    """Close a todo with optional outcome + spawned follow-ups.

    Body:
      closure_note: optional str — short outcome text
      spawned:      optional list of {text, due_hint?, subtitle?}

    Single transaction. Each spawned entry becomes a new Todo with a
    `spawned_from` edge pointing back to todo_id. Children inherit the
    parent's focus_id so chains stay within the same focus context.

    Returns:
      {"parent": serialized, "spawned": [serialized, ...], "edges": [id, ...]}
    """
    from .services.todo_service import todo_service

    closure_note = payload.get("closure_note") if isinstance(payload, dict) else None
    spawned = payload.get("spawned") if isinstance(payload, dict) else None
    if spawned is not None and not isinstance(spawned, list):
        raise HTTPException(status_code=400, detail="spawned must be a list")

    result = todo_service.close_with_outcome(
        db,
        todo_id,
        closure_note=closure_note if isinstance(closure_note, str) else None,
        spawned=spawned,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return result


@app.get("/todos/{todo_id}/chain")
def todos_chain(
    todo_id: int,
    max_depth: int = 10,
    db: Session = Depends(get_db),
):
    """Walk the lineage graph centered on this todo. Returns ancestors +
    descendants + self in serialized form. Soft-deleted nodes included
    (chain history matters even when killed); caller decides render."""
    from .services.todo_service import todo_service

    max_depth = max(1, min(int(max_depth or 10), 20))
    chain = todo_service.get_chain(db, todo_id, max_depth=max_depth)
    if chain is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return chain


@app.post("/todos/{todo_id}/link-parent")
def todos_link_parent(
    todo_id: int,
    payload: dict = Body(default={}),
    db: Session = Depends(get_db),
):
    """Wire a `spawned_from` edge from todo_id (child) → parent_id (ancestor).
    Idempotent. Used by retroactive-linking UI."""
    from .services.todo_service import todo_service

    parent_id = payload.get("parent_id") if isinstance(payload, dict) else None
    if not isinstance(parent_id, int):
        raise HTTPException(status_code=400, detail="parent_id required")
    ok = todo_service.add_parent(db, todo_id, parent_id)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="invalid parent_id, same-as-child, or todo missing",
        )
    return {"ok": True, "child_id": todo_id, "parent_id": parent_id}


@app.delete("/todos/{todo_id}/parents/{parent_id}")
def todos_unlink_parent(
    todo_id: int,
    parent_id: int,
    db: Session = Depends(get_db),
):
    """Drop the spawned_from edge between child and parent. Returns count
    deleted (0 or 1)."""
    from .services.todo_service import todo_service

    deleted = todo_service.remove_parent(db, todo_id, parent_id)
    return {"deleted": deleted}


@app.get("/todos/search")
def todos_search(
    q: str,
    limit: int = 10,
    include_done: bool = True,
    db: Session = Depends(get_db),
):
    """Fuzzy substring search for retroactive linking. Returns up to
    `limit` open + done todos (excluding soft-deleted). Used by the
    Surface D link-search UI."""
    from .services.todo_service import todo_service, serialize_todo

    limit = max(1, min(int(limit or 10), 50))
    rows = todo_service.search(
        db, q, limit=limit, include_done=include_done
    )
    return {"matches": [serialize_todo(t) for t in rows]}


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


_VALID_STATUS = {"committed", "someday"}
_VALID_SCALE = {"quick", "slow"}


def _parse_optional_dt(raw):
    """ISO datetime parser used for start_at / end_at — same shape as
    _parse_optional_due but explicit so the validation error stays scoped."""
    from datetime import datetime as _dt
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="invalid datetime")
    cleaned = raw[:-1] if raw.endswith("Z") else raw
    try:
        return _dt.fromisoformat(cleaned)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid datetime")


def _validate_health(raw):
    if raw is None or raw == "":
        return None
    try:
        v = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="health must be an integer 0..100")
    if v < 0 or v > 100:
        raise HTTPException(status_code=400, detail="health must be 0..100")
    return v


def _validate_status(raw):
    if raw is None or raw == "":
        return None
    if raw not in _VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_VALID_STATUS)}")
    return raw


def _validate_scale(raw):
    if raw is None or raw == "":
        return None
    if raw not in _VALID_SCALE:
        raise HTTPException(status_code=400, detail=f"scale must be one of {sorted(_VALID_SCALE)}")
    return raw


@app.get("/items")
def items_tree(
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Tree: focuses (top-level w/ endgoal) + inbox (top-level todos), each
    with nested children + per-node progress + stale flag.

    Pagination is at the *root* level. `limit` (clamped to [1, 200], default
    50) caps how many top-level focuses + how many top-level todos are
    returned. Each surviving root keeps its full subtree intact, so
    rendering progress + stale flags stays accurate.

    Response carries `total_focuses` / `total_inbox` so the frontend can
    decide whether to show a "Load more" affordance. Default limit (50)
    is well above the typical user's count today; this is mostly a guard
    against the response payload growing without bound as the data scales.
    """
    return item_service.list_tree(db, limit=limit, offset=offset)


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
    status = _validate_status(body.get("status"))
    scale = _validate_scale(body.get("scale"))
    is_primary = bool(body.get("is_primary", False))
    health = _validate_health(body.get("health"))
    confidence = _validate_health(body.get("confidence"))  # same 0..100 shape
    start_at = _parse_optional_dt(body.get("start_at"))
    end_at = _parse_optional_dt(body.get("end_at"))
    try:
        item = item_service.create(
            db,
            text=text_val,
            parent_id=int(parent_id) if parent_id is not None else None,
            endgoal=endgoal,
            committed=committed,
            due_date=due_date,
            source_note_id=body.get("source_note_id"),
            status=status,
            scale=scale,
            health=health,
            confidence=confidence,
            start_at=start_at,
            end_at=end_at,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # is_primary is a singleton-toggle, handled in update() (which clears
    # any other primary). Apply post-create when requested.
    if is_primary:
        item = item_service.update(db, item.id, is_primary=True) or item
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
    if "state" in body:
        # Todo state enum (not_yet | doing | done). Reaches Todo via the
        # item_service facade → todo_service.update which keeps `done`
        # in sync + auto-clears is_primary on completion.
        patch["state"] = body["state"]
    if "focus_id" in body:
        patch["focus_id"] = (
            int(body["focus_id"]) if body["focus_id"] is not None else None
        )
    if "color" in body:
        patch["color"] = body["color"] or None
    if "status" in body:
        patch["status"] = _validate_status(body["status"])
    if "scale" in body:
        patch["scale"] = _validate_scale(body["scale"])
    if "health" in body:
        patch["health"] = _validate_health(body["health"])
    if "confidence" in body:
        patch["confidence"] = _validate_health(body["confidence"])
    if "start_at" in body:
        patch["start_at"] = _parse_optional_dt(body["start_at"])
    if "end_at" in body:
        patch["end_at"] = _parse_optional_dt(body["end_at"])
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


# ── Focus ↔ Todo links ─────────────────────────────────────────────────
# After the dashboard revamp, a todo links to at most ONE focus via
# todos.focus_id (the legacy focus_todo_links M2M table is gone). These
# routes keep their /items/* paths for backward compatibility but the
# semantics narrowed: derive = create todo with focus_id set; link =
# update focus_id; unlink = clear focus_id.


@app.get("/items/{todo_id}/focuses")
def items_get_focuses_for_todo(todo_id: int, db: Session = Depends(get_db)):
    """Return the focus linked to this todo (0 or 1 element). Kept as a
    list shape for back-compat with callers that expect the old M2M
    response."""
    from .services.todo_service import todo_service
    from .services.focus_service import focus_service
    todo = todo_service.get(db, todo_id)
    if not todo or not todo.focus_id:
        return []
    f = focus_service.get(db, todo.focus_id)
    if not f:
        return []
    return [{"id": f.id, "text": f.text, "color": f.color}]


@app.get("/items/{focus_id}/todos")
def items_get_todos_for_focus(focus_id: int, db: Session = Depends(get_db)):
    """Return the todos linked to a given focus."""
    from .services.focus_service import focus_service
    from .services.todo_service import serialize_todo
    todos = focus_service.linked_todos(db, focus_id)
    return [serialize_todo(t) for t in todos]


@app.post("/items/{focus_id}/derive-todo")
def items_derive_todo(focus_id: int, body: dict, db: Session = Depends(get_db)):
    """Create a leaf todo with focus_id set to this focus.

    Body: {"text": str, "due_date"?: iso8601 | "today" | "tomorrow"}.
    Returns {"todo": serialized_todo}.
    """
    from .services.focus_service import focus_service
    from .services.todo_service import todo_service, serialize_todo

    focus = focus_service.get(db, focus_id)
    if not focus:
        raise HTTPException(status_code=404, detail="focus not found")

    text_val = (body.get("text") or "").strip()
    if not text_val:
        raise HTTPException(status_code=400, detail="text required")
    due_date = _parse_optional_due(body.get("due_date"))

    todo = todo_service.create(db, text=text_val, due_date=due_date, focus_id=focus.id)
    return {"todo": serialize_todo(todo)}


@app.post("/items/{focus_id}/link-todo/{todo_id}")
def items_link_existing_todo(focus_id: int, todo_id: int, db: Session = Depends(get_db)):
    """Set the todo's focus_id to this focus. Idempotent — re-linking
    the same pair is a no-op."""
    from .services.focus_service import focus_service
    from .services.todo_service import todo_service

    focus = focus_service.get(db, focus_id)
    todo = todo_service.get(db, todo_id)
    if not focus or not todo:
        raise HTTPException(status_code=404, detail="focus or todo not found")
    if todo.focus_id == focus_id:
        return {"linked": True, "created": False}
    todo_service.update(db, todo_id, focus_id=focus_id)
    return {"linked": True, "created": True}


@app.get("/items/today-todos")
def items_today_todos(db: Session = Depends(get_db)):
    """Open todos due today + their linked-focus chips. Powers the
    dashboard's Today's todos section."""
    from .services.todo_service import todo_service
    return todo_service.today(db)


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
    _raw, segments = result
    # Multi-bubble cadence: each segment goes out as its own iMessage with a
    # short delay so the reply feels like texting, not bot dump.
    for idx, segment in enumerate(segments):
        if idx > 0:
            time.sleep(0.6)
        imessage_channel.send(handle, segment)
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


def _wa_claim_msg_id(wamid: str, db: Session) -> bool:
    """Atomic first-write claim on a Meta-issued message id.

    Returns True if THIS handler invocation owns the message (insert succeeded);
    False if another delivery (a Meta retry, or a parallel webhook arrival)
    already claimed it. UNIQUE on `wa_processed_ids.wamid` is the race boundary
    — IntegrityError = lost the race = treat as duplicate.
    """
    if not wamid:
        return True  # malformed payload; let downstream skip on missing fields
    db.add(WaProcessedId(wamid=wamid))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _process_wa_message(sender: str, body: str) -> None:
    """Run the inbound WhatsApp message through the orchestrator + send replies.

    Spawned via BackgroundTasks so the HTTP handler can 200-ack Meta inside
    their (~20s) redelivery window even when the chat turn takes 30s+. Owns
    its own SessionLocal — the request-scoped session is gone by the time
    this runs.
    """
    bg_db = SessionLocal()
    try:
        result = dispatch_inbound(whatsapp_channel, sender, body, bg_db)
        if result is None:
            return  # not allowlisted; silent drop
        _raw, segments = result
        for idx, segment in enumerate(segments):
            if idx > 0:
                time.sleep(0.6)
            try:
                whatsapp_channel.send(sender, segment)
            except Exception as e:
                print(f"[wa] send failed for {sender}: {e}")
    except Exception as e:
        print(f"[wa] orchestrator failed for {sender}: {e}")
    finally:
        bg_db.close()


@app.post("/webhooks/whatsapp")
async def whatsapp_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    db: Session = Depends(get_db),
):
    """Receive a WhatsApp Cloud API event.

    Meta delivers two kinds of events under `entry[].changes[].value`:
      - `messages`  — actual user-sent text/media (what we care about)
      - `statuses`  — delivery/read receipts for messages WE sent (ignore;
                      otherwise every reply triggers an echo and we'd loop)

    Two layers protect against double-processing:
      1. `_wa_claim_msg_id` — Meta redelivers any webhook we don't 200-ack
         within ~20s; one orchestrator turn often blows past that. The claim
         table is a UNIQUE(wamid) PK so a retry hits IntegrityError and we
         skip. This is the load-bearing one.
      2. `BackgroundTasks` — pushes the (slow) dispatch + send out of the
         request lifecycle so we return 200 fast and Meta stops retrying.

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
    queued = 0
    duplicates = 0
    for entry in entries:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            messages = value.get("messages") or []
            if not messages:
                continue  # status update or other non-message event
            for msg in messages:
                if msg.get("type") != "text":
                    continue  # v1: text only
                wamid = msg.get("id") or ""
                sender = msg.get("from") or ""
                body = (msg.get("text") or {}).get("body") or ""
                if not sender or not body:
                    continue
                if not _wa_claim_msg_id(wamid, db):
                    duplicates += 1
                    continue
                background_tasks.add_task(_process_wa_message, sender, body)
                queued += 1
    return {"ok": True, "queued": queued, "duplicates": duplicates}


# ── Settings (daily nudge config) ──────────────────────────────────────────────


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


@app.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _serialize_settings(_settings_row(db))


@app.patch("/settings")
def patch_settings(body: dict, db: Session = Depends(get_db)):
    s = _settings_row(db)
    if "nudge_enabled" in body:
        s.nudge_enabled = bool(body["nudge_enabled"])
    if "nudge_hour" in body:
        h = int(body["nudge_hour"])
        if not 0 <= h <= 23:
            raise HTTPException(status_code=400, detail="nudge_hour must be 0-23")
        s.nudge_hour = h
    if "nudge_minute" in body:
        m = int(body["nudge_minute"])
        if not 0 <= m <= 59:
            raise HTTPException(status_code=400, detail="nudge_minute must be 0-59")
        s.nudge_minute = m
    if "nudge_tz" in body:
        tz = (body["nudge_tz"] or "").strip()
        # Validate via zoneinfo so we fail fast on typos rather than at next fire.
        if ZoneInfo is not None:
            try:
                ZoneInfo(tz)
            except Exception:
                raise HTTPException(status_code=400, detail=f"unknown timezone: {tz!r}")
        s.nudge_tz = tz
    if "nudge_channels" in body:
        chans = body["nudge_channels"]
        if not isinstance(chans, list) or not all(isinstance(c, str) for c in chans):
            raise HTTPException(status_code=400, detail="nudge_channels must be list[str]")
        valid = {"telegram", "whatsapp"}
        bad = [c for c in chans if c not in valid]
        if bad:
            raise HTTPException(status_code=400, detail=f"unknown channel(s): {bad}")
        s.nudge_channels = json.dumps(chans)
    if "nudge_prompt" in body:
        # No length cap server-side — Daniel writes whatever instruction he
        # wants and the LLM cost scales with it. Empty string == use default.
        s.nudge_prompt = (body["nudge_prompt"] or "").strip()
    db.commit()
    db.refresh(s)
    return _serialize_settings(s)


@app.get("/settings/nudge-prompt-default")
def get_nudge_prompt_default():
    """Returns the bundled default digest prompt so the UI's "Use default"
    button doesn't have to mirror the string client-side."""
    return {"prompt": NUDGE_DEFAULT_PROMPT}


@app.post("/settings/test-nudge")
async def test_nudge():
    """Fire the nudge immediately, bypassing the same-day idempotency guard.
    Returns the report from the fan-out so the UI can show what landed."""
    return await _fire_nudge_once(force=True)


# ── Spaces ────────────────────────────────────────────────────────────────────


def _serialize_space(s: Space) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "emoji": s.emoji,
        "is_pinned": bool(s.is_pinned),
        "description": s.description,
        "cover_image_url": s.cover_image_url,
    }


@app.get("/spaces")
def get_spaces(db: Session = Depends(get_db)):
    # Pinned spaces sort to the top — within each pinned/un-pinned group,
    # keep the historical id-asc order so existing sidebar muscle memory
    # stays intact.
    spaces = (
        db.query(Space)
        .order_by(Space.is_pinned.desc(), Space.id.asc())
        .all()
    )
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
    if "is_pinned" in body:
        space.is_pinned = bool(body["is_pinned"])
    if "description" in body:
        # Trim trailing whitespace; collapse empty-string to NULL so the
        # serializer reports `null` instead of "" (saves the frontend a
        # special-case check for "is this really set?").
        desc = body["description"]
        space.description = (desc or "").strip() or None
    if "cover_image_url" in body:
        url = body["cover_image_url"]
        space.cover_image_url = (url or "").strip() or None
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


@app.get("/spaces/{space_id}/stats")
def get_space_stats(space_id: int, db: Session = Depends(get_db)):
    """Lightweight stats for a space's header — note count, most-recent
    touch, top-3 tags. One query per metric, all unindexed columns are
    fine at our note volume."""
    from sqlalchemy import func as sqlfunc

    space = db.query(Space).filter(Space.id == space_id).first()
    if not space:
        raise HTTPException(status_code=404, detail="Space not found")
    note_count = (
        db.query(sqlfunc.count(Note.id))
        .filter(Note.space_id == space_id)
        .scalar()
    ) or 0
    last_touched = (
        db.query(
            sqlfunc.max(
                sqlfunc.coalesce(Note.updated_at, Note.last_opened_at, Note.created_at)
            )
        )
        .filter(Note.space_id == space_id)
        .scalar()
    )
    # Top-3 tags by frequency — read raw `tags` JSON-text and tally. Note
    # cardinality per space stays small enough that we don't need a
    # materialized rollup table; a Python tally is fine.
    tag_rows = (
        db.query(Note.tags)
        .filter(Note.space_id == space_id, Note.tags.is_not(None))
        .all()
    )
    counts: dict[str, int] = {}
    for (raw,) in tag_rows:
        for t in _parse_tags(raw):
            counts[t] = counts.get(t, 0) + 1
    top_tags = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {
        "space_id": space_id,
        "note_count": note_count,
        "last_touched": last_touched.isoformat() if last_touched else None,
        "top_tags": [{"tag": t, "count": c} for t, c in top_tags],
    }


# ── Notes ─────────────────────────────────────────────────────────────────────


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
    return [_serialize_note_lite(n) for n in notes]


@app.get("/notes/recent")
def get_recent_notes(limit: int = 5, db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .order_by(_notes_order())
        .limit(limit)
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@app.post("/spaces/{space_id}/notes")
def create_space_note(space_id: str, body: dict, db: Session = Depends(get_db)):
    from datetime import datetime

    numeric_id = None if space_id == "general" else int(space_id)
    initial_content = body.get("content") or ""
    initial_tags = _normalize_tags(body.get("tags") or [])
    # G3 publish ceremony: every new note enters as a draft (Confluence
    # pattern). The Publish action — POST /notes/{id}/publish — is the
    # explicit transition from draft → published, where the user picks
    # public or private. Callers can still pass is_draft=False to bypass
    # the ceremony for programmatic creates (eval seed, MCP add_note).
    note = Note(
        title=body.get("title") or "",
        content=initial_content,
        excerpt=_excerpt_from_html(initial_content),
        space_id=numeric_id,
        is_draft=bool(body.get("is_draft", True)),
        is_pinned=bool(body.get("is_pinned", False)),
        tags=json.dumps(initial_tags) if initial_tags else None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    # G3 Note→Focus binding: embed title + first 500 chars of HTML-stripped
    # content, cosine-match active focuses, wire `supports` edge if it
    # clears the floor. Skipped when title + content are empty.
    try:
        from .services import focus_binding
        from .services.list_service import list_service
        text_seed = (note.title or "").strip()
        body_text = _excerpt_from_html(initial_content, limit=500) or ""
        if body_text:
            text_seed = f"{text_seed} {body_text}".strip()
        if text_seed:
            emb = list_service._embed_item_text(text_seed)
            if emb:
                focus_binding.bind_to_focus(
                    db, src_kind="note", src_id=note.id, embedding=emb
                )
    except Exception as e:
        print(f"[create_space_note] note→focus bind failed: {e}")

    return _serialize_note(note)


@app.post("/notes/{note_id}/publish")
def publish_note(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Promote a draft to published. Body: { visibility: "public"|"private" }.
    Confluence-style ceremony — replaces the old globe-icon instant flip
    that was too easy to misclick. Idempotent on already-published notes
    (the visibility flag still applies).
    """
    from datetime import datetime
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return {"error": "note not found"}, 404
    visibility = (body.get("visibility") or "private").lower()
    if visibility not in ("public", "private"):
        return {"error": "visibility must be 'public' or 'private'"}, 400
    note.is_draft = False
    note.is_public = visibility == "public"
    note.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.post("/notes/{note_id}/unpublish")
def unpublish_note(note_id: int, db: Session = Depends(get_db)):
    """Revert a published note back to draft state. Pulls it off the
    public site (if it was public) AND flags it as a draft again.
    """
    from datetime import datetime
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        return {"error": "note not found"}, 404
    note.is_draft = True
    note.is_public = False
    note.updated_at = datetime.utcnow()
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

    # Track whether title/content ACTUALLY differ from what's on disk. The
    # frontend's save-on-leave path PATCHes unconditionally to avoid losing
    # races (see NoteEditor's save-on-leave comment), so plenty of these
    # PATCHes carry identical values. Bumping updated_at on those would
    # promote the note to the top of the list every time it's opened —
    # that's the "no edits, but movement" bug. Only bump when something
    # actually changed.
    title_changed = False
    content_changed = False

    if "title" in body:
        new_title = body["title"]
        if (new_title or None) != (note.title or None):
            title_changed = True
        note.title = new_title
    if "content" in body:
        # Safety net for the empty-overwrite bug class (a frontend race or a
        # silently-failed request could otherwise wipe a populated note). Refuse
        # to replace non-trivial existing content with VISUALLY-empty content
        # unless the caller opts in via {"force": true}. Returns 409 so the
        # frontend can surface it in the save-status pill instead of pretending
        # the write succeeded. Title/space/visibility patches still apply.
        #
        # Visual emptiness (NOT byte emptiness): TipTap serializes a freshly-
        # cleared editor as `<p></p>` (7 bytes). The original guard used
        # `.strip()` on the raw HTML, which let `<p></p>` through and let
        # the editor wipe a populated note silently — the bug Daniel hit on
        # note 248. Strip HTML tags + common entity stand-ins before the
        # emptiness check so the guard catches every flavour of "user sees
        # nothing on screen."
        new_content = body["content"]
        prev_visible = _strip_html_to_visible_text(note.content or "")
        new_visible = _strip_html_to_visible_text(new_content) if isinstance(new_content, str) else ""
        force = bool(body.get("force"))
        if prev_visible and not new_visible and not force:
            raise HTTPException(
                status_code=409,
                detail=(
                    "refusing to overwrite non-empty note content with empty "
                    "content; pass force=true to override"
                ),
            )
        if (new_content or None) != (note.content or None):
            content_changed = True
        note.content = new_content
        # Refresh cached excerpt alongside content so list endpoints stay
        # in sync without a round-trip through the regex stripper.
        note.excerpt = _excerpt_from_html(new_content)
    if title_changed or content_changed:
        note.updated_at = datetime.utcnow()
    if "space_id" in body:
        sid = body["space_id"]
        note.space_id = None if (sid is None or sid == "general") else int(sid)
    if "is_public" in body:
        new_public = bool(body["is_public"])
        note.is_public = new_public
        # Publishing graduates the note out of draft state — once it ships,
        # the "intent to publish" flag is satisfied. User can re-mark it draft
        # explicitly if they pull it back for edits.
        if new_public:
            note.is_draft = False
    if "is_pinned" in body:
        note.is_pinned = bool(body["is_pinned"])
    if "is_public_pinned" in body:
        note.is_public_pinned = bool(body["is_public_pinned"])
    if "is_draft" in body:
        note.is_draft = bool(body["is_draft"])
    if "status" in body:
        new_status = body.get("status")
        if new_status not in ("unprocessed", "graduated", "archived"):
            raise HTTPException(
                status_code=400,
                detail="status must be unprocessed|graduated|archived",
            )
        note.status = new_status
    if "tags" in body:
        normalized = _normalize_tags(body["tags"])
        note.tags = json.dumps(normalized) if normalized else None
    if "icon" in body:
        raw_icon = body.get("icon")
        if raw_icon is None or raw_icon == "":
            note.icon = None
        elif isinstance(raw_icon, str) and len(raw_icon) <= 64:
            note.icon = raw_icon
        else:
            raise HTTPException(status_code=400, detail="icon must be string ≤64 chars or null")
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@app.post("/notes/{note_id}/extract")
def extract_to_child_note(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Carve a selection out of a parent note into a brand-new child note.

    Returns the new child note. The frontend is responsible for replacing
    the selected text in the parent's editor with a `noteLink` chip pointing
    to `child.id` and saving the updated parent. We don't mutate the parent
    here — the editor already has the in-memory state and a single PATCH
    round-trip after this avoids a content-conflict if the user kept typing.
    """
    from datetime import datetime

    parent = db.query(Note).filter(Note.id == note_id).first()
    if not parent:
        raise HTTPException(status_code=404, detail="parent note not found")
    selected_html = body.get("selected_html") or ""
    if not selected_html.strip():
        raise HTTPException(status_code=400, detail="selected_html required")
    title = (body.get("title") or "").strip() or None
    # Anchor label = first ~40 chars of plain text from the selection. The
    # editor renders this on the chip; backend just stashes it for callers
    # that need it without parsing the child's HTML.
    plain = re.sub(r"<[^>]+>", " ", selected_html).strip()
    anchor = plain[:40].strip() if plain else None

    # Dedup window: if the same parent already produced a child with this
    # exact HTML in the last 30 seconds, return that child instead of
    # creating a duplicate. Protects against the click-spam Daniel hit in
    # PR #244 (latency + no loading state → flood of POSTs → 4 junk
    # children). Idempotency on (parent_id, content). 30s is generous —
    # long enough to swallow the worst latency spike, short enough that
    # an intentional re-extract of the same paragraph an hour later still
    # creates a fresh child.
    from datetime import timedelta as _td
    cutoff = datetime.utcnow() - _td(seconds=30)
    existing = (
        db.query(Note)
        .filter(
            Note.parent_note_id == parent.id,
            Note.content == selected_html,
            Note.created_at >= cutoff,
        )
        .order_by(Note.created_at.desc())
        .first()
    )
    if existing is not None:
        return _serialize_note(existing)

    child = Note(
        title=title,
        content=selected_html,
        excerpt=_excerpt_from_html(selected_html),
        space_id=parent.space_id,
        parent_note_id=parent.id,
        excerpt_anchor=anchor,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(child)
    db.commit()
    db.refresh(child)
    return _serialize_note(child)


@app.get("/notes/{note_id}/children")
def get_note_children(note_id: int, db: Session = Depends(get_db)):
    """Direct children of `note_id` (notes whose parent_note_id points here).
    Powers the related-notes panel + the chip-target preview."""
    children = (
        db.query(Note)
        .filter(Note.parent_note_id == note_id)
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in children]


@app.get("/notes/pinned")
def get_pinned_notes(db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .filter(Note.is_pinned == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@app.get("/notes/drafts")
def get_draft_notes(db: Session = Depends(get_db)):
    notes = (
        db.query(Note)
        .filter(Note.is_draft == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@app.get("/notes/unprocessed")
def get_unprocessed_notes(db: Session = Depends(get_db)):
    """Notes captured but not yet graduated into Promise/Todo/Habit/Focus.

    Drives the "Unprocessed" sidebar view — Daniel's triage queue for
    captured thought that hasn't taken shape yet. The synthesizer reads
    the same filter to surface focus candidates from cluster patterns
    in this set (see focus_synthesizer note-graduation path).
    """
    notes = (
        db.query(Note)
        .filter(Note.status == "unprocessed")
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


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

    # Tuple query — only the columns the graph builder needs, so we don't
    # hydrate the deferred classified_embedding or any other Note columns
    # (and we still get content for word_count). 6MB notes (cf. PR-#134
    # postmortem) make this materially cheaper than .query(Note).all().
    notes = (
        db.query(Note.id, Note.title, Note.content, Note.embedding, Note.space_id)
        .filter(Note.embedding.isnot(None))
        .all()
    )

    # Parse embeddings + build node metadata.
    vectors: list[list[float]] = []
    nodes: list[dict] = []
    for nid, ntitle, ncontent, nemb, nspace in notes:
        try:
            v = json.loads(nemb)
            if not isinstance(v, list) or not v:
                continue
        except (ValueError, TypeError):
            continue
        # Word count for node size — strip HTML first.
        raw = (ntitle or "") + " " + (ncontent or "")
        raw = _re.sub(r"<[^>]+>", " ", raw)
        words = [w for w in raw.split() if w.strip()]
        word_count = len(words)
        vectors.append(v)
        nodes.append({
            "id": nid,
            "title": (ntitle or "").strip() or "(untitled)",
            "size": round(math.log2(word_count + 2), 3),
            "space_id": nspace,
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
def cleanup_empty_notes(dry_run: bool = False, db: Session = Depends(get_db)):
    """Delete notes with no real content. "Real content" = any plaintext
    >= 6 chars after stripping HTML, OR any embedded media (img/video/iframe).
    Pinned notes are always preserved (explicit user intent). Empty drafts
    are NOT preserved.

    The image carve-out matters because a note that's just a pasted
    screenshot strips down to "" plaintext under the old rule and would
    have been swept. Media tags count as content even though they don't
    contribute characters.
    """
    import re

    media_re = re.compile(r"<(img|video|iframe|figure)\b", re.IGNORECASE)
    tag_strip_re = re.compile(r"<[^>]+>")
    ws_re = re.compile(r"\s+")

    def _has_real_content(html: str | None) -> bool:
        if not html:
            return False
        if media_re.search(html):
            return True
        text_only = ws_re.sub(" ", tag_strip_re.sub(" ", html)).strip()
        return len(text_only) >= 6

    non_pinned = (
        db.query(Note)
        .filter((Note.is_pinned == False) | (Note.is_pinned.is_(None)))  # noqa: E712
        .all()
    )
    pinned_empty = (
        db.query(Note)
        .filter(Note.is_pinned == True)  # noqa: E712
        .all()
    )
    deleted_ids = []
    for n in non_pinned:
        if not _has_real_content(n.content):
            deleted_ids.append(n.id)
            if not dry_run:
                db.delete(n)
    preserved_pinned_empty = sum(
        1 for n in pinned_empty if not _has_real_content(n.content)
    )
    if not dry_run:
        db.commit()
    return {
        "deleted": len(deleted_ids),
        "ids": deleted_ids,
        "preserved_pinned_empty": preserved_pinned_empty,
        "dry_run": dry_run,
    }


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


@app.post("/notes/{note_id}/auto-title")
async def auto_title_note(note_id: int, db: Session = Depends(get_db)):
    """Generate + save a short title for a note when Daniel hasn't named it.
    Uses gpt-4o-mini (`llm_client.generate_title`). Idempotent on the
    backend — repeat calls overwrite — but the frontend gates on a
    placeholder title so we don't clobber user-typed titles.
    Returns the new title or the existing one if the note is too short.
    """
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    plaintext = note_service._strip_html(note.content or "").strip()
    # Below ~40 chars there isn't enough signal — return existing title.
    if len(plaintext) < 40:
        return {"title": note.title or "", "generated": False}

    title = await llm_client.generate_title(plaintext[:1500])
    title = (title or "").strip().strip('"').strip("'")
    if not title:
        return {"title": note.title or "", "generated": False}

    note.title = title
    db.commit()
    return {"title": title, "generated": True}


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
    from datetime import datetime

    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    # Sweep parent notes for any NoteLink chip pointing at this id and
    # replace it with its label as plain text — otherwise the parent
    # carries a dead chip that 404s when Daniel clicks it.
    # The chip HTML shape is:
    #   <a data-note-link="true" data-note-id="<id>" data-label="<label>"
    #      class="gooni-note-link" href="#" target="_self">label</a>
    # We match by `data-note-id="<id>"` to avoid touching unrelated chips.
    # Regex is the lightest tool — DOM parsing in BS4 here would add a
    # ~50ms tax on a high-traffic route, and the chip syntax is stable.
    pattern = re.compile(
        r'<a\b[^>]*\bdata-note-link="true"[^>]*\bdata-note-id="'
        + str(note.id)
        + r'"[^>]*>(.*?)</a>',
        flags=re.DOTALL | re.IGNORECASE,
    )
    affected_parents = (
        db.query(Note)
        .filter(Note.content.like(f'%data-note-id="{note.id}"%'))
        .all()
    )
    for p in affected_parents:
        if not p.content:
            continue
        # Replace the chip with its inner text. We could also pull the
        # data-label attr; the inner text is identical post-#renderHTML so
        # it's the same string either way.
        rewritten = pattern.sub(lambda m: m.group(1), p.content)
        if rewritten != p.content:
            p.content = rewritten
            p.excerpt = _excerpt_from_html(rewritten)
            p.updated_at = datetime.utcnow()
    db.delete(note)
    db.commit()
    return {"ok": True, "orphan_links_rewritten": len(affected_parents)}


@app.get("/notes/{note_id}/memories")
def get_note_memories(note_id: int, limit: int = 6, db: Session = Depends(get_db)):
    """Memories linked to this note (extracted via memorize). Used by the
    editor's Memories pill section so Daniel sees what the note contributed."""
    from .db.models import Memory
    rows = (
        db.query(Memory)
        .filter(Memory.source_note_id == note_id, Memory.is_active == True)  # noqa: E712
        .order_by(Memory.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_memory_to_dashboard(m) for m in rows]


# ── Promises ───────────────────────────────────────────────────────────────


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


@app.get("/promises")
def list_promises(
    state: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List promises. Default returns the most recent N regardless of state
    so the dashboard drawer can show history alongside active commitments.
    Pass `state=proposed|pending|kept|broken|abandoned` for one slate.
    """
    from .db.models import Promise as _Promise

    q = db.query(_Promise)
    # Modern 5-state lifecycle (matches frontend PromiseState type +
    # api.ts schema). The legacy "active" alias was renamed to "pending"
    # during the proposed-vs-pending lock-in split; this validation list
    # was stale and 400'd the dashboard PromiseDrawer fetch on "pending".
    _VALID_STATES = ("proposed", "pending", "kept", "broken", "abandoned")
    if state:
        if state not in _VALID_STATES:
            raise HTTPException(
                status_code=400,
                detail=f"invalid state (expected one of {_VALID_STATES})",
            )
        q = q.filter(_Promise.state == state)
    # Pending sorts deadline-first so the closest-due promise bubbles up;
    # everything else sorts by recency.
    if state == "pending":
        q = q.order_by(
            _Promise.inferred_due.asc().nullslast(), _Promise.created_at.desc()
        )
    else:
        q = q.order_by(_Promise.created_at.desc())
    rows = q.limit(limit).all()
    return [_serialize_promise(p) for p in rows]


@app.get("/promises/pis")
def promise_integrity_score(db: Session = Depends(get_db)):
    """Promise Integrity Score — Daniel's accountability scoreboard.

    G3.1 weighting (3-state lifecycle):
      kept   → +1.0
      broken → -1.5  (asymmetric: breaking stings more than keeping helps)
      active → 0     (not counted; resolution unknown yet)

    Normalized to 0..100 percentage. Plus current kept-streak (consecutive
    `kept` walking back from most recent) and last_broken metadata.

    Returns `{score: null, ...}` when fewer than 3 resolved promises exist
    — small-N noise distorts the score, better to show "not enough data".

    Algorithm notes:
      score% = ((sum + theoretical_min_abs) / theoretical_range) * 100
      Pre-G3.1 `abandoned` rolled into `broken` during the state collapse
      migration; the score function lost its softer-penalty middle ground.
      If a softer 'gave up gracefully' verdict comes back, add a state +
      re-introduce the asymmetric weight here.
    """
    from .db.models import Promise as _Promise

    RESOLVED = ("kept", "broken")
    WEIGHTS = {"kept": 1.0, "broken": -1.5}
    MIN_SAMPLE = 3
    WINDOW = 20

    rows = (
        db.query(_Promise)
        .filter(_Promise.state.in_(RESOLVED))
        .order_by(_Promise.resolved_at.desc().nullslast(), _Promise.id.desc())
        .limit(WINDOW)
        .all()
    )
    sample_size = len(rows)

    if sample_size < MIN_SAMPLE:
        return {
            "score": None,
            "sample_size": sample_size,
            "min_sample": MIN_SAMPLE,
            "kept_streak": 0,
            "last_broken_at": None,
            "last_broken_summary": None,
            "weights": WEIGHTS,
            "window": WINDOW,
            "note": "need at least 3 resolved promises to compute",
        }

    total = sum(WEIGHTS[r.state] for r in rows)
    # Theoretical range across the sample window.
    theoretical_max = sample_size * 1.0          # all kept
    theoretical_min = sample_size * -1.5         # all broken
    range_ = theoretical_max - theoretical_min   # = sample_size * 2.5
    pct = int(round(((total - theoretical_min) / range_) * 100))
    pct = max(0, min(100, pct))

    # Kept streak — walk recent-first until we hit a non-kept.
    streak = 0
    for r in rows:
        if r.state == "kept":
            streak += 1
        else:
            break

    last_broken = next((r for r in rows if r.state == "broken"), None)

    return {
        "score": pct,
        "sample_size": sample_size,
        "min_sample": MIN_SAMPLE,
        "kept_streak": streak,
        "last_broken_at": (
            last_broken.resolved_at.isoformat() if last_broken and last_broken.resolved_at else None
        ),
        "last_broken_summary": (
            (last_broken.summary or last_broken.utterance)
            if last_broken else None
        ),
        "weights": WEIGHTS,
        "window": WINDOW,
    }


@app.patch("/promises/{promise_id}")
def patch_promise(promise_id: int, body: dict, db: Session = Depends(get_db)):
    """G3.1 state transition only — active | kept | broken. Mirrors
    `promise_service.transition` so the same idempotency + resolved_at
    bookkeeping fires regardless of caller. Lock-in is gone — habit
    auto-spawn now fires at promise create (see promise_service.create).
    """
    from .services import promise_service

    new_state = body.get("state")
    if new_state not in ("active", "kept", "broken"):
        raise HTTPException(status_code=400, detail="state required (active|kept|broken)")
    p = promise_service.transition(db, promise_id, new_state)
    if p is None:
        raise HTTPException(status_code=404, detail="Promise not found")
    return _serialize_promise(p)


# ── Note comments (Confluence-style) ───────────────────────────────────────────


def _serialize_comment(c: NoteComment) -> dict:
    return {
        "id": c.id,
        "note_id": c.note_id,
        "author": c.author,
        "content": c.content,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


@app.get("/notes/{note_id}/comments")
def list_note_comments(note_id: int, db: Session = Depends(get_db)):
    """All comments on a note, oldest first. Mirrors how Confluence threads
    read top-down so newest replies stay at the bottom of the editor."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    rows = (
        db.query(NoteComment)
        .filter(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc(), NoteComment.id.asc())
        .all()
    )
    return [_serialize_comment(c) for c in rows]


@app.post("/notes/{note_id}/comments")
def create_note_comment(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Append a comment. `author` defaults to "daniel" when the request
    doesn't supply one — Claude/Gooni pass their own label via the MCP tool
    so the bubble can show who wrote it."""
    if not db.query(Note).filter(Note.id == note_id).first():
        raise HTTPException(status_code=404, detail="Note not found")
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    author = (body.get("author") or "daniel").strip() or "daniel"
    c = NoteComment(note_id=note_id, author=author, content=content)
    db.add(c)
    db.commit()
    db.refresh(c)
    return _serialize_comment(c)


@app.delete("/comments/{comment_id}")
def delete_note_comment(comment_id: int, db: Session = Depends(get_db)):
    c = db.query(NoteComment).filter(NoteComment.id == comment_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    db.delete(c)
    db.commit()
    return {"ok": True}


# ── Reactions (Confluence-style emoji on notes + comments) ────────────────────

_REACTION_TARGETS = ("note", "comment")
# Hard cap on grapheme length so a bad client can't dump a paragraph in
# the emoji field. Single emoji can be up to ~16 bytes (ZWJ sequences).
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


@app.get("/reactions")
def list_reactions(
    target_type: str,
    target_id: int,
    reactor_id: str | None = None,
    db: Session = Depends(get_db),
):
    """Per-emoji counts for the target, plus `reacted_by_me` flag when
    the caller supplies their reactor_id. Anonymous callers omit it and
    get bare counts."""
    _validate_reaction_target(target_type, target_id, db)
    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .all()
    )
    return _serialize_reactions(rows, reactor_id)


@app.post("/reactions")
def toggle_reaction(body: dict, db: Session = Depends(get_db)):
    """Toggle a reaction: remove if (target, emoji, reactor_id) already
    exists, else insert. Returns the refreshed per-emoji bucket set.

    Body: { target_type, target_id, emoji, reactor_id }
    """
    target_type = (body.get("target_type") or "").strip()
    target_id_raw = body.get("target_id")
    emoji = (body.get("emoji") or "").strip()
    reactor_id = (body.get("reactor_id") or "").strip()
    try:
        target_id = int(target_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="target_id must be an integer")
    if not emoji or len(emoji) > _REACTION_MAX_EMOJI_LEN:
        raise HTTPException(status_code=400, detail="emoji required (≤32 chars)")
    if not reactor_id or len(reactor_id) > _REACTION_MAX_REACTOR_LEN:
        raise HTTPException(status_code=400, detail="reactor_id required (≤80 chars)")
    _validate_reaction_target(target_type, target_id, db)

    existing = (
        db.query(Reaction)
        .filter(
            Reaction.target_type == target_type,
            Reaction.target_id == target_id,
            Reaction.emoji == emoji,
            Reaction.reactor_id == reactor_id,
        )
        .first()
    )
    if existing:
        db.delete(existing)
    else:
        db.add(Reaction(
            target_type=target_type,
            target_id=target_id,
            emoji=emoji,
            reactor_id=reactor_id,
        ))
    db.commit()

    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .all()
    )
    return _serialize_reactions(rows, reactor_id)


# ── Image / file uploads (Cloudflare R2) ──────────────────────────────────────


# 10 MB per upload. TipTap pastes single images so we don't need bigger;
# a hard cap protects the FastAPI worker (UploadFile reads into memory)
# from someone pasting a screenshot of a screenshot of a screenshot.
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# 25 MB cap for generic file attachments — bigger than image cap because
# PDFs and design exports run heavier, still small enough to fit in a
# single worker memory budget without paging.
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
_ALLOWED_IMAGE_PREFIX = "image/"


@app.post("/uploads/image")
async def upload_image_route(file: UploadFile = File(...)):
    """Upload a pasted/dropped image to Cloudflare R2 and return its public
    URL. Frontend rewrites <img src="data:..."> to this URL so note bodies
    stay tiny (see PR #134 OOM postmortem).

    Returns 503 when R2 isn't configured — frontend falls back to inline
    base64, so dev / un-provisioned envs still work, just with the old
    storage cost.
    """
    from .services import image_storage

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


@app.post("/uploads/file")
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
    from .services import image_storage

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


@app.get("/uploads/og")
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


@app.get("/notes/{note_id}/attachments")
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


@app.delete("/attachments/{attachment_id}")
def delete_attachment(attachment_id: int, db: Session = Depends(get_db)):
    """Remove the DB row only — leaves the R2 object behind. A future
    sweeper can reconcile orphan keys against the table."""
    row = db.query(Attachment).filter(Attachment.id == attachment_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


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
    image_url = body.get("image_url") or None
    if not user_content and not image_url:
        raise HTTPException(status_code=400, detail="content or image_url is required")
    entry_content = body.get("entry_content", "")
    model = body.get("model") or None
    try:
        _, usage = Orchestrator.handle_chat(
            user_content,
            db,
            conversation_id=conversation_id,
            entry_content=entry_content,
            model=model,
            image_url=image_url,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    msgs = conversation_service.get_messages(conversation_id, db)
    return {
        "messages": [_serialize_message(m) for m in msgs],
        "intention": usage.get("intention") or "",
        "tools_used": usage.get("tools_used") or [],
    }


@app.post("/conversations/{conversation_id}/messages/stream")
def send_conversation_message_stream(
    conversation_id: int, body: dict,
):
    """SSE variant of /messages. Same payload, but streams pipeline events
    so the web chat UI can show "Thinking…" → tool cards in flight →
    final reply land progressively.

    Events emitted (one per `data:` line, JSON):
      - {"type":"stage","stage":"intent|memory_recall|generate","label":"..."}
      - {"type":"tool_start","id":N,"tool_name":"...","args":{...}}
      - {"type":"tool_done","id":N,"tool_name":"...","status":"done|failed","error":...}
      - {"type":"done","messages":[...],"intention":"...","tools_used":[...]}
      - {"type":"error","message":"..."}

    The endpoint takes no db Session via Depends — the chat path runs in
    a background thread with its own session, so the request handler stays
    free to stream events as fast as the queue drains.

    Bot channels (telegram/whatsapp/imessage) do NOT use this — they go
    through the non-streaming /messages endpoint.
    """
    from fastapi.responses import StreamingResponse
    from threading import Thread
    from queue import Queue, Empty

    user_content = (body.get("content") or "").strip()
    image_url = body.get("image_url") or None
    if not user_content and not image_url:
        raise HTTPException(status_code=400, detail="content or image_url is required")
    entry_content = body.get("entry_content", "")
    model = body.get("model") or None

    queue: Queue = Queue()
    SENTINEL = object()

    def _worker():
        # Background thread owns its own DB session — the FastAPI-managed
        # session can't cross threads safely. SessionLocal is the same
        # factory get_db uses for HTTP-bound work.
        from .db.database import SessionLocal
        worker_db = SessionLocal()
        try:
            try:
                _, usage = Orchestrator.handle_chat(
                    user_content,
                    worker_db,
                    conversation_id=conversation_id,
                    entry_content=entry_content,
                    model=model,
                    image_url=image_url,
                    event_cb=queue.put,
                )
                msgs = conversation_service.get_messages(conversation_id, worker_db)
                queue.put({
                    "type": "done",
                    "messages": [_serialize_message(m) for m in msgs],
                    "intention": (usage or {}).get("intention") or "",
                    "tools_used": (usage or {}).get("tools_used") or [],
                })
            except ValueError as e:
                queue.put({"type": "error", "message": str(e)})
            except Exception as e:
                # Same swallow-but-surface posture as the non-streaming path:
                # never crash the SSE stream — emit an error event the
                # frontend can render.
                queue.put({"type": "error", "message": f"chat failed: {e}"})
        finally:
            queue.put(SENTINEL)
            worker_db.close()

    Thread(target=_worker, daemon=True).start()

    def _event_source():
        while True:
            try:
                # Heartbeat every 15s so reverse proxies (Fly's edge) don't
                # idle-kill the SSE connection on long replies.
                evt = queue.get(timeout=15.0)
            except Empty:
                yield ": heartbeat\n\n"
                continue
            if evt is SENTINEL:
                break
            yield f"data: {json.dumps(evt, default=str)}\n\n"

    return StreamingResponse(
        _event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disables nginx-style buffering at the edge
            "Connection": "keep-alive",
        },
    )


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

    # MCP activity — rolling 24h window + most recent. Rolling vs UTC-midnight
    # cutoff because Fly runs UTC and Daniel's in NYC; "today" by UTC date
    # silently drops calls from late-evening NYC. Best-effort: missing table
    # (fresh DB) shouldn't break the dashboard, so we wrap and fall back.
    mcp_calls_today = 0
    mcp_last_active_at: str | None = None
    try:
        cutoff = datetime.utcnow() - timedelta(hours=24)
        mcp_calls_today = (
            db.query(McpCall)
            .filter(McpCall.called_at >= cutoff)
            .count()
        )
        last = (
            db.query(McpCall)
            .order_by(McpCall.called_at.desc())
            .first()
        )
        if last and last.called_at:
            mcp_last_active_at = last.called_at.isoformat()
    except Exception:
        pass

    # focus-cam stats. Reads sessions written by the standalone focus_cam.py
    # tracker (separate repo). Same best-effort pattern as MCP — table may
    # not exist on a fresh DB. Returns:
    #   focus_cam_sessions_total — lifetime count of finalized sessions
    #   focus_cam_7d             — list[{date, sessions, score, duration_sec}]
    #                              one entry per day in last 7 days that had
    #                              at least one session; sorted by date asc
    #   focus_cam_7d_avg_score   — avg focus_score across those sessions
    focus_cam_sessions_total = 0
    focus_cam_7d: list[dict] = []
    focus_cam_7d_avg_score: float | None = None
    try:
        focus_cam_sessions_total = (
            db.execute(
                text(
                    "SELECT COUNT(*) FROM focus_sessions WHERE ended_at IS NOT NULL"
                )
            )
            .scalar()
            or 0
        )
        rows = db.execute(
            text(
                """SELECT date(started_at) AS d,
                          COUNT(*) AS sessions,
                          AVG(focus_score) AS score,
                          SUM(duration_sec) AS dur
                   FROM focus_sessions
                   WHERE ended_at IS NOT NULL
                     AND started_at >= datetime('now', '-7 days')
                   GROUP BY d
                   ORDER BY d ASC"""
            )
        ).fetchall()
        focus_cam_7d = [
            {
                "date": r[0],
                "sessions": int(r[1] or 0),
                "score": round(float(r[2]), 1) if r[2] is not None else None,
                "duration_sec": int(r[3] or 0),
            }
            for r in rows
        ]
        avg_row = db.execute(
            text(
                """SELECT AVG(focus_score) FROM focus_sessions
                   WHERE focus_score IS NOT NULL
                     AND started_at >= datetime('now', '-7 days')"""
            )
        ).fetchone()
        if avg_row and avg_row[0] is not None:
            focus_cam_7d_avg_score = round(float(avg_row[0]), 1)
    except Exception:
        pass

    return {
        "notes_this_week": notes_this_week,
        "notes_last_week": notes_last_week,
        "recent_notes": [_serialize_note_lite(n) for n in recent_notes],
        "streak": streak,
        "notes_per_day": notes_per_day,
        "activity_per_day": activity_per_day,
        "mcp_calls_today": mcp_calls_today,
        "mcp_last_active_at": mcp_last_active_at,
        "focus_cam_sessions_total": focus_cam_sessions_total,
        "focus_cam_7d": focus_cam_7d,
        "focus_cam_7d_avg_score": focus_cam_7d_avg_score,
    }


@app.get("/dashboard/openai-usage")
def get_openai_usage(refresh: bool = False):
    """Month-to-date OpenAI spend + tokens + requests broken down by model.
    Pulled live from the OpenAI Admin API and cached in-process for 6h.
    Returns {configured: false} if OPENAI_ADMIN_KEY is not set so the UI
    can render setup help instead of empty zeros.
    """
    from .services import openai_usage
    return openai_usage.fetch_month_to_date(refresh=refresh)


@app.get("/tool-calls/failures")
def tool_call_failures(
    days: int = 7,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    """Recent failed tool calls — surfaces hallucination + integration
    breakage signal on the Build / Ops dashboard."""
    from datetime import datetime, timedelta
    from .db.models import ToolCall
    cutoff = datetime.utcnow() - timedelta(days=int(days))
    rows = (
        db.query(ToolCall)
        .filter(ToolCall.status == "failed")
        .filter(ToolCall.started_at >= cutoff)
        .order_by(ToolCall.started_at.desc())
        .limit(int(limit))
        .all()
    )
    return [
        {
            "id": r.id,
            "tool_name": r.tool_name,
            "error": r.error or "",
            "conversation_id": r.conversation_id,
            "message_id": r.message_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
        }
        for r in rows
    ]


@app.get("/health/scores")
def health_scores(db: Session = Depends(get_db)):
    """Composite 0-100 score per Gooni health axis. Drives the Build
    mode dashboard. Computed on-demand; cheap aggregates over existing
    tables, no caching. See `health_service.compute_all` for the per-
    axis scoring logic."""
    from .services.health_service import compute_all
    return compute_all(db)


@app.get("/dashboard/claude-usage")
def get_claude_usage(
    days: int = 30,
    refresh: bool = False,
    db: Session = Depends(get_db),
):
    """Claude Code usage. Source picked at runtime:

    - dev (laptop): walks ~/.claude/projects/**/*.jsonl (cached 6h)
    - prod (Fly):   reads claude_usage_turns table (populated by the local
                    uploader posting to /dashboard/claude-usage/ingest)

    `days=0` means all-time. Personal usage — distinct from
    /dashboard/openai-usage which is Gooni's spend."""
    from .services import claude_usage
    return claude_usage.fetch(days=days, refresh=refresh, db=db)


@app.post("/dashboard/claude-usage/ingest")
def ingest_claude_usage(
    payload: dict,
    db: Session = Depends(get_db),
):
    """Append Claude Code turns into the claude_usage_turns table.

    Body shape:
        {"turns": [
            {
              "session_id": "...",
              "ts":          "2026-05-03T14:22:00Z",
              "model":       "claude-opus-4-7",
              "input_tokens": 123,
              "output_tokens": 456,
              "cache_read_tokens": 789,
              "cache_creation_tokens": 0
            },
            ...
        ]}

    Idempotent: rows with a duplicate (session_id, ts) are silently
    dropped via ON CONFLICT DO NOTHING. Uploader can re-post overlapping
    windows without creating dupes.

    Auth: existing AUTH_PASSWORD bearer (same token as dashboard reads).
    """
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    from datetime import datetime as _dt
    from .db.models import ClaudeUsageTurn

    turns = payload.get("turns") or []
    if not isinstance(turns, list):
        raise HTTPException(status_code=400, detail="turns must be a list")

    rows = []
    for t in turns:
        sid = t.get("session_id")
        ts_raw = t.get("ts")
        if not sid or not ts_raw:
            continue
        try:
            ts = _dt.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        rows.append({
            "session_id": str(sid),
            "ts": ts,
            "model": str(t.get("model") or "unknown"),
            "input_tokens": int(t.get("input_tokens") or 0),
            "output_tokens": int(t.get("output_tokens") or 0),
            "cache_read_tokens": int(t.get("cache_read_tokens") or 0),
            "cache_creation_tokens": int(t.get("cache_creation_tokens") or 0),
        })

    inserted = 0
    if rows:
        stmt = sqlite_insert(ClaudeUsageTurn).values(rows).on_conflict_do_nothing(
            index_elements=["session_id", "ts"]
        )
        result = db.execute(stmt)
        db.commit()
        inserted = result.rowcount or 0

    return {"received": len(turns), "inserted": inserted, "skipped": len(turns) - inserted}


@app.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    """Aggregated counters for the Stats view. Returns a flat dict so the
    frontend can render each metric without knowing the source query.
    """
    from .db.models import Note as _Note, Conversation as _Conv, Message as _Msg, ListItem as _LI
    from datetime import datetime as _dt, timedelta as _td

    week_ago = _dt.utcnow() - _td(days=7)
    notes_this_week = db.query(_Note).filter(_Note.created_at >= week_ago).count()
    notes_total = db.query(_Note).count()

    conversations_total = db.query(_Conv).count()
    user_messages_total = db.query(_Msg).filter(_Msg.role == "user").count()
    assistant_messages_total = db.query(_Msg).filter(_Msg.role == "assistant").count()
    user_messages_this_week = db.query(_Msg).filter(
        _Msg.role == "user", _Msg.created_at >= week_ago
    ).count()

    # Focus / todo completion — use ListItem.done so it works for any list type.
    todos_done_this_week = db.query(_LI).filter(
        _LI.done == True,  # noqa: E712
        _LI.completed_at >= week_ago,
    ).count()
    todos_open = db.query(_LI).filter(_LI.done == False).count()  # noqa: E712

    return {
        "notes_this_week": notes_this_week,
        "notes_total": notes_total,
        "conversations_total": conversations_total,
        "user_messages_total": user_messages_total,
        "assistant_messages_total": assistant_messages_total,
        "user_messages_this_week": user_messages_this_week,
        "todos_done_this_week": todos_done_this_week,
        "todos_open": todos_open,
    }


@app.get("/dashboard/take")
def get_gooni_take(force: bool = False, db: Session = Depends(get_db)):
    """Gooni's Take — ONE tight sentence on Daniel's current focus thread.

    Persisted in `gooni_takes` (kind="focus") — one row per UTC day. Re-fetching
    the same day returns the stored row; ?force=1 regenerates and overwrites.
    """
    from .services.take_service import get_or_generate

    return get_or_generate(db, "focus", force=force)


@app.get("/dashboard/dev-take")
def get_dev_take(force: bool = False, db: Session = Depends(get_db)):
    """Dev Take — short paragraph on what Daniel shipped on Gooni today,
    derived from commits + PR titles across all tracked repos (last 24h).

    Persisted in `gooni_takes` (kind="dev") — one row per UTC day. ?force=1
    regenerates. Returns an empty take when no tracked repos / no commits;
    no row is written in that case.
    """
    from .services.take_service import get_or_generate

    return get_or_generate(db, "dev", force=force)


@app.get("/dashboard/takes/history")
def list_takes_history(
    kind: str = "focus",
    limit: int = 30,
    db: Session = Depends(get_db),
):
    """Reverse-chronological list of stored takes for `kind`. Future
    history surfaces (e.g. "how my focus has drifted") read this."""
    from .services.take_service import list_history

    if kind not in {"focus", "dev"}:
        raise HTTPException(status_code=400, detail="kind must be focus|dev")
    return list_history(db, kind, limit=limit)


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


@app.get("/notes/search-titles")
def search_note_titles(q: str = "", limit: int = 8, db: Session = Depends(get_db)):
    """Title-substring search for the @-mention note picker. Cheap (no
    embedding), prefix-friendly, recency-ordered. Empty q → recent notes.
    Returns list-shape (no body)."""
    notes = note_service.search_by_title(q, limit, db)
    return [_serialize_note_lite(n) for n in notes]


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
        "retrieval_count": m.retrieval_count,
        "last_retrieved_at": m.last_retrieved_at.isoformat() if m.last_retrieved_at else None,
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
    """Update content (supersede chain, preserves audit history) and/or
    type. Type change is in-place — no new row — since type taxonomy
    shifts are a metadata correction rather than a content change.
    Pass `content` to update text, `type` to change taxonomy, or both.
    """
    from .db.models import Memory
    content = (body.get("content") or "").strip()
    new_type = (body.get("type") or "").strip().lower() or None
    if not content and not new_type:
        raise HTTPException(status_code=400, detail="content or type is required")
    if content:
        if not memory_service.update_memory(memory_id, content, db=db):
            raise HTTPException(status_code=404, detail="memory not found")
    if new_type:
        from .services.memory_extraction import VALID_TYPES
        # `preference` is no longer in VALID_TYPES (extraction was disabled
        # there), but we still need to accept it as a target type for
        # legacy rows. Add it back to the allowed set just for this PATCH.
        allowed = VALID_TYPES | {"preference"}
        if new_type not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"type must be one of {sorted(allowed)}",
            )
        row = db.query(Memory).filter(Memory.id == memory_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="memory not found")
        row.type = new_type
        db.commit()
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


def _unique_viewers_for_note(db: Session, note_id: int) -> int:
    """Count distinct ip_hash values that hit /public/notes/{note_id}.
    Path-scoped — if a note is unpublished + republished, the historical
    visit rows still count toward the total. Daniel said "idc if data is
    erased if i pull a note out" so we keep it simple + cumulative."""
    from sqlalchemy import func as sqlfunc
    return int(
        db.query(sqlfunc.count(sqlfunc.distinct(Visit.ip_hash)))
        .filter(Visit.path == f"/public/notes/{note_id}")
        .scalar()
        or 0
    )


@app.get("/public/notes")
def get_public_notes(db: Session = Depends(get_db)):
    """Return all public notes with their space name. Public-pinned first,
    then newest. No auth."""
    rows = (
        db.query(Note, Space)
        .outerjoin(Space, Note.space_id == Space.id)
        .filter(Note.is_public == True)  # noqa: E712
        .order_by(Note.is_public_pinned.desc(), _notes_order())
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
            "is_public_pinned": bool(n.is_public_pinned),
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
        "unique_viewers": _unique_viewers_for_note(db, note.id),
    }


@app.get("/public/notes/{note_id}/comments")
def get_public_note_comments(note_id: int, db: Session = Depends(get_db)):
    """Read-only comment thread for a public note. 404 if the note isn't
    public; thread itself has no per-comment visibility flag — if the note
    is public, all its comments are visible. Auth-bypassed by middleware
    (path matches /public/* GET)."""
    note = db.query(Note).filter(Note.id == note_id, Note.is_public == True).first()  # noqa: E712
    if not note:
        raise HTTPException(status_code=404, detail="Not found")
    rows = (
        db.query(NoteComment)
        .filter(NoteComment.note_id == note_id)
        .order_by(NoteComment.created_at.asc(), NoteComment.id.asc())
        .all()
    )
    return [_serialize_comment(c) for c in rows]


@app.get("/notes/{note_id}")
def get_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single note by ID. Tacks on `unique_viewers` so the editor
    can show the count next to the Public toggle without a second round-trip."""
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    payload = _serialize_note(note)
    payload["unique_viewers"] = _unique_viewers_for_note(db, note.id)
    return payload


@app.get("/public/profile")
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


@app.patch("/public/profile")
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


# ── Whoop OAuth + recovery snapshot ────────────────────────────────────────
# Same shape as the Google Calendar block above: start → callback → status →
# delete. Data fetcher is /whoop/today, served from the cached daily
# WhoopSnapshot row when fresh, refetched live when stale (>2h old).

from .services import whoop  # noqa: E402


@app.get("/auth/whoop/start")
def auth_whoop_start():
    if not whoop.is_configured():
        raise HTTPException(status_code=503, detail="Whoop OAuth env vars not set")
    return {"authorize_url": whoop.build_authorize_url()}


@app.get("/auth/whoop/callback")
def auth_whoop_callback(code: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>Whoop OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = whoop.exchange_code_for_tokens(code)
        # Whoop's basic profile gives us first/last name + email for the
        # connected-as label.
        profile = {}
        try:
            profile = whoop.fetch_profile(tokens.get("access_token", ""))
        except Exception:
            pass
        whoop.save_tokens_from_exchange(db, tokens, account_email=profile.get("email"))
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>Whoop connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>Whoop connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@app.get("/auth/whoop/status")
def auth_whoop_status(db: Session = Depends(get_db)):
    return whoop.connection_status(db)


@app.delete("/auth/whoop")
def auth_whoop_disconnect(db: Session = Depends(get_db)):
    return {"disconnected": whoop.disconnect(db)}


@app.get("/whoop/today")
def whoop_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Return today's recovery + strain + sleep snapshot.

    Cached daily in `whoop_snapshots` (one row per date). Pass `?refresh=1`
    to force a live API hit; otherwise we serve the cached row if it was
    updated within the last 2 hours, else refetch.
    """
    from datetime import datetime as _dt, timedelta as _td
    from .db.models import WhoopSnapshot
    # `today` keyed on Daniel's local TZ so the snapshot maps to his lived
    # day, not UTC. Whoop service mirrors this in `_local_today`.
    today = whoop._local_today(db)
    row = db.query(WhoopSnapshot).filter(WhoopSnapshot.date == today).first()
    stale = (
        row is None
        or row.updated_at is None
        or (_dt.utcnow() - row.updated_at) > _td(hours=2)
    )
    if refresh or stale:
        try:
            payload = whoop.fetch_today_snapshot(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Whoop fetch failed: {e}")
        if payload is None:
            raise HTTPException(status_code=401, detail="Whoop not connected")
        row = whoop.upsert_today_snapshot(db, payload)
    return {
        "date": row.date.isoformat() if row and row.date else None,
        "recovery_score": row.recovery_score if row else None,
        "hrv_rmssd_ms": row.hrv_rmssd_ms if row else None,
        "resting_hr": row.resting_hr if row else None,
        "strain": row.strain if row else None,
        "sleep_minutes": row.sleep_minutes if row else None,
        "sleep_performance_pct": row.sleep_performance_pct if row else None,
        "sleep_start_at": (
            row.sleep_start_at.isoformat()
            if row and row.sleep_start_at else None
        ),
        "sleep_end_at": (
            row.sleep_end_at.isoformat()
            if row and row.sleep_end_at else None
        ),
        "sleep_efficiency_pct": row.sleep_efficiency_pct if row else None,
        "sleep_disturbance_count": row.sleep_disturbance_count if row else None,
        "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
        "source_updated_at": (
            row.source_updated_at.isoformat()
            if row and row.source_updated_at else None
        ),
    }


# ---------- LeetCode (public-data-only stats) ----------


@app.get("/leetcode/today")
def leetcode_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Return today's LeetCode snapshot for the configured username.

    Lazy daily pull: cached in `leetcode_snapshots` (one row per UTC
    date). First viewer per day pays a ~500ms hit to leetcode.com/graphql;
    everyone else gets the cached row. Pass `?refresh=1` to force a live
    refetch.
    """
    from .services import leetcode_service
    row = leetcode_service.get_or_fetch(db, force=refresh)
    return leetcode_service.serialize(row)


# Whoop webhook signature: base64(HMAC-SHA256(timestamp + body, client_secret)).
# Whoop reuses the OAuth client_secret for webhook signing — no separate
# webhook secret in their model. Both `X-WHOOP-Signature` and
# `X-WHOOP-Signature-Timestamp` headers must be present. We accept clock
# skew up to 5 minutes against the server time so a stale-replayed event
# still verifies, but anything older is rejected as a replay-attack guard.
def _verify_whoop_signature(raw_body: bytes, signature: str | None, timestamp: str | None) -> bool:
    secret = os.getenv("WHOOP_CLIENT_SECRET")
    if not secret:
        # Defaults to "open in dev" so webhook can be exercised locally
        # without setting the secret. Production must set WHOOP_CLIENT_SECRET.
        return True
    if not signature or not timestamp:
        return False
    try:
        ts_ms = int(timestamp)
    except ValueError:
        return False
    # Reject events older than 5 minutes (replay guard).
    now_ms = int(time.time() * 1000)
    if abs(now_ms - ts_ms) > 5 * 60 * 1000:
        return False
    import base64
    digest = hmac.new(
        secret.encode(), (timestamp + raw_body.decode("utf-8", errors="replace")).encode(), hashlib.sha256
    ).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature)


@app.post("/webhooks/whoop")
async def whoop_webhook(
    request: Request,
    x_whoop_signature: str | None = Header(None, alias="X-WHOOP-Signature"),
    x_whoop_signature_timestamp: str | None = Header(None, alias="X-WHOOP-Signature-Timestamp"),
    db: Session = Depends(get_db),
):
    """Receive a Whoop webhook event.

    Whoop fires on `recovery.updated`, `sleep.updated`, `workout.updated`,
    `cycle.updated`. Payload carries metadata only (event type + record id)
    — actual data must be fetched via the API. We don't fetch per-record;
    we just refresh the daily snapshot once any event lands so the dashboard
    is always within one webhook of truth.

    Auth: HMAC-SHA256 signature. See `_verify_whoop_signature`.
    """
    raw_body = await request.body()
    if not _verify_whoop_signature(raw_body, x_whoop_signature, x_whoop_signature_timestamp):
        raise HTTPException(status_code=401, detail="bad whoop signature")

    try:
        payload = json.loads(raw_body or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid json")

    event_type = payload.get("type") or ""
    # Only refresh on the events that actually move the snapshot. Workout
    # events don't change recovery/strain/sleep, so we skip them to avoid
    # burning the API rate budget for nothing.
    relevant = event_type.startswith(("recovery.", "sleep.", "cycle."))
    if not relevant:
        return {"ok": True, "ignored": event_type}

    try:
        snapshot = whoop.fetch_today_snapshot(db)
    except Exception as e:
        # Don't 500 — Whoop will keep retrying which doesn't help us; log
        # and move on. Daniel can hit ?refresh=1 manually to recover.
        print(f"whoop webhook fetch error: {e}")
        return {"ok": True, "warn": str(e)}
    if snapshot:
        whoop.upsert_today_snapshot(db, snapshot)
    return {"ok": True, "type": event_type}


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
def dashboard_dev_activity(refresh: bool = False, db: Session = Depends(get_db)):
    """Per-repo dev activity (today, recent commits, streak) + aggregate
    streak and weekly LLM summary across all tracked repos.

    `?refresh=1` bypasses the 60s in-memory cache so the user can yank a
    fresh pull from GitHub when they've just committed.
    """
    from .services import dev_activity_service as das
    return das.dev_activity_service.build(db, force=refresh)


@app.get("/dashboard/time-on-gooni")
def dashboard_time_on_gooni(
    owner: str = "gub1th",
    name: str = "gooni",
    gap_minutes: int = 15,
    headstart_minutes: int = 5,
    db: Session = Depends(get_db),
):
    """Estimate time spent on a repo by clustering commit timestamps.
    Default = gub1th/gooni. Two commits within `gap_minutes` count as the
    same work session; each session credits `headstart_minutes` of pre-
    first-commit work (you didn't start coding the moment you committed).

    Returns rough minutes for today (rolling 24h) and the last 7 days.
    Caveat: GitHub commits only — silent reading / WIP without commits is
    invisible. So this is a *floor* on time spent, not the truth.
    """
    from datetime import datetime, timedelta, timezone
    if not gh.is_configured() or gh.get_valid_access_token(db) is None:
        return {
            "configured": False,
            "today_minutes": 0,
            "week_minutes": 0,
            "today_sessions": 0,
            "week_sessions": 0,
        }

    since_iso = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    try:
        commits = gh.list_recent_commits(
            db, owner, name, since_iso=since_iso, per_page=100
        )
    except Exception as e:
        return {
            "configured": True,
            "error": str(e)[:200],
            "today_minutes": 0,
            "week_minutes": 0,
            "today_sessions": 0,
            "week_sessions": 0,
        }

    # Pull author timestamps; tolerate either author or committer.
    timestamps: list[datetime] = []
    for c in commits:
        commit = c.get("commit") or {}
        ts = (commit.get("author") or {}).get("date") or (
            commit.get("committer") or {}
        ).get("date")
        if not ts:
            continue
        try:
            timestamps.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
        except ValueError:
            continue

    timestamps.sort()
    if not timestamps:
        return {
            "configured": True,
            "today_minutes": 0,
            "week_minutes": 0,
            "today_sessions": 0,
            "week_sessions": 0,
        }

    # Cluster by gap. Each session: [first, last]. Credit headstart_minutes
    # before the first commit so a single-commit session isn't 0 minutes.
    sessions: list[list[datetime]] = [[timestamps[0], timestamps[0]]]
    gap = timedelta(minutes=gap_minutes)
    for t in timestamps[1:]:
        if t - sessions[-1][1] <= gap:
            sessions[-1][1] = t
        else:
            sessions.append([t, t])

    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    headstart = timedelta(minutes=headstart_minutes)

    today_minutes = 0.0
    week_minutes = 0.0
    today_sessions = 0
    week_sessions = 0
    for first, last in sessions:
        duration = (last - first + headstart).total_seconds() / 60
        if last >= cutoff_7d:
            week_minutes += duration
            week_sessions += 1
        if last >= cutoff_24h:
            today_minutes += duration
            today_sessions += 1

    return {
        "configured": True,
        "today_minutes": round(today_minutes, 1),
        "week_minutes": round(week_minutes, 1),
        "today_sessions": today_sessions,
        "week_sessions": week_sessions,
        "owner": owner,
        "name": name,
    }


@app.get("/snapshot/today")
def snapshot_today(db: Session = Depends(get_db)):
    """Gooni's Take — daily reflection on the codebase + Daniel's activity.
    Lazy-built on first read of the day; subsequent reads hit cache.
    """
    from .services.snapshot_service import snapshot_service
    snap = snapshot_service.get_or_build_today(db)
    return {
        "day": snap.day,
        "taken_at": snap.taken_at.isoformat() if snap.taken_at else None,
        "digest": snap.digest or "",
    }


# ── Eval loop ────────────────────────────────────────────────────────────────
# See app/services/eval_service.py for segmentation + dispatch logic.


@app.get("/eval/segments")
def eval_list_segments(
    sources: str | None = None,
    statuses: str | None = None,
    has_flag: bool = False,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Grid feed for the eval tab. Sorted by last_message_at DESC.

    Query params:
      sources   = comma-separated subset of web|telegram|whatsapp|imessage
      statuses  = comma-separated subset of not_yet|pending|done
      has_flag  = true → only segments that have at least one step flag
      search    = case-insensitive substring across preview + title + summary
    """
    from .services import eval_service

    src_list = [s.strip() for s in sources.split(",")] if sources else None
    status_list = [s.strip() for s in statuses.split(",")] if statuses else None
    return eval_service.list_segments(
        db,
        sources=src_list,
        statuses=status_list,
        has_flag_only=has_flag,
        search=search,
        limit=limit,
        offset=offset,
    )


@app.get("/eval/segments/{segment_id}/full")
def eval_segment_full(segment_id: int, db: Session = Depends(get_db)):
    """All messages in a segment, each with its decoded trace + per-step
    feedback. Returns 404 if the segment doesn't exist."""
    from .services import eval_service

    full = eval_service.get_segment_full(db, segment_id)
    if not full:
        raise HTTPException(status_code=404, detail="segment not found")
    return full


@app.post("/eval/feedback")
def eval_post_feedback(body: dict, db: Session = Depends(get_db)):
    """Upsert a step-level feedback. Body:
      {segment_id, message_id, step_key, step_index, rating: 1|2|3, comment?}
    Re-posting (same message_id+step_key+step_index) overwrites the prior rating."""
    from .services import eval_service

    required = ("segment_id", "message_id", "step_key", "step_index", "rating")
    for k in required:
        if k not in body:
            raise HTTPException(status_code=400, detail=f"missing field: {k}")
    try:
        fb = eval_service.upsert_feedback(
            db,
            segment_id=int(body["segment_id"]),
            message_id=int(body["message_id"]),
            step_key=str(body["step_key"]),
            step_index=int(body["step_index"]),
            rating=int(body["rating"]),
            comment=body.get("comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"id": fb.id, "ok": True}


@app.delete("/eval/feedback/{feedback_id}")
def eval_delete_feedback(feedback_id: int, db: Session = Depends(get_db)):
    from .services import eval_service

    if not eval_service.delete_feedback(db, feedback_id):
        raise HTTPException(status_code=404, detail="feedback not found")
    return {"ok": True}


@app.put("/eval/segments/{segment_id}/messages/{message_id}/rating")
def eval_put_message_rating(
    segment_id: int,
    message_id: int,
    body: dict,
    db: Session = Depends(get_db),
):
    """Per-message thumbs (1=bad, 2=meh, 3=good). One rating per message
    (unique constraint on message_id) so PUT semantics: re-submit overwrites.
    """
    from .services import eval_service

    rating = body.get("rating")
    if rating is not None and rating not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="rating must be 1, 2, or 3 (or null)")
    try:
        row = eval_service.upsert_message_rating(
            db,
            segment_id=segment_id,
            message_id=message_id,
            rating=rating,
            comment=body.get("comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "id": row.id,
        "message_id": row.message_id,
        "rating": row.rating,
        "comment": row.comment,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@app.delete("/eval/messages/{message_id}/rating")
def eval_delete_message_rating(message_id: int, db: Session = Depends(get_db)):
    from .services import eval_service

    if not eval_service.delete_message_rating(db, message_id=message_id):
        raise HTTPException(status_code=404, detail="rating not found")
    return {"ok": True}


@app.patch("/eval/segments/{segment_id}/summary")
def eval_patch_summary(segment_id: int, body: dict, db: Session = Depends(get_db)):
    """Update overall rating, comment, and status. Body fields are all optional;
    only the provided ones are written."""
    from .services import eval_service

    try:
        seg = eval_service.update_summary(
            db,
            segment_id,
            eval_status=body.get("eval_status"),
            overall_rating=body.get("overall_rating"),
            overall_comment=body.get("overall_comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")
    return {
        "id": seg.id,
        "eval_status": seg.eval_status,
        "overall_rating": seg.overall_rating,
        "overall_comment": seg.overall_comment,
    }


@app.post("/eval/segments/{segment_id}/dispatch-to-cc")
def eval_dispatch_to_cc(segment_id: int, db: Session = Depends(get_db)):
    """Bundle the eval into a Claude Code space note + a backlog item.
    Idempotent: re-dispatching overwrites the prior note rather than spawning
    duplicates. Returns the note id and backlog list id."""
    from .services import eval_service

    try:
        return eval_service.dispatch_to_cc(db, segment_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/eval/tools-legend")
def eval_tools_legend():
    """Static legend of tools / steps the orchestrator can take. Used by the
    eval UI's ⓘ popup so the reviewer knows what each step means."""
    from .services import eval_service

    return {"tools": eval_service.TOOL_LEGEND}


# ── Golden-eval runs / baselines ────────────────────────────────────────────
# Surfaces the artifacts produced by `python -m evals.run_orchestrator` inside
# the audit UI so Daniel can browse them without leaving Gooni. Local-only
# data: reports/ is gitignored so prod has nothing to show until baselines get
# committed or pushed via API. For now the UI degrades gracefully on empty.

import json as _json
from pathlib import Path as _Path

_EVAL_REPORTS_DIR = _Path(__file__).parent.parent / "evals" / "reports"
_EVAL_BASELINES_DIR = _Path(__file__).parent.parent / "evals" / "baselines"


def _safe_eval_filename(filename: str, prefix: str, suffix: str) -> bool:
    """Guard against path traversal. Filenames must start with the expected
    prefix (report_/baseline_) and end with the expected suffix."""
    return (
        "/" not in filename
        and ".." not in filename
        and filename.startswith(prefix)
        and filename.endswith(suffix)
    )


@app.get("/eval/runs")
def list_eval_runs():
    """List local eval runs (HTML reports) with metadata extracted from the
    matching baseline JSON when available. Sorted newest first by mtime.

    Reports are gitignored (ephemeral per-run HTML), but baselines ARE
    committed — so on prod the reports dir is empty but baselines still
    populate. Don't short-circuit on missing reports dir; surface
    baselines regardless.
    """
    runs: list[dict] = []
    if _EVAL_REPORTS_DIR.exists():
        for report in sorted(
            _EVAL_REPORTS_DIR.glob("report_*.html"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            runs.append({
                "filename": report.name,
                "size_bytes": report.stat().st_size,
                "mtime": report.stat().st_mtime,
            })
    # Pair with the latest baseline metadata so the UI shows scores w/o
    # opening each report. Baselines aren't 1:1 with reports (baselines
    # overwrite per pipeline_version+model; reports keep history) — best we
    # can do is summarize the most recent baseline per (version, model).
    baselines_by_key: dict[str, dict] = {}
    if _EVAL_BASELINES_DIR.exists():
        for b in _EVAL_BASELINES_DIR.glob("baseline_*.json"):
            try:
                data = _json.loads(b.read_text())
            except (_json.JSONDecodeError, OSError):
                continue
            key = f"v{data.get('pipeline_version','?')}_{data.get('pipeline_model','?')}"
            baselines_by_key[key] = {
                "filename": b.name,
                "composite_score": data.get("composite_score"),
                "passed": data.get("passed"),
                "n_cases": data.get("n_cases"),
                "means": data.get("means"),
                "pipeline_model": data.get("pipeline_model"),
                "pipeline_version": data.get("pipeline_version"),
                "pipeline_source_hash": data.get("pipeline_source_hash"),
                "timestamp": data.get("timestamp"),
                "total_cost_usd": data.get("total_cost_usd"),
                "cost_per_case_usd": data.get("cost_per_case_usd"),
            }
    return {"runs": runs, "baselines_by_key": baselines_by_key}


@app.get("/eval/runs/{filename}")
def get_eval_run(filename: str):
    """Serve the HTML scorecard inline. iframe-friendly."""
    from fastapi.responses import HTMLResponse

    if not _safe_eval_filename(filename, "report_", ".html"):
        raise HTTPException(400, "invalid report filename")
    p = _EVAL_REPORTS_DIR / filename
    if not p.exists():
        raise HTTPException(404, "report not found")
    return HTMLResponse(content=p.read_text())


# Module-level flag so we don't fire two evals at once on the same machine.
# Single-process only — fine for the current 1-machine Fly deploy. Real
# concurrency control would need Redis or a DB lock if we scale horizontally.
_EVAL_RUN_LOCK: bool = False


@app.post("/eval/run-prod-snapshot")
def run_eval_against_live_snapshot():
    """Snapshot the live DB to /tmp, run the eval harness against it, SSE-stream
    per-line stdout. Emits structured frames the FE renders as a progress drawer:

      {"type":"status", "message":"copying snapshot"}
      {"type":"line",   "data":"[PASS] 001_smoke_basic_question ..."}
      {"type":"done",   "exit_code":0}
      {"type":"error",  "message":"..."}

    Why snapshot instead of pointing the eval at the live DB: the orchestrator
    creates synthetic Conversation/Message rows per fixture case. Running
    against live prod would pollute the real conv list. Snapshot = full prod
    state for reads, scratch for writes, deleted on exit.
    """
    from fastapi.responses import StreamingResponse
    from threading import Thread
    from queue import Queue, Empty
    import shutil, subprocess, uuid, sys

    global _EVAL_RUN_LOCK
    if _EVAL_RUN_LOCK:
        raise HTTPException(409, "an eval is already running on this machine")

    # Derive live DB path from DATABASE_URL. Works locally (./db/gooni.db) and
    # on Fly (/app/db/gooni.db) — same code, different env.
    live_url = os.environ.get("DATABASE_URL", "sqlite:///./db/gooni.db")
    if not live_url.startswith("sqlite:///"):
        raise HTTPException(400, "live DB is not sqlite — snapshot path not implemented for other engines")
    live_path = live_url.removeprefix("sqlite:///")
    if not os.path.exists(live_path):
        raise HTTPException(500, f"live DB not found at {live_path}")

    snap_id = uuid.uuid4().hex[:8]
    snap_path = f"/tmp/eval-snap-{snap_id}.db"

    queue: Queue = Queue()
    SENTINEL = object()

    def _worker():
        global _EVAL_RUN_LOCK
        proc = None
        try:
            queue.put({"type": "status", "message": f"copying snapshot → {snap_path}"})
            shutil.copy(live_path, snap_path)
            queue.put({"type": "status", "message": "starting eval subprocess"})

            env = {
                **os.environ,
                "EVAL_DATABASE_URL": f"sqlite:///{snap_path}",
                # Force unbuffered so we get line-by-line progress instead of
                # everything dumping at the end.
                "PYTHONUNBUFFERED": "1",
            }
            proc = subprocess.Popen(
                [
                    sys.executable, "-m", "evals.run_orchestrator",
                    "--no-cache", "--baseline", "--label", f"live_{snap_id}",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                queue.put({"type": "line", "data": line.rstrip()})
            proc.wait()
            queue.put({"type": "done", "exit_code": proc.returncode})
        except Exception as e:
            queue.put({"type": "error", "message": f"eval failed: {e}"})
        finally:
            if proc and proc.poll() is None:
                proc.terminate()
            if os.path.exists(snap_path):
                try:
                    os.remove(snap_path)
                except OSError:
                    pass
            queue.put(SENTINEL)
            _EVAL_RUN_LOCK = False

    _EVAL_RUN_LOCK = True
    Thread(target=_worker, daemon=True).start()

    def _event_source():
        while True:
            try:
                # 15s heartbeat matches the chat-stream pattern so Fly's edge
                # proxy doesn't idle-kill the connection during the long cases.
                evt = queue.get(timeout=15.0)
            except Empty:
                yield ": heartbeat\n\n"
                continue
            if evt is SENTINEL:
                break
            yield f"data: {json.dumps(evt, default=str)}\n\n"

    return StreamingResponse(
        _event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ── Capability profile + Reflection routes ────────────────────────────────────
# Two surfaces:
#   - /capabilities: read + patch Gooni's self-knowledge inventory (facets).
#   - /reflections : read per-turn self-evaluations (Reflexion rows).
# Plus a manual telemetry trigger for the lifespan loop's nightly aggregation.


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


@app.get("/capabilities")
def list_capabilities(db: Session = Depends(get_db)):
    """List all user-visible capability facets grouped by layer.

    Skips the `_meta` layer (internal scan-hash sentinel). Status='removed'
    rows are returned so the FE can render them dimmed — useful for "Gooni
    used to do X but a refactor removed it."
    """
    rows = (
        db.query(CapabilityFacet)
        .filter(CapabilityFacet.layer != "_meta")
        .order_by(CapabilityFacet.layer, CapabilityFacet.id)
        .all()
    )
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.layer, []).append(_serialize_capability_facet(r))
    return {"by_layer": out, "total": len(rows)}


@app.patch("/capabilities/{facet_id}")
def patch_capability(facet_id: int, body: dict, db: Session = Depends(get_db)):
    """Hand-edit a facet. Allowed fields: facet_text, status, layer.
    Source flips to 'chat_tool_update' to mark provenance.
    """
    row = db.query(CapabilityFacet).filter(CapabilityFacet.id == facet_id).one_or_none()
    if row is None:
        raise HTTPException(404, "facet not found")
    if "facet_text" in body:
        new_text = (body["facet_text"] or "").strip()
        if new_text:
            row.facet_text = new_text
    if "status" in body:
        new_status = str(body["status"])
        if new_status not in {"claimed", "verified", "unverified", "broken", "removed"}:
            raise HTTPException(400, "invalid status")
        row.status = new_status
    if "layer" in body:
        new_layer = str(body["layer"])
        if new_layer not in {"mechanical", "functional", "behavioral", "architectural"}:
            raise HTTPException(400, "invalid layer")
        row.layer = new_layer
    row.source = "chat_tool_update"
    db.commit()
    return _serialize_capability_facet(row)


@app.post("/capabilities")
def create_capability(body: dict, db: Session = Depends(get_db)):
    """Create a facet manually (Daniel-seeded functional/architectural rows).
    facet_key must be unique; conflicts return 409.
    """
    facet_key = (body.get("facet_key") or "").strip()
    layer = (body.get("layer") or "").strip()
    facet_text = (body.get("facet_text") or "").strip()
    if not facet_key or not layer or not facet_text:
        raise HTTPException(400, "facet_key, layer, facet_text required")
    if layer not in {"mechanical", "functional", "behavioral", "architectural"}:
        raise HTTPException(400, "invalid layer")
    existing = db.query(CapabilityFacet).filter(CapabilityFacet.facet_key == facet_key).one_or_none()
    if existing is not None:
        raise HTTPException(409, "facet_key already exists")
    row = CapabilityFacet(
        facet_key=facet_key,
        layer=layer,
        facet_text=facet_text,
        status=str(body.get("status") or "claimed"),
        source=str(body.get("source") or "manual_seed"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_capability_facet(row)


@app.post("/capabilities/telemetry/refresh")
def trigger_capability_telemetry(db: Session = Depends(get_db)):
    """Manual trigger for the runtime-telemetry rollup. Same op the nightly
    lifespan loop fires at 03:00 local. Useful for FE-driven 'refresh now'.
    """
    from .services.capability_service import capability_service
    return capability_service.run_telemetry_rollup(db)


@app.post("/capabilities/boot-scan/refresh")
def trigger_capability_boot_scan(db: Session = Depends(get_db)):
    """Manual trigger for the boot-time mechanical-layer scan. Same op the
    lifespan startup hook fires. Use when you've added a tool/route mid-session
    without restarting uvicorn."""
    from .services.capability_service import capability_service
    return capability_service.refresh_mechanical_layer(db)


@app.post("/capabilities/dedup-behavioral")
def trigger_capability_dedup_behavioral(db: Session = Depends(get_db)):
    """One-shot cleanup over existing behavioral facets — cosine-clusters them
    and merges semantic dups into the oldest canonical row. Use after the
    cosine-dedup-at-promotion-time fix lands to clean the historical bloat
    (prod was carrying ~6 near-identical "I tend to: lack support" facets
    because the old promote path keyed on text hash, not embedding).

    Returns {scanned, kept, merged, clusters} — clusters lists the canon
    row + merged ids so the audit is auditable.
    """
    from .services.capability_service import capability_service
    return capability_service.dedup_existing_behavioral(db)


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


@app.get("/reflections")
def list_reflections(
    conversation_id: int | None = None,
    message_id: int | None = None,
    severity_min: int = 1,
    kind: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """List reflections, filterable by conversation, message, min severity, or
    kind ('turn'|'conv_rollup'). Default returns most-recent 50 across DB."""
    q = db.query(Reflection)
    if conversation_id is not None:
        q = q.filter(Reflection.conversation_id == conversation_id)
    if message_id is not None:
        q = q.filter(Reflection.message_id == message_id)
    if kind:
        q = q.filter(Reflection.kind == kind)
    q = q.filter(Reflection.severity >= severity_min)
    rows = q.order_by(Reflection.id.desc()).limit(min(max(limit, 1), 500)).all()
    return {"reflections": [_serialize_reflection(r) for r in rows]}


@app.post("/reflections/rollup-now")
def trigger_conv_rollup(
    conversation_id: int,
    db: Session = Depends(get_db),
):
    """Manual trigger for the conv-level reflection rollup. Pulls the last 20
    turn reflections in the conv, LLM-summarizes the dominant recurring
    failure modes into one paragraph, persists as a Reflection w/
    kind='conv_rollup'. Master prompt then injects the latest rollup
    instead of dumping raw turns.

    Returns the new rollup row, or null if there weren't enough sev≥2
    turn reflections to summarize.
    """
    from .services.reflexion_service import reflexion_service
    row = reflexion_service.rollup_conversation(db, conversation_id)
    return {"rollup": _serialize_reflection(row) if row else None}


@app.get("/eval/baselines")
def list_eval_baselines():
    """List committed baseline JSONs (ground-truth snapshots). These survive
    deploys; reports/ does not."""
    if not _EVAL_BASELINES_DIR.exists():
        return {"baselines": []}
    out = []
    for f in sorted(_EVAL_BASELINES_DIR.glob("baseline_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = _json.loads(f.read_text())
        except (_json.JSONDecodeError, OSError):
            continue
        out.append({
            "filename": f.name,
            "composite_score": data.get("composite_score"),
            "passed": data.get("passed"),
            "failed": data.get("failed"),
            "n_cases": data.get("n_cases"),
            "means": data.get("means"),
            "pipeline_model": data.get("pipeline_model"),
            "pipeline_version": data.get("pipeline_version"),
            "pipeline_source_hash": data.get("pipeline_source_hash"),
            "case_ids": data.get("case_ids"),
            "timestamp": data.get("timestamp"),
            "total_cost_usd": data.get("total_cost_usd"),
            "cost_per_case_usd": data.get("cost_per_case_usd"),
        })
    return {"baselines": out}


@app.get("/eval/baselines/{filename}")
def get_eval_baseline(filename: str):
    """Return the full baseline JSON for a given file — used by the
    eval-runs panel to drill into per-case results, scores, judge notes,
    and tools_called for a committed baseline."""
    if not _safe_eval_filename(filename, "baseline_", ".json"):
        raise HTTPException(400, "invalid baseline filename")
    p = _EVAL_BASELINES_DIR / filename
    if not p.exists():
        raise HTTPException(404, "baseline not found")
    try:
        return _json.loads(p.read_text())
    except (_json.JSONDecodeError, OSError):
        raise HTTPException(500, "baseline json invalid")
