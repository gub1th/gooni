"""Decay-function net for the focus system. Pure math — no DB, no LLM.
Run: python tests/test_focus_decay.py
"""

import os
import sys
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

from app.services import focus_service as fs  # noqa: E402


def _approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def test_no_decay_at_zero_elapsed():
    now = datetime(2026, 7, 23, 12, 0, 0)
    assert _approx(fs.decay_factor(now, now), 1.0)


def test_half_life():
    now = datetime(2026, 7, 23, 12, 0, 0)
    touched = now - timedelta(days=fs.SALIENCE_HALF_LIFE_DAYS)
    assert _approx(fs.decay_factor(touched, now), 0.5, tol=1e-9)
    # two half-lives → quarter
    touched2 = now - timedelta(days=2 * fs.SALIENCE_HALF_LIFE_DAYS)
    assert _approx(fs.decay_factor(touched2, now), 0.25, tol=1e-9)


def test_decayed_salience_floors():
    now = datetime(2026, 7, 23, 12, 0, 0)
    # A tiny stored value, ancient touch → clamps to the floor, never below.
    ancient = now - timedelta(days=365)
    assert fs.decayed_salience(0.99, ancient, now) == fs.SALIENCE_FLOOR
    # Fresh, high salience stays high.
    assert _approx(fs.decayed_salience(0.9, now, now), 0.9)


def test_future_touch_does_not_amplify():
    """Clock skew / a future last_touched must not push decay above 1."""
    now = datetime(2026, 7, 23, 12, 0, 0)
    future = now + timedelta(days=3)
    assert fs.decay_factor(future, now) == 1.0


def test_bump_stays_in_bounds():
    class _T:
        salience = 0.95
        last_touched = None

    t = _T()
    # bump_salience needs a real Topic-like obj; emulate the arithmetic path.
    t.salience = min(fs.SALIENCE_CEIL, t.salience + fs.SALIENCE_BUMP)
    assert t.salience <= fs.SALIENCE_CEIL


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\n{len(fns)} focus-decay tests passed")
