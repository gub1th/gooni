#!/usr/bin/env python3
"""Gooni MCP server — exposes Gooni's memory and notes to Claude Code via stdio."""

import hashlib
import os
import re
from datetime import datetime, timezone

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.getenv("GOONI_URL", "http://localhost:8000")
# Frontend host for deep-link URLs surfaced back to Claude after writes.
# Defaults to the local Vite dev server; override via env for prod links.
FRONTEND_URL = os.getenv("GOONI_FRONTEND_URL", "http://localhost:5173").rstrip("/")

# Prod has password-gated auth (see app/main.py auth_middleware). Compute the
# stable bearer token from the password locally — no need to hit /auth — and
# attach it to every outgoing request via a default-header httpx.Client.
# If GOONI_AUTH_PASSWORD is unset (e.g. running against unauthenticated dev),
# the header is omitted and the backend lets requests through.
_AUTH_PASSWORD = os.getenv("GOONI_AUTH_PASSWORD", "").strip()
# Tag every outbound request so the backend can log MCP activity separately
# from regular browser/web traffic. Surfaces as a "claude activity" stat on
# the dashboard without needing to reach into Claude Code internals.
_session_headers: dict[str, str] = {"X-Gooni-Source": "mcp"}
if _AUTH_PASSWORD:
    _token = hashlib.sha256(_AUTH_PASSWORD.encode()).hexdigest()
    _session_headers["Authorization"] = f"Bearer {_token}"

_session = httpx.Client(headers=_session_headers, timeout=10)

mcp = FastMCP("gooni")

# Trailing marker appended to a task item's text when an agent claims it.
# Format:  "⏳ [agent-id | 2026-04-21T12:34Z]" at the end of the task text.
# The timestamp group is optional to tolerate claims written by older versions.
_CLAIM_RE = re.compile(r"\s*⏳\s*\[([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]\s*$")


def _default_agent_id() -> str:
    """Agent label used to claim tasks. Override with GOONI_AGENT_ID env var."""
    override = os.getenv("GOONI_AGENT_ID")
    if override:
        return override
    return f"claude-{os.path.basename(os.getcwd()) or 'unknown'}"


