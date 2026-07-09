"""Background loop coroutines for the FastAPI process.

Extracted from main.py — these are the long-running workers the app starts in
its lifespan: the daily nudge scheduler, one-shot startup backfills, the memory
watchdog, daily capability-telemetry + urgency rollups, and the soft-delete
sweeper. main.py's lifespan owns STARTING them (asyncio.create_task); the loop
bodies live here so main stays pure app wiring.

All decision logic still lives in the respective services — these loops just
tick, call the service, and fail open. Service imports are kept lazy (inside
the loops / at function top) so a heavy or broken dependency can't crash boot
and an unused loop never drags its service in.
"""

import asyncio
from datetime import datetime as _dt

try:
    from zoneinfo import ZoneInfo  # py3.9+
except ImportError:  # pragma: no cover — Fly runs 3.11
    ZoneInfo = None  # type: ignore

from .db.database import SessionLocal
from .db.models import Note
from .deps import _fire_nudge_once, _next_fire, _settings_row
from .serializers import _excerpt_from_html


async def _proactive_nudge_loop():
    """Single tick driving every proactive surface: sleep callout +
    debounced whoop ping. Runs every 60s so the whoop debouncer has
    minute-level resolution while the sleep callout stays cheap. All
    decision logic lives in proactive_nudge; this loop just calls the
    checks and fails open. Renamed from `_sleep_nudge_loop` once the
    whoop debouncer landed."""
    # Import deferred to first run (drags in messaging + orchestrator), but
    # hoisted out of the per-tick while-loop so it's resolved once, not every
    # 60s.
    from .services.proactive_nudge import (
        maybe_fire_sleep_nudge,
        process_pending_whoop_nudge,
    )
    # Stagger past boot so we don't race the alembic upgrade.
    await asyncio.sleep(30)
    while True:
        try:
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

