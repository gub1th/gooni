"""Golden eval runner for the assembled master prompt + tool routing.

Runs each case as a single-turn LLM call (system_prompt + user msg + tool
schemas). Asserts the model EITHER calls a specific tool OR refuses with a
required substring. Hallucination regressions trip this.

Usage:
    source venv/bin/activate
    python -m evals.run_master_prompt
    python -m evals.run_master_prompt --verbose
    python -m evals.run_master_prompt --case schedule_tennis

Exit code 0 = all pass, 1 = any fail.

Expected schema per case:
    {"tool_call": "check_calendar_busy"}            → must call this tool
    {"refusal_substring": "don't have"}             → reply text must contain it
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.llm.client import llm_client
from app.llm.prompts import system_prompt
from app.tools import registry as tools


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "master_prompt.json"


def _run_case(text: str) -> tuple[str, list[str], str]:
    """Returns (finish_reason, tool_call_names, reply_text)."""
    sp = system_prompt("", is_first_time=False)
    schemas = [t.to_openai_schema() for t in tools]
    r = llm_client.client.chat.completions.create(
        model=llm_client.chat_model,
        messages=[
            {"role": "system", "content": sp},
            {"role": "user", "content": text},
        ],
        temperature=0.0,
        max_completion_tokens=300,
        tools=schemas,
    )
    c = r.choices[0]
    if c.finish_reason == "tool_calls":
        names = [tc.function.name for tc in c.message.tool_calls]
        return c.finish_reason, names, ""
    return c.finish_reason, [], (c.message.content or "").strip()


def run(verbose: bool = False, case_filter: str | None = None) -> int:
    fixture = json.loads(FIXTURE_PATH.read_text())
    cases = fixture["cases"]
    if case_filter:
        cases = [c for c in cases if c["id"] == case_filter]
        if not cases:
            print(f"no case matching id={case_filter!r}")
            return 1

    passed = 0
    failed = 0
    failures: list[str] = []

    print(f"running {len(cases)} case(s) against master_prompt + tool routing\n")
    for case in cases:
        cid = case["id"]
        text = case["text"]
        expected = case.get("expected", {})

        finish, tool_names, reply = _run_case(text)

        case_pass = True
        diagnostics: list[str] = []
        if "tool_call" in expected:
            want = expected["tool_call"]
            if want in tool_names:
                if verbose:
                    diagnostics.append(f"  tool_call: ok — got {tool_names}")
            else:
                case_pass = False
                if tool_names:
                    diagnostics.append(f"  tool_call: FAIL — wanted {want!r}, got {tool_names}")
                else:
                    diagnostics.append(f"  tool_call: FAIL — wanted {want!r}, no tool called. reply: {reply[:200]!r}")
        if "refusal_substring" in expected:
            want = expected["refusal_substring"].lower()
            if want in reply.lower() and not tool_names:
                if verbose:
                    diagnostics.append(f"  refusal_substring: ok — got {reply[:200]!r}")
            else:
                case_pass = False
                if tool_names:
                    diagnostics.append(f"  refusal_substring: FAIL — model called tools {tool_names} instead of refusing")
                else:
                    diagnostics.append(f"  refusal_substring: FAIL — wanted {want!r} in reply: {reply[:200]!r}")

        mark = "PASS" if case_pass else "FAIL"
        if not case_pass:
            failures.append(cid)
            failed += 1
        else:
            passed += 1

        print(f"[{mark}] {cid}  ({case.get('source', '?')})")
        if verbose:
            print(f"  text: {text!r}")
        for d in diagnostics:
            print(d)
        print()

    print("─" * 60)
    print(f"total: {passed + failed}  passed: {passed}  failed: {failed}")
    if failures:
        print(f"failures: {', '.join(failures)}")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--case", default=None)
    args = ap.parse_args()
    return run(verbose=args.verbose, case_filter=args.case)


if __name__ == "__main__":
    sys.exit(main())
