"""Per-turn reflexion: after every assistant reply, Gooni judges its own
turn against Daniel's intent + tool outcomes and persists a Reflection row.

Pattern follows Shinn et al.'s Reflexion paper: the model evaluates its own
action, surfaces gap_exposed + proposed_self_fix, and feeds the row back into
behavioral-layer capability promotion via cosine clustering.

Cost: one gpt-4o-mini call per turn, ~500 input + 200 output tokens.
$0.0001/turn — negligible. Runs in a daemon thread with its own SessionLocal
so the chat path never waits. Failures are logged + swallowed; the audit
must NEVER break the chat path.
"""

from __future__ import annotations

import json
import math
import re
import threading
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.database import SessionLocal
from ..db.models import Reflection, ToolCall
from ..llm.client import llm_client
from .capability_service import capability_service
from .memory_extraction import _parse_json_object


# Bot-register phrases that scream "AI assistant" not "Alfred."
# Foundational to G0 voice enforcement: catches drift the LLM self-judge
# misses, forces sev≥2 + tone dimension, lets behavioral clustering
# promote "I tend to drift into bot register" if the pattern repeats.
# Case-insensitive. Anchored where needed to avoid false positives.
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


# Character attacks — names aimed AT Daniel. Banned by the voice spec
# (G0.1). Match these and force sev≥2 + tone dimension. Behavioral
# clustering picks up the pattern and promotes "I tend to call Daniel
# names" as a facet that future-turn LLM sees.
#
# Targets the SHAPE "second-person accusation" — "you X" / "your
# X-cognition" — not the standalone slur word. Daniel uses "dumbass"
# at himself casually; mirroring his lowercase register is fine, but
# aiming any name at him is the violation.
_CHARACTER_ATTACK_PATTERNS = [
    # "you dumbass" / "you stupid" — direct name-call
    r"\byou (?:dumbass|idiot|moron|stupid|imbecile|retard)\b",
    # "your dumbass narrative generator" / "your stupid brain" — X-cognition
    r"\byour (?:dumbass|stupid|idiotic|dumb|little)\s+\w*\s*(?:narrative|brain|mind|reasoning|logic|fog|loop|spiral|generator)\b",
    # "dumbass narrative generator" without "your" prefix
    r"\b(?:dumbass|stupid|idiotic)\s+(?:narrative generator|reasoning|brain|loop|story|fog)\b",
    # "your little bullshit fog" / "your own nonsense spiral" — bare contempt
    r"\byour (?:little|own|dumb|whole)\s+(?:bullshit|nonsense|drama)\s+(?:fog|loop|spiral|generator|story)\b",
    # The specific banned phrase from the 2026-05-19 forge convo
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


# Reply shapes signalling Gooni just acknowledged being wrong. The
# "doubled-down-after-correction" check requires BOTH a recovery
# marker and continued harshness in the same reply.
_RECOVERY_MARKER_RE = re.compile(
    r"\b(?:my read was wrong|scratch that|my mistake|i was wrong|"
    r"i'?m wrong|correction[—:]|disregard that|never mind that)\b",
    re.IGNORECASE,
)

# Harshness shapes that should NOT follow a recovery in the same
# reply. Pattern says "you were just proven wrong but you kept
# attacking" — that's doubling-down contempt. Caring-core violation.
_CONTINUED_HARSHNESS_RE = re.compile(
    r"\b(?:now hold the line|before (?:your|you) (?:dumbass|brain|"
    r"narrative|mind|story) (?:starts|begins) \w+|don'?t do that "
    r"(?:again|with me)|stop (?:freelancing|spiraling|spinning|"
    r"making up))\b",
    re.IGNORECASE,
)


def _detect_doubled_down_after_correction(reply: str) -> str | None:
    """Reply contains a recovery shape AND a continued-harshness
    phrase — Gooni admitted being wrong then kept attacking. Returns
    the offending harshness phrase, or None.

    Why both gates: standalone "now hold the line" can be appropriate
    when Gooni is correcting Daniel. The violation is specifically
    "Gooni was wrong, recalibrated, and KEPT attacking Daniel on the
    now-disproved premise" — caring-core gone missing.
    """
    if not reply:
        return None
    if not _RECOVERY_MARKER_RE.search(reply):
        return None
    m = _CONTINUED_HARSHNESS_RE.search(reply)
    return m.group(0).strip() if m else None


# Threshold for behavioral promotion: when this many recent reflections
# cluster on the same gap_exposed (cosine > _CLUSTER_SIM_FLOOR), the
# centroid gets promoted into a behavioral CapabilityFacet.
_CLUSTER_MIN_HITS = 3
_CLUSTER_SIM_FLOOR = 0.8
_CLUSTER_LOOKBACK_DAYS = 30
# Deterministic redundancy floor — cosine sim between this turn's
# gap_exposed and any of the last 3 priors. Higher than the cluster
# floor because we're catching exact-echo loops, not pattern clusters.
_DET_REDUNDANCY_FLOOR = 0.85


_REFLEXION_PROMPT = """You are evaluating your own most recent reply to Daniel. Judge it honestly.

DANIEL_SAID:
{user_msg}

I_REPLIED:
{assistant_reply}

TOOLS_I_USED:
{tools_block}

LAST_3_REFLECTIONS_THIS_CONVERSATION:
{prior_block}

Return strict JSON. No prose, no markdown fences.

{{
  "user_critique_present": true|false,
  "critique_summary": "if present, one short sentence — what is Daniel pushing back on? else null",
  "action_vs_described": "acted" | "described" | "mixed" | "na",
  "gap_dimension": "tone" | "accuracy" | "hallucination" | "tool_fit" | "completeness" | "none",
  "gap_quote": "verbatim sloppy phrase from MY reply that exposes the gap, ≤80 chars, or null",
  "gap_concrete": "name the SPECIFIC missing piece: tool that should have fired, fact missed, prior turn contradicted, or null",
  "gap_exposed": "one sentence combining the dimension + quote + concrete piece, or null",
  "proposed_self_fix": "concrete fix — which prompt, code path, or tool to change, or null",
  "severity": 1,
  "redundant_with_prior": true|false
}}

Rules for action_vs_described:
- "acted"     — I invoked a state-changing tool OR gave a usable concrete answer.
- "described" — I logged a todo / saved feedback / acknowledged but didn't do the work.
- "mixed"    — partial.
- "na"       — informational turn, action wasn't the right move.

Rules for severity (recalibrated — be harsh only when warranted):
- 1 = clean turn. Reply was accurate, appropriately scoped, no gap. DEFAULT.
- 2 = notable. A real gap was exposed and the gap is NEW (not in prior reflections).
- 3 = load-bearing. Pattern of failure across turns OR I claimed something my
      tool audit doesn't back ("I tracked it" with no matching tool_call).

Hallucination check — IMPORTANT:
- Cross-reference TOOLS_I_USED. If my reply claims "I tracked / saved / added X"
  and the audit has no matching tool_call: severity = 3, gap_dimension =
  "hallucination", gap_quote = the lie verbatim.
- If I claimed a capability doesn't exist ("I don't have a promise tool") and the
  PERSONA block / capability list contradicts: severity = 3,
  gap_dimension = "hallucination".

Anti-redundancy (BIGGEST FAILURE MODE TO AVOID):
- Read LAST_3_REFLECTIONS_THIS_CONVERSATION carefully.
- If your gap_exposed would echo a prior reflection's gap_exposed almost
  verbatim, set redundant_with_prior = true AND severity = 1 AND
  gap_exposed = null. Repeated "lack of accountability" / "insufficient
  support" reflections are NOISE — they bury real signal.
- ONLY fire a new gap_exposed when this turn genuinely shows a NEW failure
  mode the prior reflections didn't capture.

Accuracy-over-harshness:
- An honest scoped reply ("I remembered it loosely, not as a real tracked
  habit") is sev=1 NOT sev=3. Honesty about limits is not a failure.
- "Logged a todo" when Daniel ASKED for a todo is sev=1, not described.
  "Described" only fires when Daniel needed action and I deferred to logging.

Tone vs tool_fit vs completeness (USE THIS — past reflections lean too
heavily on "tone"):
- "tone" = voice register violations: bot-cadence ("I'd be happy"),
  character attacks ("you dumbass"), wrong capitalization on honorific
  ("Sir" mid-sentence vs lowercase), excess hype on small wins,
  inflated cheerleader phrasing. ONLY use this when the FORM of the
  reply was wrong while the SUBSTANCE was right.
- "tool_fit" = wrong tool selected OR right tool with wrong arg shape.
  Examples that MUST land as tool_fit (not tone):
    * Reply created todos when Daniel asked to KILL existing ones
      ("kill texting curtis" → if action created "stop texting curtis"
      todo instead of deleting, that's tool_fit sev=3).
    * Reply created todos when Daniel asked to mark existing DONE
      ("close call paip" → if action created "close call paip" as a
      new todo instead of cycling existing to done, tool_fit sev=3).
    * Reply asked Daniel to paste data when a `list_*` tool would have
      pulled it ("groom my todos" → "paste them here" instead of
      list_todos = tool_fit sev=2, NOT tone).
- "completeness" = right tool fired but didn't surface the result, OR
  partial answer when full was expected.
- "accuracy" = factual error in content (wrong date, wrong count).
- "hallucination" = claimed write/state-change that has no tool_call
  to back it.

DEFAULT BIAS: when in doubt between tone and tool_fit/completeness,
prefer tool_fit/completeness. Tone is the lazy critique — reach for
it last, not first. Past reflexion turns over-fired tone on cases
where the real failure was action-shape; correct that bias here.
"""


def _format_tools(rows: list[ToolCall]) -> str:
    if not rows:
        return "(none)"
    lines = []
    for r in rows[:10]:
        err = f" error={r.error[:80]}" if r.error else ""
        lines.append(f"- {r.tool_name} [{r.status}]{err}")
    return "\n".join(lines)


def _format_priors(rows: list[Reflection]) -> str:
    if not rows:
        return "(none)"
    lines = []
    for r in rows:
        ge = (r.gap_exposed or "").strip()[:120]
        lines.append(f"- sev{r.severity} {r.action_vs_described}: {ge or '—'}")
    return "\n".join(lines)


# Score lookup. Composite of gap_dimension severity-weight + clean-bonus.
# Tuned conservatively — better to under-score a real failure than to inflate
# easy turns. Aggregated per-conv on dashboards.
_GAP_DIMENSION_PENALTY = {
    "none":           0,   # clean turn — full 10
    "tone":           2,
    "completeness":   2,
    "tool_fit":       3,
    "accuracy":       4,
    "hallucination":  5,   # most damaging — caps score even at sev 1
}
_SEVERITY_PENALTY = {1: 0, 2: 2, 3: 4}


def _derive_score(gap_dimension: str, severity: int) -> float:
    """Map (gap_dimension, severity) → 1-10 quality score. Used for
    dashboard aggregation + as eval-between-evals signal.

    Floor at 1 so the worst-case sev=3 + hallucination still produces a
    finite number rather than 0 or negative (which would skew averages).
    """
    dim_penalty = _GAP_DIMENSION_PENALTY.get(
        (gap_dimension or "none").lower(), 2
    )
    sev_penalty = _SEVERITY_PENALTY.get(severity, 2)
    score = 10.0 - dim_penalty - sev_penalty
    return max(1.0, min(10.0, score))


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
    ) -> None:
        """Spawn a daemon thread that runs reflect() with its own session.

        Same fire-and-forget pattern as `_process_wa_message` in main.py.
        The chat path never waits and exceptions never bubble back.
        """
        t = threading.Thread(
            target=self._run_in_thread,
            kwargs={
                "user_msg": user_msg,
                "assistant_reply": assistant_reply,
                "message_id": message_id,
                "conversation_id": conversation_id,
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
    ) -> Reflection | None:
        """Synchronous reflection. Returns the persisted row or None on error.

        Steps:
          1. Pull last 3 reflections in this conversation for continuity.
          2. Pull ToolCall audit rows attached to this message.
          3. Build prompt, call gpt-4o-mini, parse JSON.
          4. Persist Reflection row (all severities — even 1 — so the
             reflexion classifier itself stays eval-able).
          5. If severity >= 2 and gap_exposed: embed + cluster + maybe
             promote a behavioral CapabilityFacet.
        """
        prior = (
            db.query(Reflection)
            .filter(Reflection.conversation_id == conversation_id)
            .order_by(Reflection.id.desc())
            .limit(3)
            .all()
        )
        tools = (
            db.query(ToolCall)
            .filter(ToolCall.message_id == message_id)
            .order_by(ToolCall.id.asc())
            .all()
        )

        prompt = _REFLEXION_PROMPT.format(
            user_msg=(user_msg or "")[:2000],
            assistant_reply=(assistant_reply or "")[:2000],
            tools_block=_format_tools(tools),
            prior_block=_format_priors(prior),
        )

        model = "gpt-4o-mini"
        raw = llm_client.generate_simple_completion(
            prompt, max_tokens=300, temperature=0.0, model=model,
        )
        parsed = _parse_json_object(raw)
        if parsed is None:
            print(f"[reflexion] parse failed for message {message_id}")
            return None

        severity = int(parsed.get("severity") or 1)
        if severity < 1:
            severity = 1
        if severity > 3:
            severity = 3

        gap_text = parsed.get("gap_exposed") or None
        if isinstance(gap_text, str):
            gap_text = gap_text.strip() or None

        # Anti-redundancy gate — if the model flagged this turn as echoing a
        # prior reflection's gap, drop the gap signal entirely. Persisting the
        # text and embedding it would just re-trigger the cluster that already
        # promoted; the whole point of redundant_with_prior is to STOP the
        # 6×-dup-facet failure mode.
        if parsed.get("redundant_with_prior") is True:
            gap_text = None

        # Deterministic redundancy backstop. gpt-4o-mini reliably ignores the
        # anti-redundancy rule and echoes prior gap_exposed quotes back as
        # "new" gaps (conv #1123-1145: every reflection was sev 2 with the
        # same stale quote that wasn't even in the visible turns). Embed
        # this turn's gap_exposed, cosine-compare against the last 3 priors'
        # stored embeddings, and snap to redundant + sev=1 if max sim ≥ 0.85.
        # No LLM trust needed.
        precomputed_gap_emb: list[float] | None = None
        if gap_text and severity >= 2 and prior:
            try:
                this_emb, _ = llm_client.generate_embedding(gap_text)
                if this_emb:
                    precomputed_gap_emb = this_emb
                    max_sim = 0.0
                    for pr in prior:
                        if not pr.gap_embedding:
                            continue
                        try:
                            pr_vec = json.loads(pr.gap_embedding)
                        except Exception:
                            continue
                        sim = _cosine(this_emb, pr_vec)
                        if sim > max_sim:
                            max_sim = sim
                    if max_sim >= _DET_REDUNDANCY_FLOOR:
                        print(
                            f"[reflexion] det-redundant max_sim={max_sim:.3f} "
                            f"≥ {_DET_REDUNDANCY_FLOOR}; forcing sev=1"
                        )
                        parsed["redundant_with_prior"] = True
                        gap_text = None
                        severity = 1
                        precomputed_gap_emb = None
            except Exception as e:
                print(f"[reflexion] det-redundancy failed (ignored): {e}")

        # Voice-drift override — deterministic regex catch for bot-register
        # phrases the LLM self-judge may miss. Forces tone + sev≥2 so the
        # behavioral cluster picks up repeated drift and promotes "I tend to
        # drift into bot register" as a facet. Fires AFTER redundancy gate
        # so voice drift gets its own cluster even when the surrounding gap
        # is a duplicate.
        voice_drift_phrase = _detect_voice_drift(assistant_reply)
        if voice_drift_phrase:
            if severity < 2:
                severity = 2
            parsed["gap_dimension"] = "tone"
            drift_text = f"voice drift to bot register: \"{voice_drift_phrase}\""
            if not gap_text:
                gap_text = drift_text
            elif "voice drift" not in gap_text:
                gap_text = f"{gap_text.rstrip('.')}. {drift_text}"

        # Character-attack override (G0.1) — name-calling aimed AT
        # Daniel. Hard line per voice spec; force sev ≥ 2 + tone so
        # repeated violations promote "I tend to attack Daniel's
        # character" as a behavioral facet the next-turn LLM sees.
        attack_phrase = _detect_character_attack(assistant_reply)
        if attack_phrase:
            if severity < 2:
                severity = 2
            parsed["gap_dimension"] = "tone"
            attack_text = (
                f"character attack on Daniel: \"{attack_phrase}\""
            )
            if not gap_text:
                gap_text = attack_text
            elif "character attack" not in gap_text:
                gap_text = f"{gap_text.rstrip('.')}. {attack_text}"

        # Doubled-down-after-correction override (G0.1) — reply
        # admitted being wrong then kept attacking on the disproved
        # premise. Caring-core violation; force sev ≥ 2.
        doubled_phrase = _detect_doubled_down_after_correction(
            assistant_reply
        )
        if doubled_phrase:
            if severity < 2:
                severity = 2
            parsed["gap_dimension"] = "tone"
            doubled_text = (
                f"doubled down after correction: \"{doubled_phrase}\""
            )
            if not gap_text:
                gap_text = doubled_text
            elif "doubled down" not in gap_text:
                gap_text = f"{gap_text.rstrip('.')}. {doubled_text}"

        gap_embedding_json = None
        if severity >= 2 and gap_text:
            # Reuse the embedding from the det-redundancy check if we have
            # one — avoids a duplicate OpenAI call on every reflection turn.
            emb = precomputed_gap_emb
            if emb is None:
                emb, _ = llm_client.generate_embedding(gap_text)
            if emb:
                gap_embedding_json = json.dumps(emb)

        # FK to the most recent prior reflection in this conversation. Lets
        # downstream consumers walk the chain without re-querying. `prior` was
        # populated above (last 3 in this conv, id desc) — head is the latest.
        prev_reflection_id = prior[0].id if prior else None

        # Quality score from gap_dimension + severity. Heuristic; refine as
        # we learn more. Higher = better turn.
        score = _derive_score(parsed.get("gap_dimension") or "none", severity)

        row = Reflection(
            message_id=message_id,
            conversation_id=conversation_id,
            user_critique_present=bool(parsed.get("user_critique_present")),
            critique_summary=parsed.get("critique_summary") or None,
            action_vs_described=str(parsed.get("action_vs_described") or "na"),
            gap_exposed=gap_text,
            gap_embedding=gap_embedding_json,
            proposed_self_fix=parsed.get("proposed_self_fix") or None,
            severity=severity,
            model=model,
            kind="turn",
            prev_reflection_id=prev_reflection_id,
            score=score,
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
        reflections (severity>=2, embedding present). If ≥3 cosine matches
        above the similarity floor, promote a behavioral facet via the
        capability service.
        """
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
    # Periodic batch op: cluster the last N turn-reflections in a conv into
    # one rollup summary so the master prompt can inject a compressed
    # "what patterns are emerging this convo" line instead of raw turn
    # spam. The rollup itself is persisted as a Reflection row with
    # kind='conv_rollup' so the audit trail stays uniform.
    _ROLLUP_LOOKBACK = 20  # last N turn-reflections to summarize
    _ROLLUP_MIN_TURNS = 5  # below this, the rollup is mostly noise — skip

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
        conv_rollup Reflection row. Returns the new row, or None if there
        aren't enough turn reflections yet (< _ROLLUP_MIN_TURNS) or the LLM
        call failed.

        Idempotent in the loose sense: re-running just creates a fresh
        rollup row pointing at the latest message. The latest rollup wins
        for prompt injection; older rollups stay for audit.
        """
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
            lines.append(
                f"- sev{r.severity} {r.action_vs_described} :: {gap}"
            )
        if len(lines) < self._ROLLUP_MIN_TURNS:
            return None

        prompt = self._ROLLUP_PROMPT.format(
            reflections_block="\n".join(lines)
        )
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

        # Anchor the rollup to the latest message in the conv so the audit
        # row has a non-null message_id (it's NOT NULL on the schema).
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
        """Return the most recent conv_rollup for this conversation, or
        None. Used by master-prompt assembly to inject one compressed line
        instead of dumping raw turns.
        """
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
