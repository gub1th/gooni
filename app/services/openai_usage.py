"""OpenAI organization usage + costs reader.

Talks to the Admin API (https://api.openai.com/v1/organization/usage/*,
.../costs). Requires an `OPENAI_ADMIN_KEY` (sk-admin-...) — the regular
`OPENAI_API_KEY` does NOT have permission for these endpoints.

Caches the month-to-date roll-up for 6 hours so the dashboard doesn't
hit the API on every page load. Cache is in-process; restart clears it.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx


COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions"
EMBEDDINGS_URL = "https://api.openai.com/v1/organization/usage/embeddings"
COSTS_URL = "https://api.openai.com/v1/organization/costs"

_CACHE_TTL_SEC = 6 * 60 * 60
_cache: dict[str, Any] = {"value": None, "fetched_at": 0.0}


def _admin_key() -> str | None:
    return os.getenv("OPENAI_ADMIN_KEY")


def is_configured() -> bool:
    return bool(_admin_key())


def _month_start_unix() -> int:
    """Unix timestamp for 00:00 UTC on the 1st of the current month."""
    now = datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp())


def _fetch_paginated(url: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """Walk OpenAI's `next_page` cursor until exhausted. Each response is
    `{data: [{start_time, end_time, results: [...]}], next_page: ...}`.
    Returns the flat list of bucket results across all pages.
    """
    key = _admin_key()
    if not key:
        return []
    headers = {"Authorization": f"Bearer {key}"}
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(20):  # hard cap so a misbehaving cursor can't loop forever
        q = dict(params)
        if cursor:
            q["page"] = cursor
        resp = httpx.get(url, headers=headers, params=q, timeout=15)
        resp.raise_for_status()
        body = resp.json()
        for bucket in body.get("data", []):
            out.extend(bucket.get("results", []))
        cursor = body.get("next_page")
        if not cursor:
            break
    return out


def _aggregate_completions(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Sum tokens + requests per model across the buckets we got back."""
    by_model: dict[str, dict[str, int]] = {}
    for r in rows:
        model = r.get("model") or "unknown"
        slot = by_model.setdefault(
            model, {"input_tokens": 0, "output_tokens": 0, "requests": 0}
        )
        slot["input_tokens"] += int(r.get("input_tokens") or 0)
        slot["output_tokens"] += int(r.get("output_tokens") or 0)
        slot["requests"] += int(r.get("num_model_requests") or 0)
    return by_model


def _aggregate_embeddings(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    by_model: dict[str, dict[str, int]] = {}
    for r in rows:
        model = r.get("model") or "unknown"
        slot = by_model.setdefault(model, {"input_tokens": 0, "requests": 0})
        slot["input_tokens"] += int(r.get("input_tokens") or 0)
        slot["requests"] += int(r.get("num_model_requests") or 0)
    return by_model


def _aggregate_costs(rows: list[dict[str, Any]]) -> float:
    total = 0.0
    for r in rows:
        amount = r.get("amount") or {}
        try:
            total += float(amount.get("value") or 0)
        except (TypeError, ValueError):
            continue
    return total


def fetch_month_to_date(refresh: bool = False) -> dict[str, Any]:
    """Aggregate month-to-date OpenAI spend + tokens + requests broken down
    by model. Returns:
        {
          configured: bool,
          month_start_unix: int,
          spend_usd: float,
          requests: int,
          input_tokens: int,
          output_tokens: int,
          by_model: [
            {model, kind, requests, input_tokens, output_tokens, ...},
            ...
          ],
          fetched_at: float,
        }
    """
    if not is_configured():
        return {"configured": False}

    now = time.time()
    if (
        not refresh
        and _cache["value"] is not None
        and now - _cache["fetched_at"] < _CACHE_TTL_SEC
    ):
        return _cache["value"]

    start = _month_start_unix()
    # bucket_width=1d returns daily buckets — coarse enough that month-long
    # windows fit in a few pages without losing the right model granularity.
    base_params = {
        "start_time": start,
        "bucket_width": "1d",
        "group_by": "model",
        "limit": 31,
    }

    try:
        completions = _fetch_paginated(COMPLETIONS_URL, base_params)
        embeddings = _fetch_paginated(EMBEDDINGS_URL, base_params)
        costs = _fetch_paginated(COSTS_URL, {
            "start_time": start,
            "bucket_width": "1d",
            "limit": 31,
        })
    except httpx.HTTPStatusError as e:
        # 401 = bad admin key, 403 = key lacks usage scope, 429 = rate limited.
        # Surface a clear non-empty payload so the UI can render setup help.
        return {
            "configured": True,
            "error": f"{e.response.status_code} {e.response.reason_phrase}",
            "month_start_unix": start,
        }
    except Exception as e:
        return {
            "configured": True,
            "error": str(e),
            "month_start_unix": start,
        }

    by_model_chat = _aggregate_completions(completions)
    by_model_emb = _aggregate_embeddings(embeddings)

    by_model_list = []
    for model, vals in sorted(by_model_chat.items()):
        by_model_list.append({
            "model": model,
            "kind": "chat",
            "requests": vals["requests"],
            "input_tokens": vals["input_tokens"],
            "output_tokens": vals["output_tokens"],
            "total_tokens": vals["input_tokens"] + vals["output_tokens"],
        })
    for model, vals in sorted(by_model_emb.items()):
        by_model_list.append({
            "model": model,
            "kind": "embedding",
            "requests": vals["requests"],
            "input_tokens": vals["input_tokens"],
            "output_tokens": 0,
            "total_tokens": vals["input_tokens"],
        })

    total_in = sum(m["input_tokens"] for m in by_model_list)
    total_out = sum(m["output_tokens"] for m in by_model_list)
    total_req = sum(m["requests"] for m in by_model_list)
    spend = _aggregate_costs(costs)

    payload = {
        "configured": True,
        "month_start_unix": start,
        "spend_usd": round(spend, 4),
        "requests": total_req,
        "input_tokens": total_in,
        "output_tokens": total_out,
        "total_tokens": total_in + total_out,
        "by_model": by_model_list,
        "fetched_at": now,
    }
    _cache["value"] = payload
    _cache["fetched_at"] = now
    return payload