def _now_iso() -> str:
    """UTC timestamp, minute precision: '2026-04-21T12:34Z'."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _format_age(ts: str) -> str:
    """Turn a claim timestamp into a relative age like '3h ago'. Falls back to the raw string on parse errors."""
    if not ts:
        return ""
    try:
        dt = datetime.strptime(ts, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return ts
    secs = (datetime.now(timezone.utc) - dt).total_seconds()
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{int(secs / 60)}m ago"
    if secs < 86400:
        return f"{int(secs / 3600)}h ago"
    return f"{int(secs / 86400)}d ago"


@mcp.tool()
def get_context(query: str = "") -> str:
    """Get relevant memory context from Gooni — user facts, preferences, and past episodes.

    Call this at the start of a conversation to understand what Gooni knows about the user.
    Pass a query string to get semantically relevant memories, or leave empty for
    preferences only.

    Args:
        query: optional topic to search relevant memories for
    """
    resp = _session.get(f"{BASE_URL}/mcp/context", params={"q": query}, timeout=10)
    resp.raise_for_status()
    return resp.json()["context"] or "(no memories yet)"


@mcp.tool()
def add_memory(content: str) -> str:
    """Store a new memory about the user in Gooni.

    Args:
        content: the full memory sentence (e.g. "Currently building an MCP server in Python")
    """
    resp = _session.post(
        f"{BASE_URL}/mcp/memories",
        json={"content": content},
        timeout=10,
    )
    resp.raise_for_status()
    return f"Saved: {content}"


@mcp.tool()
def list_preferences(limit: int = 50) -> str:
    """List Daniel's active preferences — the always-injected memory rows.

    Distinguishes manually-curated entries from auto-generated feedback rules
    (key prefixed with `feedback__`). Feedback rules are written every time a
    chat correction fires; over time they bloat the system prompt, so this
    tool is the inspect-side of the recently-shipped cap (FEEDBACK_PREF_CAP =
    8 most-recent feedback prefs always inject; older feedback rules sit on
    the bench until manually pinned).

    Args:
        limit: max rows to return (default 50)
    """
    resp = _session.get(
        f"{BASE_URL}/memories",
        params={"type": "preference", "limit": limit},
        timeout=10,
    )
    resp.raise_for_status()
    payload = resp.json()
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


@mcp.tool()
def search_memories(query: str, limit: int = 8) -> str:
    """Search Gooni's memory by semantic similarity.

    Args:
        query: natural language description of what to look for
        limit: max results to return (default 8)
    """
    resp = _session.get(
        f"{BASE_URL}/mcp/memories/search",
        params={"q": query, "limit": limit},
        timeout=10,
    )
    resp.raise_for_status()
    memories = resp.json()
    if not memories:
        return "(no matching memories)"
    return "\n".join(f"- {m['memory']}" for m in memories)


@mcp.tool()
def edit_memory(memory_id: str, content: str) -> str:
    """Update an existing memory's content in Gooni.

    Args:
        memory_id: the memory UUID to update
        content: the new content to replace the old value
    """
    resp = _session.patch(
        f"{BASE_URL}/mcp/memories/{memory_id}",
        json={"content": content},
        timeout=10,
    )
    resp.raise_for_status()
    return f"Updated memory {memory_id}"


@mcp.tool()
def forget_memory(memory_id: str) -> str:
    """Remove a memory from Gooni.

    Args:
        memory_id: the memory UUID to delete
    """
    resp = _session.delete(f"{BASE_URL}/mcp/memories/{memory_id}", timeout=10)
    resp.raise_for_status()
    return f"Forgotten: {memory_id}"


@mcp.tool()
def add_note(
    title: str,
    content: str,
    is_draft: bool = False,
    is_pinned: bool = False,
    tags: list[str] | None = None,
) -> str:
    """Create a new note in Gooni.

    Slice 6: Spaces are gone — tags own organization. Every Claude-
    authored note is auto-tagged `from-claude` + `claude-code` (merged
    with any caller-supplied tags) so Daniel can filter the corpus.

    Args:
        title: short note title
        content: note body (plain text or HTML)
        is_draft: surface in the Drafts sidebar (default False). Use when
            you're seeding a half-written note Daniel should finish.
        is_pinned: pin the note (default False).
        tags: free-form labels (lowercase, ≤60 chars each, deduped).
    """
    merged_tags = ["from-claude", "claude-code", *(tags or [])]
    payload: dict = {"title": title, "content": content, "tags": merged_tags}
    if is_draft:
        payload["is_draft"] = True
    if is_pinned:
        payload["is_pinned"] = True
    resp = _session.post(f"{BASE_URL}/notes", json=payload, timeout=10)
    resp.raise_for_status()
    n = resp.json()
    flags = []
    if is_draft:
        flags.append("draft")
    if is_pinned:
        flags.append("pinned")
    suffix = f" [{', '.join(flags)}]" if flags else ""
    url = f"{FRONTEND_URL}/?note={n['id']}"
    return f"Created note #{n['id']}: {n['title']}{suffix} tags={merged_tags} ({url})"


# Mirror of AttachmentExtension.ts:iconLabelForMime/shortMime/formatBytes.
# Keep aligned — these strings appear in the rendered attachment block and
# must match the frontend renderHTML output exactly so the TipTap parseHTML
# round-trips cleanly (the editor expects the same DOM shape on next save).
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


def _attachment_block_html(
    *,
    url: str,
    filename: str,
    mime: str,
    size: int,
    attachment_id: int | None,
) -> str:
    """Render an Attachment node's HTML matching frontend renderHTML
    output exactly. TipTap parseHTML will re-recognize this on next save."""
    import html as _html
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


@mcp.tool()
def attach_file_to_note(
    note_id: int,
    file_path: str,
    filename: str | None = None,
    mime_type: str | None = None,
) -> str:
    """Upload a local file to Gooni's storage and attach it to a note as
    an inline block (PDF, doc, image, etc.). Use this when you've generated
    a file Daniel should see embedded in the note — a PDF summary, an
    exported dataset, an image. The block renders as a clickable card at
    the end of the note body, same shape as drag-dropped attachments.

    Args:
        note_id: target note id (must exist)
        file_path: absolute path to a local file you've already written
        filename: optional display name (defaults to file basename)
        mime_type: optional MIME (defaults to guess from extension)

    Returns: terse confirmation with attachment id + URL.
    """
    import mimetypes
    import pathlib

    p = pathlib.Path(file_path).expanduser()
    if not p.is_file():
        return f"ERROR: file not found at {file_path}"
    data = p.read_bytes()
    if not data:
        return f"ERROR: file is empty: {file_path}"

    name = filename or p.name
    mime = mime_type or mimetypes.guess_type(name)[0] or "application/octet-stream"

    # Multipart upload — the /uploads/file endpoint takes a `file` form
    # field + optional `note_id`. Passing note_id makes it create the
    # attachments DB row server-side; we just need to drop the block into
    # the note body afterwards.
    upload_resp = _session.post(
        f"{BASE_URL}/uploads/file",
        files={"file": (name, data, mime)},
        data={"note_id": str(note_id)},
        timeout=60,
    )
    if upload_resp.status_code == 503:
        return f"ERROR: R2 storage not configured on backend ({upload_resp.text})"
    upload_resp.raise_for_status()
    up = upload_resp.json()

    # Append the attachment block to the note's current content. We fetch
    # the current HTML, append, then PATCH — same pattern check_task uses
    # for HTML mutation through BeautifulSoup, but a string append is
    # sufficient here since the attachment block is self-contained.
    note_resp = _session.get(f"{BASE_URL}/notes/{note_id}", timeout=10)
    note_resp.raise_for_status()
    note = note_resp.json()
    current = note.get("content") or ""
    block = _attachment_block_html(
        url=up["url"],
        filename=up["filename"],
        mime=up["mime_type"],
        size=up["size_bytes"],
        attachment_id=up.get("attachment_id"),
    )
    new_content = (current + block) if current else block

    patch = _session.patch(
        f"{BASE_URL}/notes/{note_id}",
        json={"content": new_content},
        timeout=10,
    )
    patch.raise_for_status()

    aid = up.get("attachment_id")
    aid_str = f" attachment_id={aid}" if aid is not None else " (no DB row — orphan upload)"
    return (
        f"Attached {name} ({_attachment_short_mime(mime)}, "
        f"{_attachment_format_bytes(len(data))}) to note #{note_id}.{aid_str} "
        f"URL: {up['url']}"
    )


@mcp.tool()
def search_notes(query: str, limit: int = 5) -> str:
    """Search Gooni notes by semantic similarity.

    Args:
        query: what to look for in notes
        limit: max results (default 5)
    """
    resp = _session.get(
        f"{BASE_URL}/mcp/notes/search",
        params={"q": query, "limit": limit},
        timeout=10,
    )
    resp.raise_for_status()
    notes = resp.json()
    if not notes:
        return "(no matching notes)"
    lines = []
    for n in notes:
        snippet = (n.get("content") or "")[:120].replace("\n", " ")
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'}: {snippet}")
    return "\n".join(lines)


def _html_to_text(html: str) -> str:
    """Render TipTap HTML as Markdown-ish plain text.

    Task-list items become `[ ] ...` or `[x] ...` so Claude can treat a
    checklist note as a living plan.
    """
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

        # Task-list checkbox item — render as [ ] / [x]
        if name == "li" and node.get("data-type") == "taskItem":
            checked = (node.get("data-checked") or "").lower() == "true"
            mark = "[x]" if checked else "[ ]"
            body_div = node.find("div")
            text = body_div.get_text(" ", strip=True) if body_div else node.get_text(" ", strip=True)
            nested = "".join(render(c, depth + 1) for c in node.find_all("ul", recursive=False))
            return f"{indent}{mark} {text}\n{nested}"

        # Bullet-list item
        if name == "li":
            # Render children, but skip nested <ul>/<ol> so we can handle them as siblings with extra depth
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

    soup = BeautifulSoup(html, "html.parser")
    return render(soup).strip()


def _read_note_formatted(note_id: int) -> str:
    resp = _session.get(f"{BASE_URL}/notes/{note_id}", timeout=10)
    if resp.status_code == 404:
        return f"(note #{note_id} not found)"
    resp.raise_for_status()
    n = resp.json()
    title = n.get("title") or "(untitled)"
    body = _html_to_text(n.get("content") or "")
    return f"# {title}\n\n{body}" if body else f"# {title}\n\n(empty)"


def _find_command_center_note() -> dict | None:
    """Convention: the most recent note titled with 'todo' (spaces are
    gone — title match over the flat list)."""
    notes = _session.get(f"{BASE_URL}/notes", timeout=10).json()
    return next((n for n in notes if "todo" in (n.get("title") or "").lower()), None)


@mcp.tool()
def read_note(note_id: int) -> str:
    """Read the full body of a note, with task-list checkmarks preserved.

    Task items are rendered as `[ ]` (unchecked) or `[x]` (done), so a checklist
    note in any space can serve as a persistent to-do / command-center for Claude
    Code. Read current state → act on it → use edit_note() or check_task() to update.

    Args:
        note_id: numeric note ID (get this from list_notes, search_notes, or list_recent_notes)
    """
    return _read_note_formatted(note_id)


@mcp.tool()
def read_todos() -> str:
    """Read Daniel's command-center todo note — the canonical entry point.

    Convention: the note titled with 'todo' in the 'dev' space is the live
    checklist. Use this whenever Daniel says 'pull my todos', 'what's on the
    list', 'dev todos', etc. Returns items as `[ ]` / `[x]` so you can pick
    one, work on it, then call check_task() to tick it off.
    """
    n = _find_command_center_note()
    if not n:
        return "(no command-center note found — expected a note with 'todo' in the title inside the 'dev' space)"
    return f"[note #{n['id']}]\n" + _read_note_formatted(n["id"])


def _find_task_li(soup, match: str):
    """Find the first <li data-type=taskItem> whose text contains `match` (case-insensitive)."""
    match_l = match.lower().strip()
    return next(
        (
            li for li in soup.find_all("li", attrs={"data-type": "taskItem"})
            if match_l in li.get_text(" ", strip=True).lower()
        ),
        None,
    )


def _strip_claim_from_li(li) -> tuple[str, str] | None:
    """Remove trailing ⏳ [agent | timestamp?] marker from the task's paragraph.

    Returns (agent, timestamp) or None. `timestamp` is "" if the existing claim
    was written by an older version that didn't include one.
    """
    from bs4 import NavigableString
    body = li.find("div")
    if not body:
        return None
    p = body.find("p")
    if not p:
        return None

    m = _CLAIM_RE.search(p.get_text())
    if not m:
        return None

    agent = m.group(1).strip()
    ts = (m.group(2) or "").strip()

    remove_chars = len(m.group(0))
    # Walk backwards through p's contents, trimming characters off the tail.
    while remove_chars > 0 and p.contents:
        last = p.contents[-1]
        if isinstance(last, NavigableString):
            text = str(last)
            if len(text) <= remove_chars:
                remove_chars -= len(text)
                last.extract()
            else:
                last.replace_with(text[:-remove_chars])
                remove_chars = 0
        else:
            # Non-text sibling at the tail — shouldn't happen for a claim marker, but stop safely.
            break
    return agent, ts


def _append_claim_to_li(li, agent: str, timestamp: str | None = None) -> bool:
    """Append ' ⏳ [agent | timestamp]' to the task's paragraph. Returns True if added.

    Pass an explicit timestamp to preserve the original claim time when restoring;
    otherwise a fresh UTC timestamp is stamped.
    """
    from bs4 import NavigableString
    body = li.find("div")
    if not body:
        return False
    p = body.find("p")
    if not p:
        return False
    ts = timestamp or _now_iso()
    p.append(NavigableString(f" ⏳ [{agent} | {ts}]"))
    return True


def _save_note_content(note_id: int, html: str):
    r = _session.patch(f"{BASE_URL}/notes/{note_id}", json={"content": html}, timeout=10)
    r.raise_for_status()


def _load_note_soup(note_id: int):
    """Fetch note HTML and return (BeautifulSoup, None) or (None, error_string)."""
    from bs4 import BeautifulSoup
    resp = _session.get(f"{BASE_URL}/notes/{note_id}", timeout=10)
    if resp.status_code == 404:
        return None, f"(note #{note_id} not found)"
    resp.raise_for_status()
    html = resp.json().get("content") or ""
    return BeautifulSoup(html, "html.parser"), None


def _resolve_note_id(note_id: int | None) -> tuple[int | None, str | None]:
    """If note_id is None, fall back to the command-center note. Returns (id, error_or_None)."""
    if note_id is not None:
        return note_id, None
    n = _find_command_center_note()
    if not n:
        return None, "(no command-center note found — pass note_id explicitly)"
    return n["id"], None


@mcp.tool()
def check_task(match: str, checked: bool = True, note_id: int = None) -> str:
    """Flip a task-list item's checkmark by text match. Auto-releases any claim on it.

    Defaults to the command-center note (the 'todo' note in the 'dev' space)
    so a bare `check_task("fix bug")` just works.

    Args:
        match: text contained in the task item (case-insensitive substring match; first hit wins)
        checked: true to mark done [x], false to un-check [ ] — default true
        note_id: optional — operate on a specific note instead of the command-center note
    """
    note_id, err = _resolve_note_id(note_id)
    if err:
        return err
    soup, err = _load_note_soup(note_id)
    if err:
        return err

    target = _find_task_li(soup, match)
    if target is None:
        return f"(no task matching '{match}' found in note #{note_id})"

    # Strip any claim marker — checking the box implicitly releases the claim.
    _strip_claim_from_li(target)

    target["data-checked"] = "true" if checked else "false"
    inp = target.find("input", attrs={"type": "checkbox"})
    if inp is not None:
        if checked:
            inp["checked"] = "checked"
        elif "checked" in inp.attrs:
            del inp.attrs["checked"]

    _save_note_content(note_id, str(soup))
    text = target.get_text(" ", strip=True)
    return f"{'[x]' if checked else '[ ]'} {text}"


@mcp.tool()
def claim_task(match: str, agent: str = None, note_id: int = None, force: bool = False) -> str:
    """Mark a task as being worked on so other agents don't duplicate effort.

    Appends ` ⏳ [agent | timestamp]` to the task text. Other agents (or a
    human) see the claim and the age. Call release_task() or check_task()
    when done.

    If the task is already claimed by a DIFFERENT agent, this refuses and
    reports the existing claim with its age. Pass `force=True` to take over
    (useful when a prior agent crashed or a claim is clearly stale).

    Args:
        match: text contained in the task item to claim (case-insensitive substring)
        agent: agent label to record. Defaults to $GOONI_AGENT_ID or `claude-<cwd>`.
        note_id: optional — operate on a specific note instead of the command-center note
        force: if True, overwrite an existing claim by a different agent
    """
    note_id, err = _resolve_note_id(note_id)
    if err:
        return err
    soup, err = _load_note_soup(note_id)
    if err:
        return err

    target = _find_task_li(soup, match)
    if target is None:
        return f"(no task matching '{match}' found in note #{note_id})"

    agent = agent or _default_agent_id()
    existing = _strip_claim_from_li(target)
    if existing and existing[0] != agent and not force:
        # Restore the existing claim verbatim and refuse — don't silently steal work.
        _append_claim_to_li(target, existing[0], existing[1] or None)
        age = f", {_format_age(existing[1])}" if existing[1] else ""
        return f"(already claimed by '{existing[0]}'{age} — pass force=True to take over)"

    _append_claim_to_li(target, agent)
    _save_note_content(note_id, str(soup))
    text = target.get_text(" ", strip=True)
    took_over = existing and existing[0] != agent
    prefix = f"took over from '{existing[0]}' — " if took_over else ""
    return f"{prefix}claimed: {text}"


@mcp.tool()
def release_task(match: str, note_id: int = None) -> str:
    """Remove the claim marker from a task without checking it off.

    Args:
        match: text contained in the task item to release (case-insensitive substring)
        note_id: optional — operate on a specific note instead of the command-center note
    """
    note_id, err = _resolve_note_id(note_id)
    if err:
        return err
    soup, err = _load_note_soup(note_id)
    if err:
        return err

    target = _find_task_li(soup, match)
    if target is None:
        return f"(no task matching '{match}' found in note #{note_id})"

    released = _strip_claim_from_li(target)
    if not released:
        return "(task was not claimed)"

    _save_note_content(note_id, str(soup))
    agent, ts = released
    age = f", {_format_age(ts)}" if ts else ""
    text = target.get_text(" ", strip=True)
    return f"released (was '{agent}'{age}): {text}"


@mcp.tool()
def edit_note(
    note_id: int,
    title: str = None,
    content: str = None,
    is_draft: bool = None,
    is_pinned: bool = None,
    tags: list[str] | None = None,
) -> str:
    """Edit an existing note in Gooni. Use this to update progress notes or
    evolving docs, or to flip the draft/pinned flags on an existing note.

    Args:
        note_id: the numeric ID of the note to edit
        title: new title (optional — omit to keep current)
        content: new body text (optional — omit to keep current)
        is_draft: set/clear the Drafts-sidebar flag (optional — omit to leave
            unchanged). Pass True after seeding a half-written note that
            wasn't initially marked draft.
        is_pinned: set/clear the pinned flag (optional — omit to leave
            unchanged).
        tags: replace the tag set (optional). Pass an explicit list to
            overwrite; omit to keep current. To add `from-claude` without
            blowing away existing tags, fetch the note first via
            `read_note` / `find_note`, merge, then pass the merged list.
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
    resp = _session.patch(f"{BASE_URL}/notes/{note_id}", json=patch, timeout=10)
    resp.raise_for_status()
    n = resp.json()
    flags = []
    if is_draft is not None:
        flags.append(f"draft={bool(is_draft)}")
    if is_pinned is not None:
        flags.append(f"pinned={bool(is_pinned)}")
    if tags is not None:
        flags.append(f"tags={n.get('tags') or []}")
    suffix = f" [{', '.join(flags)}]" if flags else ""
    return f"Updated note #{n['id']}: {n['title']}{suffix}"


