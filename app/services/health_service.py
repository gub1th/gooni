"""Gooni health — 6-axis composite scoring.

Surfaces "how is the system doing right now" as 6 composite scores
(0-100) with per-component breakdowns. Drives the Build mode of the
dashboard. Computed on-demand on every Build mount — most underlying
queries are simple counts/aggregates over small N.

Axes:
  memory       — type balance + dedup quality + freshness
  chat         — eval rating + tool-call success + inverse-feedback
  engagement   — daily activity events vs target
  availability — process uptime + last-seen DB heartbeat
  cost         — today's claude-usage spike inverse vs 7d trailing avg
  connectors   — % of expected integrations healthy

Scores: composite 0-100. Components also normalized to 0-100 so the
drill-down rendering stays uniform. Weights add to 1.0 per axis.

Scoring is gameable — these are gut-check pulses, not formal SLAs.
Component values are shipped alongside the composite so Daniel can
see what's pulling each axis up or down.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import (
    Memory, ToolCall, EvalSegment, EvalMessageRating, Message,
    Note, Todo, HabitEntry, ClaudeUsageTurn, OAuthToken, TrackedRepo,
    WhoopSnapshot,
)


# Process start time stamped at import. Used by the availability axis.
PROCESS_START_AT = datetime.utcnow()
PROCESS_START_MONOTONIC = time.monotonic()


# ── helpers ─────────────────────────────────────────────────────────────


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _ratio_to_score(num: int, denom: int) -> float:
    """Convert a ratio to a 0-100 score. Denom 0 → 100 (no data = neutral)."""
    if denom <= 0:
        return 100.0
    return _clamp(num / denom * 100)


def _inverse_ratio(num: int, denom: int) -> float:
    """Lower-is-better ratio. 0% → 100, 100% → 0."""
    if denom <= 0:
        return 100.0
    return _clamp((1 - (num / denom)) * 100)


def _spike_score(today: float, avg: float) -> float:
    """Today's value vs trailing average. 1.0x → 100, 1.5x → 85,
    2x → 70, 3x → 40, 5x+ → 0. Below-avg is fine (full score)."""
    if avg <= 0:
        return 100.0
    ratio = today / avg
    if ratio <= 1.0:
        return 100.0
    # Linear-ish decay so the curve feels right by gut.
    if ratio <= 1.5: return _clamp(100 - (ratio - 1.0) * 30)
    if ratio <= 2.0: return _clamp(85 - (ratio - 1.5) * 30)
    if ratio <= 3.0: return _clamp(70 - (ratio - 2.0) * 30)
    if ratio <= 5.0: return _clamp(40 - (ratio - 3.0) * 20)
    return 0.0


# ── memory axis ─────────────────────────────────────────────────────────


def _memory_health(db: Session) -> dict[str, Any]:
    """30% type balance, 30% dedup quality, 40% freshness.

    type_balance: penalize extreme skew. score = (1 - max_type_fraction) * 100
      (50% split of types → 50, 100% one type → 0)
    dedup_quality: % of active rows w/ a key collision (proxy for paraphrase
      dupes — exact cosine search would be N^2)
    freshness: % of active rows w/ updated_at in last 60d
    """
    total = (
        db.query(func.count(Memory.id))
        .filter(Memory.is_active.is_(True))
        .scalar() or 0
    )
    components: list[dict[str, Any]] = []
    if total == 0:
        return {
            "axis": "memory",
            "score": 50.0,
            "headline": "No active memories yet.",
            "components": [],
        }

    # Type balance
    by_type = dict(
        db.query(Memory.type, func.count(Memory.id))
        .filter(Memory.is_active.is_(True))
        .group_by(Memory.type)
        .all()
    )
    max_frac = max(by_type.values()) / total if by_type else 1.0
    type_balance_score = _clamp((1 - max_frac) * 200)  # ×2 so a balanced 4-way ~75
    type_breakdown = ", ".join(
        f"{t}={c}" for t, c in sorted(by_type.items(), key=lambda x: -x[1])
    )
    components.append({
        "name": "type balance",
        "score": round(type_balance_score, 1),
        "weight": 0.30,
        "detail": type_breakdown,
    })

    # Dedup quality — count rows where `key` is shared with ≥1 other active row
    dup_keys = (
        db.query(Memory.key, func.count(Memory.id).label("n"))
        .filter(Memory.is_active.is_(True))
        .filter(Memory.key.isnot(None))
        .group_by(Memory.key)
        .having(func.count(Memory.id) > 1)
        .all()
    )
    dup_rows = sum(n for _, n in dup_keys)
    dedup_score = _inverse_ratio(dup_rows, total)
    components.append({
        "name": "dedup quality",
        "score": round(dedup_score, 1),
        "weight": 0.30,
        "detail": f"{dup_rows} rows in {len(dup_keys)} duplicate-key clusters",
    })

    # Freshness — % of active rows updated in last 60 days
    cutoff = datetime.utcnow() - timedelta(days=60)
    fresh = (
        db.query(func.count(Memory.id))
        .filter(Memory.is_active.is_(True))
        .filter(Memory.updated_at >= cutoff)
        .scalar() or 0
    )
    fresh_score = _ratio_to_score(fresh, total)
    components.append({
        "name": "freshness",
        "score": round(fresh_score, 1),
        "weight": 0.40,
        "detail": f"{fresh}/{total} updated in last 60d",
    })

    composite = sum(c["score"] * c["weight"] for c in components)
    headline = (
        f"{len(dup_keys)} dupe clusters · "
        f"{type_breakdown[:48]}{'…' if len(type_breakdown) > 48 else ''}"
    )
    return {
        "axis": "memory",
        "score": round(composite, 1),
        "headline": headline,
        "components": components,
    }


# ── chat axis ───────────────────────────────────────────────────────────


def _chat_health(db: Session) -> dict[str, Any]:
    """40% rolling eval rating, 40% tool-call success rate, 20% inverse
    feedback rate.

    Eval rating: avg of EvalMessageRating.rating (1-3) scaled to 0-100
      across the last 14 days. Treat empty as 50 (neutral, no signal).
    Tool success: status='done' / total across the last 100 ToolCall rows.
    Inverse feedback: 1 - (is_feedback messages / total user messages
      in last 14d). High critique rate = low chat quality.
    """
    components: list[dict[str, Any]] = []
    cutoff = datetime.utcnow() - timedelta(days=14)

    # Eval rating — rating is 1/2/3 (bad/meh/good). Map to (0/50/100).
    ratings = (
        db.query(EvalMessageRating.rating)
        .filter(EvalMessageRating.created_at >= cutoff)
        .all()
    )
    rating_values = [r[0] for r in ratings]
    if rating_values:
        rating_score = sum((v - 1) * 50 for v in rating_values) / len(rating_values)
    else:
        rating_score = 50.0
    components.append({
        "name": "eval rating",
        "score": round(rating_score, 1),
        "weight": 0.40,
        "detail": (
            f"{len(rating_values)} ratings · "
            f"avg {sum(rating_values)/len(rating_values):.1f}/3"
            if rating_values else "no ratings in last 14d"
        ),
    })

    # Tool success — last 100 calls
    recent_calls = (
        db.query(ToolCall.status)
        .order_by(ToolCall.id.desc())
        .limit(100)
        .all()
    )
    total_calls = len(recent_calls)
    done_calls = sum(1 for (s,) in recent_calls if s == "done")
    failed_calls = sum(1 for (s,) in recent_calls if s == "failed")
    tool_score = _ratio_to_score(done_calls, total_calls)
    components.append({
        "name": "tool success",
        "score": round(tool_score, 1),
        "weight": 0.40,
        "detail": f"{done_calls}/{total_calls} done · {failed_calls} failed",
    })

    # Inverse feedback — last 14d
    user_msgs = (
        db.query(func.count(Message.id))
        .filter(Message.role == "user")
        .filter(Message.created_at >= cutoff)
        .scalar() or 0
    )
    feedback_msgs = (
        db.query(func.count(Message.id))
        .filter(Message.is_feedback.is_(True))
        .filter(Message.created_at >= cutoff)
        .scalar() or 0
    )
    inv_score = _inverse_ratio(feedback_msgs, user_msgs)
    components.append({
        "name": "inverse feedback",
        "score": round(inv_score, 1),
        "weight": 0.20,
        "detail": f"{feedback_msgs}/{user_msgs} flagged as critique",
    })

    composite = sum(c["score"] * c["weight"] for c in components)
    headline = (
        f"{done_calls}/{total_calls} tools done · "
        f"{len(rating_values)} recent evals"
    )
    return {
        "axis": "chat",
        "score": round(composite, 1),
        "headline": headline,
        "components": components,
    }


# ── engagement axis ────────────────────────────────────────────────────


# Target = 10 events/day. Daniel's call. Realistic for solo use.
ENGAGEMENT_TARGET = 10


def _engagement_health(db: Session) -> dict[str, Any]:
    """Today's interaction events vs target. Counts:
    user messages + notes created + todos created/done + habit entries.

    Score = today / target * 100, capped at 100.
    """
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=7)

    def _count_today(q):
        return q.scalar() or 0

    msgs_today = _count_today(
        db.query(func.count(Message.id))
        .filter(Message.role == "user")
        .filter(Message.created_at >= today_start)
    )
    notes_today = _count_today(
        db.query(func.count(Note.id))
        .filter(Note.created_at >= today_start)
    )
    todos_today = _count_today(
        db.query(func.count(Todo.id))
        .filter(Todo.created_at >= today_start, Todo.deleted_at.is_(None))
    )
    todos_done_today = _count_today(
        db.query(func.count(Todo.id))
        .filter(Todo.completed_at >= today_start, Todo.deleted_at.is_(None))
    )
    habits_today = _count_today(
        db.query(func.count(HabitEntry.id))
        .filter(HabitEntry.created_at >= today_start)
    )

    total_today = msgs_today + notes_today + todos_today + todos_done_today + habits_today
    score = _clamp(total_today / ENGAGEMENT_TARGET * 100)

    # 7-day rolling for context
    def _count_week(q):
        return q.scalar() or 0
    msgs_week = _count_week(
        db.query(func.count(Message.id))
        .filter(Message.role == "user")
        .filter(Message.created_at >= week_start)
    )
    notes_week = _count_week(
        db.query(func.count(Note.id))
        .filter(Note.created_at >= week_start)
    )
    todos_week = _count_week(
        db.query(func.count(Todo.id))
        .filter(Todo.created_at >= week_start, Todo.deleted_at.is_(None))
    )

    components = [
        {"name": "chat messages", "score": _clamp(msgs_today / 5 * 100), "weight": 0.30,
         "detail": f"{msgs_today} today · {msgs_week} this week"},
        {"name": "notes", "score": _clamp(notes_today / 2 * 100), "weight": 0.20,
         "detail": f"{notes_today} today · {notes_week} this week"},
        {"name": "todos", "score": _clamp((todos_today + todos_done_today) / 3 * 100), "weight": 0.30,
         "detail": f"{todos_today} created · {todos_done_today} done today"},
        {"name": "habits", "score": _clamp(habits_today / 2 * 100), "weight": 0.20,
         "detail": f"{habits_today} entries today"},
    ]

    return {
        "axis": "engagement",
        "score": round(score, 1),
        "headline": f"{total_today}/{ENGAGEMENT_TARGET} events today · {msgs_week + notes_week + todos_week} this week",
        "components": components,
    }


# ── availability axis ──────────────────────────────────────────────────


def _availability_health(db: Session) -> dict[str, Any]:
    """50% process uptime, 50% DB-OK ping."""
    uptime_seconds = time.monotonic() - PROCESS_START_MONOTONIC

    # Uptime scoring
    if uptime_seconds < 5 * 60:
        uptime_score = 40.0  # very fresh restart
    elif uptime_seconds < 60 * 60:
        uptime_score = 70.0  # recent restart
    else:
        uptime_score = 100.0

    # DB-OK — trivial SELECT 1
    try:
        db.execute(func.now().select())
        db_ok = True
    except Exception:
        db_ok = False
    db_score = 100.0 if db_ok else 0.0

    components = [
        {"name": "process uptime", "score": uptime_score, "weight": 0.50,
         "detail": _fmt_uptime(uptime_seconds)},
        {"name": "database", "score": db_score, "weight": 0.50,
         "detail": "OK" if db_ok else "FAILED"},
    ]
    composite = sum(c["score"] * c["weight"] for c in components)
    return {
        "axis": "availability",
        "score": round(composite, 1),
        "headline": (
            f"up {_fmt_uptime(uptime_seconds)}"
            + ("" if db_ok else " · DB unhealthy")
        ),
        "components": components,
    }


def _fmt_uptime(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60: return f"{seconds}s"
    if seconds < 3600: return f"{seconds // 60}m"
    if seconds < 86400: return f"{seconds // 3600}h {(seconds % 3600) // 60}m"
    return f"{seconds // 86400}d {(seconds % 86400) // 3600}h"


# ── cost axis ──────────────────────────────────────────────────────────


def _cost_health(db: Session) -> dict[str, Any]:
    """Today's claude-usage turns vs 7d trailing avg. Spike inverse.

    Cheap proxy for actual spend — every turn is one API call. No
    per-turn $ multiplier yet. If spend ever spikes 3x vs trailing,
    score drops to surface the anomaly.
    """
    now = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=7)

    today_turns = (
        db.query(func.count(ClaudeUsageTurn.id))
        .filter(ClaudeUsageTurn.ts >= today_start)
        .scalar() or 0
    )
    week_turns = (
        db.query(func.count(ClaudeUsageTurn.id))
        .filter(ClaudeUsageTurn.ts >= week_start)
        .filter(ClaudeUsageTurn.ts < today_start)
        .scalar() or 0
    )
    week_avg = week_turns / 7 if week_turns else 0

    score = _spike_score(today_turns, week_avg)

    headline = (
        f"{today_turns} turns today · "
        f"{week_avg:.1f}/day avg"
    )
    return {
        "axis": "cost",
        "score": round(score, 1),
        "headline": headline,
        "components": [
            {"name": "today vs 7d avg", "score": round(score, 1), "weight": 1.0,
             "detail": (
                 f"today: {today_turns} · 7d avg: {week_avg:.1f}"
                 + (f" · {today_turns / week_avg:.2f}x" if week_avg > 0 else "")
             )},
        ],
    }


# ── connectors axis ────────────────────────────────────────────────────


def _connectors_health(db: Session) -> dict[str, Any]:
    """% of expected integrations healthy. Each integration scored 0-100
    based on (configured + connected + recent activity).

    Probes:
      Whoop:    OAuth token exists AND last WhoopSnapshot < 48h
      GitHub:   OAuth token exists AND >0 TrackedRepo rows
      Google:   OAuth token exists for 'google' provider
    """
    components: list[dict[str, Any]] = []

    # Whoop
    whoop_token = (
        db.query(OAuthToken).filter(OAuthToken.provider == "whoop").first()
    )
    if whoop_token is None:
        whoop_score = 50.0  # not configured = neutral, not penalized
        whoop_detail = "not connected"
    else:
        last_snap = (
            db.query(WhoopSnapshot)
            .order_by(WhoopSnapshot.date.desc())
            .first()
        )
        if last_snap and (datetime.utcnow().date() - last_snap.date).days <= 2:
            whoop_score = 100.0
            whoop_detail = f"last pull {last_snap.date.isoformat()}"
        else:
            whoop_score = 40.0
            whoop_detail = "stale (>2d since last pull)"
    components.append({"name": "Whoop", "score": whoop_score, "weight": 1/3, "detail": whoop_detail})

    # GitHub
    gh_token = (
        db.query(OAuthToken).filter(OAuthToken.provider == "github").first()
    )
    if gh_token is None:
        gh_score = 50.0
        gh_detail = "not connected"
    else:
        n_repos = db.query(func.count(TrackedRepo.id)).scalar() or 0
        gh_score = 100.0 if n_repos > 0 else 60.0
        gh_detail = f"{n_repos} tracked repos" if n_repos else "no tracked repos"
    components.append({"name": "GitHub", "score": gh_score, "weight": 1/3, "detail": gh_detail})

    # Google Calendar. NOTE: the OAuth flow stores this token under
    # provider="google_calendar" (see google_calendar.py), NOT "google" —
    # querying the wrong string made a connected calendar read as "not
    # connected" forever.
    google_token = (
        db.query(OAuthToken).filter(OAuthToken.provider == "google_calendar").first()
    )
    if google_token is None:
        google_score = 50.0
        google_detail = "not connected"
    else:
        google_score = 100.0
        google_detail = "connected"
    components.append({"name": "Google Calendar", "score": google_score, "weight": 1/3, "detail": google_detail})

    composite = sum(c["score"] * c["weight"] for c in components)
    healthy = sum(1 for c in components if c["score"] >= 80)
    return {
        "axis": "connectors",
        "score": round(composite, 1),
        "headline": f"{healthy}/{len(components)} healthy",
        "components": components,
    }


# ── top-level ───────────────────────────────────────────────────────────


def compute_all(db: Session) -> dict[str, Any]:
    """Run all 6 axes. Each axis is independently fallible — wrap in
    try/except so one explosion doesn't take down the dashboard."""
    out: dict[str, Any] = {"axes": []}
    for fn in (
        _memory_health, _chat_health, _engagement_health,
        _availability_health, _cost_health, _connectors_health,
    ):
        try:
            out["axes"].append(fn(db))
        except Exception as e:
            out["axes"].append({
                "axis": fn.__name__.replace("_health", "").lstrip("_"),
                "score": 0.0,
                "headline": f"compute error: {type(e).__name__}",
                "components": [],
                "error": str(e),
            })
    return out
