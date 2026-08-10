"""THE converged MCP tool surface — every tool Gooni exposes, defined once.

Before this module there were three surfaces: a 25-tool stdio server for Claude
Code, and the same seven "focus" tools written out twice (once in-process for
the claude.ai mount, once over httpx for the standalone server). The two copies
of those seven are what drifted in #458.

Two things make this file the single place a tool lives:

1. **One definition, two transports.** The functions below are registered onto
   a FastMCP server by `register()`. Which transport gets which tools is a
   declared list at the bottom (`REMOTE_TOOLS` / `STDIO_TOOLS`), not a
   condition scattered through the code.
2. **One definition, two backends.** Data access goes through the gateway
   (`gateway.py`), so the same function body serves the in-process mount and
   the laptop-to-prod stdio server. Tools own argument coercion and response
   shaping; gateways own storage. Adding a tool means editing this file.

Post-convergence the surface mirrors the DATA model rather than the retired
pre-#458 primitives. A thought IS a Note with `tags=["thought"]`; a reminder IS
a Promise with `owed_to`. So each table has exactly one writer:

    notes      → log_note(kind="note" | "thought")
    promises   → set_promise(...)

and the readers collapse the same way (`search_notes`, `list_promises`).
"""

from __future__ import annotations

import functools
import html as _html
import inspect
import json
import mimetypes
import pathlib
import re
from datetime import datetime, timezone
from typing import Any, Callable

from .gateway import Gateway

# ── gateway binding ──────────────────────────────────────────────────────────
# One gateway per process (a process is either the backend or the stdio server,
# never both), so a module-level binding is honest here — and it keeps every
# tool's real signature intact for FastMCP's schema generation, which a
# gateway-as-first-parameter design would have to hide behind a wrapper.

_GATEWAY: Gateway | None = None


def bind(gateway: Gateway) -> None:
    """Install the gateway every tool in this module will use."""
    global _GATEWAY
    _GATEWAY = gateway


def _gw() -> Gateway:
    if _GATEWAY is None:
        raise RuntimeError("mcp_surface.tools.bind(gateway) was never called")
    return _GATEWAY


# ── shared coercion ──────────────────────────────────────────────────────────


def _parse_at(raw: str | None) -> datetime | None:
    """ISO-8601 → the naive-UTC storage convention, or None.

    Offset-aware input converts to UTC BEFORE tzinfo is dropped, so a local
    offset stores the right instant instead of keeping its wall-clock digits.
    Unparseable input returns None: a bad timestamp should downgrade to "now",
    never lose the thought.
    """
    if not raw or not str(raw).strip():
        return None
    try:
        dt = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        print(f"[mcp] unparseable timestamp {raw!r} — stamping now instead")
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(tzinfo=None)


#: Sentinel for `day="today"`. "Today" depends on Daniel's configured timezone,
#: which only the backend knows — the server runs UTC, so resolving it here
#: would file a late-night call under the wrong day. Both gateways resolve it:
#: DirectGateway via `local_today(db)`, HttpGateway by forwarding the literal.
TODAY = "today"


def _parse_day(raw: str | None) -> datetime | str | None:
    """"today" (→ the TODAY sentinel) or "YYYY-MM-DD" → naive midnight, or None."""
    if not raw or not str(raw).strip():
        return None
    text = str(raw).strip()
    if text.lower() == TODAY:
        return TODAY
    try:
        d = datetime.fromisoformat(text).date()
    except (TypeError, ValueError):
        return None
    return datetime(d.year, d.month, d.day)


def _snippet(text: str | None, n: int = 120) -> str:
    return (text or "")[:n].replace("\n", " ").strip()


# ── notes: TipTap attachment block ───────────────────────────────────────────
# Mirror of frontend AttachmentExtension.ts (iconLabelForMime / shortMime /
# formatBytes). Keep aligned — these strings appear in the rendered block and
# must match renderHTML exactly so TipTap's parseHTML round-trips on next save.


def _attachment_icon_label(mime: str) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"): return "IMG"
    if m == "application/pdf": return "PDF"
    if m.startswith("video/"): return "VID"
    if m.startswith("audio/"): return "AUD"
    if m.startswith("text/") or "json" in m or "xml" in m: return "TXT"
    if any(s in m for s in ("zip", "compressed", "tar", "rar")): return "ZIP"
    if "word" in m or "officedocument.wordprocessing" in m: return "DOC"
    if "sheet" in m or "excel" in m: return "XLS"
    if "presentation" in m or "powerpoint" in m: return "PPT"
    return "FILE"


def _attachment_short_mime(mime: str) -> str:
    if not mime: return "file"
    last = mime.split("/")[-1] or mime
    return re.sub(r"^vnd\.[^.]*\.", "", last).removeprefix("x-").upper()


