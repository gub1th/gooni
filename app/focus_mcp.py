"""In-process Focus MCP server, mounted into the main FastAPI app at `/mcp`
(see app/main.py). This is the PROD path for the claude.ai custom connector:
deploying the main app to Fly ships a stable `https://gooni-bot.fly.dev/mcp`
endpoint, always-on, no tunnel.

Distinct from the standalone `mcp_servers/focus_server.py`, which is the LOCAL-dev path
(run as a script + cloudflared tunnel). Same six tools, same descriptions — but
here the tools call `focus_service` DIRECTLY against a DB session (no httpx, no
Bearer round-trip), because we're already inside the backend process.

Auth: the mounted `/mcp` endpoint is exempt from the app's Bearer middleware
(the claude.ai dialog offers only OAuth, no static-bearer field) — the tools
operate in-process, so there's no backend hop to authenticate. The endpoint is
authless-by-design; access control is the obscure tunnel/host + (later) OAuth.

Transport security: streamable-HTTP has DNS-rebinding protection that 421s any
non-localhost Host. Behind Fly's proxy the Host is the public app hostname, so
we disable the check by default (FOCUS_MCP_ALLOWED_HOSTS unset) — the endpoint
is deliberately public. Set FOCUS_MCP_ALLOWED_HOSTS to pin specific hosts.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

# The pip `mcp` SDK, imported plainly. This used to need sys.path surgery: the
# repo had a top-level `mcp/` package directory that shadowed the SDK whenever
# the repo root was on sys.path (always, under `uvicorn app.main:app`). That
# directory is now `mcp_servers/`, so there is nothing left to shadow it.
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from .db.database import SessionLocal
from .services import focus_service

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
    "gooni-focus",
    stateless_http=True,
    streamable_http_path="/",
    transport_security=_transport_security,
)


def _parse_at(raw: str | None) -> datetime | None:
    """ISO-8601 string → the naive-UTC storage convention, or None.

    Offset-aware input converts to UTC BEFORE tzinfo is dropped, so a local
    offset stores the right instant rather than keeping its wall-clock digits
    (the same trap `routers/focus.py::_parse_due` documents). Unparseable input
    returns None — a bad timestamp should downgrade to "now", not lose the
    thought.
    """
    if not raw or not str(raw).strip():
        return None
    try:
        dt = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        print(f"[focus_mcp] unparseable at={raw!r} — stamping now instead")
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(tzinfo=None)


@mcp.tool()
def log_thought(
    content: str,
    topic: str,
    new_batch: bool = False,
    label: str | None = None,
    at: str | None = None,
) -> dict:
    """Capture a single thought, idea, or observation into Gooni under a subject.
    THIS IS THE DEFAULT ACTION whenever Daniel shares something worth remembering
    that is NOT a future to-do — a reflection, an idea, a decision, a realization,
    a note about a person or project. When in doubt between capturing and setting a
    reminder, capture here; use set_reminder ONLY for a future obligation.

    `topic` is the subject line these thoughts group under (e.g. "job search",
    "focus cam", "climbing"). Reuse an existing topic name from list_topics when
    one fits — matching is case-insensitive; an unknown name auto-creates the
    topic, so never call create_topic just to log. Set `new_batch=true` to force a
    fresh thinking-run when the subject clearly turns even within the same ~30-min
    window (otherwise consecutive thoughts on a topic merge into one batch).

    `label` is a SHORT THIRD-PERSON SENTENCE summarizing this batch as it reads on
    Daniel's timeline — refer to Daniel as "Gooni". E.g. "Gooni decided the store
    should stay dumb.", "Gooni is losing 6-7 to Curtis in smash.", "Gooni promised
    not to smoke till Tuesday." It's the card the timeline renders, so write a real
    sentence (not a topic label), and re-send an updated one whenever the batch
    meaningfully advances — it OVERWRITES the batch's rendered card. Omit to keep
    the prior label / an auto-snippet of the content.

    `at` BACKDATES the thought to when it actually happened — ISO-8601, and pass
    UTC with an explicit "+00:00" offset (e.g. "2026-08-07T09:00:00+00:00"). Omit
    it and the thought is stamped now, which is right for anything happening in
    the moment. Use it when you're recording something from earlier in the
    conversation or the day: a 1am study session logged at noon should read 1am.
    Logging close to real time still beats backdating a guess.

    Returns {thought:{id,content,timestamp}, batch:{id,label,topic_id},
    topic:{...decayed salience + growth...}} — the topic's salience_decayed is
    bumped by this write. Use the returned thought.id as `from_thought` if the same
    message also creates a reminder.
    """
    db = SessionLocal()
    try:
        result = focus_service.log_thought(
            db,
            content=content,
            topic_name=topic,
            new_batch=new_batch,
            label=label,
            at=_parse_at(at),
        )
        db.commit()
        return result
    finally:
        db.close()


@mcp.tool()
def list_topics() -> list:
    """The current salience landscape: every topic ranked hottest-first by decayed
    salience. Call this to see WHAT IS TOP OF MIND RIGHT NOW, to pick the correct
    existing `topic` name before log_thought, or to answer "what have I been
    focused on lately." Salience decays with time-since-last-touched and bumps on
    every logged thought, so this is a live "recency × frequency" ranking, not a
    catalogue.

    Use this for the landscape; use query_thoughts to read the actual thoughts
    inside a topic. Returns a list of
    {id,name,parent_id,color,salience_stored,salience_decayed,last_touched,growth}
    — `salience_decayed` drives the ranking and `growth=true` flags a topic
    touched within the recent growth window (heating up).
    """
    db = SessionLocal()
    try:
        return focus_service.list_topics(db)
    finally:
        db.close()


@mcp.tool()
def create_topic(name: str, parent: str | None = None) -> dict:
    """Explicitly create a topic (optionally nested under a `parent` topic name for
    a subtopic). ONLY call this when Daniel is deliberately ORGANIZING his subjects
    — e.g. "make a topic called X" or "put Y under Z". For ordinary capture do NOT
    use this: log_thought auto-creates any unknown topic on the fly, so reaching
    here first is almost always wrong. If you just want to record a thought, call
    log_thought directly.

    Returns {id,name,parent_id,color,salience}.
    """
    db = SessionLocal()
    try:
        topic = focus_service.create_topic(db, name=name, parent=parent)
        db.commit()
        return {
            "id": topic.id,
            "name": topic.name,
            "parent_id": topic.parent_id,
            "color": topic.color,
            "salience": topic.salience,
        }
    finally:
        db.close()


@mcp.tool()
def query_thoughts(
    topic: str | None = None,
    since: str | None = None,
    text: str | None = None,
) -> list:
    """Retrieve PAST thoughts, newest-first. Call this to recall what Daniel
    previously said — "what did I think about X", "what have I logged this week",
    "did I ever mention Y". Filters combine (AND):
      - `topic`: restrict to one subject (exact name, case-insensitive)
      - `since`: ISO date "YYYY-MM-DD" — only thoughts on or after that day
      - `text`: case-insensitive substring match on thought content
    All optional; with none it returns the most recent thoughts across every topic.

    This reads the thoughts themselves — use list_topics instead when you only need
    the ranked landscape of subjects, not their contents. Returns a list of
    {id,content,timestamp,topic,batch_id,batch_label}.
    """
    from datetime import datetime

    from .common import _parse_iso_date

    since_dt = None
    if since:
        d = _parse_iso_date(since)
        if d is not None:
            since_dt = datetime(d.year, d.month, d.day)
    db = SessionLocal()
    try:
        return focus_service.query_thoughts(db, topic=topic, since=since_dt, text=text)
    finally:
        db.close()


@mcp.tool()
def set_reminder(
    content: str,
    due_at: str | None = None,
    owed_to: str | None = None,
    from_thought: int | None = None,
    is_promise: bool = False,
) -> dict:
    """Record a FUTURE OBLIGATION — a to-do, a thing to follow up on, or a promise.
    Reach here (NOT log_thought) whenever the message is forward-looking: "remind
    me to…", "I need to…", "don't let me forget…", "I owe X…", "I'll get back to Y
    about…". Thoughts are things Daniel HAS thought; reminders are things he still
    HAS TO DO.

    Every row carries the said-vs-done lifecycle (active → kept | broken) — that
    is not something you opt into. `owed_to` is the ONE input that changes the
    returned `type`: pass a person's name when the obligation is owed to someone
    ("I owe Yash the deck") → typed 'promise', surfaces by age; leave it off for
    a commitment to yourself ("I won't smoke till Tuesday") → typed 'reminder',
    with the same lifecycle.

      - `is_promise`: ACCEPTED BUT INERT. It is kept only so existing callers
        don't break. Since the 2026-08-08 convergence every row lives in
        `promises` and `type` is derived from `owed_to`, so passing this changes
        nothing about what is stored or returned. Don't reach for it to make
        something "count" as a promise — it already does.

    `due_at` is an ISO-8601 datetime; many promises have no due date and that is
    fine (they surface by age). A dated promise auto-breaks when its deadline
    passes. `from_thought` is the id returned by a log_thought call in the same
    message, linking the reminder to the thought that spawned it.

    Returns the reminder dict {id,type,content,owed_to,due_at,done,state,
    resolved_at,age_days,lasted_days,thought_id} where type is 'reminder' or
    'promise' and state is 'active' | 'kept' | 'broken'.
    """
    from datetime import datetime, timezone

    due_dt = None
    if due_at:
        try:
            _dt = datetime.fromisoformat(str(due_at).replace("Z", "+00:00"))
            # Aware input → convert to UTC before dropping tzinfo (the column is
            # naive-UTC); naive input is assumed already-UTC. Skipping the
            # astimezone made a local-offset time land hours off.
            if _dt.tzinfo is not None:
                _dt = _dt.astimezone(timezone.utc)
            due_dt = _dt.replace(tzinfo=None)
        except (ValueError, TypeError):
            due_dt = None
    db = SessionLocal()
    try:
        result = focus_service.set_reminder(
            db,
            content=content,
            due_at=due_dt,
            owed_to=owed_to,
            from_thought=from_thought,
            is_promise=is_promise,
        )
        db.commit()
        return result
    finally:
        db.close()


@mcp.tool()
def set_reminder_state(reminder_id: int, state: str) -> dict:
    """Resolve a promise (or reminder) — the SAID-VS-DONE close. `state` is one of
    'kept' (fulfilled — you did the thing), 'broken' (you didn't — you smoked, the
    resolution failed), or 'active' (reopen). Reach here the MOMENT a commitment's
    fate is known: if Daniel says he smoked after promising not to, break the
    matching promise NOW rather than leaving it standing. Find the id via
    list_reminders. Broken/kept stamp the resolution time, which the dashboard
    renders as how long the promise lasted (created → resolved) in the warn colour.
    There is no delete — resolve, don't remove.

    Returns the updated reminder dict, or raises if the id is unknown.
    """
    db = SessionLocal()
    try:
        result = focus_service.set_reminder_state(db, reminder_id, state)
        if result is None:
            raise ValueError(f"no reminder with id {reminder_id}")
        db.commit()
        return result
    finally:
        db.close()


@mcp.tool()
def list_reminders(day: str | None = None) -> list:
    """List open (not-yet-done) reminders and promises — what Daniel still owes.
    Call this for "what's on my plate", "what am I forgetting", "what do I owe
    people". `day` optionally scopes DATED reminders to one day: pass the literal
    "today" or an ISO date "YYYY-MM-DD"; undated promises always pass through
    regardless of `day` (they surface by age, not time). Omit `day` for everything
    open.

    Ordering: dated items by due time first, then undated promises oldest-first.
    Returns a list of {id,type,content,owed_to,due_at,done,age_days,thought_id};
    `type='promise'` rows carry an `owed_to` name and lean on `age_days`.
    """
    from datetime import datetime

    from .common import _parse_iso_date, local_today

    db = SessionLocal()
    try:
        day_dt = None
        if day == "today":
            day_dt = datetime.combine(local_today(db), datetime.min.time())
        elif day:
            d = _parse_iso_date(day)
            if d is not None:
                day_dt = datetime(d.year, d.month, d.day)
        return focus_service.list_reminders(db, day=day_dt)
    finally:
        db.close()


# Built once at import so main.py can mount it and wire its lifespan. The Starlette
# ASGI app serves the streamable-HTTP endpoint at the sub-app root ("/"), so it's
# mounted at "/mcp" in main.py. `session_manager` must be run inside the main app's
# lifespan (its task group backs every request).
http_app = mcp.streamable_http_app()
session_manager = mcp.session_manager
