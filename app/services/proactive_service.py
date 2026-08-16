"""The proactive layer — what Gooni says when nobody asked.

Everything else in this codebase is request-response: Daniel types, Gooni
answers. This module is the one place that speaks first. A background loop
(`background._proactive_loop`) ticks every ~15 minutes, folds what the sensors
and the deterministic rankers already know into one bounded context, makes at
most ONE cheap model call, and — usually — decides there is nothing worth
saying.

**The rule that makes it tolerable is asymmetric value.** A proactive line is
only allowed to exist when it carries something Daniel plausibly does NOT
already have: two facts held together ("25m on youtube, the review is due in
3h"), or one fact he has lost track of. Restating the dashboard, narrating what
he is obviously doing, and encouragement are all worse than silence, because a
signal that fires every tick stops being read — the same lesson the deleted
grindstone line, the deleted log-button dot and the CAPTURE persona's asymmetric
-value rule all taught. `NONE` is the expected answer and the prompt says so.

**And "the prompt says so" was measurably not enough.** Told only that NONE was
usually right, gpt-4o-mini spoke on five consecutive live ticks over a mediocre
context — a model straining to be useful walks straight past a vibe. What works
is a GATE with named tensions and numeric thresholds (see `PROACTIVE_PROMPT`),
because that is a test it can apply rather than a mood it has to infer. Measured
over live ticks after that change: 9/9 silence on boring contexts (heads-down in
one app, nothing due soon, a 5-minute gap between intervals), and the correct
two-fact line on every off-task-with-a-deadline and every long-absence context.
Re-measure the same way if you touch the prompt; this is the one part of the
feature that cannot be verified by reading it.

**"Gooni never calls a model" bends here, and only here.** The deterministic
rule stands for anything that RANKS, SURFACES or PROMOTES on the request path;
this is background inference between conversations, on its own loop, with its
own budget. Nothing here touches the chat orchestrator and no user-facing
request waits on it. What stays deterministic is the decision to *speak at all*:
every gate below (silence, presence, dedup, the delivery windows) is code, and
the model only ever gets to fill in the sentence.

**Two channels, one store.**

  · `ambient` — the display line. Written when the model finds something, read
    by `GET /proactive/current`, expires after ~30 minutes because an
    observation is a claim about a MOMENT and goes from useful to wrong as that
    moment recedes.
  · `whatsapp` — the silence reach-out. When the sensors AND the message log
    have been quiet for hours during waking hours, nobody is looking at the
    ambient display, so a line placed there is a line placed in an empty room.
    Gooni texts instead. Deterministic text, no model call — see
    `_reach_out_text`.

**The honesty rules, each the inverse of a way this could lie.**

  1. **Absence of sensor data is not evidence of absence of the human.** Every
     downstream claim is qualified by what the sensors actually observed;
     `activity_context` already phrases its own coverage that way and this block
     renders it verbatim rather than re-deriving a cheerier version.
  2. **No presence, no observation.** With no sensor activity for hours and no
     live focus session, there is no evidence Daniel is even here — so the tick
     does not spend a model call inventing a remark for an empty chair. That
     same condition is what the reach-out reads.
  3. **A dismissal means something.** A near-twin of a dismissed observation is
     suppressed for `DISMISS_COOLDOWN`, longer than the plain repeat window, so
     waving a line away buys real quiet instead of a fifteen-minute reprieve.
  4. **One live line at a time.** If an observation is already on screen the
     tick makes NO model call at all. Cheaper, and it stops the display becoming
     a feed.
  5. **A stamp is written only after delivery.** The once-per-day reach-out
     marker is the row itself, written after Meta accepts — a stamp written
     first burns the day on a message that never arrived (the 2026-06-10 nudge
     audit's exact failure).

Read-only against everything else: no Trackable, no Promise, no Message except
the assistant turn a delivered reach-out records on its own WhatsApp thread.
"""

from __future__ import annotations

import os
import random
import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Message, ProactiveObservation, Settings

# ── cadence + budget ─────────────────────────────────────────────────────────

# How often the loop ticks. Env-configurable rather than a Settings column: the
# knob you want to reach without a redeploy is on/off, and that one IS a Settings
# column. Clamped, because a 10-second cadence is a bill, not a setting.
DEFAULT_INTERVAL_MINUTES = 15
MIN_INTERVAL_MINUTES = 5
MAX_INTERVAL_MINUTES = 180

# How long an observation stays on screen. Past this it is a claim about a
# moment that has passed.
DEFAULT_TTL_MINUTES = 30
MIN_TTL_MINUTES = 5
MAX_TTL_MINUTES = 720

# The cheap model. Quality bar is low by design — the hard part (deciding
# whether to speak) is deterministic and upstream of this call.
DEFAULT_MODEL = "gpt-4o-mini"

# Hard ceiling on the rendered context, in characters. ~4 chars/token, so this
# is ~450 tokens — inside the 500-token budget with room for the section that
# announces its own truncation.
MAX_CONTEXT_CHARS = 1800

# One sentence. Longer than this and the model has started explaining itself.
MAX_OBSERVATION_CHARS = 200

# Rows older than this are pruned on tick. Kept long enough to answer "is the
# asymmetric-value rule holding?" over a few weeks of real use.
RETENTION_DAYS = 30

