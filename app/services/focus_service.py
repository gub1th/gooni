"""Focus CRUD over the dedicated `focuses` table.

Focuses are long-running commitments. Each carries endgoal / health /
confidence / scale / status / start_at / end_at / committed and a
`color` for the dot system that visually links to its todos.

After the dashboard revamp:
  - is_primary moved to Todo (todos are the active-execution layer).
  - focus_todo_links M2M dropped; todo links via the single
    `todos.focus_id` FK.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import Focus, Todo
from .list_service import _item_embed_text, list_service


# 10-color palette mirroring the migration. New focuses cycle through
# this in creation order.
_COLOR_PALETTE = [
    "#22C55E", "#3B82F6", "#F59E0B", "#A855F7", "#EF4444",
    "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#14B8A6",
]


def _next_color(db: Session) -> str:
    n = db.query(Focus).count()
    return _COLOR_PALETTE[n % len(_COLOR_PALETTE)]


class FocusService:
    def get(self, db: Session, focus_id: int) -> Focus | None:
        return db.query(Focus).filter(Focus.id == focus_id).first()

    def list_active(self, db: Session) -> list[Focus]:
        return (
            db.query(Focus)
            .filter(Focus.done.is_(False))
            .order_by(Focus.sort_order, Focus.id)
            .all()
        )

    def create(
        self,
        db: Session,
        text: str,
        endgoal: str | None = None,
        committed: bool = False,
        source_note_id: int | None = None,
        status: str | None = None,
        scale: str | None = None,
        health: int | None = None,
        confidence: int | None = None,
        start_at: datetime | None = None,
        end_at: datetime | None = None,
        subtitle: str | None = None,
        color: str | None = None,
    ) -> Focus:
        max_order = (
            db.query(Focus.sort_order)
            .order_by(Focus.sort_order.desc())
            .first()
        )
        next_order = (max_order[0] + 1) if max_order else 1

        if status is None:
            status = "committed" if committed else "someday"

        embed_raw = _item_embed_text(text, endgoal)
        embed_vec = list_service._embed_item_text(embed_raw)

        f = Focus(
            text=text.strip(),
            subtitle=subtitle,
            endgoal=(endgoal or None),
            committed=bool(committed),
            status=status,
            scale=scale,
            color=color or _next_color(db),
            health=health,
            confidence=confidence,
            start_at=start_at,
            end_at=end_at,
            sort_order=next_order,
            source_note_id=source_note_id,
            embedding=json.dumps(embed_vec) if embed_vec else None,
        )
        db.add(f)
        db.commit()
        db.refresh(f)
        return f

    def update(self, db: Session, focus_id: int, **patch: Any) -> Focus | None:
        f = self.get(db, focus_id)
        if not f:
            return None
        for key in (
            "text", "endgoal", "subtitle", "committed", "done",
            "status", "scale", "color", "health", "confidence",
            "start_at", "end_at", "sort_order",
        ):
            if key in patch:
                setattr(f, key, patch[key])
        if "done" in patch:
            f.completed_at = datetime.utcnow() if patch["done"] else None
        if "status" in patch:
            f.committed = patch["status"] == "committed"
        elif "committed" in patch and f.status is None:
            f.status = "committed" if patch["committed"] else "someday"
        if any(k in patch for k in ("text", "endgoal", "subtitle")):
            embed_raw = _item_embed_text(f.text, f.endgoal or f.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                f.embedding = json.dumps(vec)
        db.commit()
        db.refresh(f)
        return f

    def delete(self, db: Session, focus_id: int) -> bool:
        f = self.get(db, focus_id)
        if not f:
            return False
        # Clear focus_id on any linked todos so they survive as
        # focus-less rows. Cleaner than cascading the delete to todos
        # (which would surprise the user — "I deleted a focus and lost
        # my todos").
        db.query(Todo).filter(Todo.focus_id == focus_id).update(
            {"focus_id": None}, synchronize_session=False
        )
        db.delete(f)
        db.commit()
        return True

    def reorder(self, db: Session, ordered_ids: list[int]) -> None:
        for idx, fid in enumerate(ordered_ids):
            db.query(Focus).filter(Focus.id == fid).update(
                {"sort_order": idx}, synchronize_session=False
            )
        db.commit()

    def linked_todos(self, db: Session, focus_id: int) -> list[Todo]:
        return (
            db.query(Todo)
            .filter(Todo.focus_id == focus_id)
            .order_by(Todo.sort_order, Todo.id)
            .all()
        )

    def get_active_context(self, db: Session) -> str:
        """Plain-text block for system-prompt injection — committed focuses
        with their endgoals.
        """
        rows = (
            db.query(Focus)
            .filter(Focus.done.is_(False), Focus.committed.is_(True))
            .order_by(Focus.sort_order, Focus.id)
            .limit(5)
            .all()
        )
        if not rows:
            return ""
        lines = ["Daniel's active focuses:"]
        for f in rows:
            endgoal = f.endgoal or ""
            lines.append(f"- {f.text}" + (f": {endgoal}" if endgoal else ""))
        return "\n".join(lines)


def serialize_focus(f: Focus) -> dict[str, Any]:
    return {
        "id": f.id,
        "text": f.text,
        "subtitle": f.subtitle,
        "endgoal": f.endgoal,
        "committed": bool(f.committed),
        "done": bool(f.done),
        "status": f.status,
        "scale": f.scale,
        "color": f.color,
        "health": f.health,
        "confidence": f.confidence,
        "start_at": f.start_at.isoformat() if f.start_at else None,
        "end_at": f.end_at.isoformat() if f.end_at else None,
        "completed_at": f.completed_at.isoformat() if f.completed_at else None,
        "sort_order": f.sort_order,
        "source_note_id": f.source_note_id,
        "last_seen_in_synth": (
            f.last_seen_in_synth.isoformat() if f.last_seen_in_synth else None
        ),
        "missed_run_count": f.missed_run_count or 0,
        "drift_flagged_at": (
            f.drift_flagged_at.isoformat() if f.drift_flagged_at else None
        ),
        "promoted_from_candidate_id": f.promoted_from_candidate_id,
        "evolved_from_focus_id": f.evolved_from_focus_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Hybrid binding pass — re-attach synth clusters to existing Focus rows.
#
# A promoted Focus carries an initial_signature (frozen at promotion) and a
# current_signature (weighted-mean updated per successful bind). On each
# synth run, every focus-shaped cluster looks for its best home among
# active focuses. Match strong enough → bind, EMA-update the signature,
# refresh the evidence snapshot. No match → fall through to candidate
# persistence as a new proposal.
#
# Active focuses NOT bound this run accumulate `missed_run_count`. Past
# the dormancy threshold, they flip to status='dormant' — not deleted,
# just demoted. Bound focuses whose `current_signature` has drifted from
# `initial_signature` past a warning threshold get stamped with
# `drift_flagged_at` (a one-shot — cleared on rename).
# ---------------------------------------------------------------------------

# Cosine floor for binding a cluster to an existing focus's current
# signature. Higher than state_bind_sim because we're matching focus
# centroids to focus centroids — both intent-shaped, sit much closer
# in embedding space.
BIND_SIM_THRESHOLD = 0.70
# Weight on the OLD current_signature when updating via EMA. 0.7 means
# the new cluster centroid only nudges the signature by 30% per run —
# conservative enough that one outlier doesn't whip the focus.
EMA_ALPHA = 0.7
# Consecutive synth runs with no bind → status='dormant'. Three runs is
# a deliberate "two strikes plus tiebreaker" — single missed run doesn't
# punish, but a real fade trips it.
DORMANCY_THRESHOLD = 3
# 1 - cos(initial, current). When this exceeds the warning, the focus
# has drifted from its origin theme. UI surfaces "rename or fork?".
DRIFT_WARN_THRESHOLD = 0.35


def _parse_vec(s: str | None) -> list[float] | None:
    if not s:
        return None
    try:
        v = json.loads(s)
        return v if isinstance(v, list) and v else None
    except Exception:
        return None


def _cos(a: list[float], b: list[float]) -> float:
    """Local cosine helper. Avoids importing note_service to dodge any
    circular-import risk between focus_service ↔ note_service."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _ema(old: list[float], new: list[float], alpha: float) -> list[float]:
    return [alpha * a + (1.0 - alpha) * b for a, b in zip(old, new)]


