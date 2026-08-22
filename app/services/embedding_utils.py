"""Shared embedding helpers — extracted from list_service when the List
primitive died (Slice 6). Everything that cosine-matches text (promises,
memory, feature dedup) goes through these two functions so all callers
share one embedding space.
"""

from __future__ import annotations

from ..llm.client import llm_client
from ..utils.embeddings import cosine_similarity


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


# Re-export so every existing caller keeps `from .embedding_utils import cosine`.
# The implementation moved to app/utils/embeddings — it is pure math and had
# grown three copies (see that module's docstring).
cosine = cosine_similarity
