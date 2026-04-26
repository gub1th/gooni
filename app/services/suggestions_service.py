import json
import random
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Note, Suggestion, SuggestionPrompt
from ..llm.client import llm_client
from .focus_service import focus_service
from .memory_service import memory_service


REFRESH_TTL_HOURS = 24
# Three buckets, one item each. Mixed verbs (read/do/revisit) make the feed
# scan-able and force Gooni to vary instead of dumping six items of one type.
CATEGORIES = ("read", "do", "revisit")
DAILY_BATCH = {"read": 1, "do": 1, "revisit": 1}

# Notes must be at least this many days old to qualify for "revisit" — we want
# something Daniel might have actually forgotten, not something he wrote yesterday.
REVISIT_MIN_AGE_DAYS = 14
# Pull this many candidate notes; LLM picks the most interesting one to surface.
REVISIT_CANDIDATE_POOL = 12


_LLM_PROMPT = """You generate a daily "For You" feed for Daniel — two items.

Output JSON, no preamble, no markdown fences:
{{
  "read": {{"title": "...", "body": "...", "source_url": null}},
  "do":   {{"title": "...", "body": "...", "source_url": null}}
}}

Each item: short title (≤8 words) + body (1-2 sentences saying *why* this).
Optional source_url only if it's a real, well-known URL.

Category "read": something to consume — an article, idea, startup, book worth
knowing. Adjacent to Daniel's focuses but not the same. Vary across rounds.

Category "do": a real-world micro-action — try a new place, talk to a stranger,
break a small habit. Specific and a little unhinged. Skip generic ("meditate",
"go for a walk").

{user_overrides}

Context about Daniel:
{context}
"""


_REVISIT_PROMPT = """Daniel wrote these notes a while ago. Pick ONE that's most worth
resurfacing today — something he might have forgotten that's still relevant or
worth a fresh look. Return JSON:

{{
  "note_id": <int>,
  "title": "<short Gooni take, ≤8 words — e.g. 'Your March take on focus'>",
  "body":  "<1-2 sentences: what the note said + why now>"
}}

{user_override}

Notes:
{candidates}

Daniel's current focuses:
{focuses}
"""