# ── the anti-treadmill rules ─────────────────────────────────────────────────

# A near-twin of anything said in this window is suppressed. Three hours is long
# enough that the situation has genuinely moved on before Gooni says a similar
# thing again.
REPEAT_WINDOW = timedelta(hours=3)
# ...and doubled when the twin was DISMISSED. A dismissal that bought fifteen
# minutes of quiet is not a dismissal.
DISMISS_COOLDOWN = timedelta(hours=6)
# Jaccard over content words. 0.6 is deliberately loose: the failure being
# prevented is the same remark with a bigger number in it, and numbers are
# stripped before comparison for exactly that reason.
DUPLICATE_THRESHOLD = 0.6

# ── presence ─────────────────────────────────────────────────────────────────

# Nothing from any sensor for this long, with no live focus session, and the
# tick stops trying to observe: there is no evidence Daniel is at the machine,
# and a remark aimed at an empty chair is worse than silence. Deliberately
# LONGER than a lunch break — "nothing observed in 45m — stepped away?" is a
# good observation and must still be reachable.
PRESENCE_GAP = timedelta(hours=2)

# How long the sensors must have said nothing before the context MENTIONS it.
#
# `activity_context` only reports quiet it can see inside its own 30-minute
# window, so a 45-minute absence renders as an EMPTY activity section — the one
# shape that reads identically to "the extension isn't installed". This floor is
# what turns that silence back into a stated fact, and it is a DETERMINISTIC
# gate on purpose: below it, a gap is the ordinary seam between two intervals,
# and letting the model decide produced exactly the "nothing observed in the
# last 3m" line now sitting in the prompt's BAD list.
ABSENCE_FLOOR = timedelta(minutes=20)

# ── the silence reach-out ────────────────────────────────────────────────────

# How much quiet counts as "genuinely gone", measured across BOTH the device
# sensors and the message log — a WhatsApp conversation is not silence.
SILENCE_HOURS = 3
# Waking hours in Daniel's local timezone, inclusive of the start hour and
# exclusive of the end. A 4am "yo what's goin on today" is a bad friend.
WAKING_START_HOUR = 9
WAKING_END_HOUR = 23
# Meta's freeform rule: outside 24h of the user's last inbound message, only
# approved templates may be sent. We do not have templates, so outside the
# window Gooni stays quiet rather than firing a send Meta will reject.
WA_CUSTOMER_WINDOW = timedelta(hours=24)

CHANNEL_AMBIENT = "ambient"
CHANNEL_WHATSAPP = "whatsapp"

# The one prompt clause the staleness net asserts by identity rather than by
# substring, so rewording it has to be a deliberate edit in both places.
STALE_LABELS_IN_PROMPT = "READ THE AGE LABELS."


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except (TypeError, ValueError):
        print(f"[proactive] {name}={raw!r} is not an int; using {default}")
        return default


def interval_minutes() -> int:
    return _int_env(
        "PROACTIVE_INTERVAL_MIN",
        DEFAULT_INTERVAL_MINUTES,
        MIN_INTERVAL_MINUTES,
        MAX_INTERVAL_MINUTES,
    )


def ttl_minutes() -> int:
    return _int_env(
        "PROACTIVE_TTL_MIN", DEFAULT_TTL_MINUTES, MIN_TTL_MINUTES, MAX_TTL_MINUTES
    )


def model_name() -> str:
    return os.getenv("PROACTIVE_MODEL") or DEFAULT_MODEL


def is_enabled(db: Session) -> bool:
    """Two switches, and the env one WINS.

    The Settings column is the everyday knob (flip it from the UI the moment the
    loop says something stupid). The env var is the prod stop that must work when
    the thing you want to stop is the thing writing to the database — set
    GOONI_PROACTIVE_DISABLED=1 and redeploy, no DB write required.

    Read EVERY tick rather than once at boot, so flipping the setting takes
    effect within one cadence instead of at the next restart.
    """
    if (os.getenv("GOONI_PROACTIVE_DISABLED") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return False
    try:
        s = db.query(Settings).first()
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] settings read failed: {e}")
        return False
    if s is None:
        # No settings row yet (fresh DB). Default ON matches the column default.
        return True
    return bool(s.proactive_enabled)


# ── the prompt ───────────────────────────────────────────────────────────────

