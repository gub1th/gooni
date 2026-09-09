"""Screenpipe evidence for a focus session — ingest, summarize, serve.

Screenpipe (a local daemon, not in this repo) captures the screen 24/7 into its
own SQLite. Gooni does NOT re-capture: the desktop shell reads Screenpipe's DB
for exactly a stopped session's window and POSTs the frames here. This module
is the Gooni side — store the frames, build the DETERMINISTIC evidence, run ONE
LLM call to narrate it, and serve it back to the recap.

The split that runs through the whole design:

  · The RANKING is deterministic and lives in `focus_session_activity` already
    (apps, sites, pages by seconds). This module reuses it rather than
    re-ranking, so the summary's numbers and the recap's bars cannot disagree.
  · The MODEL only narrates the pre-ranked evidence into a paragraph and one
    on-task number. It invents no facts and ranks nothing — the same
    deterministic-ranks / LLM-parses rule as the rest of the app.

Frames are session-scoped by construction (the shell only reads the session
window), and the image is optional (`r2_key` NULL = text-only, which is a
complete row — see the model docstring).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from ..db.models import FocusSession, SessionScreenFrame

#: The cheap model — this is narration over pre-ranked evidence, not reasoning.
_SUMMARY_MODEL = "gpt-4o-mini"

#: How many frames of text feed the prompt. A session is bounded, but a long one
#: at Screenpipe's active frame-rate can still be hundreds of frames; the
#: ranked-by-app evidence carries the shape, and the raw text is a SAMPLE for
#: flavour, capped so the prompt stays bounded. A cut is stated in the prompt.
_MAX_TEXT_FRAMES = 40
#: Longest text snippet per frame fed to the model — a frame's full OCR can be a
#: screenful; the first line or two is what names the page.
_MAX_FRAME_TEXT = 240


def _norm_dt(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    try:
        s = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def ingest_frames(db: Session, session_id: int, frames: list[dict]) -> dict:
    """Store a batch of screen frames for a session.

    Idempotent on `client_id` (the shell mints it from Screenpipe's frame id),
    so a re-posted window dedups. One row per SAVEPOINT so a single bad frame or
    a racing duplicate unwinds ONLY itself — the same rule `interval_ingest`
    follows, and for the same reason: the response names exactly what stored, and
    an over-reported accept is permanent loss.

    Returns {accepted, duplicates, rejected: [{client_id, reason}]}.
    """
    session = db.get(FocusSession, session_id)
    if session is None:
        return {"accepted": 0, "duplicates": 0, "rejected": [], "error": "no such session"}

    accepted = 0
    duplicates = 0
    rejected: list[dict] = []
    if not isinstance(frames, list):
        return {"accepted": 0, "duplicates": 0, "rejected": [], "error": "frames must be a list"}

    for item in frames:
        if not isinstance(item, dict):
            rejected.append({"client_id": None, "reason": "not an object"})
            continue
        client_id = (item.get("client_id") or "").strip()
        if not client_id:
            rejected.append({"client_id": None, "reason": "missing client_id"})
            continue
        ts = _norm_dt(item.get("ts"))
        if ts is None:
            rejected.append({"client_id": client_id, "reason": "missing or unparseable ts"})
            continue

        # Fast-path dedup; the SAVEPOINT is the authority under a race.
        if db.query(SessionScreenFrame.id).filter_by(client_id=client_id).first():
            duplicates += 1
            continue

        row = SessionScreenFrame(
            session_id=session_id,
            ts=ts,
            app=(item.get("app") or None),
            window_name=(item.get("window_name") or None),
            url=(item.get("url") or None),
            title=(item.get("title") or None),
            text=(item.get("text") or None),
            r2_key=(item.get("r2_key") or None),
            client_id=client_id,
        )
        try:
            with db.begin_nested():
                db.add(row)
            accepted += 1
        except Exception:
            # UNIQUE violation from a concurrent post of the same window.
            duplicates += 1

    db.commit()
    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


def set_frame_image(db: Session, client_id: str, r2_key: str) -> bool:
    """Phase 2: attach an uploaded JPEG's R2 key to an already-stored frame.

    Keyed by `client_id` (the same id the text row carries), so the image lands
    on its own frame regardless of upload order. Returns whether a row matched —
    a missing one is not an error (the text batch may not have arrived yet, or
    the frame was rejected), just a False the caller can log.
    """
    row = db.query(SessionScreenFrame).filter_by(client_id=client_id).first()
    if row is None:
        return False
    row.r2_key = r2_key
    db.commit()
    return True


def _public_url(r2_key: str | None) -> str | None:
    if not r2_key:
        return None
    try:
        from . import image_storage

        cfg = image_storage._config()
        host = cfg["R2_PUBLIC_HOST"].rstrip("/")
        for pre in ("https://", "http://", "https//", "http//"):
            if host.startswith(pre):
                host = host[len(pre):]
                break
        return f"https://{host}/{r2_key}"
    except Exception:
        return None


def frames_for_session(db: Session, session_id: int) -> list[SessionScreenFrame]:
    return (
        db.query(SessionScreenFrame)
        .filter(SessionScreenFrame.session_id == session_id)
        .order_by(SessionScreenFrame.ts.asc())
        .all()
    )


def serialize_frame(f: SessionScreenFrame) -> dict:
    return {
        "id": f.id,
        "ts": f.ts.isoformat() + "+00:00" if f.ts else None,
        "app": f.app,
        "window_name": f.window_name,
        "url": f.url,
        "title": f.title,
        "text": f.text,
        "image_url": _public_url(f.r2_key),
    }


def _build_prompt(session: FocusSession, frames: list[SessionScreenFrame]) -> str:
    """The evidence the model narrates. Deterministic ranking + a bounded text
    sample. The model is told plainly: describe what happened, estimate on-task,
    invent nothing."""
    task = (session.title or "").strip() or "an unnamed task"

    # App time, deterministic — the shape of the sitting.
    by_app: dict[str, int] = {}
    for f in frames:
        name = (f.app or "unknown").strip().lower()
        by_app[name] = by_app.get(name, 0) + 1
    ranked = sorted(by_app.items(), key=lambda kv: -kv[1])
    app_lines = "\n".join(f"  - {a}: {c} frames" for a, c in ranked[:10])

    # A text sample, capped and stated.
    sample = []
    for f in frames[:_MAX_TEXT_FRAMES]:
        t = (f.text or f.title or f.window_name or "").strip().replace("\n", " ")
        if not t:
            continue
        loc = (f.url or f.app or "").strip()
        sample.append(f"  [{f.app or '?'}] {loc[:60]} :: {t[:_MAX_FRAME_TEXT]}")
    dropped = max(0, len(frames) - _MAX_TEXT_FRAMES)
    sample_block = "\n".join(sample) if sample else "  (no text captured)"
    if dropped:
        sample_block += f"\n  (+{dropped} more frames not shown)"

    return f"""You are summarizing ONE focus session from screen-capture evidence.

The session was called: "{task}"
Frames captured: {len(frames)}

Time by app (deterministic — do not re-rank, describe):
{app_lines}

Sample of what was on screen (text read off the frames):
{sample_block}

Write TWO things, plainly, in the second person ("you"):
1. A 2-3 sentence summary of what actually happened this session — the real
   work, and any drift away from the stated task. Name specific apps/sites/pages
   from the evidence. Do NOT invent anything not in the evidence above.
2. On its OWN final line, exactly: ON_TASK: <n>  where <n> is 0-100, your
   estimate of how much of the session served the stated task. If the evidence
   is too thin to judge, write ON_TASK: unknown.

Be concrete and honest. No praise, no filler."""


def summarize(db: Session, session_id: int) -> dict:
    """Run the ONE LLM call over a session's screen evidence and store the
    result on the session. Idempotent-ish: re-running regenerates (a session's
    evidence can arrive in batches, so the last batch triggers this).

    Returns {summary, on_task_pct} — both None when there is nothing to
    summarize (no Screenpipe, no frames), which reads as "no screen data" rather
    than a fabricated paragraph over an empty window.
    """
    session = db.get(FocusSession, session_id)
    if session is None:
        return {"summary": None, "on_task_pct": None, "error": "no such session"}

    frames = frames_for_session(db, session_id)
    if not frames:
        return {"summary": None, "on_task_pct": None}

    from ..llm.client import llm_client

    prompt = _build_prompt(session, frames)
    raw = llm_client.generate_simple_completion(
        prompt, max_tokens=260, temperature=0.3, model=_SUMMARY_MODEL
    )
    if not raw:
        # The model failed. Leave any prior summary intact rather than nulling a
        # good one on a transient error, and report nothing new.
        return {"summary": session.screen_summary, "on_task_pct": session.on_task_pct}

    summary, on_task = _parse_summary(raw)
    session.screen_summary = summary
    session.on_task_pct = on_task
    session.summary_at = datetime.utcnow()
    db.commit()
    return {"summary": summary, "on_task_pct": on_task}


def _parse_summary(raw: str) -> tuple[str, int | None]:
    """Split the model's output into the prose and the on-task number.

    The `ON_TASK:` line is pulled off the end; anything else is the summary. A
    missing or non-numeric value is None (unmeasured), never 0 — the same
    None-not-zero rule the focus score follows, since 0 reads as "did nothing".
    """
    on_task: int | None = None
    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("ON_TASK:"):
            val = stripped.split(":", 1)[1].strip().rstrip("%").strip()
            try:
                on_task = max(0, min(100, int(round(float(val)))))
            except (ValueError, TypeError):
                on_task = None
            continue
        kept_lines.append(line)
    summary = "\n".join(kept_lines).strip()
    return summary, on_task
