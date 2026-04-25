#!/usr/bin/env python3
"""Gooni MCP server — exposes Gooni's memory and notes to Claude Code via stdio."""

import hashlib
import os
import re
from datetime import datetime, timezone

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.getenv("GOONI_URL", "http://localhost:8000")

# Prod has password-gated auth (see app/main.py auth_middleware). Compute the
# stable bearer token from the password locally — no need to hit /auth — and
# attach it to every outgoing request via a default-header httpx.Client.
# If GOONI_AUTH_PASSWORD is unset (e.g. running against unauthenticated dev),
# the header is omitted and the backend lets requests through.
_AUTH_PASSWORD = os.getenv("GOONI_AUTH_PASSWORD", "").strip()
_session_headers: dict[str, str] = {}
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
def add_note(title: str, content: str) -> str:
    """Create a new note in Gooni.

    Args:
        title: short note title
        content: note body (plain text)
    """
    resp = _session.post(
        f"{BASE_URL}/spaces/general/notes",
        json={"title": title, "content": content},
        timeout=10,
    )
    resp.raise_for_status()
    n = resp.json()
    return f"Created note #{n['id']}: {n['title']}"


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


def _find_space_by_name(name: str) -> dict | None:
    """Case-insensitive exact-then-partial match. Returns the space dict or None."""
    spaces = _session.get(f"{BASE_URL}/spaces", timeout=10).json()
    name_l = name.lower()
    return (
        next((s for s in spaces if (s.get("name") or "").lower() == name_l), None)
        or next((s for s in spaces if name_l in (s.get("name") or "").lower()), None)
    )


def _find_command_center_note() -> dict | None:
    """Convention: the note titled with 'todo' in the 'dev' space."""
    dev = _find_space_by_name("dev")
    if not dev:
        return None
    notes = _session.get(f"{BASE_URL}/spaces/{dev['id']}/notes", timeout=10).json()
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
def edit_note(note_id: int, title: str = None, content: str = None) -> str:
    """Edit an existing note in Gooni. Use this to update progress notes or evolving docs.

    Args:
        note_id: the numeric ID of the note to edit
        title: new title (optional — omit to keep current)
        content: new body text (optional — omit to keep current)
    """
    patch: dict = {}
    if title is not None:
        patch["title"] = title
    if content is not None:
        patch["content"] = content
    if not patch:
        return "Nothing to update."
    resp = _session.patch(f"{BASE_URL}/notes/{note_id}", json=patch, timeout=10)
    resp.raise_for_status()
    n = resp.json()
    return f"Updated note #{n['id']}: {n['title']}"


@mcp.tool()
def list_spaces() -> str:
    """List all spaces in Gooni.

    Use this to know where notes are organized before creating or searching.
    """
    resp = _session.get(f"{BASE_URL}/spaces", timeout=10)
    resp.raise_for_status()
    spaces = resp.json()
    if not spaces:
        return "(no spaces yet)"
    return "\n".join(f"#{s['id']} {s.get('emoji') or ''} {s['name']}".strip() for s in spaces)


@mcp.tool()
def list_notes(space: str = "general", limit: int = 20) -> str:
    """List notes in a space. Accepts 'general', a numeric space ID, or a space name.

    Args:
        space: 'general' for all notes, a numeric space ID, or a space name (e.g. 'dev')
        limit: max notes to return (default 20)
    """
    # Resolve a name like "dev" → its numeric ID. Numeric strings and "general" pass through.
    if space.lower() == "general" or space.isdigit():
        space_key = space
    else:
        match = _find_space_by_name(space)
        if not match:
            return f"(no space matching '{space}')"
        space_key = str(match["id"])

    resp = _session.get(f"{BASE_URL}/spaces/{space_key}/notes", timeout=10)
    resp.raise_for_status()
    notes = resp.json()[:limit]
    if not notes:
        return "(no notes)"
    lines = []
    for n in notes:
        snippet = (n.get("content") or "")[:80].replace("\n", " ")
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'} — {snippet}")
    return "\n".join(lines)


def _fetch_todos() -> list[dict]:
    resp = _session.get(f"{BASE_URL}/todos", timeout=10)
    resp.raise_for_status()
    return resp.json()


