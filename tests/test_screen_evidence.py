"""Screenpipe screen-evidence ingest + summary — the Gooni side.

The LLM is INJECTED (a stub returning a canned completion), so this exercises
the real ingest, dedup, evidence-building and parse paths with no network. The
rules pinned are the ones easy to get wrong: idempotency, the None-not-zero
on-task rule, an empty window not being fabricated over, and the image being
additive to a text row.
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, FocusSession, SessionScreenFrame  # noqa: E402
from app.services import screen_evidence_service as se  # noqa: E402

_failures = []


def check(cond, label):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}")
    if not cond:
        _failures.append(label)


T0 = datetime(2026, 9, 9, 18, 0, 0)


def _session(db, title="CliffWalker RL"):
    s = FocusSession(title=title, state="stopped", started_at=T0, ended_at=T0 + timedelta(minutes=40))
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _frame(cid, mins, app, text, url=None, title=None):
    return {
        "client_id": cid,
        "ts": (T0 + timedelta(minutes=mins)).isoformat(),
        "app": app,
        "url": url,
        "title": title,
        "text": text,
    }


def test_ingest_and_dedup(db):
    print("\ningest + idempotency")
    s = _session(db)
    batch = [
        _frame("f1", 1, "Cursor", "def stop(db, s):", title="sidecar.py"),
        _frame("f2", 2, "Google Chrome", "Kafka retry mechanism", url="https://x.com/marclou/status/1"),
    ]
    r = se.ingest_frames(db, s.id, batch)
    check(r["accepted"] == 2 and r["duplicates"] == 0, f"first post stores both ({r})")

    # Replay the SAME batch — a buffered re-post must dedup, not double-insert.
    r2 = se.ingest_frames(db, s.id, batch)
    check(r2["accepted"] == 0 and r2["duplicates"] == 2, f"replay dedups ({r2})")

    stored = se.frames_for_session(db, s.id)
    check(len(stored) == 2, "exactly two rows exist")
    check(stored[0].ts < stored[1].ts, "frames come back in time order")


def test_rejects_bad_rows(db):
    print("\nrejects unusable rows without losing the batch")
    s = _session(db)
    r = se.ingest_frames(db, s.id, [
        _frame("g1", 1, "Cursor", "ok"),
        {"client_id": "", "ts": T0.isoformat(), "app": "x"},   # no client_id
        {"client_id": "g2", "app": "x", "text": "no ts"},       # no ts
    ])
    check(r["accepted"] == 1, "the one good row is stored")
    check(len(r["rejected"]) == 2, "the two bad rows are reported, not silently dropped")


def test_no_such_session(db):
    print("\nunknown session")
    r = se.ingest_frames(db, 999999, [_frame("z1", 1, "Cursor", "x")])
    check(r.get("error") == "no such session", "a missing session is an error, not a silent store")


def test_summary_none_on_empty(db):
    print("\nempty window is NOT fabricated over")
    s = _session(db)
    r = se.summarize(db, s.id)
    check(r["summary"] is None and r["on_task_pct"] is None,
          "no frames → no summary, never an invented paragraph")


def test_summary_parses_and_stores(db):
    print("\nsummary: prose split from on-task, stored on the session")
    s = _session(db)
    se.ingest_frames(db, s.id, [
        _frame("h1", 1, "Cursor", "def stop", title="sidecar.py"),
        _frame("h2", 2, "Cursor", "def start", title="focus_session_service.py"),
        _frame("h3", 30, "Google Chrome", "lofi beats", url="https://youtube.com/watch"),
    ])

    import app.llm.client as llm
    real = llm.llm_client.generate_simple_completion
    llm.llm_client.generate_simple_completion = lambda *a, **k: (
        "You spent most of the session in Cursor on sidecar.py and "
        "focus_session_service.py, with a few minutes on a YouTube tab near the end.\n"
        "ON_TASK: 82"
    )
    try:
        r = se.summarize(db, s.id)
    finally:
        llm.llm_client.generate_simple_completion = real

    check(r["on_task_pct"] == 82, f"on-task pulled off its line ({r['on_task_pct']})")
    check("ON_TASK" not in (r["summary"] or ""), "the marker line is stripped from the prose")
    check("sidecar.py" in r["summary"], "the prose survives")

    db.refresh(s)
    check(s.screen_summary == r["summary"] and s.on_task_pct == 82, "stored on the session")
    check(s.summary_at is not None, "summary_at stamped")


def test_on_task_unknown_is_none_not_zero(db):
    print("\non-task unknown → None, never 0")
    s = _session(db)
    se.ingest_frames(db, s.id, [_frame("u1", 1, "Finder", "")])
    import app.llm.client as llm
    real = llm.llm_client.generate_simple_completion
    llm.llm_client.generate_simple_completion = lambda *a, **k: "Too little to tell.\nON_TASK: unknown"
    try:
        r = se.summarize(db, s.id)
    finally:
        llm.llm_client.generate_simple_completion = real
    check(r["on_task_pct"] is None, "unknown is None (0 would read as 'did nothing')")


def test_failed_model_keeps_prior_summary(db):
    print("\na failed model call does not wipe a good summary")
    s = _session(db)
    se.ingest_frames(db, s.id, [_frame("k1", 1, "Cursor", "x")])
    s.screen_summary = "an earlier good summary"
    s.on_task_pct = 70
    db.commit()

    import app.llm.client as llm
    real = llm.llm_client.generate_simple_completion
    llm.llm_client.generate_simple_completion = lambda *a, **k: ""  # model failed
    try:
        r = se.summarize(db, s.id)
    finally:
        llm.llm_client.generate_simple_completion = real
    check(r["summary"] == "an earlier good summary", "prior summary survives a transient failure")


def test_image_is_additive(db):
    print("\nimage attaches to a text row by client_id, in any order")
    s = _session(db)
    se.ingest_frames(db, s.id, [_frame("i1", 1, "Cursor", "x")])
    ok = se.set_frame_image(db, "i1", "screen-frames/2026/09/09/abc.jpg")
    check(ok, "image key attaches to the existing text row")
    row = db.query(SessionScreenFrame).filter_by(client_id="i1").first()
    check(row.r2_key == "screen-frames/2026/09/09/abc.jpg", "r2_key stored")

    missing = se.set_frame_image(db, "does-not-exist", "k")
    check(missing is False, "an image with no text row is False, not an error")


def test_parser_handles_real_model_formatting(db):
    """The exact shape the live model produced, which the first parser missed.

    gpt-4o-mini numbered its two answers and wrote "2. ON_TASK: 85" — a
    start-anchored match dropped the 85 to None on the very first real run.
    Also covers bold and a trailing %.
    """
    print("\nparser tolerates real model formatting")
    for raw, want_pct, want_prose_starts in [
        ("1. You worked in Cursor.\n2. ON_TASK: 85", 85, "You worked"),
        ("You read docs.\n**ON_TASK:** 40%", 40, "You read docs."),
        ("Mostly Slack.\nON_TASK: unknown", None, "Mostly Slack."),
        ("Did stuff. ON_TASK: 55", 55, "Did stuff"),
    ]:
        prose, pct = se._parse_summary(raw)
        check(pct == want_pct, f"pct {pct} == {want_pct} for {raw!r}")
        check(prose.startswith(want_prose_starts), f"prose {prose!r} starts {want_prose_starts!r}")
        check("ON_TASK" not in prose, "marker stripped from prose")


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    print("screen evidence (Screenpipe ingest + summary)\n" + "=" * 46)
    test_ingest_and_dedup(db)
    test_rejects_bad_rows(db)
    test_no_such_session(db)
    test_summary_none_on_empty(db)
    test_summary_parses_and_stores(db)
    test_on_task_unknown_is_none_not_zero(db)
    test_failed_model_keeps_prior_summary(db)
    test_image_is_additive(db)
    test_parser_handles_real_model_formatting(db)
    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        return 1
    print("PASS — screen evidence")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
