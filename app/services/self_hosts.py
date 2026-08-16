"""Gooni's own hosts — browsing them is using the tool, not activity.

Single owner so the list can't drift between the "doing" fold
(`activity_context`) and the proactive layer's off-task GATE
(`proactive_service`) — both read the same `BrowserInterval.host` values and
both need the identical exclusion, or one surface would report gooni-sigma
as distraction while the other stayed quiet about it.
"""

SELF_HOSTS = frozenset(
    {
        "gooni-sigma.vercel.app",
        "gub1th.com",
        "www.gub1th.com",
        "localhost:5173",
        "localhost:8000",
        "gooni-bot.fly.dev",
    }
)


def is_self_host(host: str | None) -> bool:
    """Case-insensitive membership check against SELF_HOSTS."""
    if not host:
        return False
    return host.strip().lower() in SELF_HOSTS