def _find_todo(match: str, only_open: bool = False) -> tuple[dict | None, str | None]:
    """Case-insensitive substring match on todo text. Returns (todo, error_or_None)."""
    match_l = match.lower().strip()
    if not match_l:
        return None, "(empty match string)"
    todos = _fetch_todos()
    candidates = [t for t in todos if match_l in (t["text"] or "").lower()]
    if only_open:
        candidates = [t for t in candidates if not t["done"]]
    if not candidates:
        return None, f"(no todo matching '{match}')"
    # Prefer shortest text (most specific match)
    candidates.sort(key=lambda t: len(t["text"]))
    return candidates[0], None


@mcp.tool()
def add_todo(text: str) -> str:
    """Add a new todo to Daniel's dashboard todo list.

    The todo appears in the dashboard's Todo card, goes to the bottom of the
    list, and tracks its own created_at so the UI can show an age pill.

    Args:
        text: the todo text (e.g. "review PR #42", "fix the mascot walk cycle")
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    resp = _session.post(f"{BASE_URL}/todos", json={"text": text}, timeout=10)
    resp.raise_for_status()
    t = resp.json()
    return f"added #{t['id']}: {t['text']}"


@mcp.tool()
def list_todos(include_done: bool = False, limit: int = 50) -> str:
    """List Daniel's dashboard todos.

    Args:
        include_done: include completed items (default False — open items only)
        limit: max items to return (default 50)
    """
    todos = _fetch_todos()
    if not include_done:
        todos = [t for t in todos if not t["done"]]
    todos = todos[:limit]
    if not todos:
        return "(no todos)"
    lines = []
    for t in todos:
        mark = "[x]" if t["done"] else "[ ]"
        age = ""
        if t.get("created_at"):
            try:
                dt = datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                secs = (datetime.now(timezone.utc) - dt).total_seconds()
                if secs < 60:
                    age = "just now"
                elif secs < 3600:
                    age = f"{int(secs / 60)}m"
                elif secs < 86400:
                    age = f"{int(secs / 3600)}h"
                else:
                    age = f"{int(secs / 86400)}d"
            except (ValueError, AttributeError):
                age = ""
        suffix = f" ({age})" if age else ""
        lines.append(f"#{t['id']} {mark} {t['text']}{suffix}")
    return "\n".join(lines)


@mcp.tool()
def complete_todo(match: str) -> str:
    """Mark a todo as done by text match.

    Args:
        match: text contained in the todo (case-insensitive substring; shortest match wins)
    """
    t, err = _find_todo(match, only_open=True)
    if err:
        return err
    resp = _session.patch(f"{BASE_URL}/todos/{t['id']}", json={"done": True}, timeout=10)
    resp.raise_for_status()
    return f"[x] {t['text']}"


@mcp.tool()
def uncheck_todo(match: str) -> str:
    """Un-check a completed todo by text match.

    Args:
        match: text contained in the todo (case-insensitive substring; shortest match wins)
    """
    t, err = _find_todo(match)
    if err:
        return err
    resp = _session.patch(f"{BASE_URL}/todos/{t['id']}", json={"done": False}, timeout=10)
    resp.raise_for_status()
    return f"[ ] {t['text']}"


@mcp.tool()
def delete_todo(match: str) -> str:
    """Delete a todo by text match.

    Args:
        match: text contained in the todo (case-insensitive substring; shortest match wins)
    """
    t, err = _find_todo(match)
    if err:
        return err
    resp = _session.delete(f"{BASE_URL}/todos/{t['id']}", timeout=10)
    resp.raise_for_status()
    return f"deleted: {t['text']}"


def _fetch_focuses(include_done: bool = False, include_someday: bool = True) -> list[dict]:
    params = {}
    if include_done:
        params["include_done"] = "true"
    if not include_someday:
        params["include_someday"] = "false"
    resp = _session.get(f"{BASE_URL}/focuses", params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _find_focus(match: str) -> tuple[dict | None, str | None]:
    """Case-insensitive substring match on focus name. Returns (focus, error_or_None)."""
    match_l = match.lower().strip()
    if not match_l:
        return None, "(empty match string)"
    focuses = _fetch_focuses(include_done=True)
    candidates = [f for f in focuses if match_l in (f["name"] or "").lower()]
    if not candidates:
        return None, f"(no focus matching '{match}')"
    # Prefer shortest name (most specific match)
    candidates.sort(key=lambda f: len(f["name"]))
    return candidates[0], None


@mcp.tool()
def list_focuses(include_done: bool = False, include_someday: bool = True, limit: int = 20) -> str:
    """List Daniel's focuses — long-running things he's committed to or considering.

    Args:
        include_done: include completed focuses (default False)
        include_someday: include 'someday/maybe' focuses (default True)
        limit: max to return (default 20)
    """
    focuses = _fetch_focuses(include_done=include_done, include_someday=include_someday)
    focuses = focuses[:limit]
    if not focuses:
        return "(no focuses)"
    lines = []
    for f in focuses:
        days = f.get("days_since_activity")
        if days is None:
            heat = "no activity yet"
        elif days == 0:
            heat = "touched today"
        else:
            heat = f"{days}d ago"
        due = f" (due {f['due_date'][:10]})" if f.get("due_date") else ""
        lines.append(
            f"#{f['id']} [{f['status']}] {f['name']}{due} — {heat}\n    → {f['endgoal']}"
        )
    return "\n".join(lines)


@mcp.tool()
def add_focus(
    name: str,
    endgoal: str,
    due_date: str = None,
    status: str = "committed",
) -> str:
    """Create a new focus on Daniel's dashboard.

    Args:
        name: short label (e.g. "Ship Gooni v2")
        endgoal: what 'done' looks like — long enough that Gooni knows when Daniel's there
        due_date: optional ISO date (YYYY-MM-DD) or full datetime
        status: 'committed' | 'pending' | 'someday' (default 'committed')
    """
    name = (name or "").strip()
    endgoal = (endgoal or "").strip()
    if not name or not endgoal:
        return "(name and endgoal required)"
    if status not in ("committed", "pending", "someday", "done"):
        return f"(invalid status '{status}'; use committed/pending/someday/done)"
    body = {"name": name, "endgoal": endgoal, "status": status}
    if due_date:
        body["due_date"] = due_date
    resp = _session.post(f"{BASE_URL}/focuses", json=body, timeout=10)
    resp.raise_for_status()
    f = resp.json()
    return f"added focus #{f['id']}: {f['name']} ({f['status']})"


@mcp.tool()
def update_focus_status(match: str, status: str) -> str:
    """Change a focus's status (committed/pending/someday/done) by name match.

    Args:
        match: text contained in the focus name (case-insensitive substring)
        status: 'committed' | 'pending' | 'someday' | 'done'
    """
    if status not in ("committed", "pending", "someday", "done"):
        return f"(invalid status '{status}')"
    f, err = _find_focus(match)
    if err:
        return err
    resp = _session.patch(
        f"{BASE_URL}/focuses/{f['id']}", json={"status": status}, timeout=10
    )
    resp.raise_for_status()
    return f"[{status}] {f['name']}"


@mcp.tool()
def mark_focus_activity(match: str) -> str:
    """Record a manual heartbeat on a focus — bumps last_activity_at to now.
    Use when Daniel mentions making progress on something but no note/message
    captured it (e.g. real-world action).

    Args:
        match: text contained in the focus name
    """
    f, err = _find_focus(match)
    if err:
        return err
    resp = _session.post(f"{BASE_URL}/focuses/{f['id']}/heartbeat", timeout=10)
    resp.raise_for_status()
    updated = resp.json()
    return f"♥ {updated['name']} — touched today"


@mcp.tool()
def read_focus(match: str) -> str:
    """Read a focus's full details + recent activity log.

    Args:
        match: text contained in the focus name
    """
    f, err = _find_focus(match)
    if err:
        return err
    resp = _session.get(f"{BASE_URL}/focuses/{f['id']}/activity", timeout=10)
    resp.raise_for_status()
    activity = resp.json()
    lines = [
        f"#{f['id']} {f['name']} ({f['status']})",
        f"  Endgoal: {f['endgoal']}",
    ]
    if f.get("due_date"):
        lines.append(f"  Due: {f['due_date'][:10]}")
    days = f.get("days_since_activity")
    if days is None:
        lines.append("  Activity: no heartbeats yet")
    else:
        lines.append(f"  Last touched: {days}d ago")
    if activity:
        lines.append(f"  Recent activity ({len(activity)} events):")
        for a in activity[:10]:
            ts = a.get("created_at", "")[:16].replace("T", " ")
            sim = f" sim={a['similarity']:.2f}" if a.get("similarity") else ""
            lines.append(f"    - {ts} via {a['source_type']}{sim}")
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