# Every line of this prompt was put there by a live failure, and the two big
# ones pull in OPPOSITE directions, which is why it reads the way it does.
#
#   · Concrete examples let a cheap model lift a SUBJECT it was never shown
#     ("calories are at the limit" against a context about Chrome and YouTube).
#     Replacing them with <placeholders> fixed that instantly.
#   · ...and cost the model every sense of what "worth saying" MEANS. With only
#     shapes to copy, five consecutive live ticks on a mediocre context produced
#     five observations — "you have 3h until X is due" (one fact, already on the
#     dashboard), "nothing has been observed in the last 3m" (three minutes is
#     not an absence). It never once chose NONE.
#
# So the examples are concrete again — they carry the QUALITY BAR, and only an
# example can — with the lifting risk handled two other ways: an explicit "these
# are from another day, every noun must come from the CONTEXT" rule, and the
# deterministic `is_grounded` backstop behind it.
#
# The GATE is the other half. "NONE is usually right" is a vibe, and a model
# straining to be useful will talk past a vibe every time; TWO FACTS FROM
# DIFFERENT PARTS OF THE CONTEXT is a test it can actually apply, and it is also
# the honest definition of asymmetric value — one fact from one place is
# something Daniel can already read off a screen.
PROACTIVE_PROMPT = """You are Gooni's proactive layer.

Daniel has NOT asked you anything. This is a line you may place on his ambient
display, or not place at all. He is not waiting for it and will not miss it.

The only reason to place one is ASYMMETRIC VALUE: something you can see that he
plausibly cannot, or has lost track of. The gate below is what that means in
practice — apply the gate, not your own sense of what might be helpful.

THE GATE. Speak ONLY if the context contains one of these tensions. Check them
in order, name the one you found to yourself, and if none holds, answer NONE.

  A. A FOCUS SESSION IS ACTUALLY RUNNING (the context has a "focus session on
     ..." line) on one commitment, AND his attention — apps/sites — is on
     something else that is NOT that commitment, AND another commitment is due
     within 3 HOURS. Say both halves: what he's on, and what's due. Pending or
     open commitments with no session running are NOT off-task — there is
     nothing to be off of.
  B. His attention has been on ONE thing for 45 MINUTES OR MORE, and there is a
     commitment it lines up with or cuts against.
  C. The context itself reports that nothing was observed, and a commitment is
     running. A few minutes between sensor readings is NOT an absence.
  D. A trackable with a target is already met or already blown, and the day is
     not over.

Nothing else qualifies. Three things that look like tensions and are not:
  · a deadline ON ITS OWN, however soon — the horizon is already on his screen.
    If the only thing you can name is when something is due, answer NONE.
  · a commitment due in more than 3 hours, whatever he happens to be doing.
    There is no tension yet; he has the afternoon.
  · open commitments sitting on the dashboard while NO focus session is
    running. Having tasks is not being off-task — he has to actually be
    mid-session on something for tension A to apply.

NONE is the correct answer most of the time. A line that fires every 15 minutes
stops being read, and then the useful one gets ignored too.

GOOD — these are from ANOTHER DAY, with other data. Copy the SHAPE, never the
subject: every app, site, commitment and number you name must appear in the
CONTEXT below.
  focus session on sysdesign is 2h in and clean — the review is due at 15:00.
  25m on youtube, sir. the sysdesign review is due in 3h.
  nothing observed for 45m — stepped away mid-session?

BAD — every one of these is a real answer a model gave here, and every one is
worse than silence:
  you're coding right now.               <- he can see that
  you have 5 promises open.              <- the dashboard already says so
  you have 3h until "x" is due.          <- ONE fact, and it's on his screen
  nothing observed in the last 3m.       <- 3 minutes is not an absence
  calories are at the limit.             <- nothing in the context said so
  you have not logged any trackables.    <- the context says otherwise; read it
  keep up the good work.                 <- encouragement is not information
  you seem productive today.             <- a judgement, not an observation
  here is a summary of your day.         <- restating the context below
  you have been browsing for 6m.         <- name the site, the context has it
  you have 3 open commitments right now  <- tasks existing isn't off-task; no
    and no focus session running.           session running means tension A
                                             doesn't apply — answer NONE

RULES
  - ONE sentence. Under 140 characters. No preamble, no sign-off, no emoji.
  - Voice: dry, precise, lowercase, British-butler restraint. "sir" at most
    once, and only if it lands. Never chirpy.
  - NAME THE SPECIFIC SITE OR APP from the context, never the generic category.
    "you've been on instagram for 6m" — not "you have been browsing for 6m".
    "40m in cursor" — not "40m on your computer". The context names them; use
    the name it gives you.
  - EVERY app, site, commitment, metric and number you name must appear in the
    CONTEXT below. If you cannot point at the line that supports a claim, you
    do not get to make it — answer NONE instead.
  - Never contradict the context. If it says four trackables are logged, you do
    not get to say none are.
  - Assert ONLY what the context states. If a line says the sensors observed
    nothing, that is the SENSORS being quiet — it is NOT evidence he was idle,
    and you must not say he was.
  - READ THE AGE LABELS. The sensor section is stamped with how old its data is
    ("as of 4m ago", "stale — last data 2h ago"), and a stale layer is written
    as "apps — last seen 20m ago: cursor". That is what he WAS doing. Never
    narrate it as what he is doing now.
  - No score, no percentage, no productivity verdict, no ranking his
    commitments against one another.
  - If all you can do is summarise the context, answer NONE.

CONTEXT
{context}

Answer with the single observation, or exactly: NONE"""


# ── context assembly ─────────────────────────────────────────────────────────


def _as_naive_utc(dt):
    """Storage convention is naive UTC, but `Message.created_at` is declared
    `DateTime(timezone=True)` and comes back aware on some backends. Comparing
    the two raises, so every stamp crossing into this module goes through here.
    """
    if dt is None:
        return None
    if dt.tzinfo is not None:
        from datetime import timezone as _tz

        return dt.astimezone(_tz.utc).replace(tzinfo=None)
    return dt


