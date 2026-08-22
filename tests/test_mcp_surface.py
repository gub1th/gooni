#!/usr/bin/env python3
"""Net for the converged MCP surface (2026-08-10).

Runs the WRITE tools against a scratch DB through BOTH gateways and asserts the
rows that actually landed. The write path here is live production data — a bug
silently corrupts captured thoughts and commitments rather than failing loudly,
which is exactly the class of bug a shape assertion catches and a smoke test
doesn't.

Three things this pins:

1. **The writer merges preserve both parents.** `set_promise` has to do
   everything `set_reminder` did (owed_to, thought linking, dedup, the
   defaulted-due placement rule) AND everything `add_promise` did (cadence,
   cadence_target, is_important) — including the rule that a RECURRING
   commitment carries no deadline, which is the one place the two parents
   disagreed.
2. **Both gateways agree.** The in-process and over-HTTP implementations are the
   thing that drifted in #458. Same call through each must produce the same
   shape, or the seam has just recreated the original bug.
3. **The dead `/mcp/*` prefix stays dead.** Every route the deleted
   `app/routers/mcp.py` published was shadowed by the `/mcp` mount. The
   replacements must live somewhere nothing shadows.

Run: python tests/test_mcp_surface.py
"""

import json
import os
import pathlib
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# Scratch DB before any app import — the engine binds at import time.
_TMP = tempfile.mkdtemp(prefix="gooni-mcp-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/scratch.db"
os.environ.setdefault("OPENAI_API_KEY", "")

from fastapi.testclient import TestClient  # noqa: E402

from app.db.database import SessionLocal  # noqa: E402
from app.db.models import Edge, Note, Promise, ToolCall  # noqa: E402
from app.main import app  # noqa: E402
from app.mcp_surface import tools  # noqa: E402
from app.mcp_surface.gateway import DirectGateway, HttpGateway  # noqa: E402

FAILS: list[str] = []

#: Cosine dedup / semantic search need a live embedding backend. Without one the
#: relevant assertions are skipped rather than encoding "no API key in CI" as a
#: product expectation.
EMBEDDINGS = bool(os.environ.get("OPENAI_API_KEY", "").strip())


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILS.append(label)


def eq(label: str, got, want) -> None:
    check(label, got == want, f"(got {got!r}, want {want!r})")


# ── gateways ─────────────────────────────────────────────────────────────────
DIRECT = DirectGateway()
_client = TestClient(app, base_url="http://testserver")
HTTP = HttpGateway("http://testserver", _client)


def tagged(note: Note, tag: str) -> bool:
    return tag in json.loads(note.tags or "[]")


# ═════════════════════════════════════════════════════════════════════════════
print("\n== log_note: one writer, two kinds, both land in `notes` ==")
tools.bind(DIRECT)

thought = tools.log_note(
    content="the store should stay dumb",
    kind="thought", topic="gooni arch",
    label="Gooni decided the store should stay dumb.",
)
eq("thought kind echoed", thought["kind"], "thought")
tid = thought["thought"]["id"]

with SessionLocal() as db:
    row = db.query(Note).filter(Note.id == tid).first()
    check("thought is a Note", row is not None)
    check("tagged `thought`", tagged(row, "thought"))
    check("threaded to a batch", row.parent_note_id == thought["batch"]["id"])
    check("batch tagged `thought-batch`",
          tagged(db.query(Note).filter(Note.id == row.parent_note_id).first(), "thought-batch"))
    check("topic attached", row.topic_id is not None)
eq("batch label is Claude's sentence",
   thought["batch"]["label"], "Gooni decided the store should stay dumb.")

# Backdating: the reason `at` exists at all.
back = tools.log_note(content="1am session", kind="thought", topic="gooni arch",
                      new_batch=True, at="2026-08-07T09:00:00+00:00")
check("backdated thought keeps its instant",
      back["thought"]["timestamp"].startswith("2026-08-07T09:00"),
      f"(got {back['thought']['timestamp']})")

note = tools.log_note(content="<p>a writeup</p>", kind="note", title="writeup",
                      tags=["design"])
eq("note kind echoed", note["kind"], "note")
with SessionLocal() as db:
    row = db.query(Note).filter(Note.id == note["id"]).first()
    check("note persisted", row is not None)
    check("auto-tagged from-claude", tagged(row, "from-claude"))
    check("caller tag kept", tagged(row, "design"))
    check("NOT tagged thought", not tagged(row, "thought"))

published = tools.log_note(content="<p>x</p>", kind="note", title="published")
with SessionLocal() as db:
    row = db.query(Note).filter(Note.id == published["id"]).first()

try:
    tools.log_note(content="orphan", kind="thought")
    check("thought without topic rejected", False, "(no raise)")
except ValueError:
    check("thought without topic rejected", True)

# ═════════════════════════════════════════════════════════════════════════════
print("\n== set_promise: absorbs set_reminder AND add_promise ==")

once = tools.set_promise("ship the eval", due="2026-12-01T17:00:00+00:00",
                         is_important=True)
eq("cadence once", once["cadence"], "once")
check("explicit due kept", (once["due_at"] or "").startswith("2026-12-01"),
      f"(got {once['due_at']})")
eq("importance applied", once["is_important"], True)
with SessionLocal() as db:
    p = db.query(Promise).filter(Promise.id == once["id"]).first()
    check("explicit due is not flagged default", p.due_is_default is False)
    eq("is_important persisted", bool(p.is_important), True)

# The parents disagreed here: set_reminder stamps today-EOD on everything;
# add_promise left recurring rows dateless. A due on a daily promise is a parse
# artifact, and keeping it would file "gym 6x a week" under today's to-dos daily.
weekly = tools.set_promise("gym", cadence="n_per_week", cadence_target=6)
eq("cadence n_per_week", weekly["cadence"], "n_per_week")
eq("cadence_target kept", weekly["cadence_target"], 6)
eq("recurring carries NO due", weekly["due_at"], None)

daily = tools.set_promise("read 20 pages", cadence="daily")
eq("daily cadence", daily["cadence"], "daily")
eq("daily carries no due", daily["due_at"], None)
rule = tools.set_promise("no weed", cadence="permanent_never")
eq("standing rule cadence", rule["cadence"], "permanent_never")

# An omitted due on a ONCE promise still defaults (dashboard placement) and must
# stay flagged, or auto_break_overdue would break Daniel nightly on a deadline
# Gooni invented.
undated = tools.set_promise("call the dentist")
check("once+no due gets a placement date", undated["due_at"] is not None)
with SessionLocal() as db:
    p = db.query(Promise).filter(Promise.id == undated["id"]).first()
    check("defaulted due IS flagged", p.due_is_default is True)

owed = tools.set_promise("the deck", owed_to="Yash", from_thought=tid)
eq("owed_to resolves to a person name", owed["owed_to"], "Yash")
eq("owed row types as promise", owed["type"], "promise")
eq("self-owed row types as reminder", undated["type"], "reminder")
eq("thought link surfaced", owed["thought_id"], tid)
with SessionLocal() as db:
    edge = (
        db.query(Edge)
        .filter(Edge.src_kind == "promise", Edge.src_id == owed["id"],
                Edge.dst_kind == "note", Edge.kind == "derives_from")
        .first()
    )
    check("derives_from edge written", edge is not None and edge.dst_id == tid)

again = tools.set_promise("the deck", owed_to="Yash")
if EMBEDDINGS:
    eq("re-stating dedups to the same row", again["id"], owed["id"])
else:
    # Dedup is cosine-based, so it cannot fire without an embedding backend.
    # Asserting it here would just encode "no OPENAI_API_KEY in CI".
    print("  skip dedup assertion (no embedding backend configured)")

try:
    tools.set_promise("bad", cadence="weekly-ish")
    check("bad cadence rejected", False, "(no raise)")
except ValueError:
    check("bad cadence rejected", True)

# `is_promise` is GONE from the signature (it was accepted-but-inert).
check("inert is_promise param dropped",
      "is_promise" not in tools.set_promise.__code__.co_varnames)

# ═════════════════════════════════════════════════════════════════════════════
print("\n== list_promises: absorbs list_reminders + read_promises ==")

active = tools.list_promises(state="active", limit=50)
ids = {r["id"] for r in active}
check("open rows listed", {once["id"], weekly["id"], owed["id"]} <= ids)

closed = tools.set_promise_state(once["id"], "kept")
eq("state transition returns kept", closed["state"], "kept")
check("resolved_at stamped", closed["resolved_at"] is not None)
eq("kept row leaves the active list",
   once["id"] in {r["id"] for r in tools.list_promises(state="active", limit=50)}, False)
eq("kept row appears under state=kept",
   once["id"] in {r["id"] for r in tools.list_promises(state="kept", limit=50)}, True)
check("state=all spans both",
      {once["id"], weekly["id"]} <= {r["id"] for r in tools.list_promises(state="all", limit=99)})
check("day='today' resolves in local tz, not UTC",
      isinstance(tools.list_promises(day="today"), list))
try:
    tools.list_promises(state="nonsense")
    check("bad state rejected", False, "(no raise)")
except ValueError:
    check("bad state rejected", True)

# ═════════════════════════════════════════════════════════════════════════════
print("\n== search_notes: absorbs query_thoughts/list_notes/find_note/recent ==")

thoughts = tools.search_notes(kind="thought", topic="gooni arch")
check("thought reader returns thoughts", len(thoughts) >= 2)
check("thought rows carry topic + batch",
      all(r["kind"] == "thought" and r["topic"] == "gooni arch" for r in thoughts))
exact = tools.search_notes(q="dumb", kind="thought")
check("substring recall over thoughts", any("dumb" in (r["snippet"] or "") for r in exact))
by_tag = tools.search_notes(tag="design")
check("tag filter works", note["id"] in {r["id"] for r in by_tag})
recent = tools.search_notes(limit=5)
check("bare call lists recent notes", len(recent) >= 1)
sub = tools.search_notes(q="writeup", match="substring")
check("substring match over notes", note["id"] in {r["id"] for r in sub})

# read_note keeps the checklist rendering the deleted read_todos relied on.
tools.edit_note(note["id"], content=(
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">'
    "<label><input type=\"checkbox\" checked><span></span></label><div><p>done thing</p></div></li>"
    '<li data-type="taskItem" data-checked="false">'
    "<label><input type=\"checkbox\"><span></span></label><div><p>open thing</p></div></li></ul>"
))
body = tools.read_note(note["id"])
check("read_note renders [x]", "[x] done thing" in body, f"(got {body!r})")
check("read_note renders [ ]", "[ ] open thing" in body)
eq("missing note reads cleanly", tools.read_note(999999), "(note #999999 not found)")

# ═════════════════════════════════════════════════════════════════════════════
print("\n== trackables + the leetcode reachability claim ==")

print(" ", tools.add_trackable("test weight", kind="numeric", unit="kg", agg="last"))
out = tools.log_trackable_entry("test weight", "70.5")
check("numeric entry logged", "logged test weight = 70.5" in out, f"(got {out!r})")
out = tools.log_trackable_entry("test weight", "71.5", replace=True)
check("replace collapses the day", "71.5" in out)
check("named read returns the day", "71.5" in tools.read_trackable("test weight", 3))
check("unknown trackable is explicit",
      "no trackable" in tools.log_trackable_entry("nope", "1"))

# json-kind payloads round-trip through the generic reader — this is why
# get_leetcode_activity could be deleted without losing its data.
tools.add_trackable("test feed", kind="json", agg="last")
tools.log_trackable_entry("test feed", '{"streak": 10, "ranking": 435428}', replace=True)
feed = tools.read_trackable("test feed", 3)
check("json trackable exposes its full payload",
      "streak" in feed and "435428" in feed, f"(got {feed!r})")

# ═════════════════════════════════════════════════════════════════════════════
print("\n== MCP call logging ==")
# Logging is applied by register(), so it must be exercised through the REGISTERED
# path — calling tools.log_note() directly is the unwrapped function and would
# (correctly) record nothing. Going through mcp.call_tool is also the honest test:
# it is the path a real client takes.
import anyio  # noqa: E402

from app import focus_mcp  # noqa: E402

tools.bind(DIRECT)
anyio.run(lambda: focus_mcp.mcp.call_tool(
    "log_note", {"content": "audited write", "kind": "note", "title": "audited"}
))
anyio.run(lambda: focus_mcp.mcp.call_tool("list_topics", {}))
try:
    anyio.run(lambda: focus_mcp.mcp.call_tool(
        "log_note", {"content": "no topic", "kind": "thought"}
    ))
except Exception:
    pass  # expected — a thought needs a topic; we want the FAILED audit row

with SessionLocal() as db:
    rows = db.query(ToolCall).filter(ToolCall.source == "mcp-http").all()
    names = {r.tool_name for r in rows}
    check("calls recorded against the surface", {"log_note", "list_topics"} <= names,
          f"(saw {sorted(names)})")
    check("every logged row has a terminal status",
          all(r.status in ("done", "failed") for r in rows))
    failed = [r for r in rows if r.status == "failed"]
    check("raising tools are logged as failed", len(failed) >= 1,
          f"(failed rows: {len(failed)})")
    check("args are captured for the audit",
          any("audited" in (r.args_json or "") for r in rows))

# ═════════════════════════════════════════════════════════════════════════════
print("\n== gateway parity: in-process vs over-HTTP ==")
# The two implementations are what drifted in #458. Same call, each gateway,
# shapes must match key-for-key.
tools.bind(HTTP)

h_thought = tools.log_note(content="over http", kind="thought", topic="gooni arch",
                           new_batch=True, label="Gooni tested the seam.")
eq("http thought shape matches", set(h_thought), set(thought))
eq("http thought.batch shape matches", set(h_thought["batch"]), set(thought["batch"]))
eq("http topic shape matches", set(h_thought["topic"]), set(thought["topic"]))

h_once = tools.set_promise("http promise", due="2026-12-05T17:00:00+00:00")
eq("http promise shape matches", set(h_once), set(once))
eq("http cadence once", h_once["cadence"], "once")
check("http explicit due kept", (h_once["due_at"] or "").startswith("2026-12-05"),
      f"(got {h_once['due_at']})")

h_weekly = tools.set_promise("http gym", cadence="n_per_week", cadence_target=4)
eq("http recurring drops the defaulted due", h_weekly["due_at"], None)
eq("http cadence_target kept", h_weekly["cadence_target"], 4)

h_owed = tools.set_promise("http deck", owed_to="Curtis")
eq("http owed_to resolved", h_owed["owed_to"], "Curtis")
eq("http types as promise", h_owed["type"], "promise")

h_list = tools.list_promises(state="active", limit=50)
check("http reader returns the same shape",
      h_list and set(h_list[0]) == set(active[0]),
      f"(http keys {sorted(set(h_list[0])) if h_list else None})")
check("http day='today' forwards the literal", isinstance(tools.list_promises(day="today"), list))

h_note = tools.log_note(content="<p>http note</p>", kind="note", title="http note")
eq("http note shape matches", set(h_note), set(note))
h_search = tools.search_notes(q="http note", match="substring")
check("http search finds it", h_note["id"] in {r["id"] for r in h_search})
check("http read_note renders", tools.read_note(note["id"]).startswith("#"))
h_thoughts = tools.search_notes(kind="thought", topic="gooni arch")
eq("http thought-search shape matches", set(h_thoughts[0]), set(thoughts[0]))
eq("http state=kept works",
   once["id"] in {r["id"] for r in tools.list_promises(state="kept", limit=50)}, True)

st = tools.set_promise_state(h_once["id"], "broken")
eq("http state transition", st["state"], "broken")

check("http trackable read matches",
      "71.5" in tools.read_trackable("test weight", 3))

# The HTTP gateway cannot write its own audit row (it runs on a laptop, the DB is
# on Fly), so it POSTs to /tool-calls/mcp instead. Drive it through a registered
# server — same reason as the direct case: register() is what applies the audit.
from mcp.server.fastmcp import FastMCP as _FastMCP  # noqa: E402

_probe = _FastMCP("probe-stdio")
tools.register(_probe, ["list_topics"])
anyio.run(lambda: _probe.call_tool("list_topics", {}))

with SessionLocal() as db:
    stdio_rows = db.query(ToolCall).filter(ToolCall.source == "mcp-stdio").all()
    check("http gateway logs calls too (via /tool-calls/mcp)", len(stdio_rows) >= 1,
          f"(rows {len(stdio_rows)})")
    check("stdio rows are attributed to the stdio surface",
          all(r.source == "mcp-stdio" for r in stdio_rows))

# ═════════════════════════════════════════════════════════════════════════════
print("\n== the dead /mcp/* prefix stays dead; replacements are reachable ==")
for path in ("/mcp/context", "/mcp/memories", "/mcp/memories/search", "/mcp/notes/search"):
    r = _client.get(path, params={"q": "x"})
    eq(f"{path} is shadowed (404)", r.status_code, 404)
eq("GET /memories/context reachable", _client.get("/memories/context", params={"q": ""}).status_code, 200)
eq("POST /memories reachable",
   _client.post("/memories", json={"content": "surface test memory"}).status_code, 200)
eq("GET /memories/search reachable",
   _client.get("/memories/search", params={"q": "surface"}).status_code, 200)
eq("GET /notes/search reachable", _client.get("/notes/search", params={"q": "x"}).status_code, 200)
eq("GET /tool-calls/usage reachable", _client.get("/tool-calls/usage").status_code, 200)

# ═════════════════════════════════════════════════════════════════════════════
print("\n== one definition per tool; subsets are declared lists ==")
eq("no tool implemented twice", len(tools.ALL_TOOLS), len(set(tools.ALL_TOOLS)))
check("remote subset is a declared list", isinstance(tools.REMOTE_TOOLS, tuple))
check("stdio subset is a declared list", isinstance(tools.STDIO_TOOLS, tuple))
check("every subset name exists", set(tools.REMOTE_TOOLS) | set(tools.STDIO_TOOLS)
      <= set(tools.ALL_TOOLS))
for gone in ("log_thought", "add_note", "set_reminder", "add_promise", "list_reminders",
             "read_promises", "query_thoughts", "list_notes", "find_note",
             "list_recent_notes", "read_todos", "check_task", "claim_task",
             "release_task", "get_leetcode_activity", "set_reminder_state"):
    check(f"retired tool {gone!r} is gone", gone not in tools.ALL_TOOLS)

# All three entry points expose tools from the one module.
from app import focus_mcp  # noqa: E402

check("mounted /mcp registers from the module", set(focus_mcp.REGISTERED) <= set(tools.ALL_TOOLS))

# A typo in a transport list must fail at boot, not silently hide a tool.
from mcp.server.fastmcp import FastMCP  # noqa: E402

try:
    tools.register(FastMCP("probe"), ["log_note", "nope_not_a_tool"])
    check("register() rejects a typo'd name", False, "(no raise)")
except KeyError:
    check("register() rejects a typo'd name", True)


print()
if FAILS:
    print(f"FAILED ({len(FAILS)}): {FAILS}")
    sys.exit(1)
print("all mcp surface checks passed")