def _attachment_format_bytes(b: int) -> str:
    if b is None or b <= 0: return "0 B"
    units = ["B", "KB", "MB", "GB"]
    v = float(b)
    u = 0
    while v >= 1024 and u < len(units) - 1:
        v /= 1024
        u += 1
    val = f"{round(v)}" if (v >= 10 or u == 0) else f"{v:.1f}"
    return f"{val} {units[u]}"


def _attachment_block_html(*, url: str, filename: str, mime: str, size: int,
                           attachment_id: int | None) -> str:
    icon = _attachment_icon_label(mime)
    sub = f"{_attachment_short_mime(mime)} · {_attachment_format_bytes(size)}"
    attrs = [
        'data-attachment=""',
        f'data-url="{_html.escape(url, quote=True)}"',
        f'data-filename="{_html.escape(filename, quote=True)}"',
        f'data-mime="{_html.escape(mime, quote=True)}"',
        f'data-size="{int(size)}"',
        'class="gooni-attachment-card"',
    ]
    if attachment_id is not None:
        attrs.insert(-1, f'data-attachment-id="{int(attachment_id)}"')
    return (
        f'<div {" ".join(attrs)}>'
        f'<a href="{_html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer" class="gooni-attachment-link">'
        f'<span class="gooni-attachment-icon">{icon}</span>'
        f'<span class="gooni-attachment-meta">'
        f'<span class="gooni-attachment-name">{_html.escape(filename)}</span>'
        f'<span class="gooni-attachment-sub">{_html.escape(sub)}</span>'
        f'</span></a></div>'
    )


def _html_to_text(html: str) -> str:
    """Render TipTap HTML as Markdown-ish plain text, task-list checkmarks
    preserved as `[ ]` / `[x]` so a checklist note reads as a living plan."""
    from bs4 import BeautifulSoup, NavigableString, Tag

    if not html or not html.strip():
        return ""

    def render(node, depth: int = 0) -> str:
        if isinstance(node, NavigableString):
            return str(node)
        if not isinstance(node, Tag):
            return ""
        name = node.name
        indent = "  " * depth
        if name == "li" and node.get("data-type") == "taskItem":
            checked = (node.get("data-checked") or "").lower() == "true"
            mark = "[x]" if checked else "[ ]"
            body_div = node.find("div")
            text = body_div.get_text(" ", strip=True) if body_div else node.get_text(" ", strip=True)
            nested = "".join(render(c, depth + 1) for c in node.find_all("ul", recursive=False))
            return f"{indent}{mark} {text}\n{nested}"
        if name == "li":
            inline = "".join(
                render(c, depth) for c in node.children
                if not (isinstance(c, Tag) and c.name in ("ul", "ol"))
            ).strip()
            nested = "".join(
                render(c, depth + 1) for c in node.children
                if isinstance(c, Tag) and c.name in ("ul", "ol")
            )
            return f"{indent}- {inline}\n{nested}"
        if name in ("ul", "ol"):
            return "".join(render(c, depth) for c in node.children if isinstance(c, Tag))
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            return f"\n{'#' * int(name[1])} {node.get_text(' ', strip=True)}\n\n"
        if name == "p":
            text = node.get_text(" ", strip=True)
            return f"{text}\n\n" if text else ""
        if name == "pre":
            return f"```\n{node.get_text()}\n```\n\n"
        if name == "code":
            return f"`{node.get_text()}`"
        if name == "img":
            return "[image]"
        if name == "br":
            return "\n"
        return "".join(render(c, depth) for c in node.children)

    return render(BeautifulSoup(html, "html.parser")).strip()


# ═════════════════════════════════════════════════════════════════════════════
# Notes
# ═════════════════════════════════════════════════════════════════════════════


