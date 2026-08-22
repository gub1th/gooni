"""Vector math. No I/O, no LLM client, no DB — importable from anywhere.

THE cosine implementation. There were three: this one, `NoteService`'s private
`_cosine_similarity`, and `services/embedding_utils.cosine`. They were not
identical — the note_service copy had no length guard, so `zip` silently
truncated to the shorter vector and two embeddings of different dimensions
scored a plausible-looking similarity instead of 0. That fed `classify_note`'s
dedup gate, where a wrong "similar enough" reading skips a re-extraction.

Lives under `app/utils/` rather than `app/services/` because it depends on
nothing in the app: a service imports models and clients, this imports math.
`services/embedding_utils` keeps `embed_text` (which DOES need the LLM client)
and re-exports `cosine` from here so its callers are unchanged.
"""

from __future__ import annotations

import math


def cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """Cosine similarity in [-1, 1]. Returns 0.0 for empty or
    mismatched-length inputs rather than comparing a prefix."""
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    mag1 = math.sqrt(sum(a * a for a in vec1))
    mag2 = math.sqrt(sum(b * b for b in vec2))
    if mag1 == 0.0 or mag2 == 0.0:
        return 0.0
    return dot / (mag1 * mag2)
