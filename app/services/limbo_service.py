"""LimboItem CRUD — the raw staging layer for batched brain-dump threads.

Module-style (no class), like habit_service / daily_metric_service. The 5am
batch (batch_service) calls `capture`; the desktop review (router) calls
`promote` / `dismiss`.

Capture is cosine-deduped: a new thought that matches an existing open limbo
item bumps its `mention_count` instead of inserting a dup — that recurrence
is the promote signal. Promote is polymorphic: it spins up the chosen typed
primitive, wires a `derives_from` edge, and flips status.
"""

from __future__ import annotations

import json
import math

from sqlalchemy.orm import Session

from ..db.models import LimboItem


# Re-mention threshold. Above this cosine sim, a new thought is "the same
# idea again" → bump mention_count rather than insert. Slightly below the
# todo floor (0.85): ideas get rephrased more loosely than chores, and the
# batch classifier rewrites each thread to a clean standalone line, so true
# recurrences cluster tighter than free-text. Tunable; cross-session
# recurrence quality is a later (PR-4+) refinement. Measured: reworded
# same-ideas land ~0.74-0.78, genuinely-distinct ideas ~0.16 (wide gap).
_DEDUP_FLOOR = 0.82
_VALID_PROMOTE_TYPES = ("focus", "todo", "promise", "memory")


def _embed(text: str) -> list[float] | None:
    """Reuse the shared item-embedding helper (same one todo/focus use)."""
    try:
        from .list_service import list_service
        return list_service._embed_item_text(text)
    except Exception as e:
        print(f"[limbo] embed failed: {e}")
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def capture(
    db: Session,
    text: str,
    source_message_id: int | None = None,
    kind_hint: str | None = None,
) -> LimboItem | None:
    """Insert a limbo item, or bump an existing one's mention_count if this
    thought cosine-matches an open limbo item ≥ _DEDUP_FLOOR. Returns the row
    (new or bumped), or None for empty text."""
    text = (text or "").strip()
    if not text:
        return None

    emb = _embed(text)

    # Dedup against open limbo items. Tuple query so the deferred embedding
    # column loads without dragging full ORM objects (the N+1 lazy-load trap).
    if emb:
        rows = (
            db.query(LimboItem.id, LimboItem.embedding)
            .filter(LimboItem.status == "limbo")
            .all()
        )
        best_id, best_sim = None, 0.0
        for rid, emb_json in rows:
            if not emb_json:
                continue
            try:
                vec = json.loads(emb_json)
            except Exception:
                continue
            sim = _cosine(emb, vec)
            if sim > best_sim:
                best_id, best_sim = rid, sim
        if best_id is not None and best_sim >= _DEDUP_FLOOR:
            hit = db.query(LimboItem).filter(LimboItem.id == best_id).first()
            if hit is not None:
                hit.mention_count = (hit.mention_count or 1) + 1
                db.commit()
                db.refresh(hit)
                return hit

    item = LimboItem(
        text=text[:2000],
        source_message_id=source_message_id,
        kind_hint=kind_hint,
        embedding=json.dumps(emb) if emb else None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def list_open(db: Session, limit: int = 100) -> list[LimboItem]:
    """Open limbo items, most-mentioned first (promote candidates float up)."""
    return (
        db.query(LimboItem)
        .filter(LimboItem.status == "limbo")
        .order_by(LimboItem.mention_count.desc(), LimboItem.created_at.desc())
        .limit(limit)
        .all()
    )


def get(db: Session, item_id: int) -> LimboItem | None:
    return db.query(LimboItem).filter(LimboItem.id == item_id).first()


def promote(db: Session, item_id: int, target_type: str) -> dict | None:
    """Turn a limbo item into a typed primitive. Creates the row, wires a
    `derives_from` edge (typed primitive ← limbo), flips status='promoted',
    stamps the lineage. Returns {item, target_type, target_id} or None.

    Idempotent: a re-promote of an already-promoted item is a no-op return.
    """
    target_type = (target_type or "").strip().lower()
    if target_type not in _VALID_PROMOTE_TYPES:
        return None
    item = get(db, item_id)
    if item is None:
        return None
    if item.status == "promoted" and item.promoted_to_id is not None:
        return {"item": item, "target_type": item.promoted_to_type,
                "target_id": item.promoted_to_id, "already": True}

    target_id: int | None = None
    text = item.text
    try:
        if target_type == "todo":
            from .todo_service import todo_service
            row = todo_service.create(db, text=text[:200])
            target_id = row.id
        elif target_type == "focus":
            from .focus_service import focus_service
            row = focus_service.create(db, text=text[:200], committed=True)
            target_id = row.id
        elif target_type == "promise":
            from . import promise_service
            row = promise_service.create(db, utterance=text)
            target_id = row.id
        elif target_type == "memory":
            from .memory_service import memory_service
            row = memory_service.add_memory(content=text, type="episode", db=db)
            target_id = row.id if row else None
    except Exception as e:
        print(f"[limbo] promote→{target_type} create failed: {e}")
        return None

    if target_id is None:
        return None

    # Lineage edge: typed primitive derives_from this limbo item.
    try:
        from . import edge_service
        edge_service.link(
            db,
            src_kind=target_type,
            src_id=target_id,
            dst_kind="limbo",
            dst_id=item.id,
            kind="derives_from",
        )
    except Exception as e:
        print(f"[limbo] derives_from edge failed (non-fatal): {e}")

    item.status = "promoted"
    item.promoted_to_type = target_type
    item.promoted_to_id = target_id
    db.commit()
    db.refresh(item)
    return {"item": item, "target_type": target_type, "target_id": target_id}


def dismiss(db: Session, item_id: int) -> LimboItem | None:
    """Tombstone a limbo item so it won't resurface (capture dedup only
    matches status='limbo', so a dismissed idea won't re-bump)."""
    item = get(db, item_id)
    if item is None:
        return None
    item.status = "dismissed"
    db.commit()
    db.refresh(item)
    return item


def serialize(item: LimboItem) -> dict:
    return {
        "id": item.id,
        "text": item.text,
        "source_message_id": item.source_message_id,
        "kind_hint": item.kind_hint,
        "mention_count": item.mention_count,
        "status": item.status,
        "promoted_to_type": item.promoted_to_type,
        "promoted_to_id": item.promoted_to_id,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }
