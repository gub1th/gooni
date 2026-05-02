"""Local Claude Code usage parser.

Walks ``~/.claude/projects/**/*.jsonl`` (Claude Code's session-log
directory) and tallies token usage + estimated cost by day and by model.
Each `type: assistant` line carries a `message.usage` block + a
`message.model` + an ISO `timestamp` — that's all we need.

Same shape as ``openai_usage.fetch_month_to_date`` so the frontend can
share a chart component:

    {
      configured: bool,
      sessions, turns,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      est_cost_usd,
      by_day:    [{date: "YYYY-MM-DD", input, output, cache_read, cache_creation}, ...],
      by_model:  [{model, turns, input, output, cache_read, cache_creation, est_cost_usd}, ...],
      window_days: int,
    }

Cached at 6h TTL — JSONL files only grow, and re-walking the whole tree
on every dashboard load adds up.
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


def fetch(days: int = 30, refresh: bool = False) -> dict[str, Any]:
    """Aggregate Claude Code usage over the last `days` days.

    `days <= 0` means "all time".
    """
    if not is_configured():
        return {"configured": False, "window_days": days}

    cache_key = f"days={days}"
    now = time.time()
    if (
        not refresh
        and cache_key in _cache
        and now - _cache[cache_key]["fetched_at"] < _CACHE_TTL_SEC
    ):
        return _cache[cache_key]["value"]

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

    for entry in _walk_jsonls(_root()):
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message") or {}
        usage = msg.get("usage") or {}
        model = msg.get("model") or "unknown"
        ts = _parse_iso(entry.get("timestamp") or "")
        if ts is None:
            continue
        if cutoff and ts < cutoff:
            continue

        in_tok = int(usage.get("input_tokens") or 0)
        out_tok = int(usage.get("output_tokens") or 0)
        cr_tok = int(usage.get("cache_read_input_tokens") or 0)
        cc_tok = int(usage.get("cache_creation_input_tokens") or 0)

        # Skip turns with zero usage entirely (compaction headers etc.)
        if in_tok == 0 and out_tok == 0 and cr_tok == 0 and cc_tok == 0:
            continue

        turn_cost = cost_for_turn(model, in_tok, out_tok, cr_tok, cc_tok)

        sid = entry.get("sessionId")
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

    payload = {
        "configured": True,
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
        "fetched_at": now,
    }
    _cache[cache_key] = {"value": payload, "fetched_at": now}
    return payload
