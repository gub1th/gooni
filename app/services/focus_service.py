import json
import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Focus, Note
from ..llm.client import llm_client


# Status ordering for context injection — committed comes first because
# those are what Daniel said he's actively working on.
_STATUS_RANK = {"committed": 0, "pending": 1, "someday": 2, "done": 3}


class FocusService:
    def list_focuses(
        self, db: Session, statuses: list[str] | None = None
    ) -> list[Focus]:
        q = db.query(Focus)
        if statuses:
            q = q.filter(Focus.status.in_(statuses))
        focuses = q.all()
        focuses.sort(
            key=lambda f: (
                _STATUS_RANK.get(f.status, 99),
                -(f.last_activity_at.timestamp() if f.last_activity_at else 0),
            )
        )
        return focuses

    def get_focus(self, db: Session, focus_id: int) -> Focus | None:
        return db.query(Focus).filter(Focus.id == focus_id).first()

    def find_by_name(self, db: Session, name: str) -> Focus | None:
        """Case-insensitive substring match used by the LLM tool to resolve
        a fuzzy focus name. Prefers shortest name (most specific match)."""
        needle = (name or "").strip().lower()
        if not needle:
            return None
        candidates = [
            f for f in db.query(Focus).all()
            if needle in (f.name or "").lower()
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda f: len(f.name or ""))
        return candidates[0]

    def create_focus(
        self,
        db: Session,
        name: str,
        endgoal: str,
        due_date: datetime | None = None,
        status: str = "committed",
    ) -> Focus:
        focus = Focus(name=name, endgoal=endgoal, status=status, due_date=due_date)
        db.add(focus)
        db.commit()
        db.refresh(focus)
        return focus

    def update_focus(self, db: Session, focus_id: int, **patch) -> Focus | None:
        focus = self.get_focus(db, focus_id)
        if not focus:
            return None
        for key in ("name", "endgoal", "status", "due_date"):
            if key in patch and patch[key] is not None:
                setattr(focus, key, patch[key])
        db.commit()
        db.refresh(focus)
        return focus

    def delete_focus(self, db: Session, focus_id: int) -> bool:
        focus = self.get_focus(db, focus_id)
        if not focus:
            return False
        db.delete(focus)
        db.commit()
        return True

    def mark_activity(self, db: Session, focus_id: int) -> Focus | None:
        """Bump last_activity_at to now. Single source of activity signal —
        no event log, no provenance. Called from the manual heartbeat
        endpoint and from the `mark_focus_activity` LLM tool."""
        focus = self.get_focus(db, focus_id)
        if not focus:
            return None
        focus.last_activity_at = datetime.utcnow()
        db.commit()
        db.refresh(focus)
        return focus

    def classify_focuses(self, db: Session, text: str) -> list[int]:
        """Single cheap LLM call: which focuses does this text touch?
        One call per text — not one per focus. Returns focus IDs.

        Used by note-save (where the orchestrator's tool-based flow can't
        see content unless Daniel chats about it). Gates on text length so
        we don't burn tokens on shopping lists or scratchpads.
        """
        if not text or len(text.strip()) < 100:
            return []
        focuses = self.list_focuses(
            db, statuses=["committed", "pending", "someday"]
        )
        if not focuses:
            return []

        options = "\n".join(
            f"#{f.id} {f.name}: {f.endgoal}" for f in focuses
        )
        prompt = (
            "Which of these focuses does the text below clearly touch? "
            "Be strict — only include a focus if the text directly relates "
            "to its endgoal, not just adjacent topics. "
            "Return a JSON array of focus ID integers (e.g. [1, 3]) or [] "
            "for none. JSON only, no preamble.\n\n"
            f"Focuses:\n{options}\n\n"
            f"Text:\n{text[:2000]}\n\n"
            "JSON:"
        )
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=60)
        except Exception as e:
            print(f"focus classify error: {e}")
            return []

        cleaned = (raw or "").strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1].strip()
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        valid_ids = {f.id for f in focuses}
        out = []
        for x in parsed:
            try:
                fid = int(x)
            except (ValueError, TypeError):
                continue
            if fid in valid_ids:
                out.append(fid)
        return out

    def get_focus_context(self, db: Session) -> str:
        """Return a human-readable block listing Daniel's active focuses for
        injection into the orchestrator system prompt. The LLM uses this
        list both to ground responses and to pick targets for the
        `mark_focus_activity` tool. Limits to 5 with someday capped at 1
        to avoid noise.
        """
        focuses = self.list_focuses(
            db, statuses=["committed", "pending", "someday"]
        )
        if not focuses:
            return ""

        someday_count = 0
        kept = []
        for f in focuses:
            if f.status == "someday":
                if someday_count >= 1:
                    continue
                someday_count += 1
            kept.append(f)
            if len(kept) >= 5:
                break

        lines = ["Daniel's active focuses:"]
        now = datetime.utcnow()
        for f in kept:
            parts = [f.status]
            if f.due_date:
                parts.append(f"due {f.due_date.strftime('%b %d')}")
            if f.last_activity_at:
                days_ago = (now - f.last_activity_at).days
                if days_ago == 0:
                    parts.append("worked on today")
                else:
                    parts.append(f"last worked on {days_ago}d ago")
            else:
                parts.append("no activity yet")
            meta = ", ".join(parts)
            lines.append(f"- {f.name} ({meta}): {f.endgoal}")
        return "\n".join(lines)


    def suggest_from_notes(
        self, db: Session, days: int = 30, limit: int = 4
    ) -> list[dict]:
        """Pull last `days` of notes, hand titles + excerpts to the LLM,
        ask for up to `limit` recurring-theme focus suggestions. Skips any
        whose name overlaps an existing focus by simple token similarity.
        Returns [{name, reason}, ...] — empty list if nothing useful.
        """
        cutoff = datetime.utcnow() - timedelta(days=days)
        notes = (
            db.query(Note)
            .filter(Note.updated_at >= cutoff)
            .order_by(Note.updated_at.desc())
            .limit(60)
            .all()
        )
        if len(notes) < 5:
            return []

        existing = self.list_focuses(
            db, statuses=["committed", "pending", "someday"]
        )
        existing_names = [f.name.strip().lower() for f in existing if f.name]

        def _plain(html: str | None) -> str:
            if not html:
                return ""
            t = re.sub(r"<[^>]+>", " ", html)
            return re.sub(r"\s+", " ", t).strip()

        note_lines = []
        for n in notes:
            title = (n.title or "").strip() or "Untitled"
            body = _plain(n.content)[:160]
            note_lines.append(f"- {title}: {body}" if body else f"- {title}")
        note_block = "\n".join(note_lines)

        existing_block = (
            "\n".join(f"- {f.name}" for f in existing) if existing else "(none)"
        )

        prompt = (
            "You analyze a user's notes to identify recurring themes that "
            "suggest genuine commitment — things they keep returning to.\n\n"
            "For each strong theme cluster (5+ notes touching it), return a "
            "short focus name (3-6 words) and a casual 1-2 sentence reason "
            "that references note count and recency. Sound like a friend "
            "who's been reading their notes — not a coach.\n\n"
            f"Return at most {limit} suggestions. Skip any theme that is "
            "already an existing focus below.\n\n"
            "Return JSON only, no preamble: "
            '{"suggestions": [{"name": "...", "reason": "..."}, ...]}\n\n'
            f"Existing focuses (skip these):\n{existing_block}\n\n"
            f"Recent notes (last {days} days):\n{note_block}\n\n"
            "JSON:"
        )
        try:
            raw = llm_client.generate_simple_completion(prompt, max_tokens=500)
        except Exception as e:
            print(f"focus suggest error: {e}")
            return []

        cleaned = (raw or "").strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1].strip()
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return []

        items = parsed.get("suggestions") if isinstance(parsed, dict) else None
        if not isinstance(items, list):
            return []

        out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = (item.get("name") or "").strip()
            reason = (item.get("reason") or "").strip()
            if not name or not reason:
                continue
            # Cheap dedupe: any existing focus whose lowercased name shares a
            # 4-char prefix-ish overlap is "the same idea." Errs toward
            # filtering — better to under-suggest than re-pitch.
            low = name.lower()
            if any(low == e or e in low or low in e for e in existing_names):
                continue
            out.append({"name": name, "reason": reason})
            if len(out) >= limit:
                break
        return out


focus_service = FocusService()
