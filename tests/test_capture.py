"""Net for the converged capture path — `services/capture.py`.

The chat orchestrator and `classify_note` each hand-rolled extract -> dispatch
-> summarize. `intent_router.dispatch` was already shared; the ADAPTERS around
it drifted, one layer above the drift the router itself was built to fix.

THE BUG THIS EXISTS TO PREVENT, and the reason it is worth a test file:
`classify_note` had no `extract_failed` branch. A dead extractor wrote
`{"memory_count": 0, ...}` — byte-identical to a clean "nothing to capture" —
and then snapshotted `classified_embedding`, which is the gate telling the next
sweep "this note hasn't moved, skip it". The note was retired permanently with
its captures lost, and nothing on any surface could tell.

`extract_signals` is stubbed: it is the network boundary, and every case here
is about what happens AROUND it.

Run: python tests/test_capture.py   (no network)
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
os.environ.setdefault("OPENAI_API_KEY", "test-key-never-used")

FAILURES: list[str] = []


def check(label, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def _build_db() -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd); os.unlink(path)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"], cwd=REPO,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{path}"},
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"alembic failed:\n{proc.stdout}\n{proc.stderr}")
    return path


EMPTY = {
    "feature_requests": [], "promises": [], "memories": [],
    "reply_intent": "answer",
}


def main() -> None:
    path = _build_db()
    os.environ["DATABASE_URL"] = f"sqlite:///{path}"

    from app.db.database import SessionLocal
    from app.db.models import Note
    from app.services import capture as cap
    from app.services import intent_router
    import app.services.memory_extraction as extract_pkg
    from app.services.note_service import classify as classify_mod

    db = SessionLocal()

    # ── the fence stripper, shared by five call sites ────────────────────
    print("\n-- strip_code_fence --")
    from app.common import strip_code_fence as sf
    check("bare json untouched", sf('{"a":1}'), '{"a":1}')
    check("```json fence", sf('```json\n{"a":1}\n```'), '{"a":1}')
    check("bare fence", sf('```\n{"a":1}\n```'), '{"a":1}')
    # The regex version this replaced did .rstrip("`"), which ate this.
    check("trailing backtick in payload survives", sf('{"a":"x`"}'), '{"a":"x`"}')
    check("None is empty", sf(None), "")

    # ── capture: a failed extraction is REPORTED, not silently empty ─────
    print("\n-- capture reports extractor death --")
    seen = {}

    def fake_extract(text, prev_assistant=None, today=None):
        seen["prev_assistant"] = prev_assistant
        return dict(EMPTY, **seen.get("_out", {}))

    # Patch the PACKAGE attribute: `capture()` does
    # `from .memory_extraction import extract_signals`, which reads the name
    # off the package namespace — patching the `extract` submodule would not
    # reach it, and the call would go to the network.
    extract_pkg.extract_signals = fake_extract

    seen["_out"] = {"extract_failed": True}
    ctx = intent_router.RouterContext(db=db)
    res = cap.capture("anything", ctx, db=db)
    check("failed flag set", res.failed, True)
    check("summary says so", res.summary["status"], "extract_failed")

    seen["_out"] = {}
    res = cap.capture("anything", ctx, db=db)
    check("clean run is not failed", res.failed, False)
    check("and says ok", res.summary["status"], "ok")
    # The two are DISTINGUISHABLE — that is the whole point. An empty
    # summary with status ok means "nothing to capture"; extract_failed
    # means "we do not know".
    check("both summaries are otherwise empty", res.summary["memory_count"], 0)

    # ── memories: the divergence is now a stated parameter ───────────────
    print("\n-- route_memories is explicit --")
    routed_payloads = []
    real_dispatch = intent_router.dispatch
    intent_router.dispatch = lambda payload, c: (
        routed_payloads.append(payload) or intent_router.RouterResult()
    )
    seen["_out"] = {"memories": [{"type": "fact", "content": "x"}]}
    cap.capture("t", ctx, db=db, route_memories=False)
    check("chat strips memories before dispatch", routed_payloads[-1]["memories"], [])
    cap.capture("t", ctx, db=db, route_memories=True)
    check("notes route them through", len(routed_payloads[-1]["memories"]), 1)
    intent_router.dispatch = real_dispatch

    # ── prev_assistant reaches the extractor ─────────────────────────────
    cap.capture("t", ctx, db=db, prev_assistant="earlier reply")
    check("prev_assistant threaded", seen["prev_assistant"], "earlier reply")

    # ── THE BUG: a failed classify must NOT retire the note ──────────────
    print("\n-- a failed classify leaves the note retryable --")
    n = Note(title="t", content="<p>a real sentence of content here</p>",
             embedding=json.dumps([0.1] * 8))
    db.add(n); db.commit(); nid = n.id
    db.close()

    seen["_out"] = {"extract_failed": True}
    classify_mod.classify_note(nid)

    db = SessionLocal()
    row = db.query(Note).filter(Note.id == nid).first()
    summary = json.loads(row.last_classify_signals or "{}")
    check("summary records the failure", summary.get("status"), "extract_failed")
    # THE assertion. Snapshotting this is what told the next sweep to skip
    # the note forever.
    check("dedup gate NOT snapshotted", row.classified_embedding, None)

    print("\n-- a clean classify does retire it --")
    seen["_out"] = {}
    db.close()
    classify_mod.classify_note(nid)
    db = SessionLocal()
    row = db.query(Note).filter(Note.id == nid).first()
    check("status ok", json.loads(row.last_classify_signals)["status"], "ok")
    check("dedup gate snapshotted", row.classified_embedding is not None, True)

    db.close()
    os.unlink(path)
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): {FAILURES}"); sys.exit(1)
    print("all capture checks passed")


if __name__ == "__main__":
    main()
