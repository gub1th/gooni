"""Capture-feature-gap tool. Called when Gooni recognizes Master is asking
for a capability that doesn't exist yet. Logs an item to the canonical
"Gooni Backlog" List (auto-created on first call). Master sees the
backlog grow under the unified Lists UI.

G2 self-PM: tool now requires a `blast_radius` score (1-5) so urgency
aggregation has a workflow-impact signal. Calls
`backlog_service.find_or_create_for_friction` which upserts on cosine
similarity (kills the 50-duplicate-tickets failure mode) and logs a
FrictionEvent so the urgency_score reflects repeat hits.

Severity-aware ack (Alfred voice) — high-blast-radius gets explicit
"flagged blocker" language so Daniel hears that something is actually
blocking workflow, not just filed alongside fifty others.
"""

from .base import BaseTool
from ._returns import BacklogTicketReturn


class RequestFeatureTool(BaseTool):
    name = "request_feature"
    description = (
        "Log a capability gap as a feature request when Master asks Gooni "
        "to do something not in CAPABILITIES (e.g. set reminders, send "
        "proactive messages, filter notes by date). Upserts on cosine "
        "similarity — repeat hits bump urgency on the existing ticket "
        "instead of stacking duplicates. blast_radius (1-5) tells Gooni "
        "how much this gap actually hurts workflow:\n"
        "  1 = one-off annoyance (minor formatting, edge case)\n"
        "  2 = blocks list/UI ergonomics\n"
        "  3 = blocks a specific surface (e.g. voice capture)\n"
        "  4 = blocks daily flow (multiple sessions affected)\n"
        "  5 = blocks the daily-driver claim itself (Master can't use Gooni "
        "      for its core job until this lands).\n"
        "Score conservatively — most gaps are 1-3. Reserve 4-5 for actual "
        "session-killers. Do NOT promise the task — only log it, then tell "
        "Master what landed."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": (
                    "Short imperative title for the feature (max ~10 words). "
                    "Examples: 'Outbound time-based reminders via Telegram', "
                    "'Filter notes by date range', 'Voice-note transcription'."
                ),
            },
            "why": {
                "type": "string",
                "description": (
                    "One sentence describing what Master asked for and what's "
                    "missing today. Becomes the subtitle on the backlog item."
                ),
            },
            "blast_radius": {
                "type": "integer",
                "description": (
                    "1-5 workflow impact score. See tool description for the "
                    "scale. Required."
                ),
                "minimum": 1,
                "maximum": 5,
            },
        },
        "required": ["title", "why", "blast_radius"],
    }

    def execute(
        self,
        db=None,
        title: str = "",
        why: str = "",
        blast_radius: int = 0,
        source_note_id: int | None = None,
        message_id: int | None = None,
        **kwargs,
    ) -> BacklogTicketReturn:
        from ..services.backlog_service import backlog_service
        from ..db.models import FrictionEvent

        title = (title or "").strip()
        why = (why or "").strip()
        if not title:
            return {"kind": "backlog_ticket", "id": 0, "status": "invalid", "summary": "title required"}
        if db is None:
            return {"kind": "backlog_ticket", "id": 0, "status": "invalid", "summary": "no db session"}
        try:
            br = int(blast_radius or 0)
        except (TypeError, ValueError):
            br = 0
        if br < 1 or br > 5:
            # Be forgiving on the boundary — clamp and continue rather
            # than reject. LLM may emit 0 or string; default to 2 (the
            # mid-low band) so the call still succeeds.
            br = max(1, min(br, 5)) if br else 2

        ticket, event = backlog_service.find_or_create_for_friction(
            db,
            text=title[:120],
            blast_radius=br,
            message_id=message_id,
            reason=why or None,
            source="manual",
            subtitle=why or None,
        )

        # Count prior friction events on this ticket (excluding the one
        # we just logged) to surface "hit Nx" in the ack when it's a
        # repeat. Cheap query — bounded by 30d retention.
        prior_count = (
            db.query(FrictionEvent)
            .filter(
                FrictionEvent.backlog_ticket_id == ticket.id,
                FrictionEvent.id != (event.id if event else 0),
            )
            .count()
        )

        # Severity-aware summary (Alfred voice). The LLM paraphrases the
        # `summary` field — give it semantic shape, not bot-receipt syntax.
        # Daniel hates "Logged feature request: X" cadence. The structured
        # bits (hit_count, severity, blast_radius) ride in `context` so the
        # model can escalate tone on repeat hits without parsing prose.
        if br >= 4:
            severity_phrase = "flagged blocker"
        elif br == 3:
            severity_phrase = "logged"
        else:
            severity_phrase = "logged, minor"

        hit_count = prior_count + 1
        ctx = {
            "title": title,
            "blast_radius": br,
            "hit_count": hit_count,
            "severity_phrase": severity_phrase,
        }
        # prior_count == 0 → brand-new ticket; >=1 → upsert bumped an existing.
        status = "created" if prior_count == 0 else "duplicate"
        if prior_count >= 2:
            summary = f"{severity_phrase} (hit {hit_count}x now). {title}. urgency bumped."
        elif prior_count == 1:
            summary = f"{severity_phrase} (second hit). {title}. urgency bumped."
        else:
            summary = f"{severity_phrase}. {title}."
        return {
            "kind": "backlog_ticket", "id": ticket.id, "status": status,
            "summary": summary, "context": ctx,
        }


feature_request_tool = RequestFeatureTool()
