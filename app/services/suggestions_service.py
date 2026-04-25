import json
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Note, Suggestion
from ..llm.client import llm_client
from .focus_service import focus_service
from .memory_service import memory_service


REFRESH_TTL_HOURS = 24
DAILY_BATCH = {"discovery": 3, "whimsy": 3}


_GENERATION_PROMPT = """You generate a daily "explore" feed for Daniel.

Two categories. Return a JSON object — no preamble, no markdown fences.

Category "discovery" (3 items): things to read about, ideas to chew on, startups
or projects worth knowing. Pick what would expand his thinking — adjacent to
his current focuses but not the same. Vary across rounds.

Category "whimsy" (3 items): comfort-zone-breakers. Real-world micro-actions:
go somewhere new, talk to a stranger, try a thing. Skip generic ("meditate",
"go for a walk") — be specific and a little unhinged.

Each item: short title (≤8 words) + body (1-2 sentences saying *why* this).
Optional source_url only if it's a real, well-known link.

Output JSON:
{{
  "discovery": [{{"title": "...", "body": "...", "source_url": null}}, ...],
  "whimsy":    [{{"title": "...", "body": "...", "source_url": null}}, ...]
}}

Context about Daniel:
{context}
"""


class SuggestionsService:
    def _build_context(self, db: Session) -> str:
        parts = []
        focus_ctx = focus_service.get_focus_context(db)
        if focus_ctx:
            parts.append(focus_ctx)
        # Pull the 5 most recent note titles — gives the LLM a sense of what's
        # currently on his mind beyond just declared focuses.
        recent = (
            db.query(Note)
            .filter(Note.title.isnot(None))
            .order_by(Note.updated_at.desc())
            .limit(5)
            .all()
        )
        if recent:
            titles = [n.title for n in recent if n.title]
            if titles:
                parts.append("Recent note titles: " + "; ".join(titles))
        # Memory snippets (best-effort — Mem0 may rate-limit)
        try:
            mem = memory_service.build_memory_context("interests preferences goals")
            if mem:
                parts.append(mem[:600])
        except Exception:
            pass
        return "\n\n".join(parts) or "(no context yet — generate generic but specific suggestions)"

    def needs_refresh(self, db: Session) -> bool:
        latest = (
            db.query(Suggestion)
            .order_by(Suggestion.generated_at.desc())
            .first()
        )
        if not latest:
            return True
        cutoff = datetime.utcnow() - timedelta(hours=REFRESH_TTL_HOURS)
        return latest.generated_at < cutoff

    def regenerate(self, db: Session) -> list[Suggestion]:
        context = self._build_context(db)
        prompt = _GENERATION_PROMPT.format(context=context)
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=900)
        except Exception as e:
            print(f"suggestions LLM error: {e}")
            return []

        # Strip code fences if the model added them despite instructions.
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.rsplit("```", 1)[0].strip()

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as e:
            print(f"suggestions JSON parse error: {e} | raw: {cleaned[:200]}")
            return []

        # Hide previous undismissed items so today's batch is clearly current.
        db.query(Suggestion).filter(Suggestion.dismissed == False).update(
            {"dismissed": True}
        )

        created = []
        for category in ("discovery", "whimsy"):
            for item in (parsed.get(category) or [])[: DAILY_BATCH.get(category, 3)]:
                title = (item.get("title") or "").strip()
                body = (item.get("body") or "").strip()
                if not title or not body:
                    continue
                s = Suggestion(
                    category=category,
                    title=title,
                    body=body,
                    source_url=(item.get("source_url") or None) or None,
                    dismissed=False,
                )
                db.add(s)
                created.append(s)
        db.commit()
        for s in created:
            db.refresh(s)
        return created

    def today(self, db: Session) -> dict[str, list[Suggestion]]:
        if self.needs_refresh(db):
            self.regenerate(db)
        rows = (
            db.query(Suggestion)
            .filter(Suggestion.dismissed == False)
            .order_by(Suggestion.generated_at.desc(), Suggestion.id.desc())
            .all()
        )
        return {
            "discovery": [s for s in rows if s.category == "discovery"][: DAILY_BATCH["discovery"]],
            "whimsy": [s for s in rows if s.category == "whimsy"][: DAILY_BATCH["whimsy"]],
        }

    def dismiss(self, db: Session, suggestion_id: int) -> bool:
        s = db.query(Suggestion).filter(Suggestion.id == suggestion_id).first()
        if not s:
            return False
        s.dismissed = True
        db.commit()
        return True


suggestions_service = SuggestionsService()
