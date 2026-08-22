import json
import re

from ...common import WRITE_CLAIM_RE
from ...llm.client import llm_client
from .write_ledger import WriteLedger


_VERIFY_PROMPT = """Compare this assistant reply against the ledger of what the turn ACTUALLY wrote. Did the reply make a CONCRETE state-changing claim the ledger doesn't back?

USER ASKED: {user_msg}

DRAFT REPLY: {draft}

WRITE LEDGER FOR THIS TURN — every write BOTH writers performed. `[router]`
lines ran upstream of the reply, `[tool]` lines ran inside it. A line with no
parenthesised note LANDED; any parenthesised note means it did NOT:
{audit}

Return strict JSON. No prose, no markdown fence.

{{"ok": true|false, "critique": "if not ok, quote the EXACT unbacked phrase from the draft and name what is missing from the ledger (one sentence); else null"}}

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
- THE LEDGER IS THE WHOLE ANSWER ON FACT-OF-ACTION. The router fires
  promise/feature hooks upstream of the reply, so a claim CAN be backed
  with no tool call at all — but only by a `[router]` line that is actually
  listed above. A router-flavoured VERB ("captured" / "logged as a feature
  request" / "added that promise") is NOT itself evidence that the router
  ran. Look it up in the ledger; if no line backs it, ok=false.
- A NOTED line backs NOTHING. Specifically:
    "NOT WRITTEN — noticed only" = the router flagged a commitment for review
      and deliberately created NO row. "added/tracked that promise" off one of
      these is ok=false; "i see the commitment" / "flagged it for you" is fine.
    "queued, unconfirmed" = dispatched off-thread; the turn cannot know it
      landed, so it does not back "saved it".
    "read-only" = the tool only read. "FAILED" = it did not land.
- The backing write must be about the CLAIMED OBJECT. Writes to unrelated
  objects do not launder a claim: if the draft says "logged that feature
  request" and the only landed line is a trackable entry, ok=false. When the
  ledger is ambiguous about which object a line touched, default ok=true.
- Tone, length, helpfulness are NEVER in scope here. Only fact-of-action.
- Empty ledger + no action-claim = ok=true (default).
- Critique must be CONCRETE: include the verbatim sloppy phrase. Vague
  critiques like "may be misleading" or "could be clearer" — emit ok=true.
"""


# Write-claim detector shared with reflexion (single source of truth in
# app/common.py). Verb+object shape on purpose: bare "noted, sir" is the
# persona's mandated capture-ack, NOT a write claim — the old bare-verb
# pattern here tripped the regen rail on exactly the vocabulary PERSONA
# requires, while reflexion's copy deliberately excluded it. One regex,
# one opinion.
_UNBACKED_CLAIM_RE = WRITE_CLAIM_RE


def _deterministic_unbacked_check(*, draft: str, ledger: WriteLedger) -> str | None:
    """Return a critique string if the draft claims a persisted write that
    nothing in this turn actually backs. Returns None when the draft is
    clean OR at least one real write exists.

    Hard rail backstop — runs before the LLM verifier so the regen path
    fires deterministically on the leetcode-class miss.

    This rail is deliberately OBJECT-BLIND: any landed write suppresses it,
    because a deterministic verb→object matcher would false-positive on
    ordinary paraphrase and this rail overrides the LLM verifier outright.
    Matching the claim to the RIGHT write is the verifier's job — which is
    what it can finally do now that it is shown the ledger instead of being
    told to trust every router-shaped verb on sight.
    """
    if not draft:
        return None
    m = _UNBACKED_CLAIM_RE.search(draft)
    if not m:
        return None
    # Fail OPEN when the tool audit couldn't be read — an unreadable audit is
    # not evidence that the draft lied.
    if not ledger.audit_readable:
        return None
    # Any landed write — router capture OR non-read-only chat tool — backs the
    # claim here. Glow annotations, queued off-thread preferences and failed
    # writes are in the ledger but do NOT count: `backs_a_claim` is what draws
    # that line, in one place, for both rails.
    if ledger.backing_writes():
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
    ledger: WriteLedger,
) -> tuple[bool, str]:
    """Post-reply verify against the turn's write ledger. Returns
    (ok, critique). Fail-open on any error — never break the chat path.
    ok=True means ship as-is; ok=False + critique means regenerate w/
    correction.

    Takes the ledger rather than raw tool-call ids on purpose: the router
    writes upstream of the model and leaves no ToolCall row, so a verifier
    shown only the tool audit could never confirm a router claim — which is
    how it came to be told to trust them all unconditionally instead.
    """
    if not draft:
        return True, ""
    try:
        audit_block = ledger.render()
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

