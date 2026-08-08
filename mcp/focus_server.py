#!/usr/bin/env python3
"""Gooni Focus MCP server — the six-tool "focus system" surface, exposed to a
Claude conversation as a REMOTE (streamable-HTTP) custom connector.

This is deliberately small: six tools, not thirty. It wraps the already-live
`/focus/*` backend contract (see app/routers/focus.py) so a Claude chat can log
thoughts under decaying topics, retrieve them, and set reminders/promises. The
legacy 30-tool local stdio server (mcp/server.py) is untouched and unrelated.

Run locally (streamable HTTP on :8001 by default):

    # from the repo root — run as a script so the installed `mcp` package
    # wins over this local `mcp/` directory:
    GOONI_URL=http://localhost:8000 \
    GOONI_AUTH_PASSWORD=... \
    FOCUS_MCP_PORT=8001 \
    python mcp/focus_server.py

Config comes from the SAME env vars the legacy server uses:
  - GOONI_URL            backend base URL (default http://localhost:8000)
  - GOONI_AUTH_PASSWORD  → sha256 → Bearer token on every request (matches the
                          backend's password-gated auth middleware); unset = no
                          header (works against an unauthenticated dev backend)
Focus-server-only knobs:
  - FOCUS_MCP_HOST / FOCUS_MCP_PORT   bind address for the HTTP transport

Public exposure (a cloudflare tunnel / Fly deploy over HTTPS) and adding the
resulting URL as a custom connector at claude.ai are Daniel's manual steps —
this module only serves the MCP endpoint locally.
"""

import hashlib
import os

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.getenv("GOONI_URL", "http://localhost:8000")

# Prod has password-gated auth (see app/main.py auth_middleware). Derive the
# stable bearer token from the password locally — same scheme as mcp/server.py —
# and attach it to every outgoing request via a default-header httpx.Client.
# Unset GOONI_AUTH_PASSWORD (unauthenticated dev) → header omitted, backend lets
# the request through.
_AUTH_PASSWORD = os.getenv("GOONI_AUTH_PASSWORD", "").strip()
# Tag outbound traffic so the backend can distinguish focus-connector calls from
# browser traffic and the legacy MCP server ("mcp"). Free-form logging tag.
_session_headers: dict[str, str] = {"X-Gooni-Source": "mcp-focus"}
if _AUTH_PASSWORD:
    _token = hashlib.sha256(_AUTH_PASSWORD.encode()).hexdigest()
    _session_headers["Authorization"] = f"Bearer {_token}"

_session = httpx.Client(headers=_session_headers, timeout=15)

# DNS-rebinding protection: the streamable-HTTP transport rejects any request
# whose Host header isn't in allowed_hosts (default: localhost only) with a 421.
# Behind a tunnel, the inbound Host is the PUBLIC hostname (e.g.
# <sub>.trycloudflare.com), so it must be allowlisted or the connector's probes
# 421 before a session opens. Configure via FOCUS_MCP_ALLOWED_HOSTS
# (comma-separated hostnames); the sentinel "*" disables the protection entirely
# — acceptable here because the server is DELIBERATELY public behind the tunnel
# (rebinding protection guards localhost-only servers from browser attacks; a
# public tunnel URL that rotates makes a strict allowlist impractical). Leave
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

# host/port only matter for the streamable-HTTP transport (remote connector).
mcp = FastMCP(
    "gooni-focus",
    host=os.getenv("FOCUS_MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("FOCUS_MCP_PORT", "8001")),
    transport_security=_transport_security,
)


def _get(path: str, params: dict | None = None):
    """GET {BASE_URL}{path}. Raises httpx.HTTPError on a non-2xx response."""
    resp = _session.get(f"{BASE_URL}{path}", params=params or {})
    resp.raise_for_status()
    return resp.json()


def _post(path: str, body: dict):
    """POST json to {BASE_URL}{path}. Raises httpx.HTTPError on non-2xx."""
    resp = _session.post(f"{BASE_URL}{path}", json=body)
    resp.raise_for_status()
    return resp.json()


def _patch(path: str, body: dict):
    """PATCH json to {BASE_URL}{path}. Raises httpx.HTTPError on non-2xx."""
    resp = _session.patch(f"{BASE_URL}{path}", json=body)
    resp.raise_for_status()
    return resp.json()


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
    return _post(
        "/focus/thoughts",
        {
            "content": content,
            "topic": topic,
            "new_batch": new_batch,
            "label": label,
            "at": at,
        },
    )


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
    return _get("/focus/topics")


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
    return _post("/focus/topics", {"name": name, "parent": parent})


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
    params: dict = {}
    if topic is not None:
        params["topic"] = topic
    if since is not None:
        params["since"] = since
    if text is not None:
        params["text"] = text
    return _get("/focus/thoughts", params)


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

    Two flags decide PROMISE vs reminder — a promise is a COMMITMENT that carries
    the said-vs-done lifecycle (active → kept | broken):
      - `owed_to`: a person's name when owed to someone ("I owe Yash the deck").
      - `is_promise=true`: mark a commitment owed to YOURSELF as a promise ("I
        won't smoke till Tuesday"), so it lands in the said-vs-done section
        instead of collapsing into an undated reminder.
    `due_at` is an ISO-8601 datetime; a dated promise auto-breaks when its
    deadline passes. `from_thought` links the reminder to the thought that
    spawned it.

    Returns the reminder dict {id,type,content,owed_to,due_at,done,state,
    resolved_at,age_days,lasted_days,thought_id}.
    """
    body: dict = {"content": content}
    if due_at is not None:
        body["due_at"] = due_at
    if owed_to is not None:
        body["owed_to"] = owed_to
    if from_thought is not None:
        body["from_thought"] = from_thought
    if is_promise:
        body["is_promise"] = True
    return _post("/focus/reminders", body)


@mcp.tool()
def set_reminder_state(reminder_id: int, state: str) -> dict:
    """Resolve a promise (or reminder) — the SAID-VS-DONE close. `state` is one of
    'kept' (fulfilled), 'broken' (failed — you smoked, the resolution slipped), or
    'active' (reopen). Reach here the MOMENT a commitment's fate is known: if
    Daniel says he smoked after promising not to, break the matching promise NOW.
    Find the id via list_reminders. Broken/kept stamp the resolution time, which
    the dashboard renders as how long the promise lasted (created → resolved). No
    delete — resolve, don't remove.

    Returns the updated reminder dict.
    """
    return _patch(f"/focus/reminders/{reminder_id}", {"state": state})


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
    params: dict = {}
    if day is not None:
        params["day"] = day
    return _get("/focus/reminders", params)


if __name__ == "__main__":
    # Remote connector transport. Public exposure + claude.ai registration are
    # Daniel's manual steps (see the module docstring).
    mcp.run(transport="streamable-http")
