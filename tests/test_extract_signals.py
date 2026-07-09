"""Regression net for `memory_extraction.extract_signals`.

Not a full eval suite — just a hand-picked smoke battery so prompt edits
don't silently break the obvious cases. Run before/after touching
`_SIGNALS_PROMPT` or swapping models.

Usage:
  source venv/bin/activate && set -a && source .env && set +a
  python tests/test_extract_signals.py

Each case asserts only the *primary* signal type plus that the
unrelated arrays stay empty. Memories are checked by count + type, not
exact wording — the classifier paraphrases.

Adds one signal? Add a case. Removes one? Delete the case. The whole
file should stay under ~150 lines or it stops being a regression net
and starts being a maintenance burden.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.memory_extraction import extract_signals


CASES = [
    {
        "label": "TONE",
        "text": "less teacher-y, sound more direct",
        "prev": "That's a great question! Here are several things to consider...",
        "expect": {"tone_min": 1, "feature_max": 0, "memories_max": 0},
    },
    {
        "label": "FEATURE_CHAT",
        "text": "you can't actually schedule that, you don't have a scheduler",
        "prev": "Sure, I'll remind you tomorrow at 9am.",
        "expect": {"tone_max": 1, "feature_min": 1, "memories_max": 0},
    },
    {
        "label": "FEATURE_NOTE",
        "text": "gooni you need to allow me to add hyperlinks in notes",
        "prev": None,
        "expect": {"tone_max": 0, "feature_min": 1, "memories_max": 0},
    },
    {
        "label": "MEMORY",
        "text": "I prefer dark mode IDEs",
        "prev": None,
        "expect": {
            "tone_max": 0,
            "feature_max": 0,
            "memories_min": 1,
            # "preference" type was retired — stable tastes emit as "fact"
            # (see _SIGNALS_PROMPT memories rules).
            "memory_types": {"fact"},
        },
    },
    {
        "label": "NONE",
        "text": "how many calories in an apple?",
        "prev": None,
        "expect": {"tone_max": 0, "feature_max": 0, "memories_max": 0},
    },
    # ── ambient-loop v2 unified promise emit ──
    {
        "label": "PROMISE_NXWK",
        "text": "imma hit the gym 6x a week starting now",
        "prev": "understood, sir.",
        "expect": {
            "promise_min": 1, "feature_max": 0,
            "promise_cadence": "n_per_week", "promise_target": 6,
        },
    },
    {
        "label": "PROMISE_ONCE",
        "text": "i'll ship the memory eval by friday",
        "prev": "understood, sir.",
        "expect": {
            "promise_min": 1, "feature_max": 0,
            "promise_cadence": "once", "promise_has_due": True,
        },
    },
    {
        "label": "PROMISE_NONE",
        "text": "saw a cool paper on attention sparsity today",
        "prev": "understood, sir.",
        "expect": {"promise_max": 0, "feature_max": 0},
    },
]


def check(actual: dict, expect: dict, label: str) -> list[str]:
    fails = []
    n_tone = len(actual["tone_corrections"])
    n_feat = len(actual["feature_requests"])
    n_mem = len(actual["memories"])
    proms = actual.get("promises") or []
    creates = [p for p in proms if p.get("kind") == "create"]

    if "promise_min" in expect and len(creates) < expect["promise_min"]:
        fails.append(f"promise_min={expect['promise_min']} got {len(creates)}")
    if "promise_max" in expect and len(creates) > expect["promise_max"]:
        fails.append(f"promise_max={expect['promise_max']} got {len(creates)}")
    if "promise_cadence" in expect:
        cads = {p.get("cadence") for p in creates}
        if expect["promise_cadence"] not in cads:
            fails.append(f"promise_cadence={expect['promise_cadence']} got {cads}")
    if "promise_target" in expect:
        targets = {p.get("cadence_target") for p in creates}
        if expect["promise_target"] not in targets:
            fails.append(f"promise_target={expect['promise_target']} got {targets}")
    if expect.get("promise_has_due") and not any(
        p.get("due_date") or p.get("due_hint") for p in creates
    ):
        fails.append("promise_has_due: no due_date/due_hint on any create")

    if "tone_min" in expect and n_tone < expect["tone_min"]:
        fails.append(f"tone_min={expect['tone_min']} got {n_tone}")
    if "tone_max" in expect and n_tone > expect["tone_max"]:
        fails.append(f"tone_max={expect['tone_max']} got {n_tone}")
    if "feature_min" in expect and n_feat < expect["feature_min"]:
        fails.append(f"feature_min={expect['feature_min']} got {n_feat}")
    if "feature_max" in expect and n_feat > expect["feature_max"]:
        fails.append(f"feature_max={expect['feature_max']} got {n_feat}")
    if "memories_min" in expect and n_mem < expect["memories_min"]:
        fails.append(f"memories_min={expect['memories_min']} got {n_mem}")
    if "memories_max" in expect and n_mem > expect["memories_max"]:
        fails.append(f"memories_max={expect['memories_max']} got {n_mem}")
    if "memory_types" in expect:
        got = {m.get("type") for m in actual["memories"]}
        if not expect["memory_types"].issubset(got):
            fails.append(f"memory_types missing {expect['memory_types'] - got}")
    return fails


def main() -> int:
    if not os.getenv("OPENAI_API_KEY"):
        print("OPENAI_API_KEY not set — source .env first")
        return 2

    passed = 0
    failed = 0
    for case in CASES:
        sig = extract_signals(case["text"], prev_assistant=case["prev"])
        fails = check(sig, case["expect"], case["label"])
        status = "PASS" if not fails else "FAIL"
        print(f"[{status}] {case['label']:14s} {case['text']!r}")
        print(f"         tone={len(sig['tone_corrections'])}  "
              f"feature={len(sig['feature_requests'])}  "
              f"memories={len(sig['memories'])}  "
              f"promises={len(sig.get('promises') or [])}")
        for p in (sig.get("promises") or []):
            print(f"           promise  · [{p.get('kind')}] {p.get('utterance') or p.get('match')} "
                  f"(cadence={p.get('cadence')}, target={p.get('cadence_target')}, "
                  f"due={p.get('due_date') or p.get('due_hint')})")
        if sig["tone_corrections"]:
            for t in sig["tone_corrections"]:
                print(f"           tone     · {t['rule']}")
        if sig["feature_requests"]:
            for f in sig["feature_requests"]:
                print(f"           feature  · {f['title']} — {f['why']}")
        if sig["memories"]:
            for m in sig["memories"]:
                print(f"           memory   · [{m.get('type')}] {m.get('content')}")
        if fails:
            for f in fails:
                print(f"           ! {f}")
            failed += 1
        else:
            passed += 1
        print()

    print(f"--- {passed}/{len(CASES)} passed, {failed} failed ---")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
