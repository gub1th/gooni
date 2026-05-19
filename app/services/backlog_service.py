"""Backlog ticket CRUD over the dedicated `backlog_tickets` table.

Each ticket = one PR-or-feature-shaped chunk of engineering work. Carries
board_status (todo / in_progress / done) + pr_url for the Jira-style
3-column dashboard board. Sourced from notes via source_note_id when
classify_note flags a feature_request signal.

G2 self-PM: tickets now carry `blast_radius` (1-5 workflow impact),
`urgency_score` (aggregated from FrictionEvent rows), and
`last_friction_at`. Capability gaps from chat upsert onto existing
tickets via cosine ≥ 0.78 — no more 50 duplicate "groom todos" rows.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import BacklogTicket, FrictionEvent
from .list_service import _item_embed_text, list_service


# Cosine threshold for upsert-on-similar. Same bar as `find_similar`
# default — paraphrases ("grooming flow", "todo bulk-edit") merge,
# distinct gaps stay separate.
UPSERT_SIMILARITY_THRESHOLD = 0.78

# Urgency decay half-life. exp(-days/14) ≈ 0.5 at 10 days, ≈ 0.1 at 33d.
# Aggressive enough that ancient friction doesn't dominate but slow
# enough that a once-a-week recurring pain stays visible.
URGENCY_DECAY_DAYS = 14

# Lookback window for friction aggregation. Older events still in DB
# (for audit) but stop counting toward live urgency.
URGENCY_LOOKBACK_DAYS = 30


class BacklogService:
    def get(self, db: Session, ticket_id: int) -> BacklogTicket | None:
        return db.query(BacklogTicket).filter(BacklogTicket.id == ticket_id).first()

    def list_all(self, db: Session, include_done: bool = True) -> list[BacklogTicket]:
        q = db.query(BacklogTicket).order_by(BacklogTicket.sort_order, BacklogTicket.id)
        if not include_done:
            q = q.filter(BacklogTicket.done.is_(False))
        return q.all()

    def create(
        self,
        db: Session,
        text: str,
        subtitle: str | None = None,
        source_note_id: int | None = None,
        board_status: str | None = None,
        notes: str | None = None,
        blast_radius: int | None = None,
        skip_conflict_check: bool = False,
    ) -> BacklogTicket:
        """Create-or-upsert. Returns existing ticket if either (a) the
        source_note_id already has an open ticket, or (b) cosine
        similarity to an existing open ticket ≥ UPSERT_SIMILARITY_THRESHOLD
        (G2 — kills the duplicate-stack failure mode). Caller can bypass
        the similarity check with skip_conflict_check=True (bulk imports).
        """
        # Idempotent on (source_note_id) — repeated "tag to backlog" clicks
        # from the same note return the existing open ticket instead of
        # stacking duplicates. Only matches non-done tickets so a closed
        # ticket on the same note doesn't block re-opening the work.
        if source_note_id is not None:
            existing = (
                db.query(BacklogTicket)
                .filter(
                    BacklogTicket.source_note_id == source_note_id,
                    BacklogTicket.done.is_(False),
                )
                .order_by(BacklogTicket.id.desc())
                .first()
            )
            if existing is not None:
                return existing

        # G2 upsert: cosine-match against open tickets. If a near-paraphrase
        # exists, return it and let the caller decide whether to bump
        # urgency. Threshold matches `find_similar` default (0.78). The
        # whole point — "groom my todos" shouldn't generate a fresh ticket
        # every session when the gap is already on the board.
        if not skip_conflict_check:
            matches = self.find_similar(
                db, text, threshold=UPSERT_SIMILARITY_THRESHOLD, limit=1
            )
            # Filter to open tickets only — closed gaps shouldn't block
            # re-opening when the user hits them again post-fix-attempt.
            open_match = next(
                ((t, sim) for t, sim in matches if not t.done), None
            )
            if open_match is not None:
                existing, _sim = open_match
                # If the caller passed a blast_radius, bump it conservatively
                # (don't downgrade if the existing is already higher).
                if blast_radius is not None:
                    if existing.blast_radius is None or blast_radius > existing.blast_radius:
                        existing.blast_radius = blast_radius
                        db.commit()
                        db.refresh(existing)
                return existing

        max_order = (
            db.query(BacklogTicket.sort_order)
            .order_by(BacklogTicket.sort_order.desc())
            .first()
        )
        next_order = (max_order[0] + 1) if max_order else 1

        embed_raw = _item_embed_text(text, subtitle)
        embed_vec = list_service._embed_item_text(embed_raw)

        t = BacklogTicket(
            text=text.strip(),
            subtitle=subtitle,
            board_status=board_status,
            notes=notes,
            sort_order=next_order,
            source_note_id=source_note_id,
            embedding=json.dumps(embed_vec) if embed_vec else None,
            blast_radius=blast_radius,
        )
        db.add(t)
        db.commit()
        db.refresh(t)
        return t

    # ── G2 self-PM: friction event logging + urgency aggregation ────────

    def log_friction(
        self,
        db: Session,
        backlog_ticket_id: int,
        blast_radius: int,
        *,
        message_id: int | None = None,
        reason: str | None = None,
        source: str = "user_utterance",
    ) -> FrictionEvent | None:
        """Insert a FrictionEvent + synchronously bump the ticket's
        urgency_score and last_friction_at. Returns the event or None
        if the ticket doesn't exist. blast_radius clamped to [1, 5]."""
        ticket = self.get(db, backlog_ticket_id)
        if ticket is None:
            return None
        br = max(1, min(int(blast_radius), 5))
        ev = FrictionEvent(
            backlog_ticket_id=backlog_ticket_id,
            message_id=message_id,
            blast_radius=br,
            reason=reason,
            source=source,
        )
        db.add(ev)
        # Update the ticket's blast_radius to the max ever seen (events
        # describe how bad each hit was; ticket-level is the worst-case).
        if ticket.blast_radius is None or br > ticket.blast_radius:
            ticket.blast_radius = br
        ticket.last_friction_at = datetime.utcnow()
        db.commit()
        db.refresh(ev)
        # Recompute synchronously so the score reflects this event the
        # same turn it fired (state_block uses it in the next prompt).
        self.recompute_urgency_score(db, backlog_ticket_id)
        return ev

    def recompute_urgency_score(self, db: Session, ticket_id: int) -> float | None:
        """Recalc urgency from FrictionEvents over the lookback window.

        Formula: sum(blast_radius × exp(-days_ago / URGENCY_DECAY_DAYS))
        across events in last URGENCY_LOOKBACK_DAYS. Higher = more
        urgent. Ticket without any events gets None (sorts to bottom).
        Done tickets always 0.
        """
        ticket = self.get(db, ticket_id)
        if ticket is None:
            return None
        if ticket.done:
            ticket.urgency_score = 0.0
            db.commit()
            return 0.0
        cutoff = datetime.utcnow() - timedelta(days=URGENCY_LOOKBACK_DAYS)
        rows = (
            db.query(FrictionEvent.blast_radius, FrictionEvent.created_at)
            .filter(
                FrictionEvent.backlog_ticket_id == ticket_id,
                FrictionEvent.created_at >= cutoff,
            )
            .all()
        )
        if not rows:
            ticket.urgency_score = None
            db.commit()
            return None
        now = datetime.utcnow()
        total = 0.0
        for br, ts in rows:
            days_ago = max(0.0, (now - ts).total_seconds() / 86400.0)
            total += float(br) * math.exp(-days_ago / URGENCY_DECAY_DAYS)
        ticket.urgency_score = round(total, 3)
        db.commit()
        return ticket.urgency_score

    def recompute_all_urgency(self, db: Session) -> dict[str, int]:
        """Nightly rollup. Walks all non-done tickets, recomputes score.
        Returns counters for observability."""
        tickets = (
            db.query(BacklogTicket)
            .filter(BacklogTicket.done.is_(False))
            .all()
        )
        scored = 0
        cleared = 0
        for t in tickets:
            before = t.urgency_score
            after = self.recompute_urgency_score(db, t.id)
            if after is not None:
                scored += 1
            elif before is not None:
                cleared += 1
        return {"total": len(tickets), "scored": scored, "cleared": cleared}

    def list_by_urgency(
        self, db: Session, limit: int = 10, min_score: float = 0.0
    ) -> list[BacklogTicket]:
        """Top tickets by urgency_score desc, open only. Used by
        state_block + REST `?sort=urgency`."""
        return (
            db.query(BacklogTicket)
            .filter(
                BacklogTicket.done.is_(False),
                BacklogTicket.urgency_score.isnot(None),
                BacklogTicket.urgency_score >= min_score,
            )
            .order_by(BacklogTicket.urgency_score.desc())
            .limit(limit)
            .all()
        )

    def find_or_create_for_friction(
        self,
        db: Session,
        text: str,
        blast_radius: int,
        *,
        message_id: int | None = None,
        reason: str | None = None,
        source: str = "user_utterance",
        subtitle: str | None = None,
    ) -> tuple[BacklogTicket, FrictionEvent]:
        """Single-call helper for the friction-detection paths. Cosine-
        matches first; logs against the match if found, else creates a
        fresh ticket with first-event severity. Returns (ticket, event)."""
        # create() already does the cosine-match-and-return-existing
        # dance. Pass blast_radius so it bumps if the existing ticket
        # underestimated.
        ticket = self.create(
            db,
            text=text,
            subtitle=subtitle,
            blast_radius=blast_radius,
        )
        event = self.log_friction(
            db,
            ticket.id,
            blast_radius,
            message_id=message_id,
            reason=reason,
            source=source,
        )
        return ticket, event  # type: ignore[return-value]

    def update(self, db: Session, ticket_id: int, **patch: Any) -> BacklogTicket | None:
        t = self.get(db, ticket_id)
        if not t:
            return None
        for key in (
            "text", "subtitle", "board_status", "pr_url", "done", "sort_order",
            "todo_id", "notes",
        ):
            if key in patch:
                setattr(t, key, patch[key])
        if "done" in patch:
            t.completed_at = datetime.utcnow() if patch["done"] else None
        if any(k in patch for k in ("text", "subtitle")):
            embed_raw = _item_embed_text(t.text, t.subtitle)
            vec = list_service._embed_item_text(embed_raw)
            if vec:
                t.embedding = json.dumps(vec)
        db.commit()
        db.refresh(t)
        return t

    def delete(self, db: Session, ticket_id: int) -> bool:
        t = self.get(db, ticket_id)
        if not t:
            return False
        db.delete(t)
        db.commit()
        return True

    def promote(self, db: Session, ticket_id: int) -> tuple[BacklogTicket, "Todo"] | None:
        """Create a Todo mirroring this ticket's text/subtitle and link
        them via ticket.todo_id. Idempotent — re-promoting an already-
        linked ticket returns the existing pair.
        """
        from .todo_service import todo_service
        t = self.get(db, ticket_id)
        if not t:
            return None
        if t.todo_id is not None:
            existing = todo_service.get(db, t.todo_id)
            if existing:
                return t, existing
            # Linked todo was deleted out from under us — fall through and
            # create a fresh one.
        todo = todo_service.create(
            db, text=t.text, subtitle=t.subtitle,
            source_note_id=t.source_note_id,
        )
        t.todo_id = todo.id
        db.commit()
        db.refresh(t)
        return t, todo

    def demote(self, db: Session, ticket_id: int) -> BacklogTicket | None:
        """Sever the ticket↔todo link by deleting the linked todo and
        clearing ticket.todo_id. Backlog row stays."""
        from .todo_service import todo_service
        t = self.get(db, ticket_id)
        if not t:
            return None
        if t.todo_id is not None:
            todo_service.delete(db, t.todo_id)
        t.todo_id = None
        db.commit()
        db.refresh(t)
        return t

    def find_similar(
        self, db: Session, text: str, threshold: float = 0.78, limit: int = 5
    ) -> list[tuple[BacklogTicket, float]]:
        """Return tickets with cosine similarity >= threshold, descending."""
        from .list_service import _cosine
        target = list_service._embed_item_text(text)
        if not target:
            return []
        rows = db.query(BacklogTicket.id, BacklogTicket.embedding).filter(
            BacklogTicket.embedding.is_not(None)
        ).all()
        scored: list[tuple[int, float]] = []
        for ticket_id, emb_raw in rows:
            try:
                emb = json.loads(emb_raw)
            except (TypeError, ValueError):
                continue
            sim = _cosine(target, emb)
            if sim >= threshold:
                scored.append((ticket_id, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        scored = scored[:limit]
        if not scored:
            return []
        id_set = [s[0] for s in scored]
        ticket_map = {
            t.id: t for t in db.query(BacklogTicket).filter(BacklogTicket.id.in_(id_set)).all()
        }
        return [(ticket_map[i], sim) for i, sim in scored if i in ticket_map]


def serialize_ticket(t: BacklogTicket) -> dict[str, Any]:
    return {
        "id": t.id,
        "text": t.text,
        "subtitle": t.subtitle,
        "board_status": t.board_status,
        "pr_url": t.pr_url,
        "notes": t.notes,
        "todo_id": t.todo_id,
        "done": bool(t.done),
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "sort_order": t.sort_order,
        "source_note_id": t.source_note_id,
        "blast_radius": t.blast_radius,
        "urgency_score": t.urgency_score,
        "last_friction_at": (
            t.last_friction_at.isoformat() if t.last_friction_at else None
        ),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


backlog_service = BacklogService()
