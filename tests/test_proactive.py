"""Proactive-layer net — the one loop that speaks first, and every reason it doesn't.

No LLM, no HTTP: the model call is injected (`tick(generate=...)`) and the
WhatsApp channel is a fake, so the entire decision ladder runs offline against a
temp SQLite db — same harness as test_activity_context / test_focus_attribution.

Injecting the generator rather than mocking the client is deliberate: the thing
worth testing here is NOT that a model can write a sentence, it is that every
gate deciding whether to ask one is deterministic and closed in the right
direction. A mocked `llm_client` would have exercised the same call and none of
the gates.

The load-bearing assertions:

  1. ONE MODEL CALL PER TICK, AT MOST — and zero whenever a gate already
     answered. A live observation on screen doesn't even build the context.
  2. NONE IS SILENCE. The model's refusal, an empty string (which is what a
     FAILED api call returns), and a NONE with punctuation all store nothing.
  3. ASYMMETRIC VALUE IS ENFORCED BY THE PROMPT, AND THE PROMPT SAYS SO. The
     bad-example list and the no-judgement rule are pinned, because the failure
     mode of a cheap model on "notice something" is fluent restatement.
  3b. AN UNGROUNDED OBSERVATION IS DROPPED. Found on the first LIVE tick, not
     imagined: shown Chrome, YouTube and one due promise, gpt-4o-mini answered
     "calories are at the limit and it is 12:41" — a subject that appeared
     nowhere in the context, lifted from the prompt's own examples. That exact
     string is the fixture.
  4. NO PRESENCE, NO OBSERVATION. With nothing from the sensors for hours and no
     live session, the tick doesn't invent a remark for an empty chair.
  5. EXPIRY IS REAL. A stale observation stops being served rather than lingering
     as a claim about a moment that has passed.
  6. A DISMISSAL MEANS SOMETHING. It's durable, it clears the display, and a
     near-twin is suppressed for LONGER than an ordinary repeat — otherwise
     waving a line away buys one tick of quiet.
  7. THE TREADMILL IS BROKEN. The same remark with a bigger number in it is a
     repeat, not news.
  8. THE CONTEXT FITS ITS BUDGET, AND SAYS SO WHEN IT DOESN'T.
  9. THE SILENCE REACH-OUT: fires only on real quiet, only in waking hours, only
     once a day, only inside Meta's 24h window — and the once-a-day stamp is
     written only after delivery.
 10. THE KILL SWITCH WORKS from both the Settings column and the env var.
 11. READ-ONLY. The loop mints no Trackable and writes no Promise.

Usage:
  source venv/bin/activate
  python tests/test_proactive.py
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))
# The env kill switch must not be inherited from a developer's shell — several
# tests assert the loop RUNS, and a stray export would make them all pass by
# skipping.
os.environ.pop("GOONI_PROACTIVE_DISABLED", None)

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import (  # noqa: E402
    AppInterval,
    Base,
    BrowserInterval,
    Conversation,
    Message,
    ProactiveObservation,
    Promise,
    Settings,
    Trackable,
)
from app.services import proactive_service as ps  # noqa: E402

_failures = []


def check(cond, label):
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        _failures.append(label)


# A Wednesday afternoon, well inside waking hours in America/Los_Angeles
# (13:00 local for a 20:00 UTC stamp).
NOW = datetime(2026, 8, 12, 20, 0, 0)


# ── fixtures ─────────────────────────────────────────────────────────────────


def reset(db):
    """Wipe everything the tick reads or writes. Each test builds its own world
    so a gate that passes only because of a leftover row can't hide."""
    for model in (
        ProactiveObservation,
        AppInterval,
        BrowserInterval,
        Message,
        Conversation,
        Promise,
        Trackable,
    ):
        db.query(model).delete()
    s = db.query(Settings).first()
    if s is None:
        s = Settings(id=1, nudge_tz="America/Los_Angeles")
        db.add(s)
    s.proactive_enabled = True
    # A live-session blob is a claim with a six-hour life, so leaving one behind
    # would silently hand the NEXT test a running focus session.
    s.focus_cam = None
    db.commit()


def add_interval(db, *, app="cursor", ends_ago_min=1, minutes=10, at=NOW):
    end = at - timedelta(minutes=ends_ago_min)
    start = end - timedelta(minutes=minutes)
    db.add(
        AppInterval(
            client_id=f"c{db.query(AppInterval).count()}-{ends_ago_min}-{app}",
            app=app,
            started_at=start,
            ended_at=end,
            duration_sec=minutes * 60.0,
            end_reason="app_change",
            truncated=False,
            created_at=end,
        )
    )
    db.commit()