def log_note(
    content: str,
    kind: str = "note",
    topic: str | None = None,
    title: str | None = None,
    tags: list[str] | None = None,
    new_batch: bool = False,
    label: str | None = None,
    at: str | None = None,
    is_draft: bool = True,
    is_pinned: bool = False,
) -> dict:
    """Write something down. THE DEFAULT ACTION whenever Daniel shares something
    worth remembering that is NOT a future obligation — a reflection, an idea, a
    decision, a realization, a note about a person or project. When in doubt
    between writing it down and committing to it, write it down here; use
    `set_promise` ONLY for a future obligation. Notes are things Daniel HAS
    thought; promises are things he still HAS TO DO. That distinction is the one
    routing call that matters on this surface.

    `kind` picks the shape, and both land in the same `notes` table:

    - `kind="thought"` (needs `topic`) — a single logged thought inside a
      thinking-run. Use for in-the-moment capture during a conversation. `topic`
      is the subject these group under ("job search", "focus cam", "climbing");
      reuse an existing name from `list_topics` when one fits — matching is
      case-insensitive and an unknown name auto-creates the topic, so never call
      `create_topic` just to log. Consecutive thoughts on a topic merge into one
      batch (~30-min window); set `new_batch=true` to force a fresh run when the
      subject clearly turns. Logging a thought bumps the topic's salience.
    - `kind="note"` (the default) — a standalone document with a `title`. Use for
      something written to be re-read: a summary, a writeup, a seeded draft.

    `label` (thoughts only) is a SHORT THIRD-PERSON SENTENCE summarizing the
    batch as it reads on Daniel's timeline — refer to Daniel as "Gooni". E.g.
    "Gooni decided the store should stay dumb.", "Gooni is losing 6-7 to Curtis
    in smash." It's the card the timeline renders, so write a real sentence (not
    a topic label), and re-send an updated one whenever the batch meaningfully
    advances — it OVERWRITES the batch's rendered card.

    `at` BACKDATES to when it actually happened — ISO-8601, and pass UTC with an
    explicit "+00:00" offset (e.g. "2026-08-07T09:00:00+00:00"). Omit it and the
    write is stamped now, which is right for anything happening in the moment.
    Use it when recording something from earlier in the day: a 1am study session
    logged at noon should read 1am.

    `is_draft` (notes only) defaults TRUE, which is what every note written
    through this surface has always actually been — the create endpoint defaults
    it on, so the old tool's `is_draft=False` never took effect. Pass False for a
    note that should NOT sit in the Drafts sidebar.

    Returns, for a thought, {thought:{id,content,timestamp}, batch:{...},
    topic:{...decayed salience...}} — use `thought.id` as `from_thought` if the
    same message also creates a promise. For a note, {id,title,tags,kind,...}.
    """
    gw = _gw()
    kind = (kind or "note").strip().lower()
    if kind not in ("note", "thought"):
        raise ValueError(f"kind must be 'note' or 'thought', got {kind!r}")
    if not (content or "").strip():
        raise ValueError("content required")

    if kind == "thought":
        if not (topic or "").strip():
            raise ValueError("kind='thought' requires a topic")
        result = gw.log_thought(
            content=content, topic=topic, new_batch=bool(new_batch),
            label=label, at=_parse_at(at),
        )
        return {"kind": "thought", **result}

    # Every note written by Claude is tagged so Daniel can filter the corpus —
    # carried over from the old add_note.
    merged = ["from-claude", "claude-code", *(tags or [])]
    note = gw.create_note(
        title=title or "", content=content, tags=merged,
        is_draft=bool(is_draft), is_pinned=bool(is_pinned),
    )
    # Deep link back into the SPA, so a created note is one click away — carried
    # over from add_note's return string. Host from GOONI_FRONTEND_URL.
    return {"kind": "note", **note, "url": f"{_frontend_url()}/?note={note['id']}"}


def _frontend_url() -> str:
    import os

    return os.getenv("GOONI_FRONTEND_URL", "http://localhost:5173").rstrip("/")


def search_notes(
    q: str = "",
    kind: str = "",
    tag: str = "",
    topic: str = "",
    since: str = "",
    limit: int = 10,
    match: str = "semantic",
) -> list[dict]:
    """Read back what Daniel has written — THE note reader. Call this to recall
    "what did I think about X", "what have I logged this week", "did I ever
    mention Y", or just to see what he's been working on lately.

    Every filter is optional and they combine:
      - `q`: what to look for. Omit it entirely to list the most recent notes.
      - `kind`: "thought" restricts to logged thoughts, "note" to standalone
        documents, empty = both.
      - `match`: "semantic" (default — embedding similarity, best for "notes
        about burnout") or "substring" (exact literal match, best for recalling
        a specific phrase you know was written, e.g. a number or a name).
        `kind="thought"` always matches by substring: it is the recall check
        against Claude's own writes, where exact beats fuzzy.
      - `tag`: only notes carrying this tag.
      - `topic` / `since` (thoughts): one subject; only thoughts on or after an
        ISO date "YYYY-MM-DD".
      - `limit`: max rows (default 10).

    Use `list_topics` instead when you only want the ranked landscape of
    subjects rather than their contents. Returns rows of
    {id, kind, title, snippet, ...} — thought rows also carry topic + batch.
    """
    gw = _gw()
    kind = (kind or "").strip().lower()
    query = (q or "").strip()
    limit = max(1, min(int(limit or 10), 100))

    if kind == "thought":
        rows = gw.query_thoughts(
            topic=(topic or None), since=_thought_since(since),
            text=(query or None), limit=limit,
        )
        return [
            {
                "id": r["id"], "kind": "thought", "title": r.get("batch_label"),
                "snippet": _snippet(r.get("content")), "topic": r.get("topic"),
                "batch_id": r.get("batch_id"), "timestamp": r.get("timestamp"),
            }
            for r in rows
        ]

    if query and (match or "semantic").strip().lower() == "semantic":
        rows = gw.search_notes_semantic(q=query, limit=limit)
    elif query:
        # Substring over the recent window — the old find_note behaviour, for
        # picking a specific note out of a small set by a remembered phrase.
        needle = query.lower()
        scanned = gw.recent_notes(limit=max(limit * 20, 100))
        rows = [
            n for n in scanned
            if needle in (n.get("title") or "").lower()
            or needle in (n.get("content") or n.get("excerpt") or "").lower()
        ][:limit]
    elif tag.strip():
        rows = gw.list_notes(tag=tag.strip().lower(), limit=limit)
    else:
        rows = gw.recent_notes(limit=limit)

    return [
        {
            "id": n["id"], "kind": "note", "title": n.get("title") or "(untitled)",
            "snippet": _snippet(n.get("excerpt") or n.get("content")),
            "tags": n.get("tags") or [],
        }
        for n in rows
    ]


