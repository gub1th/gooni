"""Gooni's MCP surface: one tool module, one gateway seam, three entry points.

    tools.py    every tool implementation + the per-transport tool lists
    gateway.py  data access, two impls (in-process / over HTTP)

Entry points, all registering off `tools.ALL_TOOLS`:

    app/focus_mcp.py             → mounted at /mcp in the FastAPI app (claude.ai)
    mcp_servers/focus_server.py  → standalone streamable-HTTP on :8001 (local dev)
    mcp_servers/server.py        → stdio (Claude Code)

Deliberately NOT named `mcp/`: a top-level package by that name shadows the pip
`mcp` SDK whenever the repo root is on sys.path, which is always under
`uvicorn app.main:app`. That bug cost a rename in #461; don't reintroduce it.
"""