def add_promise(db, summary="ship the sysdesign review", due_in_h=3):
    p = Promise(
        utterance=summary,
        summary=summary,
        state="active",
        cadence="once",
        inferred_due=NOW + timedelta(hours=due_in_h),
        is_important=True,
        created_at=NOW - timedelta(days=1),
    )
    db.add(p)
    db.commit()
    return p


def wa_thread(db, *, last_user_ago_h=1.0, at=NOW):
    """A WhatsApp conversation whose newest inbound message is `last_user_ago_h`
    old — which is what Meta's 24h freeform window is measured against."""
    conv = Conversation(source="whatsapp")
    db.add(conv)
    db.commit()
    db.add(
        Message(
            conversation_id=conv.id,
            role="user",
            content="yo",
            created_at=at - timedelta(hours=last_user_ago_h),
        )
    )
    db.commit()
    return conv


class FakeWhatsApp:
    """Stands in for `whatsapp_channel`. Records sends; `ok=False` simulates a
    Meta rejection, which `WhatsAppCloudClient.send_text` reports as False."""

    def __init__(self, ok=True, allowed=("15551234567",)):
        self.ok = ok
        self._allowed = set(allowed)
        self.sent = []

    def format_outbound(self, text):
        return text

    def send(self, recipient, text):
        self.sent.append((recipient, text))
        return self.ok


def gen(answer):
    """A stub model that records how many times it was asked."""

    calls = []

    def _gen(prompt):
        calls.append(prompt)
        return answer

    _gen.calls = calls
    return _gen


def present_world(db):
    """The ordinary case: sensors just saw something, one commitment is due."""
    reset(db)
    add_interval(db, app="cursor", ends_ago_min=1, minutes=25)
    add_promise(db)


# ── 1 · one call per tick, zero when a gate already answered ─────────────────


def test_one_model_call_per_tick(db):
    print("\n[one model call per tick]")
    present_world(db)
    g = gen("25m on youtube, sir. the review is due in 3h.")
    res = ps.tick(db, now=NOW, generate=g)
    check(res["status"] == "stored", f"a real observation stores: {res['status']}")
    check(len(g.calls) == 1, f"exactly one model call, got {len(g.calls)}")

    # Rule 4: one live line at a time. The second tick must not even ask.
    g2 = gen("something else entirely about weather")
    res2 = ps.tick(db, now=NOW + timedelta(minutes=1), generate=g2)
    check(res2["status"] == "skipped_live", f"a live line short-circuits: {res2['status']}")
    check(len(g2.calls) == 0, "…with ZERO model calls — the cheapest gate is first")
    check(
        db.query(ProactiveObservation).count() == 1,
        "and no second row was written",
    )


# ── 2 · NONE is silence, and so is a failed call ─────────────────────────────


def test_none_is_silence(db):
    print("\n[NONE is silence]")
    for answer, label in (
        ("NONE", "a bare NONE"),
        ("  none.  ", "NONE with whitespace + punctuation"),
        ("", "an EMPTY string — what a FAILED api call returns"),
        (None, "a None return"),
    ):
        present_world(db)
        res = ps.tick(db, now=NOW, generate=gen(answer))
        check(res["status"] == "none", f"{label} → status 'none' (got {res['status']})")
        check(
            db.query(ProactiveObservation).count() == 0,
            f"{label} → nothing stored",
        )

    check(ps.parse_reply("NONE — nothing to report") is None, "a NONE with a tail is still NONE")
    check(
        ps.parse_reply('"25m on youtube, sir."') == "25m on youtube, sir.",
        "a quoted sentence is unwrapped",
    )
    long = "x" * (ps.MAX_OBSERVATION_CHARS + 60)
    check(
        len(ps.parse_reply(long) or "") <= ps.MAX_OBSERVATION_CHARS + 1,
        "an over-long answer is clamped rather than stored whole",
    )
    check(
        ps.parse_reply("first line, the observation\nsecond line rambling") ==
        "first line, the observation",
        "a multi-line answer collapses to its first line",
    )


# ── 3 · the asymmetric-value rule is in the prompt ───────────────────────────


