"""Anthropic public pricing for cost estimation against local Claude Code
JSONL session logs.

Numbers are USD per 1,000 tokens (matches MODEL_PRICING in
app/llm/pricing.py for OpenAI). Cache rules per Anthropic's docs (as of
Apr 2026):
  - Cache writes (`cache_creation_input_tokens`):    1.25x input price (5 min TTL)
                                                     2.00x input price (1 hour TTL)
  - Cache reads  (`cache_read_input_tokens`):       0.10x input price

We don't get TTL info per turn in the JSONL — use the 5-min multiplier
since that's the default Claude Code uses. Off by at most ~60% on the
cache_creation slice; total spend is dominated by cache_read for big
sessions anyway.
"""

from __future__ import annotations

# Per 1,000 tokens, in USD. `cache_read` and `cache_create` are derived
# from `input` at call sites — don't hardcode them again.
MODEL_PRICING: dict[str, dict[str, float]] = {
    # Claude 4.x family (current Apr 2026 list price).
    "claude-opus-4":          {"input": 0.015,  "output": 0.075},
    "claude-opus-4-5":        {"input": 0.015,  "output": 0.075},
    "claude-opus-4-6":        {"input": 0.015,  "output": 0.075},
    "claude-opus-4-7":        {"input": 0.015,  "output": 0.075},
    "claude-sonnet-4":        {"input": 0.003,  "output": 0.015},
    "claude-sonnet-4-5":      {"input": 0.003,  "output": 0.015},
    "claude-sonnet-4-6":      {"input": 0.003,  "output": 0.015},
    "claude-haiku-4-5":       {"input": 0.001,  "output": 0.005},
    # Older lineage kept so historical sessions don't go uncosted.
    "claude-3-5-sonnet":      {"input": 0.003,  "output": 0.015},
    "claude-3-5-haiku":       {"input": 0.0008, "output": 0.004},
    "claude-3-opus":          {"input": 0.015,  "output": 0.075},
}

CACHE_READ_MULTIPLIER = 0.10
CACHE_CREATE_MULTIPLIER = 1.25  # 5-min TTL — Claude Code's default


def _resolve(model: str) -> dict[str, float]:
    """Map a full model id ("claude-opus-4-7-20251015") to its base pricing.
    We strip any trailing date suffix and try progressively shorter
    prefixes so a new minor revision still costs against its lineage.
    """
    if model in MODEL_PRICING:
        return MODEL_PRICING[model]
    # Strip date suffixes / versions like "-20251015"
    parts = model.split("-")
    while parts:
        candidate = "-".join(parts)
        if candidate in MODEL_PRICING:
            return MODEL_PRICING[candidate]
        parts.pop()
    return {"input": 0.0, "output": 0.0}


def cost_for_turn(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> float:
    """Estimate USD spend for one assistant turn. Splits inputs into
    fresh / cached-read / cached-write at their respective multipliers."""
    rates = _resolve(model)
    in_rate = rates["input"]
    out_rate = rates["output"]
    return (
        (input_tokens / 1_000) * in_rate
        + (output_tokens / 1_000) * out_rate
        + (cache_read_tokens / 1_000) * in_rate * CACHE_READ_MULTIPLIER
        + (cache_creation_tokens / 1_000) * in_rate * CACHE_CREATE_MULTIPLIER
    )


def known_models() -> list[str]:
    return list(MODEL_PRICING.keys())