def _thought_since(since: str) -> datetime | None:
    if not (since or "").strip():
        return None
    try:
        d = datetime.fromisoformat(since.strip()).date()
    except (TypeError, ValueError):
        return None
    return datetime(d.year, d.month, d.day)


def read_note(note_id: int) -> str:
    """Read one note's FULL body, with task-list checkmarks preserved as `[ ]`
    (unchecked) / `[x]` (done). `search_notes` returns snippets — reach here
    when you need the whole thing, e.g. a checklist note serving as a plan.

    Args:
        note_id: numeric id (from search_notes)
    """
    note = _gw().get_note(int(note_id))
    if note is None:
        return f"(note #{note_id} not found)"
    title = note.get("title") or "(untitled)"
    body = _html_to_text(note.get("content") or "")
    return f"# {title}\n\n{body}" if body else f"# {title}\n\n(empty)"


def edit_note(
    note_id: int,
    title: str | None = None,
    content: str | None = None,
    is_draft: bool | None = None,
    is_pinned: bool | None = None,
    tags: list[str] | None = None,
) -> str:
    """Edit an existing note — update a progress note or evolving doc, or flip
    the draft/pinned flags. This is also how you edit a note's checklist: read
    it with `read_note`, then write the updated body back through `content`.

    Args:
        note_id: numeric id of the note to edit
        title: new title (omit to keep current)
        content: new body, plain text or HTML (omit to keep current)
        is_draft: set/clear the Drafts-sidebar flag (omit to leave unchanged)
        is_pinned: set/clear the pinned flag (omit to leave unchanged)
        tags: REPLACE the tag set. Omit to keep current; to add without
            blowing away existing tags, read the note first and pass the merge.
    """
    patch: dict = {}
    if title is not None:
        patch["title"] = title
    if content is not None:
        patch["content"] = content
    if is_draft is not None:
        patch["is_draft"] = bool(is_draft)
    if is_pinned is not None:
        patch["is_pinned"] = bool(is_pinned)
    if tags is not None:
        patch["tags"] = list(tags)
    if not patch:
        return "Nothing to update."
    note = _gw().update_note(int(note_id), patch)
    if note is None:
        return f"(note #{note_id} not found)"
    flags = []
    if is_draft is not None:
        flags.append(f"draft={bool(is_draft)}")
    if is_pinned is not None:
        flags.append(f"pinned={bool(is_pinned)}")
    if tags is not None:
        flags.append(f"tags={note.get('tags') or []}")
    suffix = f" [{', '.join(flags)}]" if flags else ""
    return f"Updated note #{note['id']}: {note.get('title')}{suffix}"


def delete_note(note_id: int) -> str:
    """Delete a note by id. Irreversible — call `search_notes` first to confirm
    you have the right one. Returns the deleted title as an audit trail.

    Args:
        note_id: numeric id of the note to delete
    """
    if not isinstance(note_id, int) or note_id <= 0:
        return "(note_id must be a positive integer)"
    snap = _gw().delete_note(int(note_id))
    if snap is None:
        return f"(note #{note_id} not found)"
    return f"deleted note #{snap['id']}: {snap.get('title') or '(untitled)'}"


