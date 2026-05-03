"""Claude Code usage parser.

Two data sources, picked at runtime:

  1. **Local JSONLs** — ``~/.claude/projects/**/*.jsonl`` on the dev
     machine. Each `type: assistant` line carries a `message.usage` block
     + `message.model` + ISO `timestamp`. Default when the directory
     exists.

  2. **DB rows** — ``claude_usage_turns`` table populated by
     ``scripts/upload_claude_usage.py`` POSTing to ``/dashboard/claude-usage/
     ingest``. Used on prod (Fly) where there are no JSONLs to walk.

Output shape (same for both sources, so the frontend chart component
doesn't care):

    {
      configured: bool,
      available:  bool,   # True iff there's data to show (jsonls OR DB rows)
      sessions, turns,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      est_cost_usd,
      by_day:    [{date: "YYYY-MM-DD", input, output, cache_read, cache_creation}, ...],
      by_model:  [{model, turns, input, output, cache_read, cache_creation, est_cost_usd}, ...],
      window_days: int,
    }

Cached at 6h TTL on the JSONL path — JSONL files only grow, and re-walking
the whole tree on every dashboard load adds up. DB path bypasses cache
(Postgres/SQLite read is cheap and ingest writes should be reflected
immediately).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..llm.anthropic_pricing import cost_for_turn


_DEFAULT_ROOT = Path.home() / ".claude" / "projects"
_CACHE_TTL_SEC = 6 * 60 * 60
_cache: dict[str, Any] = {}  # keyed by `days` window


def is_configured() -> bool:
    """We're 'configured' as long as the projects dir exists. Honors a
    CLAUDE_PROJECTS_DIR env override for users who moved the data."""
    return _root().exists()


def _root() -> Path:
    override = os.getenv("CLAUDE_PROJECTS_DIR")
    return Path(override) if override else _DEFAULT_ROOT


def _parse_iso(ts: str) -> datetime | None:
    if not ts:
        return None
    s = ts.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _empty_day_slot() -> dict[str, int]:
    return {
        "input": 0, "output": 0,
        "cache_read": 0, "cache_creation": 0,
    }


def _empty_model_slot() -> dict[str, Any]:
    return {
        "turns": 0,
        "input": 0, "output": 0,
        "cache_read": 0, "cache_creation": 0,
        "est_cost_usd": 0.0,
    }


def _walk_jsonls(root: Path):
    """Yield every session JSONL under root. Skips unreadable files
    silently — Claude Code occasionally writes empty / locked files."""
    if not root.exists():
        return
    for path in root.rglob("*.jsonl"):
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def fetch(days: int = 30, refresh: bool = False, db=None) -> dict[str, Any]:
    """Aggregate Claude Code usage over the last `days` days.

    `days <= 0` means "all time".

    Source priority: local JSONLs (if dir exists) > DB rows. Prod Fly
    boxes have no JSONLs so they fall through to the DB-row path.
    """
    if is_configured():
        return _fetch_from_jsonls(days=days, refresh=refresh)
    if db is not None:
        return _fetch_from_db(days=days, db=db)
    # No JSONLs and no DB session passed — surface as not-available so
    # the frontend hides the section entirely on prod.
    return {"configured": False, "available": False, "window_days": days}


def _empty_payload(days: int, available: bool) -> dict[str, Any]:
    return {
        "configured": True,
        "available": available,
        "window_days": days,
        "sessions": 0,
        "turns": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "est_cost_usd": 0.0,
        "by_day": [],
        "by_model": [],
        "fetched_at": time.time(),
    }


def _aggregate(
    rows: list[tuple[str, datetime, str, int, int, int, int]],
    days: int,
) -> dict[str, Any]:
    """Shared aggregator. `rows` is a list of
    (session_id, ts, model, in, out, cache_read, cache_creation)."""
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=days)
        if days > 0 else None
    )

    by_day: dict[str, dict[str, int]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    sessions: set[str] = set()
    turns = 0
    total_in = 0
    total_out = 0
    total_cr = 0
    total_cc = 0
    total_cost = 0.0

    for sid, ts, model, in_tok, out_tok, cr_tok, cc_tok in rows:
        if ts is None:
            continue
        if cutoff and ts < cutoff:
            continue
        if in_tok == 0 and out_tok == 0 and cr_tok == 0 and cc_tok == 0:
            continue

        turn_cost = cost_for_turn(model, in_tok, out_tok, cr_tok, cc_tok)
        if sid:
            sessions.add(sid)
        turns += 1
        total_in += in_tok
        total_out += out_tok
        total_cr += cr_tok
        total_cc += cc_tok
        total_cost += turn_cost

        date_key = ts.astimezone(timezone.utc).strftime("%Y-%m-%d")
        slot = by_day.setdefault(date_key, _empty_day_slot())
        slot["input"] += in_tok
        slot["output"] += out_tok
        slot["cache_read"] += cr_tok
        slot["cache_creation"] += cc_tok

        mslot = by_model.setdefault(model, _empty_model_slot())
        mslot["turns"] += 1
        mslot["input"] += in_tok
        mslot["output"] += out_tok
        mslot["cache_read"] += cr_tok
        mslot["cache_creation"] += cc_tok
        mslot["est_cost_usd"] += turn_cost

    by_day_list = [
        {"date": d, **vals}
        for d, vals in sorted(by_day.items())
    ]
    by_model_list = [
        {"model": m, **vals, "est_cost_usd": round(vals["est_cost_usd"], 4)}
        for m, vals in sorted(by_model.items(), key=lambda kv: -kv[1]["est_cost_usd"])
    ]

    return {
        "configured": True,
        "available": turns > 0,
        "window_days": days,
        "sessions": len(sessions),
        "turns": turns,
        "input_tokens": total_in,
        "output_tokens": total_out,
        "cache_read_tokens": total_cr,
        "cache_creation_tokens": total_cc,
        "est_cost_usd": round(total_cost, 4),
        "by_day": by_day_list,
        "by_model": by_model_list,
        "fetched_at": time.time(),
    }


def _fetch_from_jsonls(days: int, refresh: bool) -> dict[str, Any]:
    cache_key = f"days={days}"
    now = time.time()
    if (
        not refresh
        and cache_key in _cache
        and now - _cache[cache_key]["fetched_at"] < _CACHE_TTL_SEC
    ):
        return _cache[cache_key]["value"]

    rows: list[tuple[str, datetime, str, int, int, int, int]] = []
    for entry in _walk_jsonls(_root()):
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message") or {}
        usage = msg.get("usage") or {}
        rows.append((
            entry.get("sessionId") or "",
            _parse_iso(entry.get("timestamp") or ""),
            msg.get("model") or "unknown",
            int(usage.get("input_tokens") or 0),
            int(usage.get("output_tokens") or 0),
            int(usage.get("cache_read_input_tokens") or 0),
            int(usage.get("cache_creation_input_tokens") or 0),
        ))

    payload = _aggregate(rows, days=days)
    _cache[cache_key] = {"value": payload, "fetched_at": now}
    return payload


def _fetch_from_db(days: int, db) -> dict[str, Any]:
    """Read pre-ingested turns out of the claude_usage_turns table.
    No cache — the table only grows when the uploader posts, and the read
    is just a column scan with a timestamp filter."""
    from ..db.models import ClaudeUsageTurn

    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=days)
        if days > 0 else None
    )
    q = db.query(ClaudeUsageTurn)
    if cutoff:
        q = q.filter(ClaudeUsageTurn.ts >= cutoff)
    db_rows = q.all()

    rows: list[tuple[str, datetime, str, int, int, int, int]] = [
        (
            r.session_id,
            r.ts if r.ts and r.ts.tzinfo else (r.ts.replace(tzinfo=timezone.utc) if r.ts else None),
            r.model,
            r.input_tokens,
            r.output_tokens,
            r.cache_read_tokens,
            r.cache_creation_tokens,
        )
        for r in db_rows
    ]
    return _aggregate(rows, days=days)