def test_prompt_carries_the_rule(db):
    print("\n[the prompt enforces asymmetric value]")
    p = ps.PROACTIVE_PROMPT.lower()
    check("asymmetric value" in p, "the rule is named")
    check("none is the correct answer most of the time" in p, "NONE is framed as the default")
    check("you have 5 promises open" in p, "the dashboard-restatement bad example is present")
    check("keep up the good work" in p, "the encouragement bad example is present")
    check("no score, no percentage" in p, "no scoring / no verdict")
    check(
        "not evidence that he was idle" in p or "not evidence he was idle" in p,
        "quiet sensors are explicitly NOT evidence of an idle human",
    )
    check("{context}" in ps.PROACTIVE_PROMPT, "the context slot exists")
    check(
        "must appear in the" in p and "answer none instead" in p,
        "the grounding rule is stated, not just hoped for",
    )
    flat = " ".join(p.split())
    check(
        "copy the shape, never the subject" in flat,
        "the GOOD examples are marked as SHAPE, not content — they are what the "
        "model lifted 'calories' from on the first live tick",
    )
    # The gate. Vague guidance ("NONE is usually right") measurably did not
    # work: five consecutive live ticks on a mediocre context produced five
    # observations. These four named tensions are what a cheap model can
    # actually apply, and the deadline-alone clause kills the exact bad line it
    # kept reaching for.
    check(
        "if the only thing you can name is when something is due, answer none" in flat,
        "a deadline on its own is explicitly disqualified",
    )
    check(
        all(f"{k}." in ps.PROACTIVE_PROMPT for k in ("A", "B", "C", "D")),
        "the gate lists its four tensions rather than gesturing at a vibe",
    )
    check(
        "a few minutes between sensor readings is not an absence" in flat,
        "a short sensor gap is explicitly not an absence",
    )
    check(
        "never contradict the context" in flat,
        "contradicting the context is explicitly banned",
    )


# ── 3b · the grounding backstop ──────────────────────────────────────────────


def test_ungrounded_is_dropped(db):
    print("\n[an ungrounded observation is dropped]")
    present_world(db)
    ctx = ps.build_context(db, now=NOW)
    check("youtube" not in ctx["text"], "sanity: this world has no youtube in it")

    # The verbatim answer gpt-4o-mini gave on the first live tick, against a
    # context that mentioned neither calories nor a limit.
    fabricated = "calories are at the limit and it is 12:41."
    check(
        not ps.is_grounded(fabricated, ctx["text"]),
        f"the real hallucination is caught (overlap "
        f"{ps.grounding_overlap(fabricated, ctx['text']):.2f})",
    )
    res = ps.tick(db, now=NOW, generate=gen(fabricated))
    check(res["status"] == "skipped_ungrounded", f"…and dropped by the tick: {res['status']}")
    check(db.query(ProactiveObservation).count() == 0, "nothing stored")

    # …and it never enters the dedup history, or a hallucinated subject would go
    # on to suppress the REAL observation that mentions it.
    check(
        ps.is_repeat(db, fabricated, now=NOW + timedelta(minutes=5)) is None,
        "an ungrounded line leaves no trace in the repeat history",
    )

    # A grounded observation about the same world still lands.
    real = "cursor for 25m, sir — the sysdesign review is due in 3h."
    check(ps.is_grounded(real, ctx["text"]), "an observation built from the context passes")
    res2 = ps.tick(db, now=NOW, generate=gen(real))
    check(res2["status"] == "stored", f"…and is stored: {res2['status']}")

    # The check must not be so strict it eats the quiet-sensor observation,
    # whose wording is mostly the context's own.
    quiet_ctx = "- nothing observed since 45m ago (screen went idle/locked)"
    check(
        ps.is_grounded("nothing observed for 45m — stepped away?", quiet_ctx),
        "a paraphrase built on the context's own words survives",
    )


# ── 4 · no presence, no observation ──────────────────────────────────────────


def test_absence_skips_the_model(db):
    print("\n[no presence, no observation]")
    reset(db)
    # Sensors last saw something well past PRESENCE_GAP, and no focus session.
    add_interval(db, ends_ago_min=int(ps.PRESENCE_GAP.total_seconds() / 60) + 30)
    add_promise(db)
    g = gen("you have promises due")
    # No WhatsApp channel configured → the reach-out branch stops at its own
    # gate, but the point here is that the MODEL was never asked.
    res = ps.tick(db, now=NOW, generate=g)
    check(len(g.calls) == 0, "the model is not called for an empty chair")
    check(
        res["status"].startswith("skipped_") or res["status"] == "reach_out_failed",
        f"the tick reports a deliberate silence: {res['status']}",
    )
    check(db.query(ProactiveObservation).count() == 0, "nothing stored")


