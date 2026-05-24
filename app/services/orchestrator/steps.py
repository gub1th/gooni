import json
import re

from ...db.models import ToolCall as ToolCallModel
from ...llm.client import llm_client


_PLAN_PROMPT = """You are Gooni's pre-action planner. Read the user's message + state and decide what should happen this turn.

USER MESSAGE: {user_msg}

YOUR CURRENT STATE:
{state}

CHAT-SURFACE TOOLS AVAILABLE: {tools_list}

ROUTER SIGNALS (auto-extracted upstream BEFORE the chat model runs — these
fire whether or not the chat model calls a tool):
  router:promise, router:todo, router:feature_request, router:tone_correction

Return strict JSON. No prose, no markdown fence.

{{
  "goal": "<one short sentence — what does Daniel actually want this turn>",
  "intended_tools": ["tool_name", ...] or [],
  "minimum_action": "<one sentence — smallest sufficient response>",
  "reasoning": "<one sentence — why this plan>"
}}

Rules:
- Venting / thinking-aloud / vague intent → intended_tools=[], minimum_action="terse empathic response, push back if commitment is fuzzy"
- Commitment statements ("i won't smoke for a week" / "imma X tonight") → router:promise fires upstream; chat reply acknowledges, optional add_focus if arc
- "remember/track Y" → save_memory or appropriate persistent tool
- "what did I commit to / show my X" → READ tool (show_list, list_todos, list_focuses, search_notes)
- Recurring-reminder asks ("remind me daily") → request_feature (capability gap)
- Don't propose tools not in TOOLS AVAILABLE
- Plan is allowed to be empty if no action is required."""


