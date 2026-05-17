"""Daily LLM-generated takes (focus + dev).

Two surfaces consume these:
  - Dashboard "Gooni's Take" pill (kind="focus") — what Daniel is focused
    on right now, derived from recently-touched notes + active focuses.
  - Dashboard "Dev activity" tab on the take card (kind="dev") — what
    Daniel shipped on Gooni THIS WEEK, derived from commits + PR titles
    across tracked repos. (Was 24h until v2 prompt; weekly window
    matches the dashboard tab title "what did I ship this week?")

Both are upserted into `gooni_takes` keyed on (day, kind) — one row per
day per kind. /dashboard/take and /dashboard/dev-take return today's row
and only regenerate when forced or when the row doesn't exist for today.

Long arc: every regen overwrites the same day's row, so the table grows
by ~2 rows/day. Future "how my focus has drifted" view can scan the
table chronologically — that's why we persist instead of caching in
memory only.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import GooniTake, Note, TrackedRepo
from ..llm.client import llm_client
from . import github as gh
from .item_service import item_service

# Per-kind prompt versions. Bump when the prompt/input shape changes so
# stored rows from the prior version are auto-regenerated on next read.
PROMPT_VERSIONS: dict[str, str] = {"focus": "v2", "dev": "v3"}


def _version_for(kind: str) -> str:
    return PROMPT_VERSIONS.get(kind, "v1")


# Back-compat: a single PROMPT_VERSION constant some old callers reference.
PROMPT_VERSION = PROMPT_VERSIONS["dev"]


def _strip_html(html: str | None) -> str:
    if not html:
        return ""
    t = re.sub(r"<[^>]+>", " ", html)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


# ── Focus take (notes + focuses → one sentence) ────────────────────────────


def _build_focus_inputs(db: Session) -> tuple[str, list[int], str, list[int]]:
    """Returns (note_block, note_ids, focus_block, focus_ids)."""
    from sqlalchemy import func as sqlfunc

    recent_notes = (
        db.query(Note)
        .order_by(sqlfunc.coalesce(Note.updated_at, Note.created_at).desc())
        .limit(8)
        .all()
    )
    top_notes = [
        n
        for n in recent_notes
        if (n.title and n.title.strip()) or (n.content and n.content.strip())
    ][:5]

    note_lines: list[str] = []
    for i, n in enumerate(top_notes):
        title = (n.title or "").strip() or "Untitled"
        body = _strip_html(n.content)[:240]
        marker = "(MOST RECENT)" if i == 0 else ""
        note_lines.append(
            f"- {title} {marker}: {body}" if body else f"- {title} {marker}"
        )
    note_block = "\n".join(note_lines) if note_lines else "(no notes yet)"

    focus_block = item_service.get_active_context(db) or "(no active focuses)"
    note_ids = [n.id for n in top_notes]
    # item_service.get_active_context returns formatted text — we don't have
    # the source ids handy here without re-querying. Skip them; future history
    # consumers can re-derive focuses from the day's snapshot.
    focus_ids: list[int] = []
    return note_block, note_ids, focus_block, focus_ids


def _focus_prompt(note_block: str, focus_block: str) -> str:
    return (
        "You are Gooni — Daniel's AI notebook companion.\n\n"
        "Surface Daniel's CURRENT FOCUSES / PRIORITIES — the question this "
        "answers is literally 'what are my current focuses?' on the dashboard.\n\n"
        "Write ONE sentence (max 25 words) naming the dominant thread he's "
        "working on right now. Recent notes carry more weight than older ones. "
        "Active-focus rows below are the long-running commitments — anchor "
        "your sentence to those when they overlap with the notes.\n\n"
        "Format options (pick what fits):\n"
        '  "Focus is on X."\n'
        '  "Split between X and Y."\n'
        '  "Mostly X, with some Y on the side."\n'
        '  "Priorities: X, then Y."\n'
        '  "Heads-down on X this week."\n\n'
        "No preamble, no sign-off, no filler. Just the sentence.\n\n"
        f"Active focuses:\n{focus_block}\n\n"
        f"Recent notes (newest first):\n{note_block}\n\n"
        "Your one-sentence take:"
    )


def generate_focus_take(db: Session) -> tuple[str, dict[str, Any]]:
    """Build a fresh focus take. Returns (take_text, sources)."""
    note_block, note_ids, focus_block, focus_ids = _build_focus_inputs(db)
    if note_block.startswith("(") and focus_block.startswith("("):
        return "", {"note_ids": [], "focus_ids": []}
    prompt = _focus_prompt(note_block, focus_block)
    try:
        take = llm_client.generate_simple_completion(prompt, max_tokens=80)
        take = take.strip().strip('"').strip("'")
    except Exception as e:
        print(f"[take_service] focus take failed: {e}")
        take = ""
    return take, {"note_ids": note_ids, "focus_ids": focus_ids}


# ── Dev take (commits + PR titles → one short paragraph) ──────────────────


# Window the dev take looks back over. Bumped from 24h → 7 days for v2
# so the dashboard "what did I ship this week?" tab actually summarises
# the week. If you change this, also update the prompt copy + the user-
# facing tab title in TakeTabs.tsx.
DEV_TAKE_LOOKBACK_DAYS = 7
DEV_TAKE_MAX_COMMITS = 60


def _build_dev_inputs(db: Session) -> tuple[str, list[str], list[str]]:
    """Returns (commit_block, commit_shas, pr_urls).

    Pulls last-7d commits across every tracked github repo. Cap at 60
    commits to keep the prompt cheap on busy weeks. PR titles come for
    free — github embeds them in the merge commit subject.
    """
    tracked = db.query(TrackedRepo).filter(TrackedRepo.provider == "github").all()
    if not tracked:
        return "", [], []

    since_iso = (
        datetime.now(timezone.utc) - timedelta(days=DEV_TAKE_LOOKBACK_DAYS)
    ).isoformat()
    lines: list[str] = []
    shas: list[str] = []
    pr_urls: list[str] = []

    for tr in tracked:
        try:
            commits = gh.list_recent_commits(db, tr.owner, tr.name, since_iso=since_iso)
        except Exception as e:
            print(f"[take_service] commit fetch failed for {tr.owner}/{tr.name}: {e}")
            continue
        for c in commits:
            sha = (c.get("sha") or "")[:7]
            msg = ((c.get("commit") or {}).get("message") or "").split("\n", 1)[0]
            committed_at = (
                ((c.get("commit") or {}).get("committer") or {}).get("date")
                or ((c.get("commit") or {}).get("author") or {}).get("date")
                or ""
            )
            html_url = c.get("html_url") or ""
            lines.append(f"- [{tr.name}] {sha} {msg}".strip())
            if sha:
                shas.append(sha)
            # GitHub merge-commit subjects look like "Merge pull request #N
              # from foo/bar". Capture the URL even though we render only
              # subjects in the prompt — useful for future history surfaces.
            if "pull request" in msg.lower() and html_url:
                pr_urls.append(html_url)
            if len(lines) >= DEV_TAKE_MAX_COMMITS:
                break
        if len(lines) >= DEV_TAKE_MAX_COMMITS:
            break

    return "\n".join(lines), shas, pr_urls


def _dev_prompt(commit_block: str) -> str:
    return (
        "You are Gooni — Daniel's AI notebook companion.\n\n"
        "Answer 'what did I ship this WEEK?' for a head-of-engineering audience "
        "reading the dashboard. Group the commits + merged PRs below into 3-5 "
        "THEMES — areas of work, not individual PRs. Themes might be things like "
        "'Chat quality', 'Memory', 'Platform', 'Dashboard', 'Capabilities', "
        "'Infra' — pick whatever shape actually fits this week's work. Each "
        "theme summary is ONE short sentence describing the substance. NO PR "
        "numbers, NO commit SHAs, NO 'shipped PR #N'.\n\n"
        "Output ONLY valid JSON — a single array of objects with shape "
        '`[{"theme": "Chat quality", "summary": "Streaming UX + feedback ack loop."}]`. '
        "No prose, no markdown fences, no preamble. Max 5 themes. If the week is "
        "mostly chores (typo fixes, dep bumps, version commits), return a single "
        'theme `{"theme": "Maintenance", "summary": "Mostly chores — typo fixes, version bumps."}`.\n\n'
        f"Commits + merged PRs (last 7 days):\n{commit_block or '(none)'}\n\n"
        "JSON:"
    )


def _parse_dev_themes(raw: str) -> str:
    """Validate the LLM's themed-JSON response. Returns a JSON-stringified
    array of `{theme, summary}` objects, or empty string on parse failure.

    Stored verbatim in `take_text`; frontend tries `JSON.parse` and falls
    back to plain-text rendering for legacy v2 (paragraph) rows.
    """
    if not raw:
        return ""
    # Strip common LLM fence wrappers just in case the model leaks them.
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError as e:
        print(f"[take_service] dev take JSON parse failed: {e}")
        return ""
    if not isinstance(parsed, list):
        return ""
    cleaned: list[dict[str, str]] = []
    for item in parsed[:5]:
        if not isinstance(item, dict):
            continue
        theme = str(item.get("theme") or "").strip()
        summary = str(item.get("summary") or "").strip()
        if theme and summary:
            cleaned.append({"theme": theme, "summary": summary})
    if not cleaned:
        return ""
    return json.dumps(cleaned)


def generate_dev_take(db: Session) -> tuple[str, dict[str, Any]]:
    commit_block, shas, pr_urls = _build_dev_inputs(db)
    if not commit_block:
        return "", {"commit_shas": [], "pr_urls": []}
    prompt = _dev_prompt(commit_block)
    try:
        raw = llm_client.generate_simple_completion(prompt, max_tokens=400, temperature=0.4)
    except Exception as e:
        print(f"[take_service] dev take failed: {e}")
        raw = ""
    take = _parse_dev_themes(raw)
    return take, {"commit_shas": shas, "pr_urls": pr_urls}


# ── Persistence + serving ──────────────────────────────────────────────────


def _serialize(t: GooniTake) -> dict[str, Any]:
    try:
        sources = json.loads(t.sources) if t.sources else {}
    except json.JSONDecodeError:
        sources = {}
    return {
        "id": t.id,
        "day": t.day.isoformat() if t.day else None,
        "kind": t.kind,
        "take": t.take_text,
        "model": t.model,
        "prompt_version": t.prompt_version,
        "sources": sources,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def get_or_generate(
    db: Session,
    kind: str,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Return today's take for `kind`. Generates + persists if missing
    (or if force=True). Idempotent on (today, kind).

    Empty take rows aren't persisted — there's nothing to reflect on, so
    we just return an empty dict and let the caller render a fallback.
    """
    today = _today_utc()
    existing = (
        db.query(GooniTake)
        .filter(GooniTake.day == today, GooniTake.kind == kind)
        .first()
    )
    target_version = _version_for(kind)
    if existing and not force and existing.prompt_version == target_version:
        return _serialize(existing)

    if kind == "focus":
        take_text, sources = generate_focus_take(db)
    elif kind == "dev":
        take_text, sources = generate_dev_take(db)
    else:
        raise ValueError(f"unknown take kind: {kind}")

    if not take_text:
        # Don't write empty rows. If a prior row exists, leave it alone so
        # yesterday's take doesn't get blown away by a transient LLM/API
        # failure today.
        if existing:
            return _serialize(existing)
        return {"day": today.isoformat(), "kind": kind, "take": "", "sources": sources}

    if existing:
        existing.take_text = take_text
        existing.model = llm_client.chat_model
        existing.prompt_version = target_version
        existing.sources = json.dumps(sources)
        db.commit()
        db.refresh(existing)
        return _serialize(existing)

    row = GooniTake(
        day=today,
        kind=kind,
        take_text=take_text,
        model=llm_client.chat_model,
        prompt_version=target_version,
        sources=json.dumps(sources),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row)


def list_history(db: Session, kind: str, limit: int = 30) -> list[dict[str, Any]]:
    rows = (
        db.query(GooniTake)
        .filter(GooniTake.kind == kind)
        .order_by(GooniTake.day.desc())
        .limit(max(1, min(limit, 365)))
        .all()
    )
    return [_serialize(r) for r in rows]
