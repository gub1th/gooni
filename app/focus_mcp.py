"""In-process MCP server, mounted into the main FastAPI app at `/mcp`
(see app/main.py). This is the PROD path for the claude.ai custom connector:
deploying the main app to Fly ships a stable `https://gooni-bot.fly.dev/mcp`
endpoint, always-on, no tunnel.

It no longer defines any tools. Every tool lives once in
`app/mcp_surface/tools.py`; this module only picks a transport, a gateway, and a
tool subset. Before the convergence this file hand-maintained its own copy of
seven tools that `mcp_servers/focus_server.py` also implemented over httpx —
two code paths for one surface, which is how the schemas drifted in #458.

Gateway: `DirectGateway` — we are already inside the backend process, so tools
call the services against a DB session directly (no httpx, no Bearer hop).

Auth: the mounted `/mcp` endpoint is exempt from the app's Bearer middleware
(the claude.ai dialog offers only OAuth, no static-bearer field) — the tools
operate in-process, so there is no backend hop to authenticate. Authless by
design; access control is the obscure host + (later) OAuth.

Transport security: streamable-HTTP has DNS-rebinding protection that 421s any
non-localhost Host. Behind Fly's proxy the Host is the public app hostname, so
it is disabled by default (FOCUS_MCP_ALLOWED_HOSTS unset) — the endpoint is
deliberately public. Set FOCUS_MCP_ALLOWED_HOSTS to pin specific hosts.
"""

from __future__ import annotations

import os

# The pip `mcp` SDK, imported plainly. This used to need sys.path surgery: the
# repo had a top-level `mcp/` package directory that shadowed the SDK whenever
# the repo root was on sys.path (always, under `uvicorn app.main:app`). That
# directory is now `mcp_servers/`, so there is nothing left to shadow it.
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from .mcp_surface import tools
from .mcp_surface.gateway import DirectGateway

_allowed_hosts = [h.strip() for h in os.getenv("FOCUS_MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
if _allowed_hosts and _allowed_hosts != ["*"]:
    _transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_allowed_hosts + [f"{h}:443" for h in _allowed_hosts],
        allowed_origins=[f"https://{h}" for h in _allowed_hosts],
    )
else:
    # Default (and "*"): disable — the mounted endpoint is intentionally public.
    _transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)

# stateless_http=True: each request is self-contained (no persistent SSE session
# to keep alive), which is the right fit for a mounted sub-app and keeps the
# lifespan wiring simple. streamable_http_path="/" so mounting the sub-app at
# "/mcp" yields the external path exactly /mcp (no /mcp/mcp doubling).
mcp = FastMCP(
    "gooni",
    stateless_http=True,
    streamable_http_path="/",
    transport_security=_transport_security,
)

tools.bind(DirectGateway())
REGISTERED = tools.register(mcp, tools.REMOTE_TOOLS)

# Built once at import so main.py can mount it and wire its lifespan. The Starlette
# ASGI app serves the streamable-HTTP endpoint at the sub-app root ("/"), so it's
# mounted at "/mcp" in main.py. `session_manager` must be run inside the main app's
# lifespan (its task group backs every request).
http_app = mcp.streamable_http_app()
session_manager = mcp.session_manager
