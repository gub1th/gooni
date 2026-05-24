import hashlib
import hmac
import json
import os
import re
import time

from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, Header, HTTPException, Request, UploadFile
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..db.database import engine, get_db, SessionLocal
from ..db.models import (
    Attachment,
    CapabilityFacet,
    Conversation,
    GooniTake,
    McpCall,
    Memory,
    Message,
    List as ListModel,
    ListItem,
    Note,
    NoteComment,
    PublicProfile,
    Reaction,
    Reflection,
    Settings,
    Space,
    Visit,
    WaProcessedId,
)
from ..db.schemas import ChatRequest
from ..llm.client import llm_client
from ..services.conversation_service import conversation_service
from ..services.item_service import item_service
from ..services.memory_service import memory_service
from ..services.messaging import (
    dispatch_inbound,
    imessage_channel,
    telegram_channel,
    whatsapp_channel,
)
from ..services.note_service import note_service
from ..services.orchestrator import Orchestrator
from ..services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
    compose_message as compose_nudge_message,
)

from ..serializers import (
    _TAG_RE, _IMG_TAG_RE, _WHITESPACE_RE, _EXTERNAL_IMG_SRC_RE, _REACTION_TARGETS, _REACTION_MAX_EMOJI_LEN, _REACTION_MAX_REACTOR_LEN, _excerpt_from_html, _strip_html_to_visible_text, _external_thumb_from_html, _note_excerpt, _parse_tags, _normalize_tags, _serialize_note, _serialize_note_lite, _notes_order, _serialize_list, _serialize_list_item, _serialize_item, _serialize_space, _serialize_settings, _serialize_promise, _serialize_comment, _validate_reaction_target, _serialize_reactions, _serialize_conversation, _serialize_message, _serialize_capability_facet, _serialize_reflection
)
from ..common import (
    _AUTH_PASSWORD, _expected_token, _parse_iso_date, _parse_optional_due, _parse_optional_dt, _validate_health, _validate_status, _validate_scale, _VALID_STATUS, _VALID_SCALE, _unique_viewers_for_note
)
from ..deps import _fire_nudge_once, _settings_row, _next_fire


router = APIRouter()


