#!/usr/bin/env python3
"""Gooni MCP server, standalone streamable-HTTP — the LOCAL-DEV stand-in for the
`/mcp` mount inside the app (app/focus_mcp.py), for iterating behind a
cloudflared tunnel before a Fly deploy exists.

It no longer defines any tools. Every tool lives once in
`app/mcp_surface/tools.py`; this module picks a transport, a gateway, and a tool
subset. Before the convergence it hand-maintained httpx copies of the same seven
tools `app/focus_mcp.py` implemented in-process — the duplication behind #458's
schema drift.

Gateway: `HttpGateway`. This is a separate process from the backend, so it goes
over HTTP like any other client (and `GOONI_URL` may legitimately point at prod).

Run locally (streamable HTTP on :8001 by default):

    # from the repo root:
    GOONI_URL=http://localhost:8000 \
    GOONI_AUTH_PASSWORD=... \
    FOCUS_MCP_PORT=8001 \
    python mcp_servers/focus_server.py

Config:
  - GOONI_URL            backend base URL (default http://localhost:8000)
  - GOONI_AUTH_PASSWORD  → sha256 → Bearer on every request (matches the
                          backend's password-gated auth middleware); unset = no
                          header (works against an unauthenticated dev backend)
  - FOCUS_MCP_HOST / FOCUS_MCP_PORT   bind address for the HTTP transport
  - FOCUS_MCP_ALLOWED_HOSTS           DNS-rebinding allowlist; "*" disables

Public exposure (a cloudflare tunnel / Fly deploy over HTTPS) and adding the
resulting URL as a custom connector at claude.ai are Daniel's manual steps.
"""

import os
import sys

# Repo root on sys.path so `app.mcp_surface` imports when this file is run as a
# script (Python puts the SCRIPT's directory on the path, not the repo root).
# Safe post-#461: the shadowing top-level `mcp/` package is now `mcp_servers/`,
# so the pip `mcp` SDK still resolves from site-packages.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server.fastmcp import FastMCP  # noqa: E402

from app.mcp_surface import tools  # noqa: E402
from app.mcp_surface.gateway import build_http_gateway  # noqa: E402

# DNS-rebinding protection: the streamable-HTTP transport rejects any request
# whose Host header isn't in allowed_hosts (default: localhost only) with a 421.
# Behind a tunnel, the inbound Host is the PUBLIC hostname (e.g.
# <sub>.trycloudflare.com), so it must be allowlisted or the connector's probes
# 421 before a session opens. The sentinel "*" disables the protection entirely —
# acceptable here because the server is DELIBERATELY public behind the tunnel,
# and a rotating quick-tunnel URL makes a strict allowlist impractical. Leave
# unset for pure-local use (localhost stays trusted).
_allowed_hosts = [h.strip() for h in os.getenv("FOCUS_MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
_transport_security = None
if _allowed_hosts == ["*"]:
    from mcp.server.transport_security import TransportSecuritySettings

    _transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
elif _allowed_hosts:
    from mcp.server.transport_security import TransportSecuritySettings

    _transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_allowed_hosts + [f"{h}:443" for h in _allowed_hosts],
        allowed_origins=[f"https://{h}" for h in _allowed_hosts],
    )

mcp = FastMCP(
    "gooni",
    host=os.getenv("FOCUS_MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("FOCUS_MCP_PORT", "8001")),
    transport_security=_transport_security,
)

tools.bind(build_http_gateway("mcp-local"))
REGISTERED = tools.register(mcp, tools.LOCAL_HTTP_TOOLS)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