class SuggestionsService:
    # ── Context + prompts ───────────────────────────────────────────────────

    def _build_context(self, db: Session) -> str:
        parts = []
        focus_ctx = focus_service.get_focus_context(db)
        if focus_ctx:
            parts.append(focus_ctx)
        # 5 most recent note titles — what's actually on his mind right now.
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
        # Memory snippets — preferences + interests Gooni learned over time.
        try:
            mem = memory_service.build_memory_context("interests preferences goals")
            if mem:
                parts.append(mem[:600])
        except Exception:
            pass
        return "\n\n".join(parts) or "(no context yet — generate generic but specific suggestions)"

    def get_user_prompts(self, db: Session) -> dict[str, str]:
        rows = db.query(SuggestionPrompt).all()
        return {r.category: (r.user_prompt or "") for r in rows}

    def set_user_prompt(self, db: Session, category: str, prompt: str) -> SuggestionPrompt:
        if category not in CATEGORIES:
            raise ValueError(f"unknown category: {category}")
        row = (
            db.query(SuggestionPrompt)
            .filter(SuggestionPrompt.category == category)
            .first()
        )
        if row:
            row.user_prompt = prompt
        else:
            row = SuggestionPrompt(category=category, user_prompt=prompt)
            db.add(row)
        db.commit()
        db.refresh(row)
        return row

    # ── Refresh logic ───────────────────────────────────────────────────────

    def needs_refresh(self, db: Session) -> bool:
        latest = (
            db.query(Suggestion)
            .filter(Suggestion.category.in_(CATEGORIES))
            .order_by(Suggestion.generated_at.desc())
            .first()
        )
        if not latest:
            return True
        cutoff = datetime.utcnow() - timedelta(hours=REFRESH_TTL_HOURS)
        return latest.generated_at < cutoff

    def regenerate(self, db: Session) -> list[Suggestion]:
        # Pull current user-overrides up front — both LLM calls need them.
        user_prompts = self.get_user_prompts(db)

        # Hide previous undismissed items so today's batch is clearly current.
        db.query(Suggestion).filter(Suggestion.dismissed == False).update(  # noqa: E712
            {"dismissed": True}
        )

        created: list[Suggestion] = []

        # ── read + do: one LLM call ──
        read_do_items = self._generate_read_do(db, user_prompts)
        for cat, item in read_do_items.items():
            title = (item.get("title") or "").strip()
            body = (item.get("body") or "").strip()
            if not title or not body:
                continue
            s = Suggestion(
                category=cat,
                title=title,
                body=body,
                source_url=(item.get("source_url") or None) or None,
                dismissed=False,
            )
            db.add(s)
            created.append(s)

        # ── revisit: pull candidate notes, LLM picks one ──
        revisit = self._generate_revisit(db, user_prompts.get("revisit", ""))
        if revisit:
            db.add(revisit)
            created.append(revisit)

        db.commit()
        for s in created:
            db.refresh(s)
        return created

    # ── Generation: read + do ──────────────────────────────────────────────

    def _generate_read_do(self, db: Session, user_prompts: dict[str, str]) -> dict[str, dict]:
        context = self._build_context(db)
        # User overrides get framed as PRIORITY so the model treats them as
        # constraints rather than gentle suggestions.
        overrides = []
        if user_prompts.get("read"):
            overrides.append(f"PRIORITY for 'read': {user_prompts['read'].strip()}")
        if user_prompts.get("do"):
            overrides.append(f"PRIORITY for 'do': {user_prompts['do'].strip()}")
        user_overrides = "\n".join(overrides) if overrides else ""

        prompt = _LLM_PROMPT.format(context=context, user_overrides=user_overrides)
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=600)
        except Exception as e:
            print(f"suggestions LLM error: {e}")
            return {}

        cleaned = self._strip_fences(raw)
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as e:
            print(f"suggestions JSON parse error: {e} | raw: {cleaned[:200]}")
            return {}

        out: dict[str, dict] = {}
        for cat in ("read", "do"):
            item = parsed.get(cat)
            if isinstance(item, dict):
                out[cat] = item
        return out

    # ── Generation: revisit ─────────────────────────────────────────────────

    def _generate_revisit(self, db: Session, user_override: str) -> Suggestion | None:
        cutoff = datetime.utcnow() - timedelta(days=REVISIT_MIN_AGE_DAYS)
        # Older notes with content; sample randomly across the pool so the
        # same handful doesn't keep getting picked.
        candidates = (
            db.query(Note)
            .filter(Note.updated_at < cutoff)
            .filter(Note.content.isnot(None))
            .order_by(Note.updated_at.desc())
            .limit(REVISIT_CANDIDATE_POOL * 3)
            .all()
        )
        # Filter out empty/whitespace and pick at random for variety.
        candidates = [n for n in candidates if (n.content or "").strip()]
        if not candidates:
            return None
        random.shuffle(candidates)
        candidates = candidates[:REVISIT_CANDIDATE_POOL]

        # Compact representation for the LLM. Truncate body to keep token cost low.
        listed = []
        for n in candidates:
            body = (n.content or "").strip()
            # Strip HTML tags rough-and-ready — TipTap content is HTML.
            import re
            text = re.sub(r"<[^>]+>", " ", body)
            text = re.sub(r"\s+", " ", text).strip()
            listed.append(f"- id={n.id} | title={n.title or '(untitled)'} | snippet=\"{text[:240]}\"")
        candidates_str = "\n".join(listed)

        focus_str = focus_service.get_focus_context(db) or "(no active focuses)"
        override_str = f"PRIORITY: {user_override.strip()}" if user_override.strip() else ""
        prompt = _REVISIT_PROMPT.format(
            candidates=candidates_str,
            focuses=focus_str,
            user_override=override_str,
        )

        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=400)
        except Exception as e:
            print(f"revisit LLM error: {e}")
            return None
        cleaned = self._strip_fences(raw)
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as e:
            print(f"revisit JSON parse error: {e} | raw: {cleaned[:200]}")
            return None

        note_id = parsed.get("note_id")
        title = (parsed.get("title") or "").strip()
        body = (parsed.get("body") or "").strip()
        if not isinstance(note_id, int) or not title or not body:
            return None
        # Validate the LLM picked an id from our candidate pool — guard against
        # hallucinated IDs.
        if not any(n.id == note_id for n in candidates):
            return None
        return Suggestion(
            category="revisit",
            title=title,
            body=body,
            source_url=None,
            note_id=note_id,
            dismissed=False,
        )

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _strip_fences(self, raw: str) -> str:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        return cleaned

    def today(self, db: Session) -> dict[str, list[Suggestion]]:
        if self.needs_refresh(db):
            self.regenerate(db)
        rows = (
            db.query(Suggestion)
            .filter(Suggestion.dismissed == False)  # noqa: E712
            .filter(Suggestion.category.in_(CATEGORIES))
            .order_by(Suggestion.generated_at.desc(), Suggestion.id.desc())
            .all()
        )
        return {
            cat: [s for s in rows if s.category == cat][: DAILY_BATCH[cat]]
            for cat in CATEGORIES
        }

    def dismiss(self, db: Session, suggestion_id: int) -> bool:
        s = db.query(Suggestion).filter(Suggestion.id == suggestion_id).first()
        if not s:
            return False
        s.dismissed = True
        db.commit()
        return True


suggestions_service = SuggestionsService()