def bind_to_clusters(db: Session, synth_output: dict) -> dict[str, Any]:
    """Re-bind focus-shaped clusters from synth output to existing Focus
    rows. Mutates synth_output['candidates'] in place — bound entries
    get `bound_to_focus_id` stamped so the candidate-persistence pass
    can skip them.

    Greedy 1-to-1 assignment by descending pair similarity: each focus
    can bind at most one cluster per run, each cluster binds at most
    one focus. This avoids two clusters fighting over the same focus
    when both score above threshold.

    Returns {bound, dormant_focus_ids, newly_drifted_focus_ids}.
    """
    from ..db.models import Focus  # local import — module-level would
    # work too but keeping this contained keeps the binding logic
    # surgically lifted out of the FocusService class.

    now = datetime.utcnow()
    candidates = synth_output.get("candidates", [])
    focus_clusters: list[tuple[int, dict, list[float]]] = []
    for i, c in enumerate(candidates):
        cls = c.get("classification") or {}
        if cls.get("category") != "focus":
            continue
        centroid = c.get("centroid_embedding")
        if not centroid:
            continue
        focus_clusters.append((i, c, centroid))

    # No early return on empty focus_clusters — even with zero clusters
    # this run, active focuses still need their missed_run_count bumped
    # (a run with no clusters at all is a STRONG dormancy signal).

    # Pull active focuses (not done, not dormant) w/ a populated current
    # signature. Legacy focuses (signature NULL) are skipped — they
    # predate this PR and can't participate in the binding game until
    # promoted via synth.
    rows = (
        db.query(Focus.id, Focus.current_signature)
        .filter(Focus.done.is_(False))
        .filter((Focus.status.is_(None)) | (~Focus.status.in_(["dormant", "evolved"])))
        .filter(Focus.current_signature.isnot(None))
        .all()
    )
    focus_sigs: list[tuple[int, list[float]]] = []
    for fid, sig in rows:
        vec = _parse_vec(sig)
        if vec:
            focus_sigs.append((fid, vec))

    # Build all viable (sim, ci, fid) pairs above threshold. Sort by sim
    # desc → greedy assign each best pair, skipping clusters/focuses
    # that have already been claimed.
    pairs: list[tuple[float, int, int]] = []
    for ci, _, cluster_centroid in focus_clusters:
        for fid, fsig in focus_sigs:
            sim = _cos(cluster_centroid, fsig)
            if sim >= BIND_SIM_THRESHOLD:
                pairs.append((sim, ci, fid))
    pairs.sort(key=lambda p: -p[0])

    used_clusters: set[int] = set()
    bound_focus_ids: set[int] = set()
    bound: list[dict] = []
    newly_drifted: list[int] = []

    cluster_lookup = {ci: (c, centroid) for ci, c, centroid in focus_clusters}

    for sim, ci, fid in pairs:
        if ci in used_clusters or fid in bound_focus_ids:
            continue
        c, cluster_centroid = cluster_lookup[ci]
        focus = db.query(Focus).filter(Focus.id == fid).first()
        if not focus:
            continue
        old_sig = _parse_vec(focus.current_signature) or cluster_centroid
        new_sig = _ema(old_sig, cluster_centroid, EMA_ALPHA)
        focus.current_signature = json.dumps(new_sig)
        focus.current_evidence_json = json.dumps(c.get("evidence") or [])
        focus.last_seen_in_synth = now
        focus.missed_run_count = 0

        # Drift check against the frozen origin.
        init_sig = _parse_vec(focus.initial_signature)
        if init_sig:
            drift_score = 1.0 - _cos(init_sig, new_sig)
            if drift_score > DRIFT_WARN_THRESHOLD and focus.drift_flagged_at is None:
                focus.drift_flagged_at = now
                newly_drifted.append(focus.id)

        c["bound_to_focus_id"] = fid
        bound.append({
            "focus_id": fid,
            "cluster_index": ci,
            "sim": round(sim, 3),
        })
        used_clusters.add(ci)
        bound_focus_ids.add(fid)

    # Active focuses NOT bound this run → bump missed_run_count. Skip
    # focuses with NULL current_signature (legacy / pre-PR — not part
    # of the binding game yet).
    active_with_sig = (
        db.query(Focus)
        .filter(Focus.done.is_(False))
        .filter((Focus.status.is_(None)) | (~Focus.status.in_(["dormant", "evolved"])))
        .filter(Focus.current_signature.isnot(None))
        .all()
    )
    dormant_ids: list[int] = []
    for f in active_with_sig:
        if f.id in bound_focus_ids:
            continue
        f.missed_run_count = (f.missed_run_count or 0) + 1
        if f.missed_run_count >= DORMANCY_THRESHOLD:
            f.status = "dormant"
            dormant_ids.append(f.id)

    db.commit()

    return {
        "bound": bound,
        "dormant_focus_ids": dormant_ids,
        "newly_drifted_focus_ids": newly_drifted,
    }