# ── 5 · expiry ───────────────────────────────────────────────────────────────


def test_expiry(db):
    print("\n[observations expire]")
    present_world(db)
    ps.tick(db, now=NOW, generate=gen("focus session 2h in, review due at 15:00."))
    check(ps.current(db, now=NOW) is not None, "served while live")
    ttl = ps.ttl_minutes()
    check(
        ps.current(db, now=NOW + timedelta(minutes=ttl + 1)) is None,
        f"not served past its {ttl}m TTL",
    )
    check(
        db.query(ProactiveObservation).count() == 1,
        "…but the row survives for the dedup + tuning reads",
    )


# ── 6 · dismissal ────────────────────────────────────────────────────────────


def test_dismissal(db):
    print("\n[dismissal]")
    present_world(db)
    line = "25m on youtube, sir. the review is due in 3h."
    ps.tick(db, now=NOW, generate=gen(line))
    row = ps.current(db, now=NOW)
    check(row is not None, "there is something to dismiss")

    ps.dismiss(db, row.id, now=NOW)
    check(ps.current(db, now=NOW) is None, "dismissed → no longer served")
    stored = (
        db.query(ProactiveObservation)
        .filter(ProactiveObservation.id == row.id)
        .first()
    )
    check(stored.dismissed is True, "durably dismissed")

    # The asymmetry that gives the button meaning: a near-twin stays suppressed
    # past the ordinary repeat window.
    beyond_repeat = NOW + ps.REPEAT_WINDOW + timedelta(minutes=5)
    check(
        beyond_repeat < NOW + ps.DISMISS_COOLDOWN,
        "sanity: the probe time is past REPEAT_WINDOW but inside DISMISS_COOLDOWN",
    )
    check(
        ps.is_repeat(db, line, now=beyond_repeat) is not None,
        "a dismissed twin is still suppressed after the plain repeat window",
    )
    check(
        ps.is_repeat(db, line, now=NOW + ps.DISMISS_COOLDOWN + timedelta(minutes=5)) is None,
        "…and free again once the dismissal cooldown is spent",
    )

    check(ps.dismiss(db, 999_999, now=NOW) is None, "dismissing a missing id returns None")


# ── 7 · the treadmill ────────────────────────────────────────────────────────


def test_the_treadmill_is_broken(db):
    print("\n[same remark, bigger number, is not news]")
    present_world(db)
    ps.tick(db, now=NOW, generate=gen("25m on youtube, sir. the review is due in 3h."))
    row = ps.current(db, now=NOW)
    ps.dismiss(db, row.id, now=NOW)

    later = NOW + timedelta(minutes=15)
    g = gen("40m on youtube, sir. the review is due in 2h.")
    res = ps.tick(db, now=later, generate=g)
    check(len(g.calls) == 1, "the model still gets asked (the gate is on the ANSWER)")
    check(res["status"] == "skipped_repeat", f"…and the answer is suppressed: {res['status']}")
    check(db.query(ProactiveObservation).count() == 1, "no second row")

    check(
        ps.similarity("25m on youtube, the review is due in 3h",
                      "40m on youtube, the review is due in 2h") >= ps.DUPLICATE_THRESHOLD,
        "digits are stripped before comparison, so the pair reads as one remark",
    )
    check(
        ps.similarity("25m on youtube, the review is due in 3h",
                      "your calories are already at the limit") < ps.DUPLICATE_THRESHOLD,
        "a genuinely different remark is NOT a repeat",
    )


# ── 8 · the context budget ───────────────────────────────────────────────────