def _run_plan(
    user_msg: str,
    state_summary: str,
    tools_list: list[str],
) -> dict | None:
    """Pre-reply plan step. Returns parsed dict or None on failure.
    Single gpt-4o-mini call (~$0.0001). Fail-open."""
    if not user_msg:
        return None
    try:
        prompt = _PLAN_PROMPT.format(
            user_msg=user_msg[:600],
            state=state_summary[:500] or "(no state)",
            tools_list=", ".join(tools_list[:50]),
        )
        raw = llm_client.generate_simple_completion(
            prompt, max_tokens=300, temperature=0.0, model="gpt-4o-mini",
        )
        s = (raw or "").strip()
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*", "", s).rstrip("`").rstrip()
        parsed = json.loads(s)
        if not isinstance(parsed, dict):
            return None
        return {
            "goal": str(parsed.get("goal") or "").strip()[:200],
            "intended_tools": [
                str(t).strip()
                for t in (parsed.get("intended_tools") or [])
                if isinstance(t, str)
            ][:8],
            "minimum_action": str(parsed.get("minimum_action") or "").strip()[:240],
            "reasoning": str(parsed.get("reasoning") or "").strip()[:200],
        }
    except Exception as e:
        print(f"[plan] failed: {e}")
        return None


_VERIFY_PROMPT = """Compare this assistant reply against the actual tool audit. Did the reply make a CONCRETE state-changing claim that the audit doesn't back?

USER ASKED: {user_msg}

DRAFT REPLY: {draft}

TOOLS ACTUALLY CALLED THIS TURN (status='done' means action succeeded):
{audit}

Return strict JSON. No prose, no markdown fence.

{{"ok": true|false, "critique": "if not ok, quote the EXACT unbacked phrase from the draft and name the missing tool (one sentence); else null"}}

Rules — be CONSERVATIVE (default ok=true):
- ok=false ONLY when the draft contains an EXPLICIT past-tense state-changing
  verb tied to a specific OBJECT: "tracked X", "saved X as a memory", "added X
  to your Y list", "logged feature request X", "created focus X", "marked X
  done", "noted X in your journal", "wrote it down". If you can't quote the
  exact phrase, it's not a lie — ok=true.
- BARE words "tracked" / "noted" / "got it" / "ok" / "remembered" alone are
  NOT enough. The draft must claim a specific persisted side-effect.
- HONEST SCOPING ALWAYS ok=true:
    "I can't track that as a habit / I don't have a tool for X / loosely
    remembered, not formally tracked / only in conversation context / not
    durable / I'd need a tool for that / no recurring reminder support"
- ROUTER-LAYER CLAIMS ok=true: the orchestrator router fires promise/feature/
  tone hooks UPSTREAM of the chat model. If the draft says "captured" /
  "logged as a feature request" / "added that promise" without an explicit
  chat-side tool call, it's still ACCURATE — the router did it. ok=true.
- Tone, length, helpfulness are NEVER in scope here. Only fact-of-action.
- Empty audit + no action-claim = ok=true (default).
- Critique must be CONCRETE: include the verbatim sloppy phrase. Vague
  critiques like "may be misleading" or "could be clearer" — emit ok=true.
"""


# Verbs the LLM uses to claim a persisted side-effect. If any of these
# appear in a draft reply on a turn where nothing was actually persisted
# (no captured_* router writes, no state-changing chat tool call), the
# claim is unbacked — force a regen. Deterministic backstop for the LLM
# verifier, which has historically missed the "tracked"-class lie
# (conv #1136-1137: "do a little leetcode" tracked with no audit).
_UNBACKED_CLAIM_RE = re.compile(
    r"\b(tracked|logged|saved|added|noted|created|recorded)\b",
    re.IGNORECASE,
)

# Read-only tools whose presence in the audit doesn't justify a
# "tracked/saved" claim. Used by the deterministic precheck.
_READ_ONLY_TOOLS = {
    "list_todos", "list_focuses", "list_promises", "list_habits",
    "list_recent_notes", "list_recent_commits", "list_recent_backlog",
    "read_note", "read_todos", "read_focus", "read_list",
    "find_note", "search_notes", "search_memories",
    "find_similar_items", "find_similar_backlog",
    "web_search", "fetch_url",
    "check_calendar_busy", "get_calendar_event", "list_calendar_events",
    "get_context", "read_capability_facets",
    "get_leetcode_activity", "list_comments", "list_focus_signals",
}

def _deterministic_unbacked_check(
    *,
    draft: str,
    captured_features: list[dict],
    captured_promises: list[dict],
    captured_todos: list[dict],
    captured_metrics: list[dict] | None = None,
    tool_call_ids: list[int],
    db,
) -> str | None:
    """Return a critique string if the draft claims a persisted write that
    nothing in this turn actually backs. Returns None when the draft is
    clean OR a real write exists.

    Hard rail backstop — runs before the LLM verifier so the regen path
    fires deterministically on the leetcode-class miss.
    """
    if not draft:
        return None
    # Router-layer writes back any "tracked"/"logged" claim — Promise /
    # Feature / Todo / DailyMetric rows landed even when no chat tool
    # fired. ok regardless of verb. (DailyMetric matters here because the
    # fitness ack legitimately says "logged" — without this, a fitness
    # turn on the full-reply path would falsely trip the regen.)
    if captured_features or captured_promises or captured_todos or captured_metrics:
        return None
    m = _UNBACKED_CLAIM_RE.search(draft)
    if not m:
        return None
    # Any state-changing chat tool call this turn also backs the claim.
    # Filter out read-only tools — they don't justify "tracked/saved".
    if tool_call_ids:
        try:
            rows = (
                db.query(ToolCallModel)
                .filter(ToolCallModel.id.in_(tool_call_ids))
                .all()
            )
            for r in rows:
                if r.status != "done":
                    continue
                if (r.tool_name or "") not in _READ_ONLY_TOOLS:
                    return None
        except Exception as e:
            print(f"[unbacked_check] audit read failed: {e}")
            return None
    return (
        f'reply contains "{m.group(0)}" claim but nothing was persisted '
        f"this turn — no router-layer captures and no state-changing tool "
        f"call. Drop the verb or scope it honestly "
        f'("noted in chat, sir — not formally tracked").'
    )


# Phase 2 (backlog #313): memory-citation anchors. The static system prompt
# (app/llm/prompts.py master-rule #7) requires the LLM to tag every recalled
# memory it synthesizes from with an inline [M#N] anchor — anti-hallucination
# grounding. Those anchors are INTERNAL: they force the model to ground its
# claims, but they're noise to the user. The leak: "job apps are still the
# cleanest leverage [M#184]" surfaced verbatim in a WhatsApp reply. We strip
# them on the way out so the grounding contract stays in the prompt while the
# user sees clean prose. Matches single [M#1] and multi [M#3, M#7] forms.
_MEMORY_ANCHOR_RE = re.compile(r"\s*\[M#\d+(?:\s*,\s*M#\d+)*\]")


def _strip_memory_anchors(text: str) -> str:
    """Remove [M#N] / [M#3, M#7] memory-citation tags from outbound text."""
    if not text or "[M#" not in text:
        return text
    cleaned = _MEMORY_ANCHOR_RE.sub("", text)
    # Tidy whitespace the removal left behind: space-before-punctuation and
    # collapsed double-spaces mid-sentence.
    cleaned = re.sub(r"\s+([.,;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"  +", " ", cleaned)
    return cleaned


def _run_verify(
    draft: str,
    user_msg: str,
    tool_call_ids: list[int],
    db,
) -> tuple[bool, str]:
    """Post-reply verify against ToolCall audit. Returns (ok, critique).
    Fail-open on any error — never break the chat path. ok=True means
    ship as-is; ok=False + critique means regenerate w/ correction.
    """
    if not draft:
        return True, ""
    try:
        rows: list[ToolCallModel] = []
        if tool_call_ids:
            rows = (
                db.query(ToolCallModel)
                .filter(ToolCallModel.id.in_(tool_call_ids))
                .all()
            )
        audit_lines = [
            f"- {r.tool_name} [{r.status}]" + (f" error={r.error[:80]}" if r.error else "")
            for r in rows
        ]
        audit_block = "\n".join(audit_lines) if audit_lines else "(no tools called)"
        prompt = _VERIFY_PROMPT.format(
            user_msg=(user_msg or "")[:600],
            draft=(draft or "")[:1500],
            audit=audit_block,
        )
        raw = llm_client.generate_simple_completion(
            prompt, max_tokens=200, temperature=0.0, model="gpt-4o-mini",
        )
        # Strip code fences if any.
        s = (raw or "").strip()
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*", "", s).rstrip("`").rstrip()
        parsed = json.loads(s)
        ok = bool(parsed.get("ok", True))
        critique = (parsed.get("critique") or "").strip()
        return ok, critique
    except Exception as e:
        print(f"[verify_reply] failed: {e}")
        return True, ""