@mcp.tool()
def list_notes(tag: str = "", limit: int = 20) -> str:
    """List notes, newest first. Optional tag filter (spaces are gone —
    tags own organization).

    Args:
        tag: filter to notes carrying this tag (empty = all)
        limit: max notes (default 20)
    """
    params: dict = {}
    if (tag or "").strip():
        params["tag"] = tag.strip().lower()
    resp = _session.get(f"{BASE_URL}/notes", params=params, timeout=10)
    resp.raise_for_status()
    notes = resp.json()[: max(1, min(limit, 100))]
    if not notes:
        return "(no notes)"
    lines = []
    for n in notes:
        tags = n.get("tags") or []
        tag_part = f" [{', '.join(tags)}]" if tags else ""
        lines.append(f"#{n['id']} {n.get('title') or '(untitled)'}{tag_part}")
    return "\n".join(lines)


@mcp.tool()
def add_promise(
    text: str,
    cadence: str = "once",
    cadence_target: int | None = None,
    is_important: bool = False,
    due: str | None = None,
) -> str:
    """Add a Promise — Gooni's unified commitment primitive (ambient-loop
    v2). A Promise expresses one-shot chores (cadence=once), recurring
    habits (daily / n_per_week), and standing rules (permanent_do /
    permanent_never) in one shape.

    Args:
        text: the commitment ("ship the eval", "gym 6x a week", "no weed")
        cadence: once | daily | n_per_week | permanent_do | permanent_never
        cadence_target: N for n_per_week (e.g. 6 for six times a week)
        is_important: flag for the overlay's action-horizon zone
        due: optional ISO datetime deadline (once-cadence only)
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    payload: dict = {
        "text": text,
        "cadence": cadence,
        "is_important": is_important,
    }
    if cadence_target is not None:
        payload["cadence_target"] = cadence_target
    resp = _session.post(f"{BASE_URL}/promises", json=payload, timeout=10)
    resp.raise_for_status()
    p = resp.json()
    if due:
        patch = _session.patch(
            f"{BASE_URL}/promises/{p['id']}", json={"due": due}, timeout=10
        )
        patch.raise_for_status()
        p = patch.json()
    cad = p.get("cadence", "once")
    if cad == "n_per_week":
        cad_str = f" [{p.get('cadence_target') or '?'}x/wk]"
    elif cad != "once":
        cad_str = f" [{cad}]"
    else:
        cad_str = ""
    return f"promise #{p['id']} tracked: {p.get('summary') or text}{cad_str}"


@mcp.tool()
def read_promises(state: str = "active", limit: int = 30) -> str:
    """List Daniel's promises (the unified commitment primitive).

    Args:
        state: active | kept | broken | all (default active)
        limit: max rows (default 30)
    """
    params: dict = {"limit": limit}
    if state and state != "all":
        params["state"] = state
    resp = _session.get(f"{BASE_URL}/promises", params=params, timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        return "(no promises)"
    lines = []
    for p in rows:
        cad = p.get("cadence") or "once"
        cad_tag = ""
        if cad == "n_per_week":
            cad_tag = f" [{p.get('cadence_target') or '?'}x/wk]"
        elif cad != "once":
            cad_tag = f" [{cad}]"
        imp = " ★" if p.get("is_important") else ""
        due = f" (due {p['inferred_due'][:10]})" if p.get("inferred_due") else ""
        lines.append(
            f"#{p['id']} [{p.get('state')}] {p.get('summary') or p.get('utterance')}"
            f"{cad_tag}{imp}{due}"
        )
    return "\n".join(lines)


@mcp.tool()
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
    """Create a Trackable — Gooni's generic measurement definition
    (ambient-loop v2). Adding a new tracked thing is one call, no schema
    migration. Name-idempotent: an existing name returns that definition.

    Args:
        name: what's tracked ("sleep score", "leetcode solved", "weight")
        kind: boolean (did/didn't) | numeric | json (arbitrary payload)
        unit: display unit ("kcal", "kg", "hrs")
        cadence: expected rhythm (once|daily|n_per_week|...) — informational
        target: numeric goal (limit or floor; consumer decides direction)
        is_important: surfaces in the overlay's trackables zone
        agg: per-day fold — "sum" (additive, like calories) or "last"
             (newest wins, like weight). Default last.
        schema_hint: JSON string describing the value_json payload shape
    """
    name = (name or "").strip()
    if not name:
        return "(name required)"
    payload: dict = {
        "name": name, "kind": kind, "is_important": is_important,
    }
    for k, v in (("unit", unit), ("cadence", cadence), ("target", target),
                 ("agg", agg), ("schema_hint", schema_hint)):
        if v is not None:
            payload[k] = v
    resp = _session.post(f"{BASE_URL}/trackables", json=payload, timeout=10)
    resp.raise_for_status()
    t = resp.json()
    return f"trackable #{t['id']} ready: {t['name']} ({t['kind']}, agg={t['agg']})"


@mcp.tool()
def log_trackable_entry(
    name: str,
    value: str,
    date: str | None = None,
    replace: bool = False,
) -> str:
    """Log one entry on a Trackable (resolved by name).

    `value` parsing by the trackable's kind:
      boolean → "true"/"false"/"1"/"0"
      numeric → a number ("2100", "70.8")
      json    → a JSON object string ('{"score": 87, "strain": 12.1}')

    Args:
        name: trackable name (see read_trackable / add_trackable)
        value: the value, encoded as above
        date: YYYY-MM-DD (defaults to today in Daniel's TZ)
        replace: collapse the day to this single entry (cell-edit
                 semantics) instead of appending
    """
    import json as _json

    resp = _session.get(f"{BASE_URL}/trackables", timeout=10)
    resp.raise_for_status()
    match = next(
        (t for t in resp.json() if t["name"] == (name or "").strip().lower()), None
    )
    if match is None:
        return f"(no trackable named {name!r} — create it with add_trackable)"
    body: dict = {"source": "manual", "replace": replace}
    if date:
        body["date"] = date
    kind = match["kind"]
    v = (value or "").strip()
    if kind == "boolean":
        body["value_boolean"] = v.lower() in ("true", "1", "yes")
    elif kind == "numeric":
        try:
            body["value_numeric"] = float(v)
        except ValueError:
            return f"(numeric trackable — {v!r} is not a number)"
    else:
        try:
            body["value_json"] = _json.loads(v)
        except ValueError:
            body["value_json"] = {"text": v}
    resp = _session.post(
        f"{BASE_URL}/trackables/{match['id']}/entries", json=body, timeout=10
    )
    resp.raise_for_status()
    out = resp.json()
    if out.get("cleared"):
        return f"cleared {match['name']} for {date or 'today'}"
    e = out["entry"]
    val = e.get("value_numeric") if e.get("value_numeric") is not None else (
        e.get("value_boolean") if e.get("value_boolean") is not None else e.get("value_json")
    )
    return f"logged {match['name']} = {val} on {e['date']}"


@mcp.tool()
def read_trackable(name: str = "", days: int = 14) -> str:
    """Read Trackables. Empty name lists all definitions; a name returns
    that trackable's per-day pivot for the last `days` days.

    Args:
        name: trackable name (empty = list all)
        days: pivot window when a name is given (default 14)
    """
    resp = _session.get(f"{BASE_URL}/trackables", timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    if not (name or "").strip():
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
    match = next((t for t in rows if t["name"] == name.strip().lower()), None)
    if match is None:
        return f"(no trackable named {name!r})"
    resp = _session.get(
        f"{BASE_URL}/trackables/{match['id']}/entries",
        params={"days": days},
        timeout=10,
    )
    resp.raise_for_status()
    pivot = resp.json()["days"]
    if not pivot:
        return f"{match['name']}: no entries in last {days}d"
    lines = [f"{match['name']} ({match['kind']}, last {days}d):"]
    for d in pivot:
        lines.append(f"  {d['date']}: {d['value']}")
    return "\n".join(lines)


@mcp.tool()
def list_recent_notes(limit: int = 10) -> str:
    """List the most recently updated notes across all spaces.

    Use this to see what Daniel has been working on lately.

    Args:
        limit: max notes to return (default 10)
    """
    resp = _session.get(f"{BASE_URL}/notes/recent", params={"limit": limit}, timeout=10)
    resp.raise_for_status()
    notes = resp.json()
    if not notes:
        return "(no notes)"
    lines = []
    for n in notes:
        snippet = (n.get("content") or "")[:80].replace("\n", " ")
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'} — {snippet}")
    return "\n".join(lines)


@mcp.tool()
def find_note(match: str, limit: int = 5) -> str:
    """Find notes by substring match across recent titles + content snippets.

    Returns id + title + snippet so you can pick one before destructive ops.
    For semantic search use search_notes() instead — this is for picking a
    specific note out of a small recent set when you remember a phrase.

    Args:
        match: case-insensitive substring to look for
        limit: max recent notes to scan (default 5; up to 100)
    """
    match_l = (match or "").lower().strip()
    if not match_l:
        return "(empty match string)"
    scan_limit = max(1, min(int(limit) * 20, 100))
    resp = _session.get(f"{BASE_URL}/notes/recent", params={"limit": scan_limit}, timeout=10)
    resp.raise_for_status()
    notes = resp.json()
    hits = []
    for n in notes:
        title = (n.get("title") or "").lower()
        content = (n.get("content") or "").lower()
        if match_l in title or match_l in content:
            hits.append(n)
            if len(hits) >= limit:
                break
    if not hits:
        return f"(no recent note matching '{match}' in last {scan_limit})"
    lines = []
    for n in hits:
        snippet = (n.get("content") or "")[:120].replace("\n", " ")
        tag_part = f" {n['tags']}" if n.get("tags") else ""
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'}{tag_part} — {snippet}")
    return "\n".join(lines)


@mcp.tool()
def delete_note(note_id: int) -> str:
    """Delete a note by numeric id. Irreversible — call find_note() first to confirm
    you have the right id. Returns the deleted note's title for an audit trail.

    Args:
        note_id: numeric id of the note to delete (get from find_note, list_recent_notes, etc.)
    """
    if not isinstance(note_id, int) or note_id <= 0:
        return "(note_id must be a positive integer)"
    # Fetch first so we can echo the title back — also catches typoed ids before deletion.
    pre = _session.get(f"{BASE_URL}/notes/{note_id}", timeout=10)
    if pre.status_code == 404:
        return f"(note #{note_id} not found)"
    pre.raise_for_status()
    snapshot = pre.json()
    title = snapshot.get("title") or "(untitled)"
    resp = _session.delete(f"{BASE_URL}/notes/{note_id}", timeout=10)
    if resp.status_code == 404:
        return f"(note #{note_id} not found)"
    resp.raise_for_status()
    return f"deleted note #{note_id}: {title}"


@mcp.tool()
def get_leetcode_activity() -> str:
    """Get Daniel's recent LeetCode activity — current streak, today's
    submission count, and the last 7 days' total. Pulls from Gooni's cached
    daily snapshot (one row per UTC date in `leetcode_snapshots`).

    Use this when Daniel asks how his LeetCode practice is going, or when
    you want context on whether he's been grinding problems lately.
    """
    try:
        resp = _session.get(f"{BASE_URL}/leetcode/today", timeout=15)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        return f"(leetcode fetch failed: {exc})"
    data = resp.json() or {}
    if not data.get("available"):
        return "(no leetcode snapshot yet)"
    parts = [
        f"user: {data.get('username')}",
        f"streak: {data.get('streak')} day(s)",
        f"today: {data.get('today_count')} submissions",
        f"past 7d: {data.get('week_count')} submissions",
        f"total solved: {data.get('total_solved')} "
        f"(easy {data.get('easy_solved')} / med {data.get('medium_solved')} / hard {data.get('hard_solved')})",
        f"global rank: {data.get('ranking')}",
    ]
    snapshot_date = data.get("snapshot_date")
    if snapshot_date:
        parts.append(f"snapshot date: {snapshot_date}")
    return "\n".join(parts)