def test_context_budget(db):
    print("\n[the context fits its budget]")
    reset(db)
    add_interval(db, app="cursor", ends_ago_min=1, minutes=20)
    for i in range(12):
        add_interval(db, app=f"app{i}", ends_ago_min=2 + i, minutes=1)
    for i in range(12):
        add_promise(db, summary=f"commitment number {i} with a reasonably long title", due_in_h=i)

    ctx = ps.build_context(db, now=NOW)
    check(
        len(ctx["text"]) <= ps.MAX_CONTEXT_CHARS + 60,
        f"saturated context stays inside the budget: {len(ctx['text'])} chars",
    )
    check(ctx["has_commitments"], "the commitments made it in")
    check(ctx["has_activity"], "the sensor fold made it in")
    check("local time:" in ctx["text"], "the local wall clock is present (a due time needs it)")
    check(
        not any(ln.lstrip().startswith("[") for ln in ctx["lines"]),
        "the overlay block's chat-facing 'don't nag' header is stripped — here unprompted IS the job",
    )

    # An absence LONGER than activity_context's own 30m window renders there as
    # an empty section — indistinguishable from an uninstalled extension. The
    # gap has to be stated, or "stepped away?" can never be observed.
    reset(db)
    add_interval(db, ends_ago_min=45)
    add_promise(db)
    absent = ps.build_context(db, now=NOW)
    check(
        "nothing at all in this window" in absent["text"],
        f"a 45m absence is STATED, not left as a hole: {absent['text']!r}",
    )
    check("45m ago" in absent["text"], "…with how long ago the sensors last saw anything")
    check(
        "they observed" in absent["text"] and "he was idle" not in absent["text"],
        "…phrased as a fact about the SENSORS, never about the human",
    )
    check(absent["has_activity"], "the absence counts as context worth reasoning about")

    # …but an ordinary seam between two intervals is not an absence. Letting the
    # model judge this produced "nothing observed in the last 3m" on a live tick.
    reset(db)
    add_interval(db, ends_ago_min=3)
    add_promise(db)
    seam = ps.build_context(db, now=NOW)
    check(
        "nothing at all in this window" not in seam["text"],
        "a 3m gap is a seam between intervals, and is never mentioned",
    )

    # No silent caps.
    clipped, truncated = ps._clip(["x" * 100] * 40, 500)
    check(truncated and len(clipped) < 40, "the clipper actually clips")
    ctx2 = ps.build_context(db, now=NOW)
    if ctx2["truncated"]:
        check(
            "not everything" in ctx2["text"],
            "a truncated context ANNOUNCES the cut rather than reading as the whole",
        )
    else:
        check(True, "context fit without truncation (cut announcement untested this run)")


# ── 8b · staleness reaches the proactive prompt ──────────────────────────────


def test_staleness_reaches_the_prompt(db):
    print("\n[the sensors' age reaches the proactive prompt]")
    # A proactive claim built on a 25-minute-old app switch is the most
    # embarrassing thing this surface can say, so the age label #484 added to
    # the chat state block has to reach THIS block too — it is not shared
    # automatically, and both blocks read the same `activity_context` summary.
    reset(db)
    add_interval(db, app="cursor", ends_ago_min=1, minutes=20)
    fresh = ps.build_context(db, now=NOW)
    check("as of" in fresh["text"], f"a fresh read is stamped: {fresh['lines'][0]!r}")

    reset(db)
    # Ends 22m ago but still overlaps the 30m window: observed, and STALE.
    add_interval(db, app="cursor", ends_ago_min=22, minutes=6)
    stale = ps.build_context(db, now=NOW)
    check(
        "stale" in stale["text"] and "last seen" in stale["text"],
        f"a stale layer is labelled as past, not as doing: {stale['text']!r}",
    )
    check(
        "cursor 6m" not in stale["text"],
        "…and is NOT rendered as a doing-line with a duration",
    )
    check(
        ps.STALE_LABELS_IN_PROMPT in ps.PROACTIVE_PROMPT,
        "…and the prompt tells the model to READ those labels rather than "
        "narrate stale data as current",
    )


# ── 8c · the session's task reaches the prompt, so on-task ≠ distraction ─────


def add_browsing(db, *, host, ends_ago_min=1, minutes=13, at=NOW):
    end = at - timedelta(minutes=ends_ago_min)
    start = end - timedelta(minutes=minutes)
    db.add(
        BrowserInterval(
            client_id=f"w{db.query(BrowserInterval).count()}-{host}",
            host=host,
            path="/",
            url=f"https://{host}/",
            started_at=start,
            ended_at=end,
            duration_sec=minutes * 60.0,
            end_reason="tab_change",
            truncated=False,
            created_at=end,
        )
    )
    db.commit()


def start_focus_session(db, promise, *, started_ago_min=20, at=NOW):
    """The one server-visible signal a session is live: the focus_cam control
    blob, exactly as `focus_cam_service.set_control` writes it."""
    s = db.query(Settings).first()
    s.focus_cam = json.dumps(
        {
            "control": "running",
            "target_reminder_id": promise.id,
            "control_at": (at - timedelta(minutes=started_ago_min)).isoformat(),
        }
    )
    db.commit()


