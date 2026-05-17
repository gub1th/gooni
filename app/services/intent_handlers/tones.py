"""Tone-correction routing — captures the rule + spawns the off-thread
`memory_service.add_feedback_preference` call. Requires `prev_assistant_*`
context: tone corrections only fire when there's a prior assistant turn
to attribute the correction to (note-save path has no prev_assistant, so
tones are quietly skipped there).
"""

from __future__ import annotations

import threading


def handle(corrections: list[dict], ctx, result) -> None:
    if not corrections:
        return
    if ctx.prev_assistant_text is None:
        return  # tone corrections require a prior assistant turn

    from ..memory_service import memory_service

    for t in corrections:
        rule = t.get("rule") or ""
        if not rule:
            continue
        evidence = t.get("evidence", "")
        anti_pattern = t.get("anti_pattern", "")

        result.tone_rules.append(rule)
        result.tools_used.append("router:tone")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:tone",
                    label="Captured tone correction",
                    args={
                        "rule": rule,
                        "evidence": evidence,
                        "anti_pattern": anti_pattern,
                    },
                )
            except Exception as e:
                print(f"[tones handler] trace hook error: {e}")

        # Off-thread feedback-preference write so the chat reply path
        # isn't blocked by an embed + DB round-trip.
        threading.Thread(
            target=memory_service.add_feedback_preference,
            args=(rule, ctx.prev_assistant_text),
            kwargs={"anti_pattern": anti_pattern},
            daemon=True,
        ).start()
