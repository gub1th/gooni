"""Router modules, ordered by original main.py route appearance.

Slice 6 nuke removed: visits stays, lists/list_items/backlog/habits/
focuses/focus_candidates/todos/items/spaces/comments/reactions/dashboard/
capabilities are gone with their primitives.
"""

ROUTER_MODULES = [
    "visits",
    "public",
    "metrics",
    "trackables",
    "overlay",
    "auth",
    "misc",
    "chat",
    "speech",
    "webhooks",
    "settings",
    "notes",
    "promises",
    "uploads",
    "conversations",
    "activity",
    "health",
    "tool_calls",
    # "mcp" is GONE (2026-08-10): every route it declared sat under the `/mcp`
    # prefix that main.py mounts the Focus MCP connector on, so a Starlette
    # Mount shadowed all of them and they 404'd. Its live endpoints were
    # re-homed onto `/memories/*` (see routers/memories.py) and `/notes/search`.
    "memories",
    "eval",
    "whoop",
    "integrations",
    "reflections",
    "focus",
    "focus_cam",
    "browser_activity",
    "display",
]
