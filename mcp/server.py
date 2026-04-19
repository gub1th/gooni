#!/usr/bin/env python3
"""Gooni MCP server — exposes Gooni's memory and notes to Claude Code via stdio."""

import os

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.getenv("GOONI_URL", "http://localhost:8000")

mcp = FastMCP("gooni")


@mcp.tool()
def get_context(query: str = "") -> str:
    """Get relevant memory context from Gooni — user facts, preferences, and past episodes.

    Call this at the start of a conversation to understand what Gooni knows about the user.
    Pass a query string to get semantically relevant memories, or leave empty for
    preferences only.

    Args:
        query: optional topic to search relevant memories for
    """
    resp = httpx.get(f"{BASE_URL}/mcp/context", params={"q": query}, timeout=10)
    resp.raise_for_status()
    return resp.json()["context"] or "(no memories yet)"


@mcp.tool()
def add_memory(content: str) -> str:
    """Store a new memory about the user in Gooni.

    Args:
        content: the full memory sentence (e.g. "Currently building an MCP server in Python")
    """
    resp = httpx.post(
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
    resp = httpx.get(
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
    resp = httpx.patch(
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
    resp = httpx.delete(f"{BASE_URL}/mcp/memories/{memory_id}", timeout=10)
    resp.raise_for_status()
    return f"Forgotten: {memory_id}"


@mcp.tool()
def add_note(title: str, content: str) -> str:
    """Create a new note in Gooni.

    Args:
        title: short note title
        content: note body (plain text)
    """
    resp = httpx.post(
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
    resp = httpx.get(
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
    resp = httpx.patch(f"{BASE_URL}/notes/{note_id}", json=patch, timeout=10)
    resp.raise_for_status()
    n = resp.json()
    return f"Updated note #{n['id']}: {n['title']}"


@mcp.tool()
def list_spaces() -> str:
    """List all spaces in Gooni.

    Use this to know where notes are organized before creating or searching.
    """
    resp = httpx.get(f"{BASE_URL}/spaces", timeout=10)
    resp.raise_for_status()
    spaces = resp.json()
    if not spaces:
        return "(no spaces yet)"
    return "\n".join(f"#{s['id']} {s.get('emoji') or ''} {s['name']}".strip() for s in spaces)


@mcp.tool()
def list_notes(space_id: str = "general", limit: int = 20) -> str:
    """List notes in a space. Use 'general' for all notes.

    Args:
        space_id: numeric space ID or 'general' for all notes
        limit: max notes to return (default 20)
    """
    resp = httpx.get(f"{BASE_URL}/spaces/{space_id}/notes", timeout=10)
    resp.raise_for_status()
    notes = resp.json()[:limit]
    if not notes:
        return "(no notes)"
    lines = []
    for n in notes:
        snippet = (n.get("content") or "")[:80].replace("\n", " ")
        lines.append(f"#{n['id']} {n['title'] or '(untitled)'} — {snippet}")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run(transport="stdio")