def to_local(db: Session, when: datetime):
    """A naive-UTC instant → the same instant in Daniel's configured zone.

    Every time-of-day question in this module — is it waking hours, which local
    day is this — resolves against the TICK's `now`, never against the wall
    clock. Reading `local_now(db)` for the hour while measuring silence from
    `now` would be two clocks answering one question: identical in production
    where they agree, and wrong the moment they don't (a replayed tick, a test,
    a retry). It is the same frozen-vs-live-clock class of bug the whoop tile's
    age and the focus day-key have each been bitten by, from the other side.

    Only the ZONE comes from `local_now`, so its resolution + fallback stay
    single-owned in `common`.
    """
    from datetime import timezone as _tz

    from ..common import local_now

    tz = local_now(db).tzinfo
    return when.replace(tzinfo=_tz.utc).astimezone(tz)


def last_sensor_signal(db: Session) -> datetime | None:
    """When either attention sensor last saw anything end. None = never.

    Two indexed `ORDER BY started_at DESC LIMIT 1` reads, the same shape
    `activity_service.current_activity` uses — the newest-started interval is
    the newest-ended one in practice, because intervals close on every switch.
    """
    from ..db.models import AppInterval, BrowserInterval

    ends: list[datetime] = []
    for model in (AppInterval, BrowserInterval):
        try:
            row = db.query(model).order_by(model.started_at.desc()).first()
        except Exception as e:  # pragma: no cover — defensive
            print(f"[proactive] sensor read failed ({model.__tablename__}): {e}")
            continue
        if row is not None and row.ended_at is not None:
            ends.append(_as_naive_utc(row.ended_at))
    return max(ends) if ends else None


def last_message_at(db: Session) -> datetime | None:
    """When Daniel last SAID anything, on any channel. A conversation is not
    silence, so the reach-out has to see it."""
    try:
        row = (
            db.query(Message.created_at)
            .filter(Message.role == "user")
            .order_by(Message.created_at.desc())
            .first()
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] message read failed: {e}")
        return None
    return _as_naive_utc(row[0]) if row and row[0] else None


def _clip(lines: list[str], max_chars: int) -> tuple[list[str], bool]:
    """Keep whole lines in order until the budget runs out.

    Announces the cut rather than swallowing it — a truncated context read by
    the model as the whole context is how a proactive line ends up confidently
    wrong about a day it was only shown half of.
    """
    out: list[str] = []
    used = 0
    for line in lines:
        cost = len(line) + 1
        if used + cost > max_chars:
            return out, True
        out.append(line)
        used += cost
    return out, False


def build_context(db: Session, *, now: datetime | None = None) -> dict:
    """Everything the tick knows, as prompt lines plus the gates' inputs.

    Composed entirely of surfaces that already exist and already carry their own
    honesty rules — `overlay_service`'s ranked horizon and trackable fold via the
    prompt block that already renders them, and `activity_context`'s device
    summary. Nothing here re-derives a ranking or invents a number; a second
    cascade is how two surfaces drift into disagreeing.
    """
    now = now or datetime.utcnow()
    lines: list[str] = []

    # What the sensors saw, and the live session if there is one. This block
    # already refuses to claim a session from a stale control blob, already
    # reports coverage as a claim about the SENSORS, and already flags salvaged
    # spans as a floor — so it is rendered, not re-read.
    activity_lines: list[str] = []
    focus = None
    freshness = None
    observed_nothing = True
    try:
        from . import activity_context

        summary = activity_context.build_activity_summary(db, now=now)
        activity_lines = activity_context.render_activity_lines(summary)
        focus = summary.get("focus")
        # The AGE LABEL — `as of 4m ago` / `stale — last data 2h ago`. Rendered
        # into the section header exactly as the chat state block does, because
        # a proactive claim built on a 40-minute-old app switch is the single
        # most embarrassing thing this surface can say. `_layer_line` already
        # reframes a stale layer as `apps — last seen 20m ago: cursor` rather
        # than a doing-line; this is the same signal one level up.
        freshness = activity_context.freshness_suffix(summary)
        # Derived from the SUMMARY, not by string-matching the render: the "no
        # recent activity data" sentinel is a rendering decision that can be
        # reworded, and this is the condition behind it.
        observed_nothing = summary.get("observed_seconds", 0) <= 0 and not focus
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] activity context failed: {e}")

    sensor_end = last_sensor_signal(db)

    header = "what the sensors saw (last 30m"
    header += f", {freshness})" if freshness else ")"
    header += ":"

    if observed_nothing and sensor_end is not None and now - sensor_end >= ABSENCE_FLOOR:
        # `render_activity_lines` says "no recent activity data" here, which is
        # the right answer for the chat block and one word short for this one: a
        # dead extension and a man who walked away are the same rows, and only
        # HOW LONG separates a fresh gap from a dark sensor. So the concrete gap
        # replaces the sentinel — still phrased as a fact about the SENSORS,
        # never about the human.
        from .activity_context import fmt_dur

        lines.append(header)
        lines.append(
            "- nothing at all in this window; the last thing they observed ended "
            f"{fmt_dur((now - sensor_end).total_seconds())} ago"
        )
        activity_lines = lines[-1:]  # so `has_activity` reflects it
    elif activity_lines:
        lines.append(header)
        lines.extend(activity_lines)

    # The ranked horizon + today's trackable targets, rendered by the block the
    # chat prompt already uses. One renderer, so a promise reads identically
    # whether Gooni was asked or volunteered.
    horizon_lines: list[str] = []
    try:
        from .orchestrator.prompt_blocks import _build_overlay_block

        block = _build_overlay_block(db)
        # Its own `[...]` header is written for the CHAT model and tells it not
        # to turn any of this into an unprompted nag — advice that is exactly
        # backwards here, where unprompted is the entire job. The DATA lines are
        # what's shared; the framing belongs to each caller.
        horizon_lines = [
            ln
            for ln in (block or "").splitlines()
            if ln.strip() and not ln.lstrip().startswith("[")
        ]
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] overlay block failed: {e}")

    if horizon_lines:
        lines.append("what he has committed to:")
        lines.extend(horizon_lines)

    # The wall clock, in HIS timezone. Without it "the review is due at 15:00"
    # is not an observation, because the model cannot tell whether that is four
    # hours away or four hours gone.
    try:
        lines.append(f"local time: {to_local(db, now):%H:%M on %a %d %b}")
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] local time failed: {e}")

    clipped, truncated = _clip(lines, MAX_CONTEXT_CHARS)
    if truncated:
        clipped.append("(context truncated — this is not everything)")

    msg_at = last_message_at(db)
    signals = [t for t in (sensor_end, msg_at) if t is not None]

    return {
        "lines": clipped,
        "text": "\n".join(clipped),
        "truncated": truncated,
        "has_activity": bool(activity_lines),
        "has_commitments": bool(horizon_lines),
        "focus": focus,
        "last_sensor_signal": sensor_end,
        "last_message_at": msg_at,
        # The newest evidence Daniel exists, from any source.
        "last_signal": max(signals) if signals else None,
        "now": now,
    }


