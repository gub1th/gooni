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
import threading
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.database import SessionLocal
from ..db.models import Reflection, ToolCall
from ..llm.client import llm_client
from .capability_service import capability_service
from .memory_extraction import _parse_json_object


# Threshold for behavioral promotion: when this many recent reflections
# cluster on the same gap_exposed (cosine > _CLUSTER_SIM_FLOOR), the
# centroid gets promoted into a behavioral CapabilityFacet.
_CLUSTER_MIN_HITS = 3
_CLUSTER_SIM_FLOOR = 0.8
_CLUSTER_LOOKBACK_DAYS = 30


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

        gap_embedding_json = None
        if severity >= 2 and gap_text:
            emb, _ = llm_client.generate_embedding(gap_text)
            if emb:
                gap_embedding_json = json.dumps(emb)

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


reflexion_service = ReflexionService()