def attach_file_to_note(
    note_id: int,
    file_path: str,
    filename: str | None = None,
    mime_type: str | None = None,
) -> str:
    """Upload a local file to Gooni's storage and attach it to a note as an
    inline block (PDF, doc, image…). Use when you've generated a file Daniel
    should see embedded in the note — a PDF summary, an exported dataset. The
    block renders as a clickable card at the end of the note body, same shape as
    a drag-dropped attachment.

    Args:
        note_id: target note id (must exist)
        file_path: absolute path to a local file you've already written
        filename: optional display name (defaults to the file's basename)
        mime_type: optional MIME (defaults to a guess from the extension)
    """
    p = pathlib.Path(file_path).expanduser()
    if not p.is_file():
        return f"ERROR: file not found at {file_path}"
    data = p.read_bytes()
    if not data:
        return f"ERROR: file is empty: {file_path}"
    name = filename or p.name
    mime = mime_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    try:
        up = _gw().attach_file(
            note_id=int(note_id), filename=name, data=data, mime=mime,
            block_html_fn=_attachment_block_html,
        )
    except LookupError as exc:
        return f"ERROR: {exc}"
    except RuntimeError as exc:
        return f"ERROR: {exc}"
    aid = up.get("attachment_id")
    aid_str = f" attachment_id={aid}" if aid is not None else " (no DB row — orphan upload)"
    return (
        f"Attached {name} ({_attachment_short_mime(mime)}, "
        f"{_attachment_format_bytes(len(data))}) to note #{note_id}.{aid_str} "
        f"URL: {up['url']}"
    )


# ═════════════════════════════════════════════════════════════════════════════
# Promises
# ═════════════════════════════════════════════════════════════════════════════


def set_promise(
    content: str,
    due: str | None = None,
    owed_to: str | None = None,
    cadence: str = "once",
    cadence_target: int | None = None,
    from_thought: int | None = None,
    is_important: bool = False,
) -> dict:
    """Record a FUTURE OBLIGATION — a to-do, a thing to follow up on, a promise,
    a habit, or a standing rule. Reach here (NOT `log_note`) whenever the message
    is forward-looking: "remind me to…", "I need to…", "don't let me forget…",
    "I owe X…", "I'll get back to Y about…", "gym 6x a week", "no weed".
    Promises are things Daniel still HAS TO DO; notes are things he HAS thought.

    Every row carries the said-vs-done lifecycle (active → kept | broken) — not
    something you opt into. Close one with `set_promise_state` the moment its
    fate is known.

    `cadence` expresses the shape of the commitment:
      - `once` (default) — a one-shot chore. Gets a deadline: an omitted `due`
        defaults to today's local end-of-day so the row can be placed on the
        dashboard, and a defaulted deadline never auto-breaks (Gooni picked it,
        so it can't accuse Daniel of missing it). A due YOU pass is real and
        will auto-break when it passes.
      - `daily` / `n_per_week` (pass `cadence_target`, e.g. 6 for six times a
        week) — a recurring habit. Carries no single deadline by design.
      - `permanent_do` / `permanent_never` — a standing rule ("no weed").

    `owed_to` is the ONE input that changes the returned `type`: pass a person's
    name when the obligation is owed to someone ("I owe Yash the deck") → typed
    'promise', surfaced by age; leave it off for a commitment to yourself → typed
    'reminder', same lifecycle either way.

    `from_thought` is the `thought.id` returned by a `log_note(kind="thought")`
    call in the same message, linking the commitment to the thought that spawned
    it. `is_important` stars it in the overlay's action-horizon.

    Re-stating an existing commitment returns the EXISTING row (cosine dedup)
    rather than minting a duplicate. Returns {id, type, content, owed_to, due_at,
    state, cadence, cadence_target, is_important, age_days, thought_id, ...}.
    """
    gw = _gw()
    if not (content or "").strip():
        raise ValueError("content required")
    cadence = (cadence or "once").strip().lower()
    valid = ("once", "daily", "n_per_week", "permanent_do", "permanent_never")
    if cadence not in valid:
        raise ValueError(f"cadence must be one of {valid}, got {cadence!r}")
    return gw.create_promise(
        content=content, due=_parse_at(due), owed_to=(owed_to or None),
        from_thought=(int(from_thought) if from_thought else None),
        cadence=cadence, cadence_target=cadence_target,
        is_important=bool(is_important),
    )


def list_promises(
    day: str | None = None,
    state: str = "active",
    limit: int = 30,
) -> list[dict]:
    """List commitments — THE promise reader. Call this for "what's on my plate",
    "what am I forgetting", "what do I owe people", or to find the id of a
    promise you're about to close with `set_promise_state`.

    Args:
        day: optionally scope DATED rows to one day — the literal "today" or an
            ISO date "YYYY-MM-DD". Undated rows always pass through (they
            surface by age, not time). Omit for everything.
        state: "active" (default — still open), "kept", "broken", or "all". Use
            "kept"/"broken" to review what actually happened, "all" for both.
        limit: max rows (default 30)

    Ordering: dated items by due time first, then undated oldest-first. Returns
    rows of {id, type, content, owed_to, due_at, state, done, age_days,
    lasted_days, thought_id}; `type='promise'` rows carry an `owed_to` name.
    """
    state = (state or "active").strip().lower()
    valid = ("active", "kept", "broken", "all")
    if state not in valid:
        raise ValueError(f"state must be one of {valid}, got {state!r}")
    return _gw().list_promises(
        day=_parse_day(day), state=state, limit=max(1, min(int(limit or 30), 200))
    )