def _present(ctx: dict) -> bool:
    """Is there any evidence Daniel is at the machine right now?

    A live focus session counts on its own — `activity_context` only claims one
    from a server-stamped, in-window `control_at`, so it cannot be a ghost of a
    tab closed last Tuesday.
    """
    if ctx.get("focus"):
        return True
    last = ctx.get("last_signal")
    if last is None:
        return False
    return (ctx["now"] - last) <= PRESENCE_GAP


# ── dedup ────────────────────────────────────────────────────────────────────

_WORD_RE = re.compile(r"[a-z]+")
# Function words carry no topic, and leaving them in inflates every pairwise
# score toward the threshold from below.
_STOPWORDS = frozenset(
    """a an and are as at be been but by for from had has have he her him his i
    if in into is it its me my no not of on or our out over should sir so than
    that the their them then there these they this to too up was we were what
    when which while who will with you your""".split()
)


def _tokens(text: str, *, min_len: int = 1) -> set[str]:
    """Content words only, digits dropped.

    Dropping digits is the load-bearing part: the repeat this exists to catch is
    the same remark with a bigger number in it ("25m on youtube" at 14:00,
    "40m on youtube" at 14:15). Comparing those as different sentences would let
    the display nag on a fifteen-minute cycle, which is how a signal stops being
    read.

    `min_len` drops the unit fragments the digit-stripping leaves behind ("25m"
    → "m", "3h" → "h"). Harmless for dedup, but they'd pad the grounding ratio
    with two tokens that are in every context by construction.
    """
    return {
        w
        for w in _WORD_RE.findall((text or "").lower())
        if w not in _STOPWORDS and len(w) >= min_len
    }


