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
    "mcp",
    "memories",
    "eval",
    "whoop",
    "integrations",
    "reflections",
]
