
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    McpCall,
    Note,
)

from ..serializers import (
    _serialize_note_lite
)


router = APIRouter()


@router.get("/dashboard")
def get_dashboard_stats(db: Session = Depends(get_db)):
    from datetime import date, datetime, timedelta

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


@router.get("/dashboard/openai-usage")
def get_openai_usage(refresh: bool = False):
    """Month-to-date OpenAI spend + tokens + requests broken down by model.
    Pulled live from the OpenAI Admin API and cached in-process for 6h.
    Returns {configured: false} if OPENAI_ADMIN_KEY is not set so the UI
    can render setup help instead of empty zeros.
    """
    from ..services import openai_usage
    return openai_usage.fetch_month_to_date(refresh=refresh)


@router.get("/dashboard/claude-usage")
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
    from ..services import claude_usage
    return claude_usage.fetch(days=days, refresh=refresh, db=db)


@router.post("/dashboard/claude-usage/ingest")
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
    from ..db.models import ClaudeUsageTurn

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


@router.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    """Aggregated counters for the Stats view. Returns a flat dict so the
    frontend can render each metric without knowing the source query.
    """
    from ..db.models import Note as _Note, Conversation as _Conv, Message as _Msg, ListItem as _LI
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


@router.get("/dashboard/take")
def get_gooni_take(force: bool = False, db: Session = Depends(get_db)):
    """Gooni's Take — ONE tight sentence on Daniel's current focus thread.

    Persisted in `gooni_takes` (kind="focus") — one row per UTC day. Re-fetching
    the same day returns the stored row; ?force=1 regenerates and overwrites.
    """
    from ..services.take_service import get_or_generate

    return get_or_generate(db, "focus", force=force)


@router.get("/dashboard/dev-take")
def get_dev_take(force: bool = False, db: Session = Depends(get_db)):
    """Dev Take — short paragraph on what Daniel shipped on Gooni today,
    derived from commits + PR titles across all tracked repos (last 24h).

    Persisted in `gooni_takes` (kind="dev") — one row per UTC day. ?force=1
    regenerates. Returns an empty take when no tracked repos / no commits;
    no row is written in that case.
    """
    from ..services.take_service import get_or_generate

    return get_or_generate(db, "dev", force=force)


@router.get("/dashboard/takes/history")
def list_takes_history(
    kind: str = "focus",
    limit: int = 30,
    db: Session = Depends(get_db),
):
    """Reverse-chronological list of stored takes for `kind`. Future
    history surfaces (e.g. "how my focus has drifted") read this."""
    from ..services.take_service import list_history

    if kind not in {"focus", "dev"}:
        raise HTTPException(status_code=400, detail="kind must be focus|dev")
    return list_history(db, kind, limit=limit)


@router.get("/dashboard/dev-activity")
def dashboard_dev_activity(refresh: bool = False, db: Session = Depends(get_db)):
    """Per-repo dev activity (today, recent commits, streak) + aggregate
    streak and weekly LLM summary across all tracked repos.

    `?refresh=1` bypasses the 60s in-memory cache so the user can yank a
    fresh pull from GitHub when they've just committed.
    """
    from ..services import dev_activity_service as das
    return das.dev_activity_service.build(db, force=refresh)


@router.get("/dashboard/time-on-gooni")
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
    from ..services import github as gh
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