def test_on_task_browsing_is_not_a_distraction(db):
    print("\n[a session's task reaches the prompt, so on-task browsing isn't a lapse]")
    # The live failure: a session named "read some common system design
    # patterns", spent on hellointerview.com — the study site — was reported as
    # "you've been browsing hellointerview for 13m and have a commitment overdue
    # by 14h". The site IS the work. Two halves to the fix, and this asserts
    # both: the context has to NAME what the session is for (otherwise there is
    # nothing to judge relevance against), and the prompt has to tell the model
    # to read it (otherwise anything-that-isn't-literally-the-commitment reads
    # as off-task, which is what tension A used to say).
    reset(db)
    task = add_promise(db, summary="read some common system design patterns", due_in_h=6)
    start_focus_session(db, task)
    add_browsing(db, host="hellointerview.com", minutes=13)

    ctx = ps.build_context(db, now=NOW)
    text = ctx["text"].lower()
    check(
        "focus session on" in text and "system design patterns" in text,
        f"the context names the running session's TASK, in his own words: {ctx['text']!r}",
    )
    check(
        "hellointerview" in text,
        "…and names the site beside it, so relevance is a judgement the model "
        "can actually make",
    )

    flat = " ".join(ps.PROACTIVE_PROMPT.lower().split())
    check(
        ps.ON_TASK_RULE_IN_PROMPT.lower() in flat,
        "…and the prompt tells the model to read the task before calling "
        "anything off-task",
    )
    check(
        "no list" in flat or "there is no list" in flat,
        "…by INFERENCE from the task's wording, explicitly not a whitelist",
    )
    check(
        "when it is arguable, it is not off-task" in flat,
        "…and an arguable case resolves to silence, this surface's default",
    )
    check(
        "hellointerview" in flat,
        "the verbatim live failure is in the BAD examples — the quality bar "
        "only an example can carry",
    )

    # The blob must not outlive this test: it is a six-hour claim.
    reset(db)


# ── 9 · the silence reach-out ────────────────────────────────────────────────


def silent_world(db, *, quiet_h=4, wa_last_user_ago_h=5.0, at=NOW):
    """Sensors quiet for `quiet_h`, and Daniel's last WhatsApp message OLDER
    than that — because a message IS a signal. The default pair is the real
    shape of the trigger: he texted this morning, then went quiet.

    Everything is anchored on `at`, the instant the tick will be probed with,
    so a test that probes at 3am builds a world that was quiet at 3am.
    """
    reset(db)
    add_interval(db, ends_ago_min=int(quiet_h * 60), at=at)
    wa_thread(db, last_user_ago_h=wa_last_user_ago_h, at=at)


def test_reach_out(db):
    print("\n[the silence reach-out]")
    silent_world(db)
    wa = FakeWhatsApp()
    ctx = ps.build_context(db, now=NOW)
    res = ps._reach_out(db, ctx, channel=wa, now=NOW)
    check(res["status"] == "reached_out", f"real quiet in waking hours → a text: {res['status']}")
    check(len(wa.sent) == 1, "exactly one message sent")
    sent = wa.sent[0][1].lower()
    check(
        not any(b in sent for b in ("daily check-in", "no activity detected", "notification")),
        f"friend, not bot: {wa.sent[0][1]!r}",
    )
    check(
        db.query(ProactiveObservation)
        .filter(ProactiveObservation.channel == "whatsapp")
        .count()
        == 1,
        "the delivered reach-out is recorded",
    )
    # It went to his phone; echoing it onto the display is the same message twice.
    check(ps.current(db, now=NOW) is None, "a reach-out does NOT appear on the ambient display")
    # And it lands in the WhatsApp transcript as a real assistant turn.
    check(
        db.query(Message).filter(Message.role == "assistant").count() == 1,
        "recorded as an assistant turn on the WhatsApp thread",
    )


