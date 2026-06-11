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
  - voice-spec violations: bot-register / character-attack / doubled-down-
    after-correction regex.

A row is written ONLY when one of these trips. Most turns trip nothing →
return None → no row → no self-take spam. Rows that DO write still embed +
feed behavioral-facet clustering, so a recurring real failure still promotes
a CapabilityFacet.

Runs in a daemon thread with its own SessionLocal so the chat path never
waits. Failures are logged + swallowed; the audit must NEVER break chat.
"""

from __future__ import annotations

import json
import math
import re
import threading
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..common import WRITE_CLAIM_RE
from ..db.database import SessionLocal
from ..db.models import Reflection, ToolCall
from ..llm.client import llm_client
from .capability_service import capability_service


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


# Bot-register phrases that scream "AI assistant" not "Alfred." Catches voice
# drift; repeated drift clusters → promotes "I tend to drift into bot register"
# as a behavioral facet. Case-insensitive, anchored where needed.
_BOT_REGISTER_PATTERNS = [
    r"\bi'?d be happy to\b",
    r"\bi'?d love to (help|hear)\b",
    r"\bhappy to help\b",
    r"\blet me know if (you|there)\b",
    r"\bdon'?t hesitate to\b",
    r"\bfeel free to\b",
    r"\bhope (this|that) helps\b",
    r"\bgreat question\b",
    r"\bjust (a )?friendly reminder\b",
    r"\bjust checking in\b",
    r"\bi'?ve gone ahead and\b",
    r"\bi have gone ahead and\b",
    r"^\s*sure!",
    r"^\s*absolutely!",
    r"^\s*certainly!",
    r"^\s*of course!",
]

_BOT_REGISTER_RE = re.compile(
    "|".join(_BOT_REGISTER_PATTERNS), re.IGNORECASE | re.MULTILINE
)


def _detect_voice_drift(reply: str) -> str | None:
    """Return the first bot-register phrase matched, or None."""
    if not reply:
        return None
    m = _BOT_REGISTER_RE.search(reply)
    return m.group(0).strip() if m else None


# Character attacks — names aimed AT Daniel. Banned by the voice spec (G0.1).
# Targets the SHAPE "second-person accusation" ("you X" / "your X-cognition"),
# not the standalone slur (Daniel uses "dumbass" at himself; mirroring his
# register is fine — aiming a name AT him is the violation).
_CHARACTER_ATTACK_PATTERNS = [
    r"\byou (?:dumbass|idiot|moron|stupid|imbecile|retard)\b",
    r"\byour (?:dumbass|stupid|idiotic|dumb|little)\s+\w*\s*(?:narrative|brain|mind|reasoning|logic|fog|loop|spiral|generator)\b",
    r"\b(?:dumbass|stupid|idiotic)\s+(?:narrative generator|reasoning|brain|loop|story|fog)\b",
    r"\byour (?:little|own|dumb|whole)\s+(?:bullshit|nonsense|drama)\s+(?:fog|loop|spiral|generator|story)\b",
    r"\bstop freelancing\b",
]

_CHARACTER_ATTACK_RE = re.compile(
    "|".join(_CHARACTER_ATTACK_PATTERNS), re.IGNORECASE | re.MULTILINE
)


def _detect_character_attack(reply: str) -> str | None:
    """Return the first character-attack phrase matched, or None."""
    if not reply:
        return None
    m = _CHARACTER_ATTACK_RE.search(reply)
    return m.group(0).strip() if m else None


# Reply admitted being wrong (recovery marker) AND kept attacking on the
# now-disproved premise (continued harshness) — caring-core violation.
_RECOVERY_MARKER_RE = re.compile(
    r"\b(?:my read was wrong|scratch that|my mistake|i was wrong|"
    r"i'?m wrong|correction[—:]|disregard that|never mind that)\b",
    re.IGNORECASE,
)

_CONTINUED_HARSHNESS_RE = re.compile(
    r"\b(?:now hold the line|before (?:your|you) (?:dumbass|brain|"
    r"narrative|mind|story) (?:starts|begins) \w+|don'?t do that "
    r"(?:again|with me)|stop (?:freelancing|spiraling|spinning|"
    r"making up))\b",
    re.IGNORECASE,
)


def _detect_doubled_down_after_correction(reply: str) -> str | None:
    """Reply contains a recovery shape AND a continued-harshness phrase —
    Gooni admitted being wrong then kept attacking. Returns the offending
    phrase, or None. Both gates required: standalone "now hold the line" can
    be a legit correction OF Daniel; the violation is specifically recovering
    then attacking on the disproved premise."""
    if not reply:
        return None
    if not _RECOVERY_MARKER_RE.search(reply):
        return None
    m = _CONTINUED_HARSHNESS_RE.search(reply)
    return m.group(0).strip() if m else None


# Behavioral promotion: when this many recent reflections cluster on the same
# gap_exposed (cosine > floor), promote the centroid into a behavioral
# CapabilityFacet.
_CLUSTER_MIN_HITS = 3
_CLUSTER_SIM_FLOOR = 0.8
_CLUSTER_LOOKBACK_DAYS = 30


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


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


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

        Writes a Reflection row ONLY when a hard guard trips:
          - hallucination: a write-claim phrase with no ToolCall row AND no
            router capture backing it.
          - voice-spec: bot-register / character-attack / doubled-down regex.
        Nothing trips → return None (no row, no UI take). Rows that write still
        embed + feed behavioral-facet clustering.
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

        vd = _detect_voice_drift(assistant_reply)
        if vd:
            flags.append(("tone", 2, f'voice drift to bot register: "{vd}"'))

        ca = _detect_character_attack(assistant_reply)
        if ca:
            flags.append(("tone", 2, f'character attack on Daniel: "{ca}"'))

        dd = _detect_doubled_down_after_correction(assistant_reply)
        if dd:
            flags.append(("tone", 2, f'doubled down after correction: "{dd}"'))

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

        if gap_embedding_json:
            self._maybe_promote_behavioral_facet(db, row, gap_text)

        return row

    def _maybe_promote_behavioral_facet(
        self, db: Session, this_row: Reflection, gap_text: str
    ) -> None:
        """Cluster this reflection's gap_embedding against the last 30d of
        reflections (severity>=2, embedding present). ≥3 cosine matches above
        the floor → promote a behavioral facet via the capability service."""
        try:
            this_vec = json.loads(this_row.gap_embedding) if this_row.gap_embedding else None
            if not this_vec:
                return
            cutoff = datetime.utcnow() - timedelta(days=_CLUSTER_LOOKBACK_DAYS)
            rows = (
                db.query(Reflection.id, Reflection.gap_embedding)
                .filter(
                    Reflection.severity >= 2,
                    Reflection.gap_embedding.isnot(None),
                    Reflection.created_at >= cutoff,
                    Reflection.id != this_row.id,
                )
                .all()
            )
            hits: list[int] = [this_row.id]
            for rid, emb_json in rows:
                try:
                    vec = json.loads(emb_json) if emb_json else None
                except Exception:
                    continue
                if not vec:
                    continue
                if _cosine(this_vec, vec) >= _CLUSTER_SIM_FLOOR:
                    hits.append(rid)
            if len(hits) >= _CLUSTER_MIN_HITS:
                capability_service.promote_behavioral_facet(
                    db,
                    centroid_text=gap_text,
                    evidence_reflection_ids=hits,
                )
        except Exception as e:
            print(f"[reflexion] behavioral promotion failed: {e}")

    # ── Conversation-level rollup ────────────────────────────────────────
    # Manual batch op (POST /reflections/rollup-now): cluster recent turn-
    # reflections into one compressed "what patterns keep recurring" line for
    # the master prompt. With deterministic-only turns this fires rarely (few
    # sev≥2 rows), which is fine — it stays dormant until real patterns exist.
    _ROLLUP_LOOKBACK = 20
    _ROLLUP_MIN_TURNS = 5

    _ROLLUP_PROMPT = """You are summarizing your recent self-reflections in a conversation into ONE compressed paragraph.

Input: a list of per-turn reflections. Each has severity (1-3), action_vs_described, gap_dimension, and gap_exposed.

Goal: surface the 2-3 LOAD-BEARING failure modes that keep recurring, so a future system prompt can show this to Gooni as "what you tend to miss in this conv" instead of dumping all turns.

Rules:
- Be SPECIFIC. "Lack of accountability" is useless. "Claims to track commitments without firing a tool" is useful.
- Cluster paraphrases. If 4 reflections all say variants of "didn't push back on vague intent," compress to one line.
- Skip clean turns (severity 1) — they're not the pattern.
- 3 sentences max. Each sentence = one distinct recurring pattern.
- Reference dimension ("hallucination", "tool_fit") when it adds signal.
- No preamble. Just the prose.

REFLECTIONS:
{reflections_block}

Output: 3 sentences max. Plain prose, no markdown, no list."""

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
