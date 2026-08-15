"""Background loop coroutines for the FastAPI process.

Extracted from main.py — these are the long-running workers the app starts in
its lifespan: one-shot startup backfills, the memory watchdog, the hourly
integration refresh, and — since 2026-08-15 — the PROACTIVE LOOP.

That last one ends the 2026-07 proactiveness reset on purpose. The old daily
digest and whoop-ping schedulers were deleted because they were SCHEDULE-driven:
they fired whether or not there was anything to say, and a signal that fires on
a timer stops being read. The reset's own note said the next proactive system
should start from asymmetric value, be event-driven rather than schedule-driven,
and carry a per-day cap. `_proactive_loop` is a cadence, but the cadence only
decides when to LOOK — every gate on whether to speak is about what is actually
true right now (see services/proactive_service), and the WhatsApp reach-out is
silence-triggered and capped at one a day.

main.py's lifespan owns STARTING them (asyncio.create_task); the loop bodies
live here so main stays pure app wiring.

All decision logic still lives in the respective services — these loops just
tick, call the service, and fail open. Service imports are kept lazy (inside
the loops / at function top) so a heavy or broken dependency can't crash boot
and an unused loop never drags its service in.
"""

import asyncio

from .db.database import SessionLocal
from .db.models import Note
from .serializers import _excerpt_from_html

# How often the integration-refresh loop pulls whoop/leetcode/24hr. Hourly is
# plenty for these signals (a gym check-in, daily solve count, recovery); tune
# this one constant to change cadence.
INTEGRATION_REFRESH_INTERVAL_S = 3600


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



# --- integration refresh (whoop + leetcode + 24hr fitness) ------------------
# The ONE periodic "cron" for external integrations. Same background-loop
# pattern as the two loops above; runs server-side on Fly so the log stays
# current + complete even on days the app is never opened. whoop/leetcode also
# still lazy-pull on read (their tiles) -- this loop just proactively warms the
# cache and fills the 24hr `exercise` cell, which has no read tile to hang a
# lazy-fetch on. Each sub-refresh is independently guarded: one failure never
# blocks the others, and nothing here can crash boot.


def _refresh_leetcode() -> None:
    from .services import leetcode_service
    db = SessionLocal()
    try:
        leetcode_service.get_or_fetch(db, force=True)  # commits internally
    finally:
        db.close()


def _refresh_whoop() -> None:
    from .services import whoop
    db = SessionLocal()
    try:
        whoop.fetch_today_snapshot(db)  # raises if not connected -> caller logs
    finally:
        db.close()


def _refresh_24hr() -> None:
    from .services import fitness_24hr
    db = SessionLocal()
    try:
        res = fitness_24hr.sync_today(db)  # writes the exercise cell if empty
        if res.get("wrote"):
            print(f"[refresh] 24hr: {res}", flush=True)
    finally:
        db.close()


def _run_integration_refreshes() -> None:
    """Blocking body (network + sync DB) -- run off the event loop via
    asyncio.to_thread so external API latency can't stall request handling."""
    for name, fn in (("leetcode", _refresh_leetcode), ("whoop", _refresh_whoop), ("24hr", _refresh_24hr)):
        try:
            fn()
        except Exception as e:
            print(f"[refresh] {name} failed: {e}", flush=True)


async def _integration_refresh_loop():
    """Every INTEGRATION_REFRESH_INTERVAL_S, refresh whoop/leetcode/24hr."""
    await asyncio.sleep(15)  # let boot settle before the first pull
    while True:
        try:
            await asyncio.to_thread(_run_integration_refreshes)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[refresh] loop error: {e}", flush=True)
        await asyncio.sleep(INTEGRATION_REFRESH_INTERVAL_S)


# --- the proactive loop -----------------------------------------------------
# The one place Gooni speaks first. Every ~15 minutes (PROACTIVE_INTERVAL_MIN)
# it looks at what the sensors and the deterministic rankers already know and
# usually decides there is nothing worth saying. See
# services/proactive_service for the gates; this is just the clock.
#
# The model call inside is a synchronous network round trip, so the whole tick
# goes off the event loop via asyncio.to_thread — the same treatment
# _integration_refresh_loop gives its API pulls, and for the same reason: no
# user-facing request may ever wait on background inference.


async def _proactive_loop():
    """Tick the proactive layer on its configured cadence.

    Fails open in every direction. A tick that raises is logged and the loop
    keeps its cadence — a proactive layer that can take the app down with it is
    strictly worse than one that says nothing, and saying nothing is its normal
    output anyway.

    The interval is re-read every pass so PROACTIVE_INTERVAL_MIN takes effect on
    the next tick rather than at the next restart, and the enabled check lives
    inside `tick()` for the same reason — the loop keeps spinning while disabled
    (at zero cost, no context build and no model call) so flipping the Settings
    toggle back on doesn't need a redeploy.
    """
    from .services import proactive_service

    # Long enough that a boot storm (alembic, backfills, the fly-revive scan)
    # is finished before the first tick spends a model call.
    await asyncio.sleep(90)
    while True:
        try:
            result = await asyncio.to_thread(proactive_service.run_tick)
            status = (result or {}).get("status")
            # Only the interesting outcomes get a line. `skipped_live` and
            # `none` are the steady state and would otherwise be 96 log lines a
            # day saying nothing happened.
            if status not in ("none", "skipped_live", "skipped_disabled"):
                print(f"[proactive] tick: {status}", flush=True)
        except asyncio.CancelledError:
            return
        except Exception as e:
            print(f"[proactive] loop error: {e}", flush=True)
        await asyncio.sleep(proactive_service.interval_minutes() * 60)
