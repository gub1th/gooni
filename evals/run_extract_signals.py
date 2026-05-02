"""Golden eval runner for extract_signals.

Usage:
    source venv/bin/activate
    python -m evals.run_extract_signals               # full run, summary only
    python -m evals.run_extract_signals --verbose     # also print actual outputs
    python -m evals.run_extract_signals --case fp1_dumbass_venting   # one case

Exit code 0 = all cases pass, 1 = any failure. Wire into CI later.

Expected-field grammar (per fixture case):
    "empty"               → output list must be []
    "fires"               → output list must be non-empty
    "<substring>"         → output list must be non-empty AND
                            first item's title/rule must contain <substring>
                            (case-insensitive)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from app.services.memory_extraction import extract_signals


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "extract_signals.json"

# Map output field → key inside each item used for substring assertions.
ITEM_LABEL_KEY = {
    "tone_corrections": "rule",
    "feature_requests": "title",
    "memories": "content",
}


def _check_field(field: str, expected: str, actual: list[dict]) -> tuple[bool, str]:
    """Returns (passed, reason). Reason is a short diagnostic string."""
    norm = expected.strip().lower()
    if norm == "empty":
        if actual:
            first = actual[0].get(ITEM_LABEL_KEY.get(field, "rule"), "<?>")
            return False, f"expected empty, got {len(actual)} item(s); first: {first!r}"
        return True, "empty as expected"
    if norm == "fires":
        if not actual:
            return False, "expected fires, got empty"
        return True, f"fired {len(actual)} item(s)"
    # Substring match against first item's label.
    if not actual:
        return False, f"expected substring {expected!r}, got empty"
    label = actual[0].get(ITEM_LABEL_KEY.get(field, "rule"), "")
    if expected.lower() in label.lower():
        return True, f"matched {label!r}"
    return False, f"expected substring {expected!r} in {label!r}"


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

    print(f"running {len(cases)} case(s) against extract_signals\n")
    for case in cases:
        cid = case["id"]
        text = case["text"]
        prev = case.get("prev_assistant", "")
        expected = case.get("expected", {})

        out = extract_signals(text, prev_assistant=prev)

        case_pass = True
        diagnostics: list[str] = []
        for field, expectation in expected.items():
            actual = out.get(field, [])
            ok, reason = _check_field(field, expectation, actual)
            if not ok:
                case_pass = False
                diagnostics.append(f"  {field}: FAIL — {reason}")
            elif verbose:
                diagnostics.append(f"  {field}: ok — {reason}")

        if case_pass:
            passed += 1
            mark = "PASS"
        else:
            failed += 1
            mark = "FAIL"
            failures.append(cid)

        print(f"[{mark}] {cid}  ({case.get('source', '?')})")
        if verbose:
            print(f"  text: {text!r}")
        for d in diagnostics:
            print(d)
        if verbose:
            print(f"  raw: tone={len(out['tone_corrections'])} "
                  f"feature={len(out['feature_requests'])} "
                  f"memory={len(out['memories'])}")
        print()

    print("─" * 60)
    print(f"total: {passed + failed}  passed: {passed}  failed: {failed}")
    if failures:
        print(f"failures: {', '.join(failures)}")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="print expected-field diagnostics + raw counts")
    ap.add_argument("--case", default=None,
                    help="run a single case by id")
    args = ap.parse_args()
    return run(verbose=args.verbose, case_filter=args.case)


if __name__ == "__main__":
    sys.exit(main())