def set_promise_state(promise_id: int, state: str) -> dict:
    """Resolve a commitment — the SAID-VS-DONE close. `state` is 'kept'
    (fulfilled — the thing got done), 'broken' (it didn't — he smoked, the
    deadline slipped), or 'active' (reopen).

    Reach here the MOMENT a commitment's fate is known: if Daniel says he smoked
    after promising not to, break the matching promise NOW rather than leaving it
    standing. Find the id via `list_promises`. Kept/broken stamp the resolution
    time, which the dashboard renders as how long the promise lasted. There is no
    delete — resolve, don't remove.

    Args:
        promise_id: id from list_promises
        state: kept | broken | active
    """
    state = (state or "").strip().lower()
    if state not in ("active", "kept", "broken"):
        raise ValueError(f"state must be active|kept|broken, got {state!r}")
    result = _gw().set_promise_state(promise_id=int(promise_id), state=state)
    if result is None:
        raise ValueError(f"no promise with id {promise_id}")
    return result


# ═════════════════════════════════════════════════════════════════════════════
# Topics
# ═════════════════════════════════════════════════════════════════════════════


def list_topics() -> list[dict]:
    """The current salience landscape: every topic ranked hottest-first by
    decayed salience. Call this to see WHAT IS TOP OF MIND RIGHT NOW, to pick the
    correct existing `topic` name before `log_note(kind="thought")`, or to answer
    "what have I been focused on lately". Salience decays with
    time-since-last-touched and bumps on every logged thought, so this is a live
    recency × frequency ranking, not a catalogue.

    Use this for the landscape; use `search_notes(kind="thought")` to read the
    thoughts inside a topic. Returns {id, name, parent_id, color,
    salience_stored, salience_decayed, last_touched, growth} — `salience_decayed`
    drives the ranking and `growth=true` flags a topic heating up.
    """
    return _gw().list_topics()


def create_topic(name: str, parent: str | None = None) -> dict:
    """Explicitly create a topic (optionally nested under a `parent` topic name).
    ONLY call this when Daniel is deliberately ORGANIZING his subjects — "make a
    topic called X", "put Y under Z". For ordinary capture do NOT use this:
    `log_note` auto-creates any unknown topic on the fly, so reaching here first
    is almost always wrong.

    Returns {id, name, parent_id, color, salience}.
    """
    if not (name or "").strip():
        raise ValueError("name required")
    return _gw().create_topic(name=name, parent=parent)


# ═════════════════════════════════════════════════════════════════════════════
# Trackables
# ═════════════════════════════════════════════════════════════════════════════


def add_trackable(
    name: str,
    kind: str = "numeric",
    unit: str | None = None,
    cadence: str | None = None,
    target: float | None = None,
    is_important: bool = False,
    agg: str | None = None,
    schema_hint: str | None = None,
) -> str:
    """Create a Trackable — a measurement definition. Adding a new tracked thing
    is one call, no schema migration. Name-idempotent: an existing name returns
    that definition untouched.

    Args:
        name: what's tracked ("sleep score", "weight")
        kind: boolean (did/didn't) | numeric | json (arbitrary payload)
        unit: display unit ("kcal", "kg", "hrs")
        cadence: expected rhythm (once|daily|n_per_week|...) — informational
        target: numeric goal (limit or floor; the consumer decides direction)
        is_important: surfaces in the overlay's trackables zone
        agg: per-day fold — "sum" (additive, like calories) or "last" (newest
            wins, like weight). Default last.
        schema_hint: JSON string describing the value_json payload shape
    """
    name = (name or "").strip()
    if not name:
        return "(name required)"
    payload: dict = {"name": name, "kind": kind, "is_important": bool(is_important)}
    for key, value in (("unit", unit), ("cadence", cadence), ("target", target),
                       ("agg", agg), ("schema_hint", schema_hint)):
        if value is not None:
            payload[key] = value
    t = _gw().create_trackable(payload)
    return f"trackable #{t['id']} ready: {t['name']} ({t['kind']}, agg={t['agg']})"


