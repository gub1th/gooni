"""5am batch processor — the engine of the ambient loop.

Real-time capture stays terse (MODE-1 ack + typed todo/promise/fitness rows).
The slow, contextful work happens here, once a day, in ONE LLM call per
session:

  - group the day's user messages into sessions (>60-min gap = new session)
  - per session, split the brain-dump into threads and classify each
    (idea | reflection | context | noise | actionable | already_handled)
  - write the ambiguous ones: idea/context → LimboItem (cosine-deduped),
    reflection → Memory. actionable/already_handled were captured in
    real-time, so we skip them here.

Why batch instead of real-time: (1) one call sees the WHOLE session, so
cross-message context + recurrence surface; (2) one call/day is far cheaper
than one/message. The raw Message rows are the durable capture — LimboItems
are derived, so a failed run loses nothing (next run re-reads the messages;
cosine-dedup collapses re-seen threads into mention_count bumps).

Session summary (PR-4), desktop review UI (PR-5), and synth-over-limbo
(PR-8) build on this.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Message, Note, Space
from ..llm.client import llm_client


_SESSION_GAP_MINUTES = 60
_DEFAULT_WINDOW_HOURS = 24

# Categories the classifier emits. Only idea/reflection/context produce
# writes here — actionable/already_handled were captured real-time, noise
# is dropped.
_WRITE_CATEGORIES = {"idea", "context", "reflection"}

_CLASSIFY_PROMPT = """You are Daniel's 5am batch processor. Below is ONE session of messages Daniel sent (timestamps included). Split it into distinct thought-threads and classify each.

A single message often carries MANY threads — split them. A thread spanning multiple messages = one thread.

Categories:
- "idea"        — a speculative project/feature seed worth revisiting ("what if", "would be cool if", "social media from notes", "housemates concept"). NOT an action yet.
- "reflection"  — a durable insight/feeling about himself ("i notice i resist systems", "i forget gooni when scattered").
- "context"     — a fact/situation worth remembering, attached to no clear action ("this is part of my system-design journey", "talked to yash").
- "actionable"  — a concrete todo/promise/log. These are captured live already — DO NOT re-extract; mark them "already_handled".
- "already_handled" — anything that was a clear real-time command/todo/promise/fitness log.
- "noise"       — filler, repetition, incomplete fragments. Dropped.

Return ONLY a JSON array, no prose, no fence. Each element:
{{"text": "<the thread, rewritten as a clean standalone line — max 20 words>", "category": "idea|reflection|context|actionable|already_handled|noise"}}

Bias: when a thread is a genuine new idea, prefer "idea". When unsure between idea and context, pick idea. Empty array only if the session is pure noise.

SESSION:
{session}

JSON:"""


def _gather_sessions(db: Session, window_hours: int) -> list[list[Message]]:
    """User messages in the window, split into gap-bounded sessions."""
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)
    msgs = (
        db.query(Message)
        .filter(Message.role == "user", Message.created_at >= cutoff)
        .order_by(Message.created_at.asc())
        .all()
    )
    sessions: list[list[Message]] = []
    cur: list[Message] = []
    prev_ts = None
    for m in msgs:
        if prev_ts is not None and m.created_at is not None:
            gap = (m.created_at - prev_ts).total_seconds() / 60.0
            if gap > _SESSION_GAP_MINUTES:
                if cur:
                    sessions.append(cur)
                cur = []
        cur.append(m)
        prev_ts = m.created_at
    if cur:
        sessions.append(cur)
    return sessions


def _classify_session(msgs: list[Message]) -> list[dict]:
    """One LLM call → list of {text, category} threads. [] on failure."""
    if not msgs:
        return []
    lines = []
    for m in msgs:
        ts = m.created_at.strftime("%H:%M") if m.created_at else "??:??"
        body = (m.content or "").strip().replace("\n", " ")
        lines.append(f"[{ts}] {body[:600]}")
    session_block = "\n".join(lines)[:6000]
    try:
        raw = llm_client.generate_simple_completion(
            _CLASSIFY_PROMPT.format(session=session_block),
            max_tokens=700,
            temperature=0.0,
            model="gpt-5.4-mini",
        )
    except Exception as e:
        print(f"[batch] classify LLM error: {e}")
        return []
    s = (raw or "").strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1].strip()
        if s.startswith("json"):
            s = s[4:].strip()
        s = s.rsplit("```", 1)[0].strip()
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError as e:
        print(f"[batch] classify parse error: {e} | raw: {s[:160]}")
        return []
    if not isinstance(parsed, list):
        return []
    out = []
    for it in parsed:
        if not isinstance(it, dict):
            continue
        text = (it.get("text") or "").strip()
        cat = (it.get("category") or "").strip().lower()
        if text and cat:
            out.append({"text": text[:300], "category": cat})
    return out


_SUMMARY_PROMPT = """You are Daniel's 5am batch processor writing a 2-3 sentence prose summary of one of his sessions. Dry, honest, a little Alfred — no hype. Reference what actually happened: the shape of the dump, recurring themes, anything notable. Max 3 sentences, no preamble.