@router.get("/chat-audit")
def list_chat_audit(
    has_feedback_only: bool = False,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Audit feed: every assistant reply with any linked feedback inline.

    Each entry: assistant message + the user followup that was flagged as
    feedback (if any) + conversation context. Default returns all assistant
    replies, newest first. `has_feedback_only=true` filters to flagged ones.
    """
    from ..db.models import Memory  # local to avoid circular at import time

    asst = aliased(Message)
    fb = aliased(Message)
    conv = aliased(Conversation)
    q = (
        db.query(asst, fb, conv)
        .outerjoin(
            fb,
            (fb.feedback_for_message_id == asst.id) & (fb.is_feedback == True),  # noqa: E712
        )
        .outerjoin(conv, conv.id == asst.conversation_id)
        .filter(asst.role == "assistant")
    )
    if has_feedback_only:
        q = q.filter(fb.id.isnot(None))
    total = q.count()
    rows = q.order_by(asst.id.desc()).offset(offset).limit(limit).all()

    # Top-level: every active feedback-derived preference. Surfaced separately
    # because we don't persist message↔memory links (avoids another schema
    # migration) — the audit UI uses this list to render dismiss buttons.
    active_feedback_prefs = (
        db.query(Memory)
        .filter(
            Memory.type == "preference",
            Memory.is_active == True,  # noqa: E712
            Memory.key.like("feedback__%"),
        )
        .order_by(Memory.id.desc())
        .all()
    )

    entries = []
    for asst_m, fb_m, conv_m in rows:
        feedback = None
        if fb_m is not None:
            feedback = {
                "id": fb_m.id,
                "content": fb_m.content,
                "created_at": fb_m.created_at.isoformat() if fb_m.created_at else None,
            }
        entries.append({
            "id": asst_m.id,
            "conversation_id": asst_m.conversation_id,
            "conversation_title": conv_m.title if conv_m else None,
            "conversation_source": conv_m.source if conv_m else None,
            "content": asst_m.content,
            "created_at": asst_m.created_at.isoformat() if asst_m.created_at else None,
            "feedback": feedback,
        })
    return {
        "total": total,
        "entries": entries,
        "active_rules": [
            {
                "memory_id": p.id,
                "rule": p.content,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in active_feedback_prefs
        ],
    }


@router.get("/eval/segments")
def eval_list_segments(
    sources: str | None = None,
    statuses: str | None = None,
    has_flag: bool = False,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Grid feed for the eval tab. Sorted by last_message_at DESC.

    Query params:
      sources   = comma-separated subset of web|telegram|whatsapp|imessage
      statuses  = comma-separated subset of not_yet|pending|done
      has_flag  = true → only segments that have at least one step flag
      search    = case-insensitive substring across preview + title + summary
    """
    from ..services import eval_service

    src_list = [s.strip() for s in sources.split(",")] if sources else None
    status_list = [s.strip() for s in statuses.split(",")] if statuses else None
    return eval_service.list_segments(
        db,
        sources=src_list,
        statuses=status_list,
        has_flag_only=has_flag,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.get("/eval/segments/{segment_id}/full")
def eval_segment_full(segment_id: int, db: Session = Depends(get_db)):
    """All messages in a segment, each with its decoded trace + per-step
    feedback. Returns 404 if the segment doesn't exist."""
    from ..services import eval_service

    full = eval_service.get_segment_full(db, segment_id)
    if not full:
        raise HTTPException(status_code=404, detail="segment not found")
    return full


@router.post("/eval/feedback")
def eval_post_feedback(body: dict, db: Session = Depends(get_db)):
    """Upsert a step-level feedback. Body:
      {segment_id, message_id, step_key, step_index, rating: 1|2|3, comment?}
    Re-posting (same message_id+step_key+step_index) overwrites the prior rating."""
    from ..services import eval_service

    required = ("segment_id", "message_id", "step_key", "step_index", "rating")
    for k in required:
        if k not in body:
            raise HTTPException(status_code=400, detail=f"missing field: {k}")
    try:
        fb = eval_service.upsert_feedback(
            db,
            segment_id=int(body["segment_id"]),
            message_id=int(body["message_id"]),
            step_key=str(body["step_key"]),
            step_index=int(body["step_index"]),
            rating=int(body["rating"]),
            comment=body.get("comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"id": fb.id, "ok": True}


@router.delete("/eval/feedback/{feedback_id}")
def eval_delete_feedback(feedback_id: int, db: Session = Depends(get_db)):
    from ..services import eval_service

    if not eval_service.delete_feedback(db, feedback_id):
        raise HTTPException(status_code=404, detail="feedback not found")
    return {"ok": True}


@router.put("/eval/segments/{segment_id}/messages/{message_id}/rating")
def eval_put_message_rating(
    segment_id: int,
    message_id: int,
    body: dict,
    db: Session = Depends(get_db),
):
    """Per-message thumbs (1=bad, 2=meh, 3=good). One rating per message
    (unique constraint on message_id) so PUT semantics: re-submit overwrites.
    """
    from ..services import eval_service

    rating = body.get("rating")
    if rating is not None and rating not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="rating must be 1, 2, or 3 (or null)")
    try:
        row = eval_service.upsert_message_rating(
            db,
            segment_id=segment_id,
            message_id=message_id,
            rating=rating,
            comment=body.get("comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "id": row.id,
        "message_id": row.message_id,
        "rating": row.rating,
        "comment": row.comment,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.delete("/eval/messages/{message_id}/rating")
def eval_delete_message_rating(message_id: int, db: Session = Depends(get_db)):
    from ..services import eval_service

    if not eval_service.delete_message_rating(db, message_id=message_id):
        raise HTTPException(status_code=404, detail="rating not found")
    return {"ok": True}


@router.patch("/eval/segments/{segment_id}/summary")
def eval_patch_summary(segment_id: int, body: dict, db: Session = Depends(get_db)):
    """Update overall rating, comment, and status. Body fields are all optional;
    only the provided ones are written."""
    from ..services import eval_service

    try:
        seg = eval_service.update_summary(
            db,
            segment_id,
            eval_status=body.get("eval_status"),
            overall_rating=body.get("overall_rating"),
            overall_comment=body.get("overall_comment"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")
    return {
        "id": seg.id,
        "eval_status": seg.eval_status,
        "overall_rating": seg.overall_rating,
        "overall_comment": seg.overall_comment,
    }


@router.post("/eval/segments/{segment_id}/dispatch-to-cc")
def eval_dispatch_to_cc(segment_id: int, db: Session = Depends(get_db)):
    """Bundle the eval into a Claude Code space note + a backlog item.
    Idempotent: re-dispatching overwrites the prior note rather than spawning
    duplicates. Returns the note id and backlog list id."""
    from ..services import eval_service

    try:
        return eval_service.dispatch_to_cc(db, segment_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/eval/tools-legend")
def eval_tools_legend():
    """Static legend of tools / steps the orchestrator can take. Used by the
    eval UI's ⓘ popup so the reviewer knows what each step means."""
    from ..services import eval_service

    return {"tools": eval_service.TOOL_LEGEND}


import json as _json


from pathlib import Path as _Path


_EVAL_REPORTS_DIR = _Path(__file__).parent.parent / "evals" / "reports"


_EVAL_BASELINES_DIR = _Path(__file__).parent.parent / "evals" / "baselines"


def _safe_eval_filename(filename: str, prefix: str, suffix: str) -> bool:
    """Guard against path traversal. Filenames must start with the expected
    prefix (report_/baseline_) and end with the expected suffix."""
    return (
        "/" not in filename
        and ".." not in filename
        and filename.startswith(prefix)
        and filename.endswith(suffix)
    )


@router.get("/eval/runs")
def list_eval_runs():
    """List local eval runs (HTML reports) with metadata extracted from the
    matching baseline JSON when available. Sorted newest first by mtime.

    Reports are gitignored (ephemeral per-run HTML), but baselines ARE
    committed — so on prod the reports dir is empty but baselines still
    populate. Don't short-circuit on missing reports dir; surface
    baselines regardless.
    """
    runs: list[dict] = []
    if _EVAL_REPORTS_DIR.exists():
        for report in sorted(
            _EVAL_REPORTS_DIR.glob("report_*.html"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            runs.append({
                "filename": report.name,
                "size_bytes": report.stat().st_size,
                "mtime": report.stat().st_mtime,
            })
    # Pair with the latest baseline metadata so the UI shows scores w/o
    # opening each report. Baselines aren't 1:1 with reports (baselines
    # overwrite per pipeline_version+model; reports keep history) — best we
    # can do is summarize the most recent baseline per (version, model).
    baselines_by_key: dict[str, dict] = {}
    if _EVAL_BASELINES_DIR.exists():
        for b in _EVAL_BASELINES_DIR.glob("baseline_*.json"):
            try:
                data = _json.loads(b.read_text())
            except (_json.JSONDecodeError, OSError):
                continue
            key = f"v{data.get('pipeline_version','?')}_{data.get('pipeline_model','?')}"
            baselines_by_key[key] = {
                "filename": b.name,
                "composite_score": data.get("composite_score"),
                "passed": data.get("passed"),
                "n_cases": data.get("n_cases"),
                "means": data.get("means"),
                "pipeline_model": data.get("pipeline_model"),
                "pipeline_version": data.get("pipeline_version"),
                "pipeline_source_hash": data.get("pipeline_source_hash"),
                "timestamp": data.get("timestamp"),
                "total_cost_usd": data.get("total_cost_usd"),
                "cost_per_case_usd": data.get("cost_per_case_usd"),
            }
    return {"runs": runs, "baselines_by_key": baselines_by_key}


@router.get("/eval/runs/{filename}")
def get_eval_run(filename: str):
    """Serve the HTML scorecard inline. iframe-friendly."""
    from fastapi.responses import HTMLResponse

    if not _safe_eval_filename(filename, "report_", ".html"):
        raise HTTPException(400, "invalid report filename")
    p = _EVAL_REPORTS_DIR / filename
    if not p.exists():
        raise HTTPException(404, "report not found")
    return HTMLResponse(content=p.read_text())


_EVAL_RUN_LOCK: bool = False


@router.post("/eval/run-prod-snapshot")
def run_eval_against_live_snapshot():
    """Snapshot the live DB to /tmp, run the eval harness against it, SSE-stream
    per-line stdout. Emits structured frames the FE renders as a progress drawer:

      {"type":"status", "message":"copying snapshot"}
      {"type":"line",   "data":"[PASS] 001_smoke_basic_question ..."}
      {"type":"done",   "exit_code":0}
      {"type":"error",  "message":"..."}

    Why snapshot instead of pointing the eval at the live DB: the orchestrator
    creates synthetic Conversation/Message rows per fixture case. Running
    against live prod would pollute the real conv list. Snapshot = full prod
    state for reads, scratch for writes, deleted on exit.
    """
    from fastapi.responses import StreamingResponse
    from threading import Thread
    from queue import Queue, Empty
    import shutil, subprocess, uuid, sys

    global _EVAL_RUN_LOCK
    if _EVAL_RUN_LOCK:
        raise HTTPException(409, "an eval is already running on this machine")

    # Derive live DB path from DATABASE_URL. Works locally (./db/gooni.db) and
    # on Fly (/app/db/gooni.db) — same code, different env.
    live_url = os.environ.get("DATABASE_URL", "sqlite:///./db/gooni.db")
    if not live_url.startswith("sqlite:///"):
        raise HTTPException(400, "live DB is not sqlite — snapshot path not implemented for other engines")
    live_path = live_url.removeprefix("sqlite:///")
    if not os.path.exists(live_path):
        raise HTTPException(500, f"live DB not found at {live_path}")

    snap_id = uuid.uuid4().hex[:8]
    snap_path = f"/tmp/eval-snap-{snap_id}.db"

    queue: Queue = Queue()
    SENTINEL = object()

    def _worker():
        global _EVAL_RUN_LOCK
        proc = None
        try:
            queue.put({"type": "status", "message": f"copying snapshot → {snap_path}"})
            shutil.copy(live_path, snap_path)
            queue.put({"type": "status", "message": "starting eval subprocess"})

            env = {
                **os.environ,
                "EVAL_DATABASE_URL": f"sqlite:///{snap_path}",
                # Force unbuffered so we get line-by-line progress instead of
                # everything dumping at the end.
                "PYTHONUNBUFFERED": "1",
            }
            proc = subprocess.Popen(
                [
                    sys.executable, "-m", "evals.run_orchestrator",
                    "--no-cache", "--baseline", "--label", f"live_{snap_id}",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                queue.put({"type": "line", "data": line.rstrip()})
            proc.wait()
            queue.put({"type": "done", "exit_code": proc.returncode})
        except Exception as e:
            queue.put({"type": "error", "message": f"eval failed: {e}"})
        finally:
            if proc and proc.poll() is None:
                proc.terminate()
            if os.path.exists(snap_path):
                try:
                    os.remove(snap_path)
                except OSError:
                    pass
            queue.put(SENTINEL)
            _EVAL_RUN_LOCK = False

    _EVAL_RUN_LOCK = True
    Thread(target=_worker, daemon=True).start()

    def _event_source():
        while True:
            try:
                # 15s heartbeat matches the chat-stream pattern so Fly's edge
                # proxy doesn't idle-kill the connection during the long cases.
                evt = queue.get(timeout=15.0)
            except Empty:
                yield ": heartbeat\n\n"
                continue
            if evt is SENTINEL:
                break
            yield f"data: {json.dumps(evt, default=str)}\n\n"

    return StreamingResponse(
        _event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/eval/baselines")
def list_eval_baselines():
    """List committed baseline JSONs (ground-truth snapshots). These survive
    deploys; reports/ does not."""
    if not _EVAL_BASELINES_DIR.exists():
        return {"baselines": []}
    out = []
    for f in sorted(_EVAL_BASELINES_DIR.glob("baseline_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = _json.loads(f.read_text())
        except (_json.JSONDecodeError, OSError):
            continue
        out.append({
            "filename": f.name,
            "composite_score": data.get("composite_score"),
            "passed": data.get("passed"),
            "failed": data.get("failed"),
            "n_cases": data.get("n_cases"),
            "means": data.get("means"),
            "pipeline_model": data.get("pipeline_model"),
            "pipeline_version": data.get("pipeline_version"),
            "pipeline_source_hash": data.get("pipeline_source_hash"),
            "case_ids": data.get("case_ids"),
            "timestamp": data.get("timestamp"),
            "total_cost_usd": data.get("total_cost_usd"),
            "cost_per_case_usd": data.get("cost_per_case_usd"),
        })
    return {"baselines": out}


@router.get("/eval/baselines/{filename}")
def get_eval_baseline(filename: str):
    """Return the full baseline JSON for a given file — used by the
    eval-runs panel to drill into per-case results, scores, judge notes,
    and tools_called for a committed baseline."""
    if not _safe_eval_filename(filename, "baseline_", ".json"):
        raise HTTPException(400, "invalid baseline filename")
    p = _EVAL_BASELINES_DIR / filename
    if not p.exists():
        raise HTTPException(404, "baseline not found")
    try:
        return _json.loads(p.read_text())
    except (_json.JSONDecodeError, OSError):
        raise HTTPException(500, "baseline json invalid")
