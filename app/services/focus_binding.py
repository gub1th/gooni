"""Shared helper for "everything maps to Focus" (G3).

Wires a `supports` edge from any primitive (Todo / List / Message / Note
/ Habit) to its nearest matching active Focus by cosine similarity. One
edge per call — strongest signal wins, no fan-out to multiple focuses
because multi-edges crowd traversal results.

Centralizes:
  - Active-focus tuple-query (Focus.id, Focus.embedding deferred)
  - Cosine compare + best-match selection
  - Floor gating (cross-kind matches are noisier than same-kind; default
    floor matches list_service._FOCUS_SUPPORTS_FLOOR = 0.75)
  - edge_service.link() call with consistent kind=`supports`

Callers pass src_kind + src_id + an embedding (or text we'll embed). All
failures swallowed by caller try/except — focus binding is a side-effect
of create paths, never blocks them.
"""

from __future__ import annotations

import json
import math

from sqlalchemy.orm import Session

from ..db.models import Focus


# Floor for cross-kind supports edges. Mirrors list_service convention.
# Same-kind cosine (focus↔focus) is reliable down to ~0.65; cross-kind
# (todo↔focus, note↔focus, etc.) is noisier — stay conservative.
SUPPORTS_FLOOR = 0.75


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def best_active_focus(
    db: Session,
    *,
    embedding: list[float],
    floor: float = SUPPORTS_FLOOR,
) -> tuple[int | None, float]:
    """Return (focus_id, score) for the best active focus above `floor`,
    or (None, 0.0) if no match clears it. Reads Focus.embedding via tuple
    query so the deferred column doesn't hydrate the whole row.
    """
    if not embedding:
        return (None, 0.0)
    rows = (
        db.query(Focus.id, Focus.embedding)
        .filter(
            Focus.status == "committed",
            Focus.embedding.isnot(None),
        )
        .all()
    )
    best_id: int | None = None
    best_score = 0.0
    for fid, emb_text in rows:
        try:
            emb = json.loads(emb_text)
        except Exception:
            continue
        score = _cosine(embedding, emb)
        if score >= floor and score > best_score:
            best_id = fid
            best_score = score
    return (best_id, best_score)


def bind_to_focus(
    db: Session,
    *,
    src_kind: str,
    src_id: int,
    embedding: list[float],
    floor: float = SUPPORTS_FLOOR,
) -> int | None:
    """Find the best-matching active focus for the given embedding and
    write a `supports` edge from (src_kind, src_id) → (focus, focus_id).
    Returns the focus_id linked, or None if no match cleared the floor.
    Idempotent — edge_service.link() upserts on the 5-tuple.
    """
    from . import edge_service

    focus_id, score = best_active_focus(db, embedding=embedding, floor=floor)
    if focus_id is None:
        return None
    edge_service.link(
        db,
        src_kind=src_kind,
        src_id=src_id,
        dst_kind="focus",
        dst_id=focus_id,
        kind="supports",
        weight=round(score, 4),
    )
    return focus_id
