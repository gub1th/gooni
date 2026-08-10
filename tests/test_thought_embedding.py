"""Net for thought embedding — `focus_service._embed_note_async`.

The bug this exists to prevent: `_embed_note_async` did `from . import
note_service` (the MODULE) and called `.update_embedding` on it, but that is a
method on the `NoteService` CLASS, exposed as the `note_service` INSTANCE at
the bottom of the module. Every call raised AttributeError into a bare
`except` that printed, so no logged thought was ever embedded and semantic
search never returned one.

The test deliberately exercises the REAL path — real `log_thought`, real
`_embed_note_async` thread, real `note_service.update_embedding`, real DB
write. The ONLY thing stubbed is `llm_client.generate_embedding`, the actual
network boundary (this clone has no OPENAI_API_KEY). A test that mocked
`note_service` would have passed throughout the bug's entire life, which is
the whole reason the bug survived.

Run: python tests/test_thought_embedding.py   (no network)
"""

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

# `app.llm.client` builds an OpenAI() at import time and that constructor
# refuses to exist without a key. Nothing here ever reaches the network — the
# only two paths through `generate_embedding` in this file are a stub and a
# raise — so a placeholder is enough to let the module import.
os.environ.setdefault("OPENAI_API_KEY", "test-key-never-used")

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def _build_db() -> str:
    """Throwaway SQLite at head, built by the REAL migration chain."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.unlink(db_path)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=REPO,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"},
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"alembic upgrade head failed:\n{proc.stdout}\n{proc.stderr}")
    return db_path


def _await_embedding(SessionLocal, Note, note_id: int, timeout: float = 10.0):
    """Poll for the detached embed thread's commit. `_embed_note_async` is
    fire-and-forget by design (log_thought is a hot path), so there is no
    handle to join — polling the row is how a caller would observe it."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        db = SessionLocal()
        try:
            row = db.query(Note.embedding).filter(Note.id == note_id).first()
            if row and row[0]:
                return row[0]
        finally:
            db.close()
        time.sleep(0.05)
    return None


# ── the wiring assertion, stated directly ────────────────────────────────────


def test_instance_not_module() -> None:
    """The exact confusion that caused the bug, pinned.

    `update_embedding` lives on the instance and NOT on the module, so the
    module-level import can never work. If someone reintroduces
    `from . import note_service` this stays green but the end-to-end test
    below goes red — this one is here to explain WHY.
    """
    print("\n[wiring] the module does not carry update_embedding; the instance does")
    from app.services import note_service as note_service_module
    from app.services.note_service import note_service as note_service_instance

    check(
        "module has no update_embedding",
        hasattr(note_service_module, "update_embedding"),
        False,
    )
    check(
        "instance has update_embedding",
        callable(getattr(note_service_instance, "update_embedding", None)),
        True,
    )


# ── the real path ────────────────────────────────────────────────────────────


def test_logged_thought_gets_embedded(db_path: str) -> None:
    """End-to-end: log a thought, the note ends up with an embedding.

    FAILS on the pre-fix code (AttributeError inside the thread → embedding
    stays NULL → this times out and reports None).
    """
    from app.db.database import SessionLocal
    from app.db.models import Note
    from app.llm import client as llm_module
    from app.services import focus_service as fs

    fake = [0.25] * 8
    calls: list[str] = []

    def _stub(text: str):
        calls.append(text)
        return fake, {"embedding_tokens": 3, "embedding_cost": 0.0}

    real = llm_module.llm_client.generate_embedding
    llm_module.llm_client.generate_embedding = _stub
    try:
        print("\n[real path] log_thought → detached embed → note.embedding")
        db = SessionLocal()
        try:
            res = fs.log_thought(
                db,
                content="the embed thread never reached the instance",
                topic_name="Gooni",
                now=datetime(2026, 8, 9, 10, 0, 0),
            )
            db.commit()
            note_id = res["thought"]["id"]
        finally:
            db.close()

        stored = _await_embedding(SessionLocal, Note, note_id)
        check("embedding written", stored is not None, True)
        if stored:
            check("embedding round-trips as the stubbed vector", json.loads(stored), fake)
        check("the embedder was actually called", len(calls) >= 1, True)
        if calls:
            check(
                "embedded text carries the thought body",
                "never reached the instance" in calls[0],
                True,
            )
    finally:
        llm_module.llm_client.generate_embedding = real


def test_failure_is_logged_at_error_level() -> None:
    """A broken embed must stay best-effort AND be findable in the logs.

    The bare `print` is why this bug survived; assert the replacement emits an
    ERROR record naming the note id and the exception type.
    """
    from app.services import focus_service as fs

    print("\n[handler] a failing embed logs ERROR, does not raise")
    records: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    fs.log.addHandler(handler)
    prior_level = fs.log.level
    fs.log.setLevel(logging.DEBUG)

    from app.services.note_service import note_service as instance

    real = instance.update_embedding

    def _boom(note_id):
        raise RuntimeError("openai exploded")

    instance.update_embedding = _boom
    try:
        fs._embed_note_async(4242)  # must not raise into the caller
        deadline = time.time() + 5.0
        while time.time() < deadline and not records:
            time.sleep(0.02)
    finally:
        instance.update_embedding = real
        fs.log.removeHandler(handler)
        fs.log.setLevel(prior_level)

    check("a record was emitted", len(records), 1)
    if records:
        rec = records[0]
        msg = rec.getMessage()
        check("level is ERROR", rec.levelname, "ERROR")
        check("names the note id", "4242" in msg, True)
        check("names the exception type", "RuntimeError" in msg, True)
        check("carries a traceback", rec.exc_info is not None, True)


if __name__ == "__main__":
    db_path = _build_db()
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
    try:
        test_instance_not_module()
        test_logged_thought_gets_embedded(db_path)
        test_failure_is_logged_at_error_level()
    finally:
        if os.path.exists(db_path):
            os.unlink(db_path)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + ", ".join(FAILURES))
        sys.exit(1)
    print("all thought-embedding checks passed")
