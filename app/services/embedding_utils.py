"""Shared embedding helpers — extracted from list_service when the List
primitive died (Slice 6). Everything that cosine-matches text (promises,
memory, feature dedup) goes through these two functions so all callers
share one embedding space.
"""

from __future__ import annotations

import math

from ..llm.client import llm_client


def embed_text(raw: str) -> list[float] | None:
    """Wrap llm_client.generate_embedding; callers stay synchronous and
    failures degrade to None (cosine paths self-skip)."""
    if not raw or not raw.strip():
        return None
    try:
        embedding, _ = llm_client.generate_embedding(raw.strip())
        return embedding or None
    except Exception as e:
        print(f"[embedding_utils] embed error: {e}")
        return None


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