def test_reach_out_is_once_a_day(db):
    print("\n[reach-out: once a day]")
    silent_world(db)
    wa = FakeWhatsApp()
    ps._reach_out(db, ps.build_context(db, now=NOW), channel=wa, now=NOW)
    check(len(wa.sent) == 1, "first one sends")

    later = NOW + timedelta(hours=3)  # 16:00 local, still waking hours
    res = ps._reach_out(db, ps.build_context(db, now=later), channel=wa, now=later)
    check(
        res["status"] == "skipped_already_reached_out",
        f"a second one the same day is refused: {res['status']}",
    )
    check(len(wa.sent) == 1, "…and nothing was sent")

    # Local day, not a rolling 24h: tomorrow afternoon is free again — assuming
    # he answered at some point, which is also what keeps Meta's window open. A
    # 24h+ silence shuts the freeform door on its own, and that is correct.
    tomorrow = NOW + timedelta(days=1)
    conv = db.query(Conversation).filter(Conversation.source == "whatsapp").first()
    db.add(
        Message(
            conversation_id=conv.id,
            role="user",
            content="ye been heads down",
            created_at=tomorrow - timedelta(hours=6),
        )
    )
    db.commit()
    res2 = ps._reach_out(db, ps.build_context(db, now=tomorrow), channel=wa, now=tomorrow)
    check(res2["status"] == "reached_out", f"the next local day is free again: {res2['status']}")


def test_reach_out_gates(db):
    print("\n[reach-out: every gate]")
    # Not actually silent.
    silent_world(db, quiet_h=1)
    wa = FakeWhatsApp()
    res = ps._reach_out(db, ps.build_context(db, now=NOW), channel=wa, now=NOW)
    check(res["status"] == "skipped_not_silent", f"1h of quiet is not silence: {res['status']}")

    # Silent, but at 03:00 local (10:00 UTC on a PDT date). The world is built
    # around that instant, so the ONLY reason to stay quiet is the hour.
    night = datetime(2026, 8, 12, 10, 0, 0)
    silent_world(db, at=night)
    check(
        ps.to_local(db, night).hour == 3,
        "sanity: the probe really is 03:00 in Daniel's zone",
    )
    res = ps._reach_out(db, ps.build_context(db, now=night), channel=wa, now=night)
    check(res["status"] == "skipped_asleep", f"a 3am text is a bad friend: {res['status']}")
    check(len(wa.sent) == 0, "…and nothing was sent")

    # Silent, waking, but Meta's freeform window is shut.
    silent_world(db, wa_last_user_ago_h=30)
    res = ps._reach_out(db, ps.build_context(db, now=NOW), channel=wa, now=NOW)
    check(
        res["status"] == "skipped_wa_window_closed",
        f"outside the 24h customer window Gooni stays quiet: {res['status']}",
    )
    check(len(wa.sent) == 0, "…and does not fire a send Meta would reject")

    # Silent, waking, in-window — but Meta rejects it.
    silent_world(db)
    failing = FakeWhatsApp(ok=False)
    res = ps._reach_out(db, ps.build_context(db, now=NOW), channel=failing, now=NOW)
    check(res["status"] == "reach_out_failed", f"a rejected send is reported: {res['status']}")
    check(
        db.query(ProactiveObservation).filter(ProactiveObservation.channel == "whatsapp").count() == 0,
        "NO row on failure — the once-a-day stamp must not burn on a message that never arrived",
    )
    # …so the day's send is still owed, and a retry lands.
    retry = FakeWhatsApp()
    res = ps._reach_out(db, ps.build_context(db, now=NOW + timedelta(minutes=20)),
                        channel=retry, now=NOW + timedelta(minutes=20))
    check(res["status"] == "reached_out", "the retry after a failed send goes through")

    # No handles configured at all.
    silent_world(db)
    res = ps._reach_out(db, ps.build_context(db, now=NOW),
                        channel=FakeWhatsApp(allowed=()), now=NOW)
    check(res["status"] == "skipped_wa_unconfigured", f"unconfigured → quiet: {res['status']}")

    # A brand-new install: never a sensor row, never a message. Not a quiet day.
    reset(db)
    res = ps._reach_out(db, ps.build_context(db, now=NOW), channel=wa, now=NOW)
    check(res["status"] == "skipped_no_history", f"no history is not silence: {res['status']}")


def test_a_conversation_is_not_silence(db):
    print("\n[a conversation is not silence]")
    reset(db)
    add_interval(db, ends_ago_min=600)  # sensors quiet for 10h…
    conv = wa_thread(db, last_user_ago_h=0.5)  # …but he texted 30 min ago
    check(conv is not None, "world built")
    ctx = ps.build_context(db, now=NOW)
    check(
        ctx["last_signal"] is not None
        and (NOW - ctx["last_signal"]) < timedelta(hours=1),
        "the message log counts as a signal, not just the sensors",
    )
    res = ps._reach_out(db, ctx, channel=FakeWhatsApp(), now=NOW)
    check(
        res["status"] == "skipped_not_silent",
        f"talking to Gooni half an hour ago is not silence: {res['status']}",
    )


