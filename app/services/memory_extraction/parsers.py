"""JSON parsing + candidate validation helpers for memory extraction."""

import json

from ...common import strip_code_fence


VALID_TYPES = {"fact", "routine", "constraint", "episode"}


def _parse_json_array(raw: str) -> list:
    cleaned = strip_code_fence(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"memory extraction JSON parse error: {e} | raw: {cleaned[:200]}")
        return []
    return parsed if isinstance(parsed, list) else []


def _parse_json_object(raw: str) -> dict | None:
    cleaned = strip_code_fence(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"memory reconcile JSON parse error: {e} | raw: {cleaned[:200]}")
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate_candidate(c: dict) -> bool:
    if not isinstance(c, dict):
        return False
    if c.get("type") not in VALID_TYPES:
        return False
    if not c.get("content") or not isinstance(c["content"], str):
        return False
    conf = c.get("confidence")
    if not isinstance(conf, (int, float)) or not (0.0 <= conf <= 1.0):
        return False
    ctx = c.get("context") or {}
    if not isinstance(ctx, dict):
        return False
    if ctx.get("scope") not in ("global", "contextual"):
        return False
    return True
