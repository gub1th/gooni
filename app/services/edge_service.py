"""Generic graph layer over the `edges` table.

Why this exists: cross-entity semantic links (Promise supports Focus,
Promise closes Todo, Note derives_from Memory) would M²-explode the
schema if modeled as FK columns. FK still wins for OWNERSHIP relations
(Comment.note_id, Memory.source_note_id, Promise.source_message_id);
this module handles the semantic many-to-many layer.

Edge kinds in use (v1):
  - 'utters'        Message → Promise (source utterance)
  - 'supports'     Promise → Focus    (this promise serves a focus)
  - 'closes'       Promise → Todo     (promise fulfilled by todo)
  - 'derives_from' generic provenance
  - 'mentions'     references without owning

Idempotency: insert is upsert-on-conflict (the UNIQUE constraint
`uq_edges_endpoints_kind` covers the 5-tuple).
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db.models import Edge


def link(
    db: Session,
    *,
    src_kind: str,
    src_id: int,
    dst_kind: str,
    dst_id: int,
    kind: str,
    weight: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> Edge:
    """Insert (or return existing) edge. Idempotent on the 5-tuple."""
    existing = (
        db.query(Edge)
        .filter(
            Edge.src_kind == src_kind,
            Edge.src_id == src_id,
            Edge.dst_kind == dst_kind,
            Edge.dst_id == dst_id,
            Edge.kind == kind,
        )
        .first()
    )
    if existing is not None:
        return existing

    edge = Edge(
        src_kind=src_kind,
        src_id=src_id,
        dst_kind=dst_kind,
        dst_id=dst_id,
        kind=kind,
        weight=weight,
        metadata_json=json.dumps(metadata) if metadata else None,
    )
    db.add(edge)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent insert lost the race — fetch the winner.
        db.rollback()
        return (
            db.query(Edge)
            .filter(
                Edge.src_kind == src_kind,
                Edge.src_id == src_id,
                Edge.dst_kind == dst_kind,
                Edge.dst_id == dst_id,
                Edge.kind == kind,
            )
            .first()
        )
    db.refresh(edge)
    return edge


def unlink(
    db: Session,
    *,
    src_kind: str,
    src_id: int,
    dst_kind: str,
    dst_id: int,
    kind: str | None = None,
) -> int:
    """Delete edge(s) matching the endpoints. If `kind` is None, drops
    every link between the pair regardless of kind. Returns count
    deleted."""
    q = db.query(Edge).filter(
        Edge.src_kind == src_kind,
        Edge.src_id == src_id,
        Edge.dst_kind == dst_kind,
        Edge.dst_id == dst_id,
    )
    if kind is not None:
        q = q.filter(Edge.kind == kind)
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return deleted


def links_for(
    db: Session,
    *,
    kind_of_node: str,
    node_id: int,
    edge_kind: str | None = None,
) -> list[Edge]:
    """Bidirectional traversal — returns every edge touching the node,
    whether the node is on the src or dst side. Filters by edge `kind`
    when supplied.

    Use this when you want "everything related to X" — promise + its
    source message + the focus it supports + the todo it closes, in
    one shot.
    """
    q = db.query(Edge).filter(
        or_(
            (Edge.src_kind == kind_of_node) & (Edge.src_id == node_id),
            (Edge.dst_kind == kind_of_node) & (Edge.dst_id == node_id),
        )
    )
    if edge_kind is not None:
        q = q.filter(Edge.kind == edge_kind)
    return q.order_by(Edge.created_at.asc()).all()


def neighbors(
    db: Session,
    *,
    kind_of_node: str,
    node_id: int,
    edge_kind: str | None = None,
    direction: str = "any",  # 'out' | 'in' | 'any'
) -> list[tuple[str, int, str]]:
    """Shorthand: returns (neighbor_kind, neighbor_id, edge_kind) tuples
    for every node connected to (kind_of_node, node_id). `direction`
    filters to outgoing (this node is src), incoming (this node is dst),
    or both.
    """
    edges = links_for(
        db,
        kind_of_node=kind_of_node,
        node_id=node_id,
        edge_kind=edge_kind,
    )
    out: list[tuple[str, int, str]] = []
    for e in edges:
        on_src = e.src_kind == kind_of_node and e.src_id == node_id
        on_dst = e.dst_kind == kind_of_node and e.dst_id == node_id
        if direction in ("out", "any") and on_src:
            out.append((e.dst_kind, e.dst_id, e.kind))
        if direction in ("in", "any") and on_dst:
            out.append((e.src_kind, e.src_id, e.kind))
    return out


def serialize_edge(e: Edge) -> dict[str, Any]:
    return {
        "id": e.id,
        "src_kind": e.src_kind,
        "src_id": e.src_id,
        "dst_kind": e.dst_kind,
        "dst_id": e.dst_id,
        "kind": e.kind,
        "weight": e.weight,
        "metadata": json.loads(e.metadata_json) if e.metadata_json else None,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }
