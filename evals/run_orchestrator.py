"""Golden eval runner for the chat orchestrator (end-to-end).

Usage:
    source venv/bin/activate
    python -m evals.run_orchestrator                      # full run
    python -m evals.run_orchestrator --verbose            # also print replies + judge notes
    python -m evals.run_orchestrator --case smoke_basic_question
    python -m evals.run_orchestrator --baseline           # save scores to baselines/baseline_v<PROMPT_VERSION>.json

Pipeline per case:
    1. Open ephemeral Conversation (source='eval'), seed memories / prefs /
       focuses / history from fixture, then call Orchestrator.handle_chat.
    2. Apply hard regex assertions (must_not_include). Failure short-circuits
       the judge and marks the case FAIL.
    3. LLM judge (gpt-4o-mini by default; per-case override via judge.model)
       scores the reply 1-10 per dim.
    4. Per-dim min_scores in the fixture enforce floor; below = case fails.
    5. Teardown deletes seeded rows so cases don't pollute the live DB.

Exit code: 0 = all pass, 1 = any fail.

CLOSED ENV:
    - Eval auto-points DATABASE_URL at a scratch DB (./db/gooni-eval.db by
      default; override via EVAL_DATABASE_URL). Schema is built on first
      run, then survives. Live prefs / memories / focuses NEVER leak in.
    - Each case seeds against an empty starting state, runs, tears down.
    - Why: baselines must be reproducible. If yesterday's score depended on
      yesterday's pref count, today's run isn't comparable.
    - Trade-off: realistic-data behavior isn't tested here. That's a separate
      smoke check (run with EVAL_DATABASE_URL=sqlite:///./db/gooni.db).

BASELINE INTEGRITY:
    Each baseline JSON captures everything that affects scores:
      pipeline_version (PROMPT_VERSION) — manual coarse marker; bump on
                                          generation jumps (e.g. ReAct shipped)
      pipeline_model                    — chat model under test
      judge_models[]                    — actual judges used (per-case overrides)
      case_ids[]                        — list of case IDs that ran. Compare
                                          two baselines: same case_ids = same
                                          test set, deltas trustworthy.
      pipeline_source_hash              — sha256[:12] of pipeline source files
                                          (orchestrator, prompts, memory, etc).
                                          Auto-busts cache + flags drift even
                                          if PROMPT_VERSION wasn't bumped.
      eval_db_url                       — the scratch DB used
    Two baselines comparable iff: same pipeline_source_hash + case_ids.
    Different pipeline_source_hash → pipeline code changed; absolute deltas
    are noisy; trend the composite score across runs.

OTHER:
    - Default judge is gpt-4o-mini. Override via EVAL_JUDGE_MODEL or per-case
      `judge.model`. Subtle cases (multi-hop, in-conv state, conflict
      resolution) override to gpt-5.4 since mini gets noisy.
    - Seed teardown is best-effort. Crashes leak seeded rows; re-running is
      safe — the scratch DB persists between runs but seeded rows have unique
      timestamps and don't conflict.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

load_dotenv()  # must run before importing app modules that read env vars

# Closed eval environment: force a scratch DB so live prefs / memories /
# focuses don't leak into baseline scores. Override via EVAL_DATABASE_URL.
# Set BEFORE importing app modules — `app.db.database` reads DATABASE_URL at
# import time, so any later assignment is too late.
_EVAL_DB_URL = os.environ.get("EVAL_DATABASE_URL", "sqlite:///./db/gooni-eval.db")
os.environ["DATABASE_URL"] = _EVAL_DB_URL

from app.db.database import SessionLocal, engine
from app.db.models import Conversation as ConvModel
from app.db.models import Focus as FocusModel
from app.db.models import ListItem as ListItemModel
from app.db.models import Memory as MemoryModel
from app.db.models import Message as MessageModel
from app.db.models import Todo as TodoModel
from app.llm.client import llm_client
from app.main import _alembic_upgrade
from app.services.orchestrator import Orchestrator as orchestrator  # singleton instance
from app.services.trace_builder import PROMPT_VERSION
from evals.judge import JUDGE_MODEL, grade


def _ensure_scratch_db_ready() -> None:
    """Build / upgrade the eval scratch DB via alembic. Idempotent — on
    first run the empty SQLite file gets every migration applied; on
    subsequent runs the version cursor matches head and it's a no-op.
    """
    _alembic_upgrade(engine)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "orchestrator.json"
BASELINE_DIR = Path(__file__).parent / "baselines"
REPORT_DIR = Path(__file__).parent / "reports"
CACHE_DIR = Path(__file__).parent / "cache"

# Mirror of memory_service._FEEDBACK_KEY_PREFIX. Feedback-derived prefs are
# always-injected by the system prompt builder; non-feedback prefs are
# injected via cosine search like other memories. We seed under the feedback
# prefix when the case wants the rule guaranteed-visible.
_FEEDBACK_KEY_PREFIX = "feedback__"


def _slug_rule(rule: str) -> str:
    """Inline copy of memory_service._slug_rule (private fn, don't import)."""
    slug = re.sub(r"[^a-z0-9]+", "_", rule.lower()).strip("_")[:60] or "rule"
    return f"{_FEEDBACK_KEY_PREFIX}{slug}"


def _check_regex_asserts(reply: str, case: dict) -> tuple[bool, list[str]]:
    """Hard regex asserts. Returns (all_passed, failure_reasons)."""
    fails: list[str] = []
    for pat in case.get("must_not_include_regex", []) or []:
        if re.search(pat, reply):
            fails.append(f"must_not_include hit: {pat!r}")
    return (len(fails) == 0), fails


def _check_tool_invocations(case: dict, trace: list[dict]) -> tuple[bool, list[str]]:
    """Verify case.must_invoke_tool tools were actually called during the turn.

    Reads the structured trace (TraceBuilder output) for steps with key='tool_call'
    and meta.tool=<name>. Catches the fake-completion failure where the reply
    text claims a tool fired without the side effect actually happening.

    Returns (all_passed, failure_reasons).
    """
    required = case.get("must_invoke_tool") or []
    if not required:
        return True, []
    tools_called = [
        s.get("meta", {}).get("tool")
        for s in trace
        if s.get("key") == "tool_call"
    ]
    fails = [
        f"must_invoke_tool miss: {tool!r} not called (called: {tools_called})"
        for tool in required
        if tool not in tools_called
    ]
    return (len(fails) == 0), fails


# Files that define pipeline behavior. Editing any of these can change a
# reply for the same input, so the cache key includes a content-hash of all
# of them. Auto-busts cache when you tweak prompts, retrieval logic, etc —
# no need to manually bump PROMPT_VERSION (which is still useful for
# coarse "this is a new generation" labeling on baselines).
#
# Add a file here if you find it changes pipeline output and isn't being
# captured. Cost: cache rebuild on edit. Trivial — ~$0.10 full run.
_PIPELINE_SOURCE_FILES = [
    "app/services/orchestrator/core.py",
    "app/services/orchestrator/prompt_blocks.py",
    "app/services/orchestrator/steps.py",
    "app/services/conversation_service.py",
    "app/services/memory_service.py",
    "app/services/memory_extraction.py",
    "app/services/item_service.py",
    "app/services/feedback_detector.py",
    "app/services/trace_builder.py",
    "app/llm/prompts.py",
    "app/llm/client.py",
]

_REPO_ROOT = Path(__file__).parent.parent


def _pipeline_source_hash() -> str:
    """sha256 of concatenated bytes of every pipeline source file. Cached
    per process so we don't re-read on every case."""
    if hasattr(_pipeline_source_hash, "_cached"):
        return _pipeline_source_hash._cached  # type: ignore
    h = hashlib.sha256()
    for rel in _PIPELINE_SOURCE_FILES:
        path = _REPO_ROOT / rel
        try:
            h.update(rel.encode())
            h.update(b"\0")
            h.update(path.read_bytes())
            h.update(b"\0\0")
        except FileNotFoundError:
            # File got renamed or moved — record that, busts cache.
            h.update(b"<missing>")
    digest = h.hexdigest()[:12]
    _pipeline_source_hash._cached = digest  # type: ignore
    return digest


def _case_cache_key(case: dict, pipeline_model: str, judge_default: str) -> str:
    """Stable hash for a single case. Different from fixture_hash — that hashes
    the whole fixture file, this hashes one case + every param that would
    change its result.

    Cache busts when:
      - case body changes (rubric, seeds, min_scores, judge override)
      - pipeline model swaps
      - default judge model swaps (per-case overrides live inside case body)
      - PROMPT_VERSION bumps (manual coarse marker)
      - eval DB URL changes (different schema, different starting state)
      - ANY file in _PIPELINE_SOURCE_FILES is edited (auto, no discipline needed)
    """
    payload = json.dumps({
        "case": case,
        "pipeline_model": pipeline_model,
        "judge_default": judge_default,
        "prompt_version": PROMPT_VERSION,
        "pipeline_source_hash": _pipeline_source_hash(),
        "eval_db": _EVAL_DB_URL,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _cache_load(key: str) -> dict | None:
    p = CACHE_DIR / f"{key}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _cache_save(key: str, result: dict) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(result, indent=2))


def _seed_world(db, conv_id: int, case: dict) -> Callable[[], None]:
    """Insert seed_memories, seed_prefs, seed_focuses, history for one case.

    Returns a teardown callable that removes the seeded rows. Caller MUST
    invoke teardown before closing the session, otherwise rows leak.

    Seed schema:
      seed_prefs:    [{rule: str, [confidence: float]}]  → type='preference', feedback__ key
      seed_memories: [{type: str, content: str, [key: str], [confidence: float]}]
      seed_focuses:  [{text: str, [endgoal: str], [is_primary: bool], [status: str], [scale: str]}]
                     → ListItem rows in the focuses list. Always committed=True
                       (uncommitted-but-still-actionable focuses use status='someday').
                       Mirrors prod data path for "what's my current focus?"-shape questions
                       — orchestrator pulls these via item_service.get_active_context, NOT cosine.
      seed_todos:    [{text: str, [subtitle: str], [done: bool], [state: str]}]
                     → Todo rows with embeddings generated on insert. Required for
                       G1.1 destructive-action dispatch tests — router cosine-matches
                       the extractor's `match` field against open todos at extract
                       time. state ∈ {not_yet, doing, done} (default not_yet).
      history:       [{role: 'user'|'assistant', content: str}]

    Embeddings generated on insert for memories so cosine retrieval picks them
    up mid-turn. ~10-30ms per seeded memory row.
    """
    seeded_memory_ids: list[int] = []
    seeded_message_ids: list[int] = []
    seeded_focus_ids: list[int] = []
    seeded_todo_ids: list[int] = []

    for entry in case.get("seed_prefs") or []:
        rule = (entry.get("rule") or entry.get("content") or "").strip()
        if not rule:
            continue
        emb, _ = llm_client.generate_embedding(rule)
        m = MemoryModel(
            type="preference",
            key=_slug_rule(rule),
            content=rule,
            embedding=json.dumps(emb) if emb else None,
            confidence=float(entry.get("confidence", 1.0)),
            is_active=True,
        )
        db.add(m)
        db.flush()
        seeded_memory_ids.append(m.id)

    for entry in case.get("seed_memories") or []:
        content = (entry.get("content") or "").strip()
        if not content:
            continue
        emb, _ = llm_client.generate_embedding(content)
        m = MemoryModel(
            type=entry.get("type", "fact"),
            key=entry.get("key"),
            content=content,
            embedding=json.dumps(emb) if emb else None,
            confidence=float(entry.get("confidence", 0.9)),
            is_active=True,
        )
        db.add(m)
        db.flush()
        seeded_memory_ids.append(m.id)

    for entry in case.get("seed_focuses") or []:
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        # Focus moved out of list_items into its own table (PR d4e1f2a3b5c8).
        # is_primary moved further to Todo (dashboard revamp e6c2a9b1f4d3).
        focus = FocusModel(
            text=text,
            endgoal=entry.get("endgoal"),
            committed=True,
            status=entry.get("status", "committed"),
            scale=entry.get("scale"),
        )
        db.add(focus)
        db.flush()
        seeded_focus_ids.append(focus.id)

    # Seed todos. Required for G1.1 destructive-action dispatch tests
    # (router cosine-matches the extractor's `match` field against open
    # todos at extract time; with no seeded todos, every delete/complete
    # action no-matches and the test can't verify the dispatch happened).
    # Embeddings generated on insert so the cosine match works.
    for entry in case.get("seed_todos") or []:
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        emb, _ = llm_client.generate_embedding(text)
        todo = TodoModel(
            text=text,
            subtitle=entry.get("subtitle"),
            done=bool(entry.get("done", False)),
            state=entry.get("state", "not_yet"),
            embedding=json.dumps(emb) if emb else None,
        )
        db.add(todo)
        db.flush()
        seeded_todo_ids.append(todo.id)

    for turn in case.get("history") or []:
        msg = MessageModel(
            conversation_id=conv_id,
            role=turn["role"],
            content=turn["content"],
        )
        db.add(msg)
        db.flush()
        seeded_message_ids.append(msg.id)

    db.commit()

    def teardown() -> None:
        if seeded_memory_ids:
            db.query(MemoryModel).filter(MemoryModel.id.in_(seeded_memory_ids)).delete(
                synchronize_session=False
            )
        if seeded_message_ids:
            db.query(MessageModel).filter(
                MessageModel.id.in_(seeded_message_ids)
            ).delete(synchronize_session=False)
        if seeded_focus_ids:
            db.query(FocusModel).filter(
                FocusModel.id.in_(seeded_focus_ids)
            ).delete(synchronize_session=False)
        if seeded_todo_ids:
            db.query(TodoModel).filter(
                TodoModel.id.in_(seeded_todo_ids)
            ).delete(synchronize_session=False)
        db.commit()

    return teardown


def _run_case(orch, case: dict, verbose: bool, use_cache: bool = True) -> dict[str, Any]:
    """Run one case end-to-end. Returns {id, status, scores, fails, reply, ...}."""
    cid = case["id"]
    user_msg = case["user_message"]
    entry = case.get("entry_content", "")

    cache_key = _case_cache_key(case, llm_client.chat_model, JUDGE_MODEL)
    if use_cache:
        cached = _cache_load(cache_key)
        if cached is not None:
            cached["cached"] = True
            return cached

    # Open a cost session so EVERY llm call inside this case (chat, extract,
    # reflect, plan, verify, sub-tool-loops) folds into one bucket. Judge
    # cost gets added manually below since it bypasses UsageTracker.
    from app.llm.pricing import (
        start_cost_session,
        end_cost_session,
        cost_session_add,
    )
    start_cost_session(f"case:{cid}")

    db = SessionLocal()
    teardown: Callable[[], None] | None = None
    trace: list[dict] = []
    try:
        # Fresh conversation per case → no leakage across runs.
        # source='eval' keeps these out of the human-facing /feed.
        conv = ConvModel(source="eval", title=f"eval:{cid}")
        db.add(conv)
        db.commit()
        db.refresh(conv)

        teardown = _seed_world(db, conv.id, case)

        reply, _usage = orch.handle_chat(
            message=user_msg,
            db=db,
            conversation_id=conv.id,
            source="eval",
            entry_content=entry,
        )

        # Pull the trace off the assistant message we just produced. Trace is
        # stored as JSON on Message.trace (orchestrator persists it). Used to
        # verify must_invoke_tool — the trace records actual tool_call steps,
        # so we can detect fake completions where the reply text says a tool
        # fired without the side effect.
        last_msg = (
            db.query(MessageModel)
            .filter(
                MessageModel.conversation_id == conv.id,
                MessageModel.role == "assistant",
            )
            .order_by(MessageModel.id.desc())
            .first()
        )
        if last_msg and last_msg.trace:
            try:
                trace = json.loads(last_msg.trace)
            except json.JSONDecodeError:
                trace = []
    finally:
        if teardown is not None:
            try:
                teardown()
            except Exception as e:
                print(f"  teardown error (manual cleanup may be needed): {e}")
        db.close()

    # Hard gates collect failures but DON'T short-circuit the judge anymore —
    # always running judge means scores are visible on every case, even
    # failures. Marginal extra cost (one judge call) buys debuggability.
    tool_ok, tool_fails = _check_tool_invocations(case, trace)
    regex_ok, regex_fails = _check_regex_asserts(reply, case)
    hard_fails = tool_fails + regex_fails

    # Trace summary: tools actually called + master_prompt size. Surfaced
    # in the scorecard so you can see what the orchestrator saw without
    # having to dig into the DB.
    tools_called = [
        s.get("meta", {}).get("tool")
        for s in trace
        if s.get("key") == "tool_call"
    ]
    master_prompt_step = next(
        (s for s in trace if s.get("key") == "master_prompt"), None
    )
    master_prompt_chars = (
        len(master_prompt_step.get("input") or "") if master_prompt_step else 0
    )

    # Judge. Per-case `judge.model` overrides the harness default — use it
    # for subtle cases (multi-hop reasoning, in-conv state tracking, conflict
    # resolution) where gpt-4o-mini is too noisy.
    judge_cfg = case.get("judge", {})
    rubric = judge_cfg.get("rubric", "Reply should be coherent and helpful.")
    min_scores = judge_cfg.get("min_scores", {})
    judge_model_override = judge_cfg.get("model")

    judged = grade(
        user_message=user_msg,
        reply=reply,
        rubric=rubric,
        context={
            "history": case.get("history"),
            "seed_memories": case.get("seed_memories"),
            "seed_prefs": case.get("seed_prefs"),
            "entry_content": entry,
        },
        model=judge_model_override,
    )
    scores = judged.get("scores", {})
    notes = judged.get("notes", "")
    judge_model_used = judged.get("judge_model", "")
    # Fold judge token usage into the case cost session. Judge bypasses
    # UsageTracker (direct OpenAI client call in evals/judge.py).
    _judge_usage = judged.get("usage") or {}
    if _judge_usage and judge_model_used:
        cost_session_add(
            judge_model_used,
            _judge_usage.get("input_tokens", 0),
            _judge_usage.get("output_tokens", 0),
        )
    # Close the cost session and attach summary to the result dict so the
    # baseline JSON shows actual $$ per case.
    cost_summary = end_cost_session()

    floor_fails = [
        f"{dim} = {scores.get(dim, '?')} < {threshold}"
        for dim, threshold in min_scores.items()
        if scores.get(dim, 0) < threshold
    ]
    all_fails = hard_fails + floor_fails
    if hard_fails:
        stage = "tool_invocation" if tool_fails else "regex"
    elif floor_fails:
        stage = "judge"
    else:
        stage = "ok"
    status = "FAIL" if all_fails else "PASS"
    result = {
        "id": cid,
        "status": status,
        "stage": stage,
        "fails": all_fails,
        "scores": scores,
        "reply": reply,
        "judge_notes": notes,
        "judge_model": judge_model_used,
        "tools_called": tools_called,
        "master_prompt_chars": master_prompt_chars,
        "cost": cost_summary,
        "context_summary": {
            "seed_focuses": case.get("seed_focuses") or [],
            "seed_memories": case.get("seed_memories") or [],
            "seed_prefs": case.get("seed_prefs") or [],
            "seed_todos": case.get("seed_todos") or [],
            "history": case.get("history") or [],
            "user_message": user_msg,
        },
        "cached": False,
    }
    _cache_save(cache_key, result)
    return result


def _render_html_report(
    results: list[dict[str, Any]],
    *,
    pipeline_model: str,
    judges_used: list[str],
    case_ids: list[str],
    means: dict[str, float],
    passed: int,
    failed: int,
    timestamp: str,
) -> str:
    """Self-contained HTML scorecard. No external CSS/JS — opens anywhere."""
    import html as _html

    def score_color(v: int) -> str:
        if v >= 8: return "#0a8a3a"   # green
        if v >= 6: return "#9a7a00"   # amber
        return "#b3261e"              # red

    def status_color(s: str) -> str:
        return "#0a8a3a" if s == "PASS" else "#b3261e"

    def _render_context(ctx: dict) -> str:
        """Render seeds + history as a compact key→value list."""
        parts = []
        if ctx.get("user_message"):
            parts.append(
                f'<div><b>user_message:</b> <span style="color:#222">{_html.escape(ctx["user_message"])}</span></div>'
            )
        if ctx.get("seed_focuses"):
            parts.append(
                f'<div><b>seed_focuses:</b> <pre style="margin:2px 0;font-size:11px;white-space:pre-wrap">{_html.escape(json.dumps(ctx["seed_focuses"], indent=2))}</pre></div>'
            )
        if ctx.get("seed_memories"):
            parts.append(
                f'<div><b>seed_memories:</b> <pre style="margin:2px 0;font-size:11px;white-space:pre-wrap">{_html.escape(json.dumps(ctx["seed_memories"], indent=2))}</pre></div>'
            )
        if ctx.get("seed_prefs"):
            parts.append(
                f'<div><b>seed_prefs:</b> <pre style="margin:2px 0;font-size:11px;white-space:pre-wrap">{_html.escape(json.dumps(ctx["seed_prefs"], indent=2))}</pre></div>'
            )
        if ctx.get("seed_todos"):
            parts.append(
                f'<div><b>seed_todos:</b> <pre style="margin:2px 0;font-size:11px;white-space:pre-wrap">{_html.escape(json.dumps(ctx["seed_todos"], indent=2))}</pre></div>'
            )
        if ctx.get("history"):
            hist = "\n".join(
                f"  [{turn['role']}] {turn['content']}" for turn in ctx["history"]
            )
            parts.append(
                f'<div><b>history:</b> <pre style="margin:2px 0;font-size:11px;white-space:pre-wrap">{_html.escape(hist)}</pre></div>'
            )
        return "".join(parts) or '<span style="color:#888">no seeds, no history</span>'

    rows_html = []
    for r in results:
        scores = r.get("scores", {})
        # Vertical score list — full dim names, no truncation. Color-coded
        # background per chip for quick scanning.
        if scores:
            score_block = "".join(
                f'<div style="display:flex;align-items:center;gap:8px;margin:2px 0">'
                f'<span style="display:inline-block;min-width:28px;text-align:center;'
                f'padding:2px 6px;border-radius:4px;background:{score_color(v)};color:#fff;font-weight:700">{v}</span>'
                f'<span style="font-size:12px;color:#333">{_html.escape(k)}</span>'
                f'</div>'
                for k, v in scores.items()
            )
        else:
            score_block = '<span style="color:#888">— (judge skipped)</span>'

        fails_html = "<br>".join(_html.escape(f) for f in r.get("fails", [])) or ""
        judge_notes = _html.escape(r.get("judge_notes", "") or "")
        reply_full = _html.escape(r.get("reply") or "(no reply)")
        judge_model = _html.escape(r.get("judge_model") or "—")
        tools_called = r.get("tools_called") or []
        tools_html = ", ".join(_html.escape(t or "?") for t in tools_called) or '<span style="color:#888">none</span>'
        master_prompt_chars = r.get("master_prompt_chars", 0)
        context_html = _render_context(r.get("context_summary") or {})
        stage_label = r.get("stage", "ok")

        rows_html.append(f"""
        <tr>
          <td style="vertical-align:top;width:200px">
            <div style="font-weight:600;font-size:13px">{_html.escape(r["id"])}</div>
            <div style="color:{status_color(r['status'])};font-weight:700;font-size:11px;margin-top:4px">{r['status']} <span style="color:#888;font-weight:400">· stage={_html.escape(stage_label)}</span></div>
            <div style="color:#888;font-size:10px;margin-top:4px">judge: {judge_model}</div>
            <div style="color:#888;font-size:10px;margin-top:2px">master_prompt: {master_prompt_chars} chars</div>
            <div style="color:#888;font-size:10px;margin-top:2px">tools_called: {tools_html}</div>
            {f'<div style="margin-top:8px;color:#b3261e;font-size:11px;font-weight:600">{fails_html}</div>' if fails_html else ''}
          </td>
          <td style="vertical-align:top;width:160px">{score_block}</td>
          <td style="vertical-align:top;font-size:12px;color:#333">
            <details open>
              <summary style="cursor:pointer;color:#222;font-weight:600">reply</summary>
              <pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;background:#f7f7f8;padding:8px;border-radius:6px;margin:4px 0;max-height:400px;overflow:auto">{reply_full}</pre>
            </details>
            <div style="margin-top:8px;color:#444"><b>judge:</b> <em>{judge_notes}</em></div>
            <details style="margin-top:10px">
              <summary style="cursor:pointer;color:#222;font-weight:600">context (seeds, history, user_message)</summary>
              <div style="margin-top:6px;font-size:11px;color:#444">{context_html}</div>
            </details>
          </td>
        </tr>""")

    means_html = " ".join(
        f'<span style="margin-right:10px"><b>{k}</b>: {v}</span>' for k, v in means.items()
    ) or '<span style="color:#888">no judged cases</span>'
    judges_str = ", ".join(judges_used) or "—"

    # Composite score: blends pass-rate (binary) with quality-mean (gradient)
    # so improvements in BOTH show up. Ranged 0-100 for legibility.
    pass_rate = (passed / (passed + failed)) if (passed + failed) else 0.0
    quality_mean = (sum(means.values()) / len(means) / 10) if means else 0.0
    composite = round((pass_rate * 0.5 + quality_mean * 0.5) * 100, 1)

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Gooni eval scorecard</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; max-width:1200px; margin:24px auto; padding:0 24px; color:#1a1a1a }}
  h1 {{ font-size:20px; margin:0 0 4px }}
  .meta {{ color:#666; font-size:12px; margin-bottom:16px }}
  .summary {{ background:#f7f7f8; border-radius:8px; padding:12px 16px; margin-bottom:20px; font-size:13px }}
  table {{ width:100%; border-collapse:collapse; font-size:13px }}
  th, td {{ padding:10px 12px; border-bottom:1px solid #eee; text-align:left }}
  th {{ background:#fafafa; font-size:11px; text-transform:uppercase; color:#555; letter-spacing:0.4px }}
</style></head>
<body>
  <h1>Gooni eval scorecard</h1>
  <div class="meta">{_html.escape(timestamp)} · pipeline=<b>{_html.escape(pipeline_model)}</b> · judges=<b>{_html.escape(judges_str)}</b> · cases=<b>{len(case_ids)}</b> · prompt_v=<b>{PROMPT_VERSION}</b> · scale=1-10</div>
  <div class="summary">
    <div style="font-size:22px;font-weight:700;margin-bottom:8px">
      Composite: <span style="color:{score_color(int(composite/10))}">{composite}</span>
      <span style="font-size:12px;font-weight:400;color:#666">(pass-rate × 50 + quality-mean × 50)</span>
    </div>
    <div style="font-size:14px;margin-bottom:6px"><b>{passed}</b> / {passed + failed} passed
      {'<span style="color:#b3261e">· ' + str(failed) + ' failed</span>' if failed else ''}</div>
    <div>Means: {means_html}</div>
  </div>
  <table>
    <thead><tr><th>case</th><th>scores</th><th>reply / judge notes / fails</th></tr></thead>
    <tbody>{''.join(rows_html)}</tbody>
  </table>
</body></html>"""


def run(
    verbose: bool = False,
    case_filter: str | None = None,
    save_baseline: bool = False,
    baseline_label: str | None = None,
    use_cache: bool = True,
) -> int:
    _ensure_scratch_db_ready()

    fixture = json.loads(FIXTURE_PATH.read_text())
    cases = fixture["cases"]
    case_ids = [c["id"] for c in cases]
    if case_filter:
        cases = [c for c in cases if c["id"] == case_filter]
        if not cases:
            print(f"no case matching id={case_filter!r}")
            return 1

    orch = orchestrator
    results: list[dict[str, Any]] = []

    cache_state = "cache=on" if use_cache else "cache=OFF"
    print(f"running {len(cases)} case(s) (PROMPT_VERSION={PROMPT_VERSION}, src={_pipeline_source_hash()}, {cache_state})\n")
    for case in cases:
        result = _run_case(orch, case, verbose, use_cache=use_cache)
        results.append(result)

        mark = result["status"]
        scores_str = " ".join(f"{k}={v}" for k, v in result["scores"].items())
        judge_tag = f" [judge={result['judge_model']}]" if result.get("judge_model") else ""
        cache_tag = " (cached)" if result.get("cached") else ""
        print(f"[{mark}] {result['id']}  {scores_str}{judge_tag}{cache_tag}")
        if verbose:
            print(f"  reply: {result['reply'][:300]!r}")
            if result["judge_notes"]:
                print(f"  judge: {result['judge_notes']}")
        for f in result["fails"]:
            print(f"  - {f}")
        print()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = len(results) - passed
    print("─" * 60)
    print(f"total: {len(results)}  passed: {passed}  failed: {failed}")

    # Aggregate per-dim mean across cases that got judged (skip regex-fail cases).
    judged = [r for r in results if r["scores"]]
    if judged:
        dims_seen = sorted({d for r in judged for d in r["scores"].keys()})
        means = {
            d: round(sum(r["scores"].get(d, 0) for r in judged) / len(judged), 2)
            for d in dims_seen
        }
        print(f"means (n={len(judged)}): {means}")
    else:
        means = {}

    # Composite score: blends pass-rate (binary) with quality-mean (gradient)
    # so improvements in BOTH show up. Ranged 0-100 for legibility.
    pass_rate = (passed / (passed + failed)) if (passed + failed) else 0.0
    quality_mean_norm = (sum(means.values()) / len(means) / 10) if means else 0.0
    composite_score = round((pass_rate * 0.5 + quality_mean_norm * 0.5) * 100, 1)
    print(f"composite: {composite_score}/100  (pass_rate={int(pass_rate*100)}% · quality_mean={round(quality_mean_norm*10, 2)}/10)")

    pipeline_model = llm_client.chat_model
    safe_model = pipeline_model.replace("/", "_")
    timestamp = datetime.utcnow().isoformat() + "Z"
    judges_used = sorted({r["judge_model"] for r in results if r.get("judge_model")})

    # Roll up total cost across cases. Each result has a `cost` dict from the
    # per-case cost session (chat + extract + reflect + plan + verify + judge).
    total_cost_usd = round(
        sum((r.get("cost") or {}).get("total_cost_usd", 0.0) for r in results),
        4,
    )
    cost_per_case_avg = round(
        total_cost_usd / len(results) if results else 0.0, 4
    )
    print(f"cost: ${total_cost_usd:.4f} total · ${cost_per_case_avg:.4f}/case")

    # HTML scorecard — always written for any run with ≥1 case so you have a
    # browsable artifact. Per-run filename (timestamp-stamped) so history
    # accumulates rather than overwrites — diff scorecards across runs.
    REPORT_DIR.mkdir(exist_ok=True)
    ts_short = timestamp.replace(":", "").replace("-", "").split(".")[0]
    report_path = REPORT_DIR / f"report_{ts_short}_v{PROMPT_VERSION}_{safe_model}.html"
    report_path.write_text(_render_html_report(
        results,
        pipeline_model=pipeline_model,
        judges_used=judges_used,
        case_ids=case_ids,
        means=means,
        passed=passed,
        failed=failed,
        timestamp=timestamp,
    ))
    # file:// URI is clickable in iTerm2, VSCode terminal, Warp, modern Terminal.
    print(f"\nscorecard → file://{report_path.resolve()}")

    if save_baseline:
        BASELINE_DIR.mkdir(exist_ok=True)
        # Filename includes pipeline version + model so multiple snapshots
        # coexist (e.g. baseline_v2_gpt-5.4.json vs baseline_v2_gpt-5.5.json).
        # Lets you A/B model swaps without overwriting prior numbers.
        # Optional label suffix (e.g. "prod_2026-05-18") distinguishes runs
        # against different EVAL_DATABASE_URLs (scratch vs prod snapshot).
        label_suffix = f"_{baseline_label}" if baseline_label else ""
        baseline_path = BASELINE_DIR / f"baseline_v{PROMPT_VERSION}_{safe_model}{label_suffix}.json"
        baseline_path.write_text(json.dumps({
            "pipeline_version": PROMPT_VERSION,
            "pipeline_model": pipeline_model,
            "judge_models": judges_used,
            "case_ids": case_ids,
            "pipeline_source_hash": _pipeline_source_hash(),
            "eval_db_url": _EVAL_DB_URL,
            "score_scale": "1-10",
            "timestamp": timestamp,
            "n_cases": len(results),
            "passed": passed,
            "failed": failed,
            "composite_score": composite_score,
            "means": means,
            "total_cost_usd": total_cost_usd,
            "cost_per_case_usd": cost_per_case_avg,
            "results": [
                {k: v for k, v in r.items() if k != "reply"}  # replies = noisy, skip
                for r in results
            ],
        }, indent=2))
        print(f"baseline saved → {baseline_path}")

    return 0 if failed == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="print replies + judge notes")
    ap.add_argument("--case", default=None, help="run a single case by id")
    ap.add_argument("--baseline", action="store_true",
                    help="save run as baselines/baseline_v<PROMPT_VERSION>_<model>[_<label>].json")
    ap.add_argument("--label", default=None,
                    help="filename suffix for the baseline (e.g. 'prod_2026-05-18'). "
                         "Distinguishes runs against different EVAL_DATABASE_URLs.")
    ap.add_argument("--no-cache", action="store_true",
                    help="ignore per-case cache; rerun every case fresh (still writes cache)")
    args = ap.parse_args()
    return run(
        verbose=args.verbose,
        case_filter=args.case,
        save_baseline=args.baseline,
        baseline_label=args.label,
        use_cache=not args.no_cache,
    )


if __name__ == "__main__":
    sys.exit(main())
