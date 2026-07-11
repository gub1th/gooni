"""Per-turn reflexion — DETERMINISTIC guardrail only.

History: this used to make a gpt-4o-mini "judge your own turn" call after every
reply. That LLM layer manufactured noise — a weak model asked "what's wrong
here" always finds something, judging one turn in isolation invents
"completeness gaps" it can't see were resolved later, and at temp 0 it echoed
the prior-reflections block back as "new" gaps. The 140-line prompt was 90%
suppression rules fighting that bias. Killed it.

What's left is the part that was always reliable: ground-truthable checks that
need NO model judgment.
  - hallucination cross-ref: the reply CLAIMS a durable write ("tracked",
    "logged", "saved") but the audit trail (ToolCall rows + the turn's router
    captures) is empty → the claim is a lie. Ground truth lives in the DB; we
    only string-match the claim side.

(The voice-spec regexes — bot-register / character-attack / doubled-down —
died in the 2026-07 lean sweep: verbatim-phrase lists could only catch the
exact phrasings enumerated, had zero test coverage, and nothing consumed the
sev2 rows once facet promotion died. Tone is the eval loop's job now.)

A row is written ONLY when the guard trips. Most turns trip nothing →
return None → no row → no self-take spam.

Runs in a daemon thread with its own SessionLocal so the chat path never
waits. Failures are logged + swallowed; the audit must NEVER break chat.
"""

from __future__ import annotations

import json
import threading

from sqlalchemy.orm import Session

from ..common import WRITE_CLAIM_RE
from ..db.database import SessionLocal
from ..db.models import Reflection, ToolCall
from ..llm.client import llm_client


# Durable-write claim verbs — shared single source in app/common.py (also
# used by the orchestrator verify rail, which historically carried a looser
# bare-verb copy that contradicted this one). Kept TIGHT on purpose: bare
# "noted, sir" / "got it" are valid terse capture-acks, NOT write claims.
_WRITE_CLAIM_RE = WRITE_CLAIM_RE


def _detect_write_claim(reply: str) -> str | None:
    """Return the write-claim phrase the reply asserts, or None."""
    if not reply:
        return None
    m = _WRITE_CLAIM_RE.search(reply)
    return m.group(0).strip() if m else None


# Score lookup: composite of gap-dimension weight + severity. Conservative —
# better to under-score than inflate. Aggregated per-conv on dashboards.
_GAP_DIMENSION_PENALTY = {
    "none":           0,
    "tone":           2,
    "completeness":   2,
    "tool_fit":       3,
    "accuracy":       4,
    "hallucination":  5,
}
_SEVERITY_PENALTY = {1: 0, 2: 2, 3: 4}


def _derive_score(gap_dimension: str, severity: int) -> float:
    """Map (gap_dimension, severity) → 1-10 quality score for dashboards.
    Floor at 1 so worst-case still produces a finite number."""
    dim_penalty = _GAP_DIMENSION_PENALTY.get((gap_dimension or "none").lower(), 2)
    sev_penalty = _SEVERITY_PENALTY.get(severity, 2)
    return max(1.0, min(10.0, 10.0 - dim_penalty - sev_penalty))


