#!/usr/bin/env python3
"""Gooni MCP server over stdio — the Claude Code entry point.

It no longer defines any tools. Every tool lives once in
`app/mcp_surface/tools.py`; this module picks a transport, a gateway, and a tool
subset. It used to hand-maintain 25 tool implementations of its own, six of which
had been silently 404ing for months (they called `/mcp/*` paths that the app's
`/mcp` mount shadows — see the audit in the convergence PR).

Gateway: `HttpGateway`. This process runs on Daniel's LAPTOP, normally against
PROD (`GOONI_URL=https://gooni-bot.fly.dev`, see `.mcp.json.example`). That is
why the gateway seam exists: prod's SQLite sits on a Fly volume with no route
from here, so calling the services directly would silently redirect every write
into a local database file — writes that look successful and land where nothing
reads them.

Config:
  - GOONI_URL            backend base URL (default http://localhost:8000)
  - GOONI_AUTH_PASSWORD  → sha256 → Bearer on every request; unset = no header
  - GOONI_FRONTEND_URL   unused here now (deep links moved into the tool layer)

Register with:
    claude mcp add gooni -- /path/to/venv/bin/python /path/to/mcp_servers/server.py
"""

import os
import sys

# Repo root on sys.path so `app.mcp_surface` imports when this file is run as a
# script (Python puts the SCRIPT's directory on the path, not the repo root).
# Safe post-#461: the shadowing top-level `mcp/` package is now `mcp_servers/`,
# so the pip `mcp` SDK still resolves from site-packages. `tests/test_imports.py`
# guards that.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server.fastmcp import FastMCP  # noqa: E402

from app.mcp_surface import tools  # noqa: E402
from app.mcp_surface.gateway import build_http_gateway  # noqa: E402

mcp = FastMCP("gooni")

tools.bind(build_http_gateway())
REGISTERED = tools.register(mcp, tools.STDIO_TOOLS)


if __name__ == "__main__":
    mcp.run()
