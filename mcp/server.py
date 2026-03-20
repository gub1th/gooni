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
    preferences + active goals only.

    Args:
        query: optional topic to search relevant memories for
    """
    resp = httpx.get(f"{BASE_URL}/mcp/context", params={"q": query}, timeout=10)
    resp.raise_for_status()
    return resp.json()["context"] or "(no memories yet)"


@mcp.tool()
def add_memory(key: str, content: str, type: str = "fact") -> str:
    """Store a new memory about the user in Gooni.

    Args:
        key: snake_case identifier (e.g. "current_project", "preferred_language")
        content: the full memory sentence (e.g. "Currently building an MCP server in Python")
        type: "fact" (default) or "preference" (how they want Gooni to behave)
    """
    resp = httpx.post(
        f"{BASE_URL}/mcp/memories",
        json={"key": key, "content": content, "type": type},
        timeout=10,
    )
    resp.raise_for_status()
    m = resp.json()
    return f"Saved: [{m['type']}] {m['key']} = {m['content']}"


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
    return "\n".join(
        f"[{m['type']}] {m['key']}: {m['content']}" for m in memories
    )


@mcp.tool()
def edit_memory(key: str, content: str) -> str:
    """Update an existing memory's content in Gooni.

    Args:
        key: the memory key to update (e.g. "current_project")
        content: the new content to replace the old value
    """
    resp = httpx.patch(
        f"{BASE_URL}/mcp/memories/{key}",
        json={"content": content},
        timeout=10,
    )
    resp.raise_for_status()
    m = resp.json()
    return f"Updated: {m['key']} = {m['content']}"


@mcp.tool()
def forget_memory(key: str) -> str:
    """Remove a memory from Gooni (soft-delete — recoverable from DB if needed).

    Args:
        key: the memory key to delete
    """
    resp = httpx.delete(f"{BASE_URL}/mcp/memories/{key}", timeout=10)
    resp.raise_for_status()
    return f"Forgotten: {key}"


@mcp.tool()
def add_note(title: str, content: str) -> str:
    """Create a new note in Gooni.

    Args:
        title: short note title
        content: note body (plain text)
    """
    resp = httpx.post(
        f"{BASE_URL}/notes",
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
