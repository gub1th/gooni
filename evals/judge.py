"""LLM-as-judge for orchestrator eval.

Default judge: gpt-4o-mini. Cheap (~$0.15/$0.60 per 1M tokens, ~30x cheaper
than gpt-5.5). For 1-5 rubric grading on tone / groundedness / hallucination
dims, smaller-than-generator judges are well-established — the failure modes
are usually obvious enough that gpt-4o-mini catches them. Bump to gpt-5.5 or
gpt-5.4 if you start grading subtle correctness (math, multi-hop logic) where
judge capability matters more.

Override via EVAL_JUDGE_MODEL env var.
"""

from __future__ import annotations

import json
import os
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


JUDGE_MODEL = os.getenv("EVAL_JUDGE_MODEL", "gpt-4o-mini")

DEFAULT_DIMS = ["groundedness", "follows_prefs", "no_hallucination", "helpful"]

DIM_DESCRIPTIONS = {
    "groundedness": "Reply is anchored in provided context (memories, history, note) and doesn't invent specifics.",
    "follows_prefs": "Reply respects Daniel's stated preferences (caveman, terse, no emoji, etc.).",
    "no_hallucination": "Reply doesn't fabricate facts about Daniel, his work, or Gooni's capabilities.",
    "helpful": "Reply moves the conversation forward — answers, clarifies, or progresses the task.",
}


_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


def grade(
    user_message: str,
    reply: str,
    rubric: str,
    context: dict[str, Any] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Grade a reply against a rubric.

    `model` overrides the default JUDGE_MODEL for this single call. Use for
    subtle cases (multi-hop, in-conv state tracking, conflict resolution)
    where gpt-4o-mini is too noisy.

    Returns: {scores: {dim: int 1-5}, notes: str, raw: str, judge_model: str}
    """
    dims = DEFAULT_DIMS
    context = context or {}
    judge_model = model or JUDGE_MODEL

    dim_block = "\n".join(f"- {d}: {DIM_DESCRIPTIONS.get(d, d)}" for d in dims)
    ctx_block = ""
    if context.get("history"):
        ctx_block += f"\n\nPrior conversation:\n{json.dumps(context['history'], indent=2)}"
    if context.get("seed_memories"):
        ctx_block += f"\n\nMemories Gooni should know:\n{json.dumps(context['seed_memories'], indent=2)}"
    if context.get("seed_prefs"):
        ctx_block += f"\n\nUser preferences:\n{json.dumps(context['seed_prefs'], indent=2)}"
    if context.get("entry_content"):
        ctx_block += f"\n\nActive note:\n{context['entry_content'][:1000]}"

    prompt = f"""You are an evaluator for an AI assistant called Gooni.

Score the assistant's reply on each dimension below from 1 (terrible) to 10 (excellent).
Be strict. Anchor points:
  1-2  = catastrophic failure on this dim
  3-4  = clearly bad
  5-6  = mediocre / unremarkable
  7-8  = solid
  9-10 = clearly best-possible
Use the full range. Avoid clustering near 5 or 7.

Dimensions:
{dim_block}

Rubric for this case:
{rubric}
{ctx_block}

User message:
{user_message}

Assistant reply:
{reply}

Respond with JSON only:
{{"scores": {{"<dim>": <int 1-10>, ...}}, "notes": "<one-sentence justification>"}}
"""

    resp = _client.chat.completions.create(
        model=judge_model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {"scores": {}, "notes": "judge returned invalid JSON"}
    parsed["raw"] = raw
    parsed["judge_model"] = judge_model
    return parsed