Threads (category: text):
{threads}

Summary:"""


def _summarize_session(threads: list[dict]) -> str:
    """One small LLM call → prose summary. Deterministic fallback on failure."""
    if not threads:
        return "Quiet session — nothing worth surfacing."
    block = "\n".join(f"- {t['category']}: {t['text']}" for t in threads[:30])
    try:
        raw = llm_client.generate_simple_completion(
            _SUMMARY_PROMPT.format(threads=block[:2000]),
            max_tokens=160, temperature=0.3, model="gpt-5.4-mini",
        )
        s = (raw or "").strip()
        if s:
            return s[:600]
    except Exception as e:
        print(f"[batch] summary LLM error: {e}")
    n_idea = sum(1 for t in threads if t["category"] == "idea")
    n_ref = sum(1 for t in threads if t["category"] == "reflection")
    return f"{len(threads)} threads — {n_idea} ideas, {n_ref} reflections."


def _sessions_space_id(db: Session) -> int:
    """Find-or-create the dedicated 'Sessions' space so summaries don't
    clutter the working note list."""
    sp = db.query(Space).filter(Space.name == "Sessions").first()
    if sp is None:
        sp = Space(name="Sessions", emoji="🌙")
        db.add(sp)
        db.commit()
        db.refresh(sp)
    return sp.id


def _write_session_summary(
    db: Session, sess: list[Message], threads: list[dict], counts: dict,
) -> Note | None:
    """Persist one session-summary Note (note_type='session_summary')."""
    if not sess:
        return None
    start = sess[0].created_at
    end = sess[-1].created_at
    date_str = (start or datetime.utcnow()).strftime("%b %d")
    t_range = ""
    if start and end:
        t_range = f"{start.strftime('%-I:%M%p').lower()}–{end.strftime('%-I:%M%p').lower()} · "
    prose = _summarize_session(threads)

    idea_lines = "".join(
        f"<li>{(t['text'])[:120]}</li>" for t in threads if t["category"] == "idea"
    )
    ideas_block = f"<h3>Ideas → limbo</h3><ul>{idea_lines}</ul>" if idea_lines else ""
    content = (
        f"<p>{t_range}{len(sess)} message(s)</p>"
        f"<p>{prose}</p>"
        f"<h3>Captured</h3><ul>"
        f"<li>{counts['limbo_created']} idea/context → limbo"
        + (f" ({counts['limbo_bumped']} repeat mentions)" if counts.get('limbo_bumped') else "")
        + "</li>"
        f"<li>{counts['memories']} reflection(s) → memory</li>"
        f"<li>{counts['skipped']} handled live / noise</li>"
        f"</ul>"
        f"{ideas_block}"
    )
    note = Note(
        title=f"Session — {date_str}",
        content=content,
        space_id=_sessions_space_id(db),
        note_type="session_summary",
        session_start=start,
        session_end=end,
        message_count=len(sess),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def run(db: Session, window_hours: int = _DEFAULT_WINDOW_HOURS) -> dict:
    """Process all sessions in the window. Idempotency (day-stamp) is the
    caller's job — the loop checks it; the manual trigger forces. Returns
    stats. Per-session/per-thread failures are swallowed so one bad thread
    can't abort the run."""
    from . import limbo_service
    from .memory_service import memory_service

    sessions = _gather_sessions(db, window_hours)
    stats = {
        "sessions": len(sessions),
        "threads": 0,
        "limbo_created": 0,
        "limbo_bumped": 0,
        "memories": 0,
        "skipped": 0,
        "summaries": 0,
    }
    for sess in sessions:
        threads = _classify_session(sess)
        # Best-effort source attribution: first message of the session.
        src_id = sess[0].id if sess else None
        # Per-session counts for the summary note.
        sc = {"limbo_created": 0, "limbo_bumped": 0, "memories": 0, "skipped": 0}
        for th in threads:
            stats["threads"] += 1
            cat = th["category"]
            text = th["text"]
            if cat not in _WRITE_CATEGORIES:
                stats["skipped"] += 1
                sc["skipped"] += 1
                continue
            try:
                if cat in ("idea", "context"):
                    item = limbo_service.capture(
                        db, text=text, source_message_id=src_id, kind_hint=cat,
                    )
                    if item is None:
                        continue
                    # mention_count > 1 means capture bumped an existing item.
                    if (item.mention_count or 1) > 1:
                        stats["limbo_bumped"] += 1
                        sc["limbo_bumped"] += 1
                    else:
                        stats["limbo_created"] += 1
                        sc["limbo_created"] += 1
                elif cat == "reflection":
                    if memory_service.add_memory(content=text, type="episode", db=db):
                        stats["memories"] += 1
                        sc["memories"] += 1
            except Exception as e:
                print(f"[batch] write error ({cat}): {e}")
                continue
        # One reviewable summary note per session (skip pure-noise sessions).
        if threads:
            try:
                if _write_session_summary(db, sess, threads, sc):
                    stats["summaries"] += 1
            except Exception as e:
                print(f"[batch] session summary write error: {e}")
    print(f"[batch] run complete: {stats}", flush=True)
    return stats