# ── 10 · the kill switch ─────────────────────────────────────────────────────


def test_kill_switch(db):
    print("\n[the kill switch]")
    present_world(db)
    s = db.query(Settings).first()
    s.proactive_enabled = False
    db.commit()
    g = gen("something worth saying")
    res = ps.tick(db, now=NOW, generate=g)
    check(res["status"] == "skipped_disabled", f"the Settings toggle stops it: {res['status']}")
    check(len(g.calls) == 0, "…before any model call")

    s.proactive_enabled = True
    db.commit()
    os.environ["GOONI_PROACTIVE_DISABLED"] = "1"
    try:
        g2 = gen("something worth saying")
        res2 = ps.tick(db, now=NOW, generate=g2)
        check(
            res2["status"] == "skipped_disabled",
            f"the env var WINS over an enabled setting: {res2['status']}",
        )
        check(len(g2.calls) == 0, "…also before any model call")
    finally:
        os.environ.pop("GOONI_PROACTIVE_DISABLED", None)

    res3 = ps.tick(db, now=NOW, generate=gen("25m on youtube, review due in 3h."))
    check(res3["status"] == "stored", "clearing both switches brings it back with no restart")


# ── 11 · read-only ───────────────────────────────────────────────────────────


def test_read_only(db):
    print("\n[read-only]")
    present_world(db)
    tr_before = db.query(Trackable).count()
    pr_before = db.query(Promise).count()
    ps.tick(db, now=NOW, generate=gen("25m on youtube, the review is due in 3h."))
    check(db.query(Trackable).count() == tr_before, "no Trackable minted")
    check(db.query(Promise).count() == pr_before, "no Promise written")

    silent_world(db)
    tr_before = db.query(Trackable).count()
    ps._reach_out(db, ps.build_context(db, now=NOW), channel=FakeWhatsApp(), now=NOW)
    check(db.query(Trackable).count() == tr_before, "the reach-out mints no Trackable either")


# ── cadence knobs ────────────────────────────────────────────────────────────


def test_cadence_clamps(db):
    print("\n[cadence knobs are clamped]")
    for raw, lo, hi in (("1", ps.MIN_INTERVAL_MINUTES, ps.MAX_INTERVAL_MINUTES),
                        ("99999", ps.MIN_INTERVAL_MINUTES, ps.MAX_INTERVAL_MINUTES)):
        os.environ["PROACTIVE_INTERVAL_MIN"] = raw
        try:
            check(lo <= ps.interval_minutes() <= hi, f"interval {raw!r} clamps into [{lo},{hi}]")
        finally:
            os.environ.pop("PROACTIVE_INTERVAL_MIN", None)
    os.environ["PROACTIVE_INTERVAL_MIN"] = "not-a-number"
    try:
        check(
            ps.interval_minutes() == ps.DEFAULT_INTERVAL_MINUTES,
            "a junk interval falls back to the default rather than crashing the loop",
        )
    finally:
        os.environ.pop("PROACTIVE_INTERVAL_MIN", None)
    check(ps.model_name() == "gpt-4o-mini" or bool(os.getenv("PROACTIVE_MODEL")),
          "the default model is the cheap one")


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    test_one_model_call_per_tick(db)
    test_none_is_silence(db)
    test_prompt_carries_the_rule(db)
    test_ungrounded_is_dropped(db)
    test_absence_skips_the_model(db)
    test_expiry(db)
    test_dismissal(db)
    test_the_treadmill_is_broken(db)
    test_context_budget(db)
    test_staleness_reaches_the_prompt(db)
    test_on_task_browsing_is_not_a_distraction(db)
    test_reach_out(db)
    test_reach_out_is_once_a_day(db)
    test_reach_out_gates(db)
    test_a_conversation_is_not_silence(db)
    test_kill_switch(db)
    test_read_only(db)
    test_cadence_clamps(db)

    db.close()
    print()
    if _failures:
        print(f"FAIL — {len(_failures)} check(s) failed")
        for f in _failures:
            print(f"  · {f}")
        return 1
    print("PASS — proactive layer (one call, asymmetric value, silence by default)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