def log_trackable_entry(
    name: str,
    value: str,
    date: str | None = None,
    replace: bool = False,
) -> str:
    """Log one entry on a Trackable, resolved by name.

    `value` parsing follows the trackable's kind:
      boolean → "true"/"false"/"1"/"0"
      numeric → a number ("2100", "70.8")
      json    → a JSON object string ('{"score": 87, "strain": 12.1}')

    Args:
        name: trackable name (see read_trackable / add_trackable)
        value: the value, encoded as above
        date: YYYY-MM-DD (defaults to today in Daniel's timezone)
        replace: collapse the day to this single entry (cell-edit semantics)
            instead of appending
    """
    gw = _gw()
    wanted = (name or "").strip().lower()
    match = next((t for t in gw.list_trackables() if t["name"] == wanted), None)
    if match is None:
        return f"(no trackable named {name!r} — create it with add_trackable)"
    body: dict = {"source": "manual", "replace": bool(replace)}
    if date:
        body["date"] = date
    text = (value or "").strip()
    if match["kind"] == "boolean":
        body["value_boolean"] = text.lower() in ("true", "1", "yes")
    elif match["kind"] == "numeric":
        try:
            body["value_numeric"] = float(text)
        except ValueError:
            return f"(numeric trackable — {text!r} is not a number)"
    else:
        try:
            body["value_json"] = json.loads(text)
        except ValueError:
            body["value_json"] = {"text": text}
    out = gw.log_trackable_entry(trackable_id=match["id"], body=body)
    if out.get("cleared"):
        return f"cleared {match['name']} for {date or 'today'}"
    entry = out["entry"]
    val = entry.get("value_numeric")
    if val is None:
        val = entry.get("value_boolean")
    if val is None:
        val = entry.get("value_json")
    return f"logged {match['name']} = {val} on {entry['date']}"


def read_trackable(name: str = "", days: int = 14) -> str:
    """Read Trackables. An empty `name` lists every definition; a name returns
    that trackable's per-day values for the last `days` days. This is the generic
    reader for ALL logged measurements, including the whoop and leetcode feeds
    (their full daily payload is the json value).

    Args:
        name: trackable name (empty = list all)
        days: pivot window when a name is given (default 14)
    """
    gw = _gw()
    rows = gw.list_trackables()
    wanted = (name or "").strip().lower()
    if not wanted:
        if not rows:
            return "(no trackables)"
        lines = []
        for t in rows:
            bits = [t["kind"], f"agg={t['agg']}"]
            if t.get("unit"):
                bits.append(t["unit"])
            if t.get("target") is not None:
                bits.append(f"target {t['target']:g}")
            if t.get("is_important"):
                bits.append("★")
            lines.append(f"#{t['id']} {t['name']} ({', '.join(bits)})")
        return "\n".join(lines)
    match = next((t for t in rows if t["name"] == wanted), None)
    if match is None:
        return f"(no trackable named {name!r})"
    pivot = gw.trackable_pivot(trackable_id=match["id"], days=max(1, int(days)))
    if not pivot:
        return f"{match['name']}: no entries in last {days}d"
    lines = [f"{match['name']} ({match['kind']}, last {days}d):"]
    for row in pivot:
        lines.append(f"  {row['date']}: {row['value']}")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# Memory
# ═════════════════════════════════════════════════════════════════════════════


def get_context(query: str = "") -> str:
    """Get relevant memory context from Gooni — user facts, preferences, and past
    episodes. Call this at the start of a conversation to understand what Gooni
    knows about Daniel. Pass a query for semantically relevant memories, or leave
    it empty for preferences only.

    Args:
        query: optional topic to pull relevant memories for
    """
    return _gw().memory_context(q=query or "") or "(no memories yet)"


def add_memory(content: str) -> str:
    """Store a durable fact about Daniel in Gooni's memory. For things that stay
    true — not a dated obligation (`set_promise`) or a passing thought
    (`log_note`).

    Args:
        content: the full memory sentence (e.g. "Prefers terse, caveman-style
            replies with technical detail intact")
    """
    if not (content or "").strip():
        return "(content required)"
    _gw().add_memory(content=content)
    return f"Saved: {content}"


def search_memories(query: str, limit: int = 8) -> str:
    """Search Gooni's memory by semantic similarity.

    Args:
        query: natural-language description of what to look for
        limit: max results (default 8)
    """
    hits = _gw().search_memories(q=query, limit=max(1, min(int(limit or 8), 50)))
    if not hits:
        return "(no matching memories)"
    return "\n".join(f"- {h['memory']}" for h in hits)


def edit_memory(memory_id: str, content: str) -> str:
    """Update an existing memory's content.

    Args:
        memory_id: the memory id to update
        content: the new content replacing the old value
    """
    if not _gw().edit_memory(memory_id=memory_id, content=content):
        return f"(no memory {memory_id})"
    return f"Updated memory {memory_id}"


def forget_memory(memory_id: str) -> str:
    """Remove a memory from Gooni.

    Args:
        memory_id: the memory id to delete
    """
    if not _gw().forget_memory(memory_id=memory_id):
        return f"(no memory {memory_id})"
    return f"Forgotten: {memory_id}"


