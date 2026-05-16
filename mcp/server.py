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


def _resolve_space_id(space_name: str, emoji: str | None = None) -> int | str:
    """Map a human space name to its current ID. Creates the space if missing.

    Returns the space.id (int) for named spaces, or the literal "general"
    when space_name == "General" (since the backend keeps General as a
    pseudo-space outside the spaces table).

    Robust by name — survives DB rebuilds where IDs shift. Caller passes
    the name; this function does the lookup.
    """
    if space_name.strip().lower() == "general":
        return "general"

    resp = _session.get(f"{BASE_URL}/spaces", timeout=10)
    resp.raise_for_status()
    spaces = resp.json()
    for s in spaces:
        if (s.get("name") or "").strip().lower() == space_name.strip().lower():
            return int(s["id"])

    # Not found — create it
    payload: dict = {"name": space_name}
    if emoji:
        payload["emoji"] = emoji
    create = _session.post(f"{BASE_URL}/spaces", json=payload, timeout=10)
    create.raise_for_status()
    return int(create.json()["id"])


@mcp.tool()
def add_note(
    title: str,
    content: str,
    space_name: str = "Claude Code",
    is_draft: bool = False,
    is_pinned: bool = False,
) -> str:
    """Create a new note in Gooni.

    Defaults to the "Claude Code" space — anything Claude Code logs about
    a coding session belongs there, not in General. Pass `space_name` to
    override (e.g. "General" for free-floating notes, or any other space).

    The space is resolved by name and auto-created if missing, so this
    tool stays correct even after DB rebuilds where IDs shift.

    Args:
        title: short note title
        content: note body (plain text or HTML)
        space_name: target space (defaults to "Claude Code")
        is_draft: surface in the Drafts sidebar (default False). Use when
            you're seeding a half-written note Daniel should finish.
        is_pinned: pin the note (default False).
    """
    space_id = _resolve_space_id(space_name, emoji="🤖" if space_name == "Claude Code" else None)
    payload: dict = {"title": title, "content": content}
    if is_draft:
        payload["is_draft"] = True
    if is_pinned:
        payload["is_pinned"] = True
    resp = _session.post(
        f"{BASE_URL}/spaces/{space_id}/notes",
        json=payload,
        timeout=10,
    )
    resp.raise_for_status()
    n = resp.json()
    flags = []
    if is_draft:
        flags.append("draft")
    if is_pinned:
        flags.append("pinned")
    suffix = f" [{', '.join(flags)}]" if flags else ""
    url = f"{FRONTEND_URL}/?note={n['id']}"
    return f"Created note #{n['id']} in {space_name}: {n['title']}{suffix} ({url})"


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
def edit_note(
    note_id: int,
    title: str = None,
    content: str = None,
    is_draft: bool = None,
    is_pinned: bool = None,
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
    suffix = f" [{', '.join(flags)}]" if flags else ""
    return f"Updated note #{n['id']}: {n['title']}{suffix}"


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


def _flatten_items(tree_node: list[dict]) -> list[dict]:
    """Walk an /items tree (list of nodes with .children) and return a flat
    list. Children are included recursively; the original ordering is kept."""
    out: list[dict] = []
    for n in tree_node:
        out.append(n)
        kids = n.get("children") or []
        if kids:
            out.extend(_flatten_items(kids))
    return out


def _fetch_todos() -> list[dict]:
    """Pull every actionable item — focuses + their nested children + inbox
    todos — as a flat list. Backend renamed `/todos` → `/items` (PR #54);
    the new endpoint returns a tree, so we flatten here so the rest of the
    MCP tools stay intact."""
    resp = _session.get(f"{BASE_URL}/items", timeout=10)
    resp.raise_for_status()
    payload = resp.json()
    items: list[dict] = []
    items.extend(_flatten_items(payload.get("focuses") or []))
    items.extend(_flatten_items(payload.get("inbox") or []))
    return items


def _find_todo(match: str, only_open: bool = False) -> tuple[dict | None, str | None]:
    """Case-insensitive substring match on todo text. Returns (todo, error_or_None)."""
    match_l = match.lower().strip()
    if not match_l:
        return None, "(empty match string)"
    todos = _fetch_todos()
    candidates = [t for t in todos if match_l in (t.get("text") or "").lower()]
    if only_open:
        candidates = [t for t in candidates if not t.get("done")]
    if not candidates:
        return None, f"(no todo matching '{match}')"
    # Prefer shortest text (most specific match)
    candidates.sort(key=lambda t: len(t.get("text") or ""))
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
    resp = _session.post(f"{BASE_URL}/items", json={"text": text}, timeout=10)
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
    resp = _session.patch(f"{BASE_URL}/items/{t['id']}", json={"done": True}, timeout=10)
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
    resp = _session.patch(f"{BASE_URL}/items/{t['id']}", json={"done": False}, timeout=10)
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
    resp = _session.delete(f"{BASE_URL}/items/{t['id']}", timeout=10)
    resp.raise_for_status()
    return f"deleted: {t['text']}"


def _find_backlog_item(match: str, only_open: bool = True) -> tuple[dict | None, str | None]:
    """Locate a backlog ticket by substring match. Backlog tickets now
    live in their own `backlog_tickets` table (extracted out of
    list_items); the MCP tool hits the dedicated /backlog/tickets routes.
    Substring match on text or subtitle — auto-routed tickets often have
    a `from note #N` blurb in `subtitle`.
    """
    match_l = match.lower().strip()
    if not match_l:
        return None, "(empty match string)"

    resp = _session.get(f"{BASE_URL}/backlog/tickets", timeout=10)
    resp.raise_for_status()
    tickets = resp.json() or []
    candidates: list[dict] = []
    for t in tickets:
        if only_open and t.get("done"):
            continue
        text = (t.get("text") or "").lower()
        sub = (t.get("subtitle") or "").lower()
        if match_l in text or match_l in sub:
            candidates.append(t)

    if not candidates:
        return None, f"(no backlog item matching '{match}')"
    candidates.sort(key=lambda t: len(t.get("text") or ""))
    return candidates[0], None


@mcp.tool()
def complete_backlog_item(match: str) -> str:
    """Mark a backlog ticket as done by text match.

    Backlog tickets now live in their own `backlog_tickets` table — they
    were extracted out of list_items in the focus/todo/backlog refactor.
    Auto-routed via feature_request_tool, with `subtitle` like
    "from note #157".

    Args:
        match: text contained in the backlog item (matches text OR subtitle)
    """
    item, err = _find_backlog_item(match)
    if err:
        return err
    resp = _session.patch(
        f"{BASE_URL}/backlog/tickets/{item['id']}",
        json={"done": True},
        timeout=10,
    )
    resp.raise_for_status()
    return f"[x] {item['text']}"


# ── Backlog-tickets MCP surface ──────────────────────────────────────────
#
# Mirrors read_list / add_list_item / find_similar_items / delete_list_item
# but routes through /backlog/tickets/* directly. The legacy list-shaped
# tools refuse list_ref="backlog" (the underlying list_items rows were
# extracted into the dedicated `backlog_tickets` table — they now sit
# empty).


@mcp.tool()
def read_backlog(limit: int = 50, include_done: bool = False) -> str:
    """Read tickets from the engineering backlog board.

    Backlog tickets carry a board_status enum ('not_yet' | 'doing' |
    'done') and an optional pr_url. They live in `backlog_tickets`,
    NOT `list_items` — for arbitrary user lists, use read_list.

    Args:
        limit: max tickets to return (default 50)
        include_done: include shipped tickets (default False)
    """
    resp = _session.get(
        f"{BASE_URL}/backlog/tickets?include_done={'true' if include_done else 'false'}",
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json() or []
    rows = rows[:limit]
    if not rows:
        return "(backlog is empty)"
    lines = ["# backlog"]
    for t in rows:
        mark = "[x]" if t.get("done") else "[ ]"
        status = t.get("board_status") or "-"
        sub = f" — {t['subtitle']}" if t.get("subtitle") else ""
        pr = f" ({t['pr_url']})" if t.get("pr_url") else ""
        note_ref = f" [note #{t['source_note_id']}]" if t.get("source_note_id") else ""
        lines.append(f"#{t['id']} {mark} [{status}] {t['text']}{sub}{pr}{note_ref}")
    return "\n".join(lines)


@mcp.tool()
def add_backlog_item(
    text: str,
    subtitle: str = None,
    skip_conflict_check: bool = False,
) -> str:
    """Add a ticket to the engineering backlog.

    Conflict detection is on by default: the backend cosine-searches
    existing tickets and surfaces near-duplicates. The ticket is still
    inserted — but the response flags any matches so the caller can
    decide whether to merge or delete the new one. Pass
    `skip_conflict_check=True` for bulk imports / migrations.

    Args:
        text: ticket text
        subtitle: optional secondary line
        skip_conflict_check: bypass embed + dedup scan (default False)
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    body: dict = {"text": text}
    if subtitle:
        body["subtitle"] = subtitle
    if skip_conflict_check:
        body["skip_conflict_check"] = True
    resp = _session.post(f"{BASE_URL}/backlog/tickets", json=body, timeout=20)
    resp.raise_for_status()
    t = resp.json()
    msg = f"added backlog #{t['id']}: {t['text']}"
    conflicts = t.get("conflicts") or []
    if conflicts:
        msg += "\n\n⚠ near-duplicate(s) already on the board:"
        for c in conflicts:
            sev = c.get("severity", "medium")
            sim = c.get("similarity", 0)
            msg += f"\n  [{sev} {sim:.2f}] #{c['id']} {c['text']}"
        msg += "\n(call delete_backlog_item or PATCH if this should be merged.)"
    return msg


@mcp.tool()
def find_similar_backlog(
    text: str,
    threshold: float = 0.78,
    limit: int = 5,
    include_done: bool = False,
) -> str:
    """Cosine-search the backlog for tickets similar to `text` without
    inserting anything. Use before add_backlog_item to confirm an idea
    isn't already on the board, or to find merge candidates.

    Args:
        text: query string
        threshold: minimum cosine similarity (0..1, default 0.78)
        limit: max matches to return (default 5)
        include_done: include shipped tickets (default False)
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    resp = _session.post(
        f"{BASE_URL}/backlog/tickets/similar",
        json={
            "text": text,
            "threshold": float(threshold),
            "limit": int(limit),
            "include_done": bool(include_done),
        },
        timeout=20,
    )
    resp.raise_for_status()
    matches = resp.json().get("matches") or []
    if not matches:
        return f"(no backlog tickets above similarity {threshold:.2f})"
    lines = [f"# similar to '{text}' on backlog:"]
    for m in matches:
        status = m.get("board_status") or "-"
        lines.append(f"[{m['similarity']:.2f}] #{m['id']} [{status}] {m['text']}")
    return "\n".join(lines)


@mcp.tool()
def delete_backlog_item(match: str) -> str:
    """Delete a backlog ticket by text match. Refuses if the match is
    ambiguous — narrow it to exactly one ticket. To merge instead of
    delete, PATCH the surviving ticket and DELETE the dupe.

    Args:
        match: substring of the ticket text or subtitle (case-insensitive)
    """
    match_l = (match or "").strip().lower()
    if not match_l:
        return "(empty match string)"
    resp = _session.get(f"{BASE_URL}/backlog/tickets", timeout=10)
    resp.raise_for_status()
    rows = resp.json() or []
    candidates = [
        t for t in rows
        if match_l in (t.get("text") or "").lower()
        or match_l in (t.get("subtitle") or "").lower()
    ]
    if not candidates:
        return f"(no backlog tickets matching '{match}')"
    if len(candidates) > 1:
        preview = "; ".join(f"#{t['id']} {t['text'][:40]}" for t in candidates[:5])
        return f"(ambiguous: {len(candidates)} matches — {preview}). Narrow the substring."
    t = candidates[0]
    del_resp = _session.delete(f"{BASE_URL}/backlog/tickets/{t['id']}", timeout=10)
    del_resp.raise_for_status()
    return f"deleted backlog #{t['id']}: {t['text']}"


def _fetch_focuses(include_done: bool = False, include_someday: bool = True) -> list[dict]:
    """Top-level focus items (committed roots in the new /items tree).

    Backend renamed `/focuses` → focuses-as-root-items in PR #54. A focus is
    now a top-level ListItem in the focus list, surfaced under the
    `focuses` key of /items. We normalize to the legacy shape so existing
    tools' string formatting still works: `name` aliases `text`, `status`
    is derived from done/committed flags.

    `include_someday` is no longer meaningful — committed flag is binary.
    Kept as a no-op so existing tool signatures don't break.
    """
    del include_someday  # binary committed flag replaced the trinary status
    resp = _session.get(f"{BASE_URL}/items", timeout=10)
    resp.raise_for_status()
    raw = resp.json().get("focuses") or []
    out: list[dict] = []
    for f in raw:
        if not include_done and f.get("done"):
            continue
        out.append({
            **f,
            "name": f.get("text"),  # legacy alias
            "status": "done" if f.get("done") else ("committed" if f.get("committed") else "pending"),
        })
    return out


def _find_focus(match: str) -> tuple[dict | None, str | None]:
    """Case-insensitive substring match on focus text. Returns (focus, error_or_None)."""
    match_l = match.lower().strip()
    if not match_l:
        return None, "(empty match string)"
    focuses = _fetch_focuses(include_done=True)
    candidates = [f for f in focuses if match_l in ((f.get("text") or f.get("name") or "")).lower()]
    if not candidates:
        return None, f"(no focus matching '{match}')"
    # Prefer shortest text (most specific match)
    candidates.sort(key=lambda f: len(f.get("text") or f.get("name") or ""))
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
        name = f.get("text") or f.get("name") or "(untitled)"
        due = f" (due {f['due_date'][:10]})" if f.get("due_date") else ""
        endgoal = f.get("endgoal")
        endgoal_line = f"\n    → {endgoal}" if endgoal else ""
        lines.append(f"#{f['id']} [{f['status']}] {name}{due}{endgoal_line}")
    return "\n".join(lines)


@mcp.tool()
def add_focus(
    name: str,
    endgoal: str,
    due_date: str = None,
    status: str = "committed",
) -> str:
    """Create a new focus on Daniel's dashboard.

    A focus is a top-level item with an endgoal. The unified-item refactor
    (PR #54) routes anything with `committed=True` OR an endgoal into the
    focus list automatically — both are set here.

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
    if status not in ("committed", "pending", "someday"):
        return f"(invalid status '{status}'; use committed/pending/someday)"
    body: dict = {
        "text": name,
        "endgoal": endgoal,
        "committed": status == "committed",
        "status": status,
    }
    if due_date:
        body["due_date"] = due_date
    resp = _session.post(f"{BASE_URL}/items", json=body, timeout=10)
    resp.raise_for_status()
    f = resp.json()
    return f"added focus #{f['id']}: {f['text']} ({status})"


@mcp.tool()
def update_focus_status(match: str, status: str) -> str:
    """Change a focus's status (committed/pending/someday/done) by name match.

    `done` is a separate boolean on items; the other three map to the `status`
    field. Setting `committed`/`pending` flips the `committed` flag too — same
    rule the backend uses to keep status + flag consistent.

    Args:
        match: text contained in the focus name (case-insensitive substring)
        status: 'committed' | 'pending' | 'someday' | 'done'
    """
    if status not in ("committed", "pending", "someday", "done"):
        return f"(invalid status '{status}')"
    f, err = _find_focus(match)
    if err:
        return err
    body: dict = {}
    if status == "done":
        body["done"] = True
    else:
        body["status"] = status
        body["done"] = False
    resp = _session.patch(f"{BASE_URL}/items/{f['id']}", json=body, timeout=10)
    resp.raise_for_status()
    return f"[{status}] {f.get('text') or f.get('name')}"


@mcp.tool()
def read_focus(match: str) -> str:
    """Read a focus's full details — name, endgoal, status, due date.

    Args:
        match: text contained in the focus name
    """
    f, err = _find_focus(match)
    if err:
        return err
    name = f.get("text") or f.get("name")
    lines = [
        f"#{f['id']} {name} ({f['status']})",
    ]
    if f.get("endgoal"):
        lines.append(f"  Endgoal: {f['endgoal']}")
    if f.get("due_date"):
        lines.append(f"  Due: {f['due_date'][:10]}")
    if f.get("scale"):
        lines.append(f"  Scale: {f['scale']}")
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


# ── Generic lists (backlog / todo / focus singletons + user-created lists) ───
#
# Singletons live in the `lists` table with unique types — `backlog`, `todo`,
# `focus`. Resolving by type avoids hard-coding numeric IDs that shift across
# DB rebuilds. Generic lists fall back to name match.


def _fetch_lists() -> list[dict]:
    resp = _session.get(f"{BASE_URL}/lists", timeout=10)
    resp.raise_for_status()
    return resp.json()


def _resolve_list(list_ref: str) -> tuple[dict | None, str | None]:
    """Resolve a list by type ('todo'/'focus'), name, or numeric id.

    `list_ref="backlog"` is REJECTED — backlog tickets were extracted
    out of `list_items` into a dedicated `backlog_tickets` table, so
    the legacy "Backlog" list_items row is empty. Callers must use the
    backlog-tickets surface instead: read_backlog, add_backlog_item,
    find_similar_backlog, complete_backlog_item, delete_backlog_item.
    """
    ref = (list_ref or "").strip()
    if not ref:
        return None, "(empty list reference)"
    if ref.lower() == "backlog":
        return None, (
            "(list_ref='backlog' is deprecated — backlog tickets live in "
            "their own table now. Use read_backlog / add_backlog_item / "
            "find_similar_backlog / complete_backlog_item / "
            "delete_backlog_item instead.)"
        )
    lists = _fetch_lists()
    # numeric id wins
    if ref.isdigit():
        target_id = int(ref)
        for lst in lists:
            if lst["id"] == target_id:
                return lst, None
        return None, f"(no list with id {target_id})"
    ref_l = ref.lower()
    # singleton type match (backlog/todo/focus)
    by_type = [lst for lst in lists if (lst.get("type") or "").lower() == ref_l]
    if len(by_type) == 1:
        return by_type[0], None
    if len(by_type) > 1:
        names = ", ".join(f"#{lst['id']} {lst['name']}" for lst in by_type)
        return None, f"(multiple lists with type '{ref}': {names})"
    # fall back to case-insensitive name match
    by_name = [lst for lst in lists if (lst.get("name") or "").lower() == ref_l]
    if len(by_name) == 1:
        return by_name[0], None
    if len(by_name) > 1:
        names = ", ".join(f"#{lst['id']} {lst['name']}" for lst in by_name)
        return None, f"(multiple lists named '{ref}': {names})"
    # last-resort substring on name
    sub = [lst for lst in lists if ref_l in (lst.get("name") or "").lower()]
    if len(sub) == 1:
        return sub[0], None
    if not sub:
        return None, f"(no list matching '{ref}')"
    names = ", ".join(f"#{lst['id']} {lst['name']}" for lst in sub)
    return None, f"(ambiguous list '{ref}'; candidates: {names})"


def _fetch_list_items(list_id: int) -> list[dict]:
    resp = _session.get(f"{BASE_URL}/lists/{list_id}", timeout=10)
    resp.raise_for_status()
    return resp.json().get("items", [])


def _find_list_item(
    list_id: int, match: str, unique: bool = False, only_open: bool = False
) -> tuple[dict | None, str | None]:
    """Substring match on item text within a list.

    `unique=True` refuses if 0 or >1 candidates (use for destructive ops).
    `unique=False` returns shortest-text match (most specific) — safe for
    non-destructive toggles like check_list_item.
    """
    match_l = (match or "").lower().strip()
    if not match_l:
        return None, "(empty match string)"
    items = _fetch_list_items(list_id)
    if only_open:
        items = [it for it in items if not it.get("done")]
    # Match text OR subtitle — backlog rows often store a short title in text
    # and an auto-generated "from note #N" or descriptor in subtitle, so
    # text-only match misses obvious references.
    candidates = [
        it for it in items
        if match_l in (it.get("text") or "").lower()
        or match_l in (it.get("subtitle") or "").lower()
    ]
    if not candidates:
        return None, f"(no item matching '{match}' in list #{list_id})"
    if unique and len(candidates) > 1:
        previews = "\n".join(
            f"  #{it['id']} {'[x]' if it['done'] else '[ ]'} {it['text']}"
            for it in candidates[:6]
        )
        return None, (
            f"(ambiguous: {len(candidates)} items match '{match}'. "
            f"Refine match string or call again with the exact text.\n{previews})"
        )
    candidates.sort(key=lambda it: len(it.get("text") or ""))
    return candidates[0], None


@mcp.tool()
def read_list(list_ref: str = "todo", limit: int = 50, include_done: bool = False) -> str:
    """Read items from a Gooni list — todo, focus, or any user-created list.

    For BACKLOG tickets, use `read_backlog` — backlog rows were
    extracted out of `list_items` into a dedicated table.

    Lists are looked up by type ('todo'/'focus') first, then by name,
    then by numeric id. Type-based lookup is the stable path: it survives DB
    rebuilds where ids shift.

    Args:
        list_ref: 'todo' (default), 'focus', a list name, or a numeric id.
            'backlog' is rejected — use read_backlog instead.
        limit: max items to return (default 50)
        include_done: include checked-off items (default False)
    """
    lst, err = _resolve_list(list_ref)
    if err:
        return err
    items = _fetch_list_items(lst["id"])
    if not include_done:
        items = [it for it in items if not it.get("done")]
    items = items[:limit]
    if not items:
        return f"(list #{lst['id']} '{lst['name']}' has no {'items' if include_done else 'open items'})"
    lines = [f"# {lst['name']} (list #{lst['id']}, type={lst['type']})"]
    for it in items:
        mark = "[x]" if it.get("done") else "[ ]"
        primary = " ★" if it.get("is_primary") else ""
        due = f" (due {it['due_date'][:10]})" if it.get("due_date") else ""
        sub = f" — {it['subtitle']}" if it.get("subtitle") else ""
        # Surface the linked source note so the caller can pull full context
        # via read_note() without an extra round trip — backlog items often
        # originate from a note discussion and that note is the richest
        # available context for "what does this item really mean."
        note_ref = f" [note #{it['source_note_id']}]" if it.get("source_note_id") else ""
        lines.append(f"#{it['id']} {mark}{primary} {it['text']}{sub}{due}{note_ref}")
    return "\n".join(lines)


@mcp.tool()
def add_list_item(
    text: str,
    list_ref: str = "todo",
    subtitle: str = None,
    skip_conflict_check: bool = False,
) -> str:
    """Add an item to a Gooni list.

    For BACKLOG tickets use `add_backlog_item` — backlog lives in its
    own table now. This tool only handles `list_items` rows (todo /
    focus singletons + user-created generic lists).

    Conflict detection is on by default: the backend cosine-searches existing
    items in the same list and surfaces near-duplicates. The item is still
    inserted — but the response flags any matches so you (or the user) can
    decide whether to merge or delete the new one. Pass
    `skip_conflict_check=True` for bulk imports / migrations.

    Args:
        text: item text (e.g. "spike WhatsApp business onboarding")
        list_ref: 'todo' (default), 'focus', name, or numeric id.
            'backlog' is rejected — use add_backlog_item instead.
        subtitle: optional secondary line shown under the item
        skip_conflict_check: bypass embed + dedup scan (default False)
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    lst, err = _resolve_list(list_ref)
    if err:
        return err
    body: dict = {"text": text}
    if subtitle:
        body["subtitle"] = subtitle
    if skip_conflict_check:
        body["skip_conflict_check"] = True
    resp = _session.post(f"{BASE_URL}/lists/{lst['id']}/items", json=body, timeout=20)
    resp.raise_for_status()
    it = resp.json()
    msg = f"added #{it['id']} to {lst['name']}: {it['text']}"
    conflicts = it.get("conflicts") or []
    if conflicts:
        msg += "\n\n⚠ near-duplicate(s) already in list:"
        for c in conflicts:
            sev = c.get("severity", "medium")
            sim = c.get("similarity", 0)
            msg += f"\n  [{sev} {sim:.2f}] #{c['id']} {c['text']}"
        msg += "\n(call delete_list_item or edit_list_item if this should be merged.)"
    return msg


@mcp.tool()
def find_similar_items(
    text: str,
    list_ref: str = "todo",
    threshold: float = 0.78,
    limit: int = 5,
    include_done: bool = False,
) -> str:
    """Cosine-search a Gooni list for items similar to `text` without
    inserting anything. Useful before adding to check if an idea already
    exists, or to find merge candidates among existing items.

    For BACKLOG search use `find_similar_backlog` — backlog rows live
    in a separate table.

    Args:
        text: query string
        list_ref: which list to search (default 'todo'). 'backlog' is
            rejected — use find_similar_backlog instead.
        threshold: minimum cosine similarity (0..1, default 0.78)
        limit: max matches to return (default 5)
        include_done: include checked-off items (default False)
    """
    text = (text or "").strip()
    if not text:
        return "(text required)"
    lst, err = _resolve_list(list_ref)
    if err:
        return err
    resp = _session.post(
        f"{BASE_URL}/lists/{lst['id']}/similar",
        json={
            "text": text,
            "threshold": float(threshold),
            "limit": int(limit),
            "include_done": bool(include_done),
        },
        timeout=20,
    )
    resp.raise_for_status()
    matches = resp.json().get("matches") or []
    if not matches:
        return f"(no items in {lst['name']} above similarity {threshold:.2f})"
    lines = [f"# similar to '{text}' in {lst['name']}:"]
    for m in matches:
        lines.append(f"[{m['similarity']:.2f}] #{m['id']} {m['text']}")
    return "\n".join(lines)


@mcp.tool()
def check_list_item(match: str, list_ref: str = "todo", done: bool = True) -> str:
    """Toggle a list item's done flag by text match (first-hit-wins, like claim_task).

    For BACKLOG tickets use `complete_backlog_item`.

    Args:
        match: substring of the item's text (case-insensitive)
        list_ref: which list to look in (default 'todo'). 'backlog' is
            rejected — use complete_backlog_item instead.
        done: True to check, False to uncheck
    """
    lst, err = _resolve_list(list_ref)
    if err:
        return err
    item, err = _find_list_item(lst["id"], match, unique=False, only_open=done)
    if err:
        return err
    resp = _session.patch(
        f"{BASE_URL}/list-items/{item['id']}", json={"done": bool(done)}, timeout=10
    )
    resp.raise_for_status()
    mark = "[x]" if done else "[ ]"
    return f"{mark} {item['text']} (in {lst['name']})"


@mcp.tool()
def delete_list_item(match: str, list_ref: str = "todo") -> str:
    """Delete a list item by text match. Refuses if the match is ambiguous —
    you must narrow it to exactly one item.

    For BACKLOG tickets use `delete_backlog_item`.

    Args:
        match: substring of the item's text (case-insensitive). Must hit exactly one item.
        list_ref: which list to look in (default 'todo'). 'backlog' is
            rejected — use delete_backlog_item instead.
    """
    lst, err = _resolve_list(list_ref)
    if err:
        return err
    item, err = _find_list_item(lst["id"], match, unique=True)
    if err:
        return err
    resp = _session.delete(f"{BASE_URL}/list-items/{item['id']}", timeout=10)
    resp.raise_for_status()
    return f"deleted #{item['id']} from {lst['name']}: {item['text']}"


# ── Notes: find + delete ─────────────────────────────────────────────────────


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
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'} — {snippet}")
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
def add_comment(note_id: int, content: str, author: str = "claude") -> str:
    """Add a Confluence-style comment to a note's thread.

    Use when reviewing or reacting to a note Daniel wrote — feedback,
    questions, follow-up thoughts that should hang off the note rather
    than spawn a new note. The bubble shows up under the editor body.

    Args:
        note_id: numeric id of the target note (get from find_note,
            list_recent_notes, search_notes, etc.)
        content: comment body (plain text or short HTML)
        author: label shown on the bubble (default "claude" — set to
            "gooni" if calling from the chat orchestrator instead)
    """
    if not isinstance(note_id, int) or note_id <= 0:
        return "(note_id must be a positive integer)"
    body = (content or "").strip()
    if not body:
        return "(content required)"
    resp = _session.post(
        f"{BASE_URL}/notes/{note_id}/comments",
        json={"content": body, "author": author},
        timeout=10,
    )
    if resp.status_code == 404:
        return f"(note #{note_id} not found)"
    resp.raise_for_status()
    c = resp.json()
    url = f"{FRONTEND_URL}/?note={note_id}"
    return f"posted comment #{c['id']} on note #{note_id} ({url})"


@mcp.tool()
def list_comments(note_id: int) -> str:
    """List comments on a note, oldest first.

    Args:
        note_id: numeric id of the note to read comments from
    """
    if not isinstance(note_id, int) or note_id <= 0:
        return "(note_id must be a positive integer)"
    resp = _session.get(f"{BASE_URL}/notes/{note_id}/comments", timeout=10)
    if resp.status_code == 404:
        return f"(note #{note_id} not found)"
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        return f"(no comments on note #{note_id})"
    lines = []
    for c in rows:
        ts = (c.get("created_at") or "")[:16].replace("T", " ")
        snippet = (c.get("content") or "")[:200].replace("\n", " ")
        lines.append(f"#{c['id']} [{c['author']} {ts}] {snippet}")
    return "\n".join(lines)


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


@mcp.tool()
def read_capability_facets(layer: str = "") -> str:
    """Read Gooni's capability inventory — what it can/can't do, grouped by
    layer (mechanical = tools+routes+channels; functional = composed
    capabilities; behavioral = patterns from reflection clustering;
    architectural = model/runtime/memory shape).

    Used by the /capability-audit slash command to inspect what's currently
    on record before proposing PR-time facet edits.

    Args:
        layer: optional layer filter ('mechanical' | 'functional' | 'behavioral' | 'architectural').
               Empty string returns all user-visible layers.
    """
    try:
        resp = _session.get(f"{BASE_URL}/capabilities", timeout=15)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        return f"(capabilities fetch failed: {exc})"
    by_layer = (resp.json() or {}).get("by_layer", {})
    target_layers = [layer] if layer else list(by_layer.keys())
    out = []
    for L in target_layers:
        rows = by_layer.get(L) or []
        out.append(f"## {L} ({len(rows)})")
        for r in rows:
            badge = f"[{r['status']}]"
            out.append(f"- {badge} {r['facet_key']} — {r['facet_text'][:160]}")
    return "\n".join(out) if out else "(no facets)"


@mcp.tool()
def update_capability_facet(
    facet_key: str,
    facet_text: str = "",
    status: str = "",
    layer: str = "",
) -> str:
    """Create or update one of Gooni's capability facets.

    Used by the /capability-audit skill to apply PR-derived edits, and by
    Claude Code when reviewing changes to tools/services. Idempotent on
    facet_key.

    Args:
        facet_key: stable slug (e.g. 'tool.add_note', 'functional.web_search').
        facet_text: new short description (required when creating).
        status: 'claimed' | 'verified' | 'unverified' | 'broken'.
        layer: 'mechanical' | 'functional' | 'behavioral' | 'architectural' (required when creating).
    """
    facet_key = (facet_key or "").strip()
    if not facet_key:
        return "facet_key required"

    # Look up existing first.
    try:
        resp = _session.get(f"{BASE_URL}/capabilities", timeout=15)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        return f"(capabilities fetch failed: {exc})"
    by_layer = (resp.json() or {}).get("by_layer", {})
    existing: dict | None = None
    for rows in by_layer.values():
        for r in rows:
            if r["facet_key"] == facet_key:
                existing = r
                break
        if existing:
            break

    if existing is None:
        if not facet_text or not layer:
            return (
                f"facet '{facet_key}' not found; provide both facet_text and "
                "layer to create it."
            )
        body = {
            "facet_key": facet_key,
            "facet_text": facet_text,
            "layer": layer,
        }
        if status:
            body["status"] = status
        try:
            r2 = _session.post(f"{BASE_URL}/capabilities", json=body, timeout=15)
            r2.raise_for_status()
        except httpx.HTTPError as exc:
            return f"(create failed: {exc})"
        return f"created facet '{facet_key}'"

    body = {}
    if facet_text:
        body["facet_text"] = facet_text
    if status:
        body["status"] = status
    if layer:
        body["layer"] = layer
    if not body:
        return f"no changes specified for '{facet_key}'"
    try:
        r3 = _session.patch(
            f"{BASE_URL}/capabilities/{existing['id']}", json=body, timeout=15
        )
        r3.raise_for_status()
    except httpx.HTTPError as exc:
        return f"(update failed: {exc})"
    return f"updated facet '{facet_key}': {', '.join(body.keys())}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