def similarity(a: str, b: str) -> float:
    """Jaccard over content words. 1.0 = same words, 0.0 = nothing shared."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_repeat(db: Session, content: str, *, now: datetime) -> ProactiveObservation | None:
    """The near-twin this would repeat, or None.

    Dismissed twins get the longer cooldown. That asymmetry is the entire
    meaning of the dismiss button: without it, waving a line away buys exactly
    one tick of quiet and the loop says the same thing again.
    """
    horizon = now - max(REPEAT_WINDOW, DISMISS_COOLDOWN)
    try:
        recent = (
            db.query(ProactiveObservation)
            .filter(ProactiveObservation.created_at >= horizon)
            .order_by(ProactiveObservation.created_at.desc())
            .limit(50)
            .all()
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] repeat check failed: {e}")
        return None

    for row in recent:
        created = _as_naive_utc(row.created_at) or horizon
        if row.dismissed:
            # Measured from the DISMISSAL: waving something away at the end of
            # its window should buy the same quiet as waving it away at the
            # start.
            since = _as_naive_utc(row.dismissed_at) or created
            window = DISMISS_COOLDOWN
        else:
            since, window = created, REPEAT_WINDOW
        if now - since > window:
            continue
        if similarity(content, row.content) >= DUPLICATE_THRESHOLD:
            return row
    return None


# ── the model call ───────────────────────────────────────────────────────────

_NONE_RE = re.compile(r"^\W*none\b", re.IGNORECASE)


def parse_reply(raw: str | None) -> str | None:
    """The model's answer → an observation, or None.

    Fails CLOSED in every ambiguous direction. An empty string is what
    `generate_simple_completion` returns when the API call itself failed, and a
    failed call is not evidence that there was something to say — silence is the
    only honest rendering of "we don't know".
    """
    text = (raw or "").strip()
    if not text:
        return None
    # Strip a wrapping quote pair the model sometimes adds around its sentence.
    if len(text) >= 2 and text[0] in "\"'" and text[-1] == text[0]:
        text = text[1:-1].strip()
    if not text or _NONE_RE.match(text):
        return None
    # Collapse a multi-line answer to its first non-empty line — the prompt asks
    # for one sentence, and a model that ignored that is not owed the rest.
    text = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    if not text or _NONE_RE.match(text):
        return None
    if len(text) > MAX_OBSERVATION_CHARS:
        cut = text[:MAX_OBSERVATION_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:-")
        text = (cut or text[:MAX_OBSERVATION_CHARS]) + "…"
    return text


# ── grounding: the deterministic backstop ────────────────────────────────────
# The prompt asks the model to assert only what the context states. This checks
# whether it did, because "asked nicely" is not evidence.
#
# The failure it exists to catch was found on the FIRST live tick, not imagined:
# handed a context about Chrome, YouTube and one due promise, gpt-4o-mini
# answered "calories are at the limit and it is 12:41." — fluent, correctly
# voiced, in the right shape, and about a metric that appeared nowhere in what
# it was shown. It had recognised the GOOD examples as templates and refilled
# one with a number it did have (the clock). That is the single worst output
# this feature can produce: a confident, plausible, unfalsifiable-at-a-glance
# claim sitting on the ambient display all day.
#
# So the examples were rewritten with placeholder subjects AND this check went
# in behind them — the same belt-and-braces the verify rail uses, where the LLM
# `_VERIFY_PROMPT` and the deterministic `_deterministic_unbacked_check` both
# read the same evidence and the deterministic one has the last word.
#
# It is a WORD-OVERLAP check, deliberately crude. It cannot tell a subtly wrong
# claim from a right one; what it can do is catch a subject that was never in
# the room, which is the failure mode a cheap model with vivid examples actually
# has. Its errors are one-directional by construction: a heavily-paraphrased but
# true observation is dropped, and dropping it costs a moment of silence — which
# is what this surface does by default anyway.
GROUNDING_MIN_OVERLAP = 0.5
# Below this length a token is a unit or an article fragment, not a subject.
GROUNDING_MIN_TOKEN = 3


def grounding_overlap(content: str, context: str) -> float:
    """Fraction of the observation's substantive words that appear in the
    context. 1.0 = every noun it used came from what it was shown."""
    said = _tokens(content, min_len=GROUNDING_MIN_TOKEN)
    if not said:
        return 0.0
    seen = _tokens(context, min_len=GROUNDING_MIN_TOKEN)
    return len(said & seen) / len(said)


def is_grounded(content: str, context: str) -> bool:
    return grounding_overlap(content, context) >= GROUNDING_MIN_OVERLAP


def _call_model(prompt: str) -> str:
    from ..llm.client import llm_client

    # Low temperature on purpose. This is a GATE with a sentence attached, not a
    # writing task — the creative range is a liability here, and warmth measured
    # in live ticks was the model reaching for something to say rather than
    # answering NONE.
    return llm_client.generate_simple_completion(
        prompt,
        max_tokens=80,
        temperature=0.2,
        model=model_name(),
    )


# ── the silence reach-out ────────────────────────────────────────────────────

# DETERMINISTIC, not generated, and that is a decision rather than a shortcut.
# The trigger for this message is the ABSENCE of signal, so there is nothing to
# condition a generation on — a model handed an empty context produces exactly
# the "you have 5 promises open" restatement the ambient side spends a whole
# prompt refusing. Tone is the entire requirement here, a template guarantees
# it, and an outbound message to a real phone number is the last place worth
# spending hallucination risk. Varied by daypart plus a random pick so a week of
# quiet afternoons doesn't read as a cron job.
_REACH_OUT = {
    "morning": [
        "yo dani what's goin on today? fill me up",
        "morning — what's the plan today?",
        "hey, quiet one so far. what are we doing today?",
    ],
    "afternoon": [
        "yo what's goin on today? been quiet on my end",
        "hey — you've gone dark on me. what's happening?",
        "oi. what are you up to?",
    ],
    "evening": [
        "yo how'd today go?",
        "hey — quiet day from where i'm sitting. what happened?",
        "evening. what did you get up to?",
    ],
}


def _daypart(hour: int) -> str:
    if hour < 12:
        return "morning"
    if hour < 17:
        return "afternoon"
    return "evening"


def _reach_out_text(local_hour: int) -> str:
    return random.choice(_REACH_OUT[_daypart(local_hour)])


def _wa_target(channel) -> str | None:
    """The one allowlisted handle to text. Single-tenant, same assumption
    `fly_revive` makes — multiple handles would need per-conversation handle
    tracking, and Daniel is the only recipient."""
    allowed = getattr(channel, "_allowed", None) or set()
    return next(iter(allowed), None)


def wa_window_open(db: Session, *, now: datetime) -> bool:
    """Is Meta's 24h freeform window open?

    Outside 24h of Daniel's last inbound WhatsApp message, only pre-approved
    template messages may be sent. Gooni has no templates, so outside the window
    the honest move is to stay quiet — firing a send Meta will reject would burn
    the day's one reach-out on a message that never arrives.
    """
    from ..db.models import Conversation

    try:
        row = (
            db.query(Message.created_at)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .filter(Conversation.source == CHANNEL_WHATSAPP)
            .filter(Message.role == "user")
            .order_by(Message.created_at.desc())
            .first()
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] wa window read failed: {e}")
        return False
    last = _as_naive_utc(row[0]) if row and row[0] else None
    if last is None:
        return False
    return (now - last) <= WA_CUSTOMER_WINDOW


def reached_out_today(db: Session, *, now: datetime) -> bool:
    """Has a reach-out already been DELIVERED this local day?

    Local day, not a rolling 24h: "max once per day" is a claim about Daniel's
    calendar, and a rolling window would drift the send an hour later every day
    until it fell out of waking hours entirely.

    The day is derived from `now` (see `to_local`), not from the wall clock —
    `_store` stamps `created_at=now`, so a day computed from a different clock
    would look for the row in a day the row was never written into.
    """
    from ..common import local_day_bounds

    try:
        local = to_local(db, now)
        start, end = local_day_bounds(local.tzinfo, local.date())
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] local day bounds failed: {e}")
        start, end = now - timedelta(days=1), now + timedelta(days=1)
    try:
        return (
            db.query(ProactiveObservation.id)
            .filter(ProactiveObservation.channel == CHANNEL_WHATSAPP)
            .filter(ProactiveObservation.created_at >= start)
            .filter(ProactiveObservation.created_at < end)
            .first()
            is not None
        )
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] reach-out day check failed: {e}")
        return True  # fail CLOSED — a duplicate text is worse than a missed one


def _reach_out(db: Session, ctx: dict, *, channel=None, now: datetime) -> dict:
    """The silence branch: text Daniel instead of writing to a display nobody
    is looking at.

    Every gate is deterministic and every one of them is a reason to stay quiet.
    Returns the tick result dict; the caller does not need to know which gate
    stopped it beyond the `status`.
    """
    last = ctx.get("last_signal")
    if last is None:
        # Never a single sensor row or message. That is a fresh install, not a
        # quiet day, and "yo what's goin on" to someone who has never spoken to
        # this bot is the wrong first contact.
        return {"status": "skipped_no_history", "observation": None}

    quiet_for = now - last
    if quiet_for < timedelta(hours=SILENCE_HOURS):
        return {"status": "skipped_not_silent", "observation": None}

    try:
        local = to_local(db, now)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] local clock failed: {e}")
        return {"status": "skipped_no_clock", "observation": None}

    if not (WAKING_START_HOUR <= local.hour < WAKING_END_HOUR):
        return {"status": "skipped_asleep", "observation": None}

    if reached_out_today(db, now=now):
        return {"status": "skipped_already_reached_out", "observation": None}

    if channel is None:
        # Lazy: messaging imports the orchestrator, which imports services.
        from .messaging.whatsapp import whatsapp_channel

        channel = whatsapp_channel

    target = _wa_target(channel)
    if not target:
        return {"status": "skipped_wa_unconfigured", "observation": None}

    if not wa_window_open(db, now=now):
        print(
            "[proactive] silence detected but the 24h WhatsApp window is shut — "
            "staying quiet (no approved template to fall back on)"
        )
        return {"status": "skipped_wa_window_closed", "observation": None}

    text = _reach_out_text(local.hour)
    try:
        delivered = channel.send(target, channel.format_outbound(text))
    except Exception as e:
        print(f"[proactive] reach-out send raised: {e}")
        delivered = False

    if not delivered:
        # No row. The once-per-day marker IS the row, so writing one here would
        # spend the day's reach-out on a message Meta refused.
        print("[proactive] reach-out not delivered; the day's send is still owed")
        return {"status": "reach_out_failed", "observation": None}

    # Record it as a real assistant turn on the WhatsApp thread, so the message
    # log shows what Gooni said and a reply lands in the right conversation.
    try:
        from .conversation_service import conversation_service

        conv = conversation_service.find_or_create_session(CHANNEL_WHATSAPP, db)
        conversation_service.add_message(conv.id, "assistant", text, db)
    except Exception as e:
        print(f"[proactive] reach-out transcript record failed: {e}")

    row = _store(db, text, ctx=ctx, now=now, channel=CHANNEL_WHATSAPP)
    print(
        f"[proactive] reached out on whatsapp after "
        f"{quiet_for.total_seconds() / 3600:.1f}h of silence: {text!r}"
    )
    return {"status": "reached_out", "observation": serialize(row)}


# ── storage + reads ──────────────────────────────────────────────────────────


def _store(
    db: Session,
    content: str,
    *,
    ctx: dict,
    now: datetime,
    channel: str = CHANNEL_AMBIENT,
) -> ProactiveObservation:
    row = ProactiveObservation(
        content=content,
        channel=channel,
        created_at=now,
        expires_at=now + timedelta(minutes=ttl_minutes()),
        dismissed=False,
        context_digest=ctx.get("text"),
        model=model_name() if channel == CHANNEL_AMBIENT else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def current(db: Session, *, now: datetime | None = None) -> ProactiveObservation | None:
    """The one observation the ambient home should be showing, or None.

    `channel == ambient` only: a delivered reach-out already reached Daniel on
    his phone, and echoing it onto the display would be the same message twice.
    """
    now = now or datetime.utcnow()
    return (
        db.query(ProactiveObservation)
        .filter(ProactiveObservation.channel == CHANNEL_AMBIENT)
        .filter(ProactiveObservation.dismissed.is_(False))
        .filter(ProactiveObservation.expires_at > now)
        .order_by(ProactiveObservation.created_at.desc())
        .first()
    )


def dismiss(db: Session, obs_id: int, *, now: datetime | None = None) -> ProactiveObservation | None:
    now = now or datetime.utcnow()
    row = (
        db.query(ProactiveObservation)
        .filter(ProactiveObservation.id == obs_id)
        .first()
    )
    if row is None:
        return None
    if not row.dismissed:
        row.dismissed = True
        row.dismissed_at = now
        db.commit()
        db.refresh(row)
    return row


def recent(db: Session, *, limit: int = 20) -> list[ProactiveObservation]:
    """Newest-first history across both channels — the tuning read. Not a
    surface: this is how you answer "is the asymmetric-value rule holding?"
    without waiting at the display for an afternoon."""
    return (
        db.query(ProactiveObservation)
        .order_by(ProactiveObservation.created_at.desc())
        .limit(max(1, min(200, limit)))
        .all()
    )


def prune(db: Session, *, now: datetime | None = None) -> int:
    """Drop rows past RETENTION_DAYS. One indexed DELETE per tick."""
    now = now or datetime.utcnow()
    cutoff = now - timedelta(days=RETENTION_DAYS)
    try:
        n = (
            db.query(ProactiveObservation)
            .filter(ProactiveObservation.created_at < cutoff)
            .delete(synchronize_session=False)
        )
        if n:
            db.commit()
        return n
    except Exception as e:  # pragma: no cover — defensive
        print(f"[proactive] prune failed: {e}")
        db.rollback()
        return 0


def serialize(row: ProactiveObservation | None, *, now: datetime | None = None) -> dict | None:
    if row is None:
        return None
    now = now or datetime.utcnow()
    created = _as_naive_utc(row.created_at)
    expires = _as_naive_utc(row.expires_at)
    return {
        "id": row.id,
        "content": row.content,
        "channel": row.channel,
        "created_at": created.isoformat() if created else None,
        "expires_at": expires.isoformat() if expires else None,
        "dismissed": bool(row.dismissed),
        "age_seconds": max(0.0, (now - created).total_seconds()) if created else None,
    }


# ── the tick ─────────────────────────────────────────────────────────────────


def tick(db: Session, *, now: datetime | None = None, generate=None) -> dict:
    """One cadence step. AT MOST one model call, often zero.

    `generate` is injectable so the whole decision ladder — every gate, the
    dedup, the reach-out — is testable with no network. Default is the real
    cheap-model call.

    Returns `{"status": str, "observation": dict | None}`. The status is the
    reason, and every non-`stored` status is a deliberate silence rather than a
    failure; the loop logs it and moves on.
    """
    now = now or datetime.utcnow()

    if not is_enabled(db):
        return {"status": "skipped_disabled", "observation": None}

    prune(db, now=now)

    # Rule 4: one live line at a time. Checked BEFORE the context is built —
    # there is no point paying for a fold, let alone a model call, to decide
    # something we already have on screen.
    live = current(db, now=now)
    if live is not None:
        return {"status": "skipped_live", "observation": serialize(live, now=now)}

    ctx = build_context(db, now=now)

    # Rule 2, and the reach-out's trigger: no evidence Daniel is here. The
    # ambient display is the wrong place to speak into, so this branch decides
    # whether to text him instead — deterministically, with no model call.
    if not _present(ctx):
        return _reach_out(db, ctx, now=now)

    if not (ctx["has_activity"] or ctx["has_commitments"]):
        # Present, but nothing to hold two facts together with.
        return {"status": "skipped_empty_context", "observation": None}

    prompt = PROACTIVE_PROMPT.format(context=ctx["text"])
    try:
        raw = (generate or _call_model)(prompt)
    except Exception as e:
        print(f"[proactive] model call failed: {e}")
        return {"status": "model_error", "observation": None}

    content = parse_reply(raw)
    if content is None:
        return {"status": "none", "observation": None}

    # Grounding BEFORE dedup: an ungrounded line must never enter the history
    # the repeat check reads, or a hallucinated subject would go on to suppress
    # the real observations that mention it.
    if not is_grounded(content, ctx["text"]):
        print(
            f"[proactive] DROPPED as ungrounded "
            f"(overlap {grounding_overlap(content, ctx['text']):.2f} < "
            f"{GROUNDING_MIN_OVERLAP}): {content!r}"
        )
        return {"status": "skipped_ungrounded", "observation": None}

    twin = is_repeat(db, content, now=now)
    if twin is not None:
        print(
            f"[proactive] suppressed as a repeat of #{twin.id} "
            f"({'dismissed' if twin.dismissed else 'recent'}): {content!r}"
        )
        return {"status": "skipped_repeat", "observation": None}

    row = _store(db, content, ctx=ctx, now=now)
    print(f"[proactive] observed: {content!r}")
    return {"status": "stored", "observation": serialize(row, now=now)}


def run_tick() -> dict:
    """Blocking tick with its own session — the background loop's entry point.

    Opens and closes its own session because the loop has no request scope, and
    runs off the event loop (`asyncio.to_thread` in `background.py`) because the
    model call is a synchronous network round trip that must not stall request
    handling.
    """
    from ..db.database import SessionLocal

    db = SessionLocal()
    try:
        return tick(db)
    finally:
        db.close()