def rename(
    db: Session,
    focus_id: int,
    text: str | None = None,
    endgoal: str | None = None,
) -> Focus | None:
    """User-driven rename. Refreshes the origin: initial_signature is
    snapped to current_signature so drift detection re-bases from now.
    drift_flagged_at clears. Use this when the user acknowledges that
    the focus has evolved but wants to keep the same row + linked todos.
    """
    f = db.query(Focus).filter(Focus.id == focus_id).first()
    if not f:
        return None
    if text is not None:
        f.text = text.strip()
    if endgoal is not None:
        f.endgoal = endgoal or None
    if f.current_signature:
        f.initial_signature = f.current_signature
    f.drift_flagged_at = None
    db.commit()
    db.refresh(f)
    return f


def fork(
    db: Session,
    focus_id: int,
    new_text: str,
    new_endgoal: str | None = None,
) -> tuple[Focus, Focus] | None:
    """User picks fork over rename: the OLD focus is preserved (status
    flipped to 'evolved'), a NEW Focus row spawns carrying the current
    signature as its initial+current, and links back via
    evolved_from_focus_id. Lineage chain forms.

    Use when the focus has drifted so far that the original commitment
    is genuinely a different thing now — preserves the historical
    audit trail rather than overwriting via rename.
    """
    old = db.query(Focus).filter(Focus.id == focus_id).first()
    if not old:
        return None

    new = focus_service.create(
        db,
        text=new_text,
        endgoal=new_endgoal,
        committed=True,
        status="committed",
    )
    # The NEW focus inherits its origin from the OLD focus's drifted
    # signature — that signature IS the new theme.
    if old.current_signature:
        new.initial_signature = old.current_signature
        new.current_signature = old.current_signature
        new.current_evidence_json = old.current_evidence_json
        new.last_seen_in_synth = old.last_seen_in_synth
    new.evolved_from_focus_id = old.id

    old.status = "evolved"
    old.drift_flagged_at = None

    db.commit()
    db.refresh(old)
    db.refresh(new)
    return old, new


focus_service = FocusService()