def list_preferences(limit: int = 50) -> str:
    """List Daniel's active preferences — the always-injected memory rows.

    Separates manually-curated entries from auto-generated feedback rules (key
    prefixed `feedback__`). Feedback rules are written on every chat correction
    and would bloat the system prompt, so only the 8 most recent inject; this is
    the inspect side of that cap.

    Args:
        limit: max rows (default 50)
    """
    payload = _gw().list_preferences(limit=max(1, min(int(limit or 50), 200)))
    rows = payload.get("memories") or []
    if not rows:
        return "(no preferences)"
    lines = [f"# {payload.get('total', len(rows))} active preference(s)"]
    curated, feedback = [], []
    for m in rows:
        bucket = feedback if (m.get("key") or "").startswith("feedback__") else curated
        bucket.append(m)
    if curated:
        lines.append("\n## Curated (always inject):")
        for m in curated:
            lines.append(f"- #{m['id']} {m.get('content', '').strip()[:140]}")
    if feedback:
        lines.append(f"\n## Feedback-derived ({len(feedback)} total; top 8 most recent inject):")
        for i, m in enumerate(feedback):
            mark = " ★" if i < 8 else "  "
            lines.append(f"-{mark}#{m['id']} {m.get('content', '').strip()[:140]}")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# Registry + per-transport subsets
# ═════════════════════════════════════════════════════════════════════════════

#: Every tool on the surface, name → function. The ONLY list to append to when
#: adding a tool (then add the name to the transport sets below).
ALL_TOOLS: dict[str, Callable[..., Any]] = {
    # notes
    "log_note": log_note,
    "search_notes": search_notes,
    "read_note": read_note,
    "edit_note": edit_note,
    "delete_note": delete_note,
    "attach_file_to_note": attach_file_to_note,
    # promises
    "set_promise": set_promise,
    "list_promises": list_promises,
    "set_promise_state": set_promise_state,
    # topics
    "list_topics": list_topics,
    "create_topic": create_topic,
    # trackables
    "add_trackable": add_trackable,
    "log_trackable_entry": log_trackable_entry,
    "read_trackable": read_trackable,
    # memory
    "get_context": get_context,
    "add_memory": add_memory,
    "search_memories": search_memories,
    "edit_memory": edit_memory,
    "forget_memory": forget_memory,
    "list_preferences": list_preferences,
}

# ── which client sees what ───────────────────────────────────────────────────
# Declared lists, deliberately, so the answer to "can claude.ai do X?" is read
# off one page instead of inferred from conditionals. Both transports get the
# full surface: claude.ai and Claude Code should be able to do the same things,
# and behaviour is steered by the descriptions above, not by withholding tools.
#
# The mechanism stays because tool schemas cost context on EVERY claude.ai turn
# (the reason the remote surface was once cut to seven). At 20 tools that is
# affordable; if it stops being affordable, narrow REMOTE_TOOLS here and nothing
# else changes.

#: claude.ai remote connector, via the `/mcp` mount.
REMOTE_TOOLS: tuple[str, ...] = tuple(ALL_TOOLS)

#: Claude Code, via stdio.
STDIO_TOOLS: tuple[str, ...] = tuple(ALL_TOOLS)

#: The standalone :8001 dev server — same surface as the remote connector,
#: since that is what it exists to stand in for.
LOCAL_HTTP_TOOLS: tuple[str, ...] = REMOTE_TOOLS


def _wrap_for_audit(name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a tool so every invocation writes a ToolCall row.

    `__signature__` and `__doc__` are carried across explicitly: FastMCP builds
    the tool's JSON schema by introspecting the callable, so a wrapper that
    dropped them would publish a tool taking (*args, **kwargs) with no
    description — the schema is the contract Claude sees, and losing it is worse
    than losing the audit row.
    """
    signature = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        bound = signature.bind_partial(*args, **kwargs)
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:
            _gw().log_tool_call(
                tool_name=name, args=dict(bound.arguments),
                status="failed", result=None, error=str(exc),
            )
            raise
        _gw().log_tool_call(
            tool_name=name, args=dict(bound.arguments),
            status="done", result=result, error=None,
        )
        return result

    wrapper.__signature__ = signature  # type: ignore[attr-defined]
    return wrapper


def register(mcp, names: tuple[str, ...] | list[str], *, audit: bool = True) -> list[str]:
    """Register `names` onto a FastMCP server. Returns the names registered.

    Unknown names raise instead of being skipped — a typo in a transport list
    should surface at boot, not as a tool Claude never sees.
    """
    registered = []
    for name in names:
        fn = ALL_TOOLS.get(name)
        if fn is None:
            raise KeyError(f"unknown tool {name!r}; known: {sorted(ALL_TOOLS)}")
        mcp.tool(name=name)(_wrap_for_audit(name, fn) if audit else fn)
        registered.append(name)
    return registered