class ReflexionService:
    """Singleton. Reach via `reflexion_service` at module bottom."""

    def reflect_async(
        self,
        *,
        user_msg: str,
        assistant_reply: str,
        message_id: int,
        conversation_id: int,
        router_wrote: bool = False,
    ) -> None:
        """Spawn a daemon thread that runs reflect() with its own session.
        Fire-and-forget — the chat path never waits, exceptions never bubble.

        `router_wrote` — did extract_signals→intent_router capture anything
        this turn (promise/todo/fitness/feature)? Those writes don't show up
        as ToolCall rows, so the hallucination cross-ref needs the orchestrator
        to tell it.
        """
        t = threading.Thread(
            target=self._run_in_thread,
            kwargs={
                "user_msg": user_msg,
                "assistant_reply": assistant_reply,
                "message_id": message_id,
                "conversation_id": conversation_id,
                "router_wrote": router_wrote,
            },
            daemon=True,
        )
        t.start()

    def _run_in_thread(self, **kwargs) -> None:
        db = SessionLocal()
        try:
            self.reflect(db=db, **kwargs)
        except Exception as e:
            print(f"[reflexion] failed: {e}")
        finally:
            db.close()

    def reflect(
        self,
        *,
        db: Session,
        user_msg: str,
        assistant_reply: str,
        message_id: int,
        conversation_id: int,
        router_wrote: bool = False,
    ) -> Reflection | None:
        """Deterministic self-take. NO LLM judgment.

        Writes a Reflection row ONLY when the hallucination guard trips:
        a write-claim phrase with no ToolCall row AND no router capture
        backing it. Nothing trips → return None (no row, no UI take).
        """
        tools = (
            db.query(ToolCall)
            .filter(ToolCall.message_id == message_id)
            .all()
        )
        wrote = router_wrote or len(tools) > 0

        # Collect tripped guards as (dimension, severity, text).
        flags: list[tuple[str, int, str]] = []

        claim = _detect_write_claim(assistant_reply)
        if claim and not wrote:
            flags.append((
                "hallucination", 3,
                f'claimed a write with no tool/router backing: "{claim}"',
            ))

        if not flags:
            return None

        primary = max(flags, key=lambda f: f[1])
        severity = primary[1]
        gap_dimension = primary[0]
        gap_text = ". ".join(f[2] for f in flags)

        emb, _ = llm_client.generate_embedding(gap_text)
        gap_embedding_json = json.dumps(emb) if emb else None

        prev = (
            db.query(Reflection)
            .filter(Reflection.conversation_id == conversation_id)
            .order_by(Reflection.id.desc())
            .first()
        )

        row = Reflection(
            message_id=message_id,
            conversation_id=conversation_id,
            user_critique_present=False,
            critique_summary=None,
            action_vs_described="acted" if wrote else "described",
            gap_exposed=gap_text,
            gap_embedding=gap_embedding_json,
            proposed_self_fix=None,
            severity=severity,
            model="deterministic",
            kind="turn",
            prev_reflection_id=prev.id if prev else None,
            score=_derive_score(gap_dimension, severity),
        )
        db.add(row)
        db.commit()
        db.refresh(row)

        return row


    def rollup_conversation(
        self,
        db: Session,
        conversation_id: int,
    ) -> "Reflection | None":
        """Summarize recent turn-reflections in this conv into a single
        conv_rollup Reflection row, or None if too few turn reflections."""
        from ..db.models import Message as MessageModel

        turn_rows = (
            db.query(Reflection)
            .filter(
                Reflection.conversation_id == conversation_id,
                Reflection.kind == "turn",
                Reflection.severity >= 2,
            )
            .order_by(Reflection.created_at.desc())
            .limit(self._ROLLUP_LOOKBACK)
            .all()
        )
        if len(turn_rows) < self._ROLLUP_MIN_TURNS:
            return None

        lines = []
        for r in turn_rows:
            gap = (r.gap_exposed or "").strip()[:200]
            if not gap:
                continue
            lines.append(f"- sev{r.severity} {r.action_vs_described} :: {gap}")
        if len(lines) < self._ROLLUP_MIN_TURNS:
            return None

        prompt = self._ROLLUP_PROMPT.format(reflections_block="\n".join(lines))
        model = "gpt-4o-mini"
        try:
            summary = llm_client.generate_simple_completion(
                prompt, max_tokens=400, temperature=0.2, model=model,
            )
        except Exception as e:
            print(f"[reflexion] rollup llm call failed: {e}")
            return None
        summary = (summary or "").strip()
        if not summary:
            return None

        latest_msg = (
            db.query(MessageModel)
            .filter(MessageModel.conversation_id == conversation_id)
            .order_by(MessageModel.id.desc())
            .first()
        )
        if latest_msg is None:
            return None

        row = Reflection(
            message_id=latest_msg.id,
            conversation_id=conversation_id,
            user_critique_present=False,
            critique_summary=None,
            action_vs_described="na",
            gap_exposed=summary,
            gap_embedding=None,
            proposed_self_fix=None,
            severity=2,
            model=model,
            kind="conv_rollup",
            prev_reflection_id=turn_rows[0].id if turn_rows else None,
            score=None,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row

    def latest_rollup_for(
        self, db: Session, conversation_id: int
    ) -> "Reflection | None":
        """Most recent conv_rollup for this conversation, or None. Injected
        into master-prompt assembly as one compressed line."""
        return (
            db.query(Reflection)
            .filter(
                Reflection.conversation_id == conversation_id,
                Reflection.kind == "conv_rollup",
            )
            .order_by(Reflection.created_at.desc())
            .first()
        )


reflexion_service = ReflexionService()
