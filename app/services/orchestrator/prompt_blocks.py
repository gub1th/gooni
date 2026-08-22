from datetime import datetime, timedelta
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from ...llm.client import llm_client

if TYPE_CHECKING:
    from ..intent_router import RouterResult


# Above this length, raw note content is summarized before injection so the
# system prompt doesn't balloon to 5K tokens for a single note.
ENTRY_SUMMARIZE_THRESHOLD = 2000


# ── OBJECT KINDS — anti-hallucination anchor ──────────────────────────
# Auto-derived list of every object kind Gooni can actually create.
# Built once at module import by walking the tool registry for creation-
# shaped tool names plus the kinds spawned by the intent router (Promise
# isn't a tool — it's extracted from utterances). The cadence rule above
# tells the LLM never to narrate "tracked"/"logged"/"created" for
# anything not on this list — without this list the LLM cheerfully
# invents object kinds ("set a recurring alert", "saved a draft of") that
# have no backing row.
#
# Adding a new creation-shaped tool? Add its name → kind mapping below.
# The build helper drops any entry whose tool isn't actually registered
# so stale entries don't bloat the prompt.
_CREATE_TOOL_KINDS: dict[str, str] = {
    "save_memory": "Memory",
    "add_note": "Note",
    "request_feature": "Note",
    "create_calendar_event": "CalendarEvent",
    "log_trackable_entry": "TrackableEntry",  # explicit log tool (fitness auto-writer cut)
}
_ROUTER_CREATED_KINDS: tuple[str, ...] = ("Promise",)


def _build_object_kinds_block() -> str:
    try:
        from ...tools import registry as _tool_registry
    except Exception as e:
        print(f"[object_kinds_block] tool registry import failed: {e}")
        return ""
    tool_names = {t.name for t in _tool_registry}
    kinds: list[str] = []
    for name, kind in _CREATE_TOOL_KINDS.items():
        if name in tool_names and kind not in kinds:
            kinds.append(kind)
    for kind in _ROUTER_CREATED_KINDS:
        if kind not in kinds:
            kinds.append(kind)
    if not kinds:
        return ""
    return (
        "OBJECT KINDS I CAN CREATE: " + ", ".join(kinds) + ". Nothing "
        "else. If asked to create or 'track' anything not on this list, "
        "say it's not a current capability — never pretend it landed."
    )


OBJECT_KINDS_BLOCK = _build_object_kinds_block()


def _summarize_signals(signals: dict, memory_candidates: list) -> dict:
    """Compact, trace-friendly view of what extract_signals surfaced this
    turn — the payload returned as usage["signals"] for the eval/debug UI.

    Mirrors the raw extractor output minus the bulky memory-candidate
    bodies (just the count). Kept in sync with extract_signals' shape; lives
    here so handle_chat doesn't carry the ~25-line dict literal inline.
    """
    return {
        "feature_requests": [
            {"title": f["title"], "why": f.get("why", "")}
            for f in signals.get("feature_requests", [])
        ],
        "promises": [
            {
                "kind": p.get("kind", "create"),
                "utterance": p.get("utterance"),
                "match": p.get("match"),
                "cadence": p.get("cadence"),
                "cadence_target": p.get("cadence_target"),
                "due_date": p.get("due_date"),
                "due_hint": p.get("due_hint"),
            }
            for p in signals.get("promises", [])
        ],
        "reply_intent": signals.get("reply_intent", "answer"),
        "memory_count": len(memory_candidates),
    }


def _build_ack(routed: "RouterResult") -> str | None:
    """Alfred-voice ack — terse, casual, no clinical receipts.

    Contract:
      - Every persisted-object arg is a structured dict carrying the real
        DB id. The id is the INTERNAL grounding contract (so the ack helper
        can't be called for a write that didn't land) — it is NOT rendered
        to the user. Daniel called the prior "ticket #281 logged" /
        "logged: X" formats clinical; Alfred speaks plainly, not in jira-
        bot syntax. The id flows into just_extracted_block so the next-
        turn LLM has a verifiable anchor for "did this land?" reasoning,
        but the user-facing bubble stays warm.
      - One bubble. Multi-signal turns chain w/ " · " for compactness.
      - Multi-feature uses "+N more" with the category tag instead of the
        opaque "(+N)" suffix Daniel flagged.

    Returns None when no signals fired (caller falls through to LLM).
    """
    # Unpack the router result into the names the body already uses, so the
    # rendering logic below is untouched. `routed` is the single source of
    # truth for what got captured this turn (RouterResult, all-empty-list
    # defaults — so a no-signal turn renders nothing and returns None).
    captured_features = routed.captured_features
    captured_promises = routed.captured_promises
    completed_promises = routed.completed_promises
    broken_promises = routed.broken_promises
    failed_promise_actions = routed.failed_promise_actions

    def _trim(s: str, n: int = 60) -> str:
        s = (s or "").strip()
        return s if len(s) <= n else s[:n].rstrip() + "…"

    parts: list[str] = []
    if captured_features:
        titles = [
            f"\"{_trim(f.get('title'))}\""
            for f in captured_features[:3]
        ]
        n = len(captured_features)
        if n == 1:
            parts.append(f"gap noted, sir: {titles[0]}")
        elif n == 2:
            parts.append(f"gap noted, sir: {titles[0]}, {titles[1]}")
        else:
            parts.append(
                f"gaps noted, sir ({n}): {', '.join(titles)}"
            )
    if captured_promises:
        # G3.1: all promises are `active` on create — no proposed/pending
        # split. `needs_clarification` (vague-promise flag) is metadata
        # that drives a conversational clarifier appended to the ack,
        # NOT a state gate. Daniel: "it's active, then kept or broken."
        #
        # Voice-of-reason: when promise_evaluator flagged a promise, its
        # single-line suggestion appends AFTER the tracking phrase.
        # Gooni pushes back conversationally; the row is already
        # persisted by the time we render this.
        def _voice_tail(prom: dict) -> str:
            v = prom.get("voice_of_reason")
            if not v:
                return ""
            sug = (v.get("suggestion") or "").strip()
            return f" — {sug}" if sug else ""

        def _clarifier_tail(prom: dict) -> str:
            """Sharp Alfred clarifier for vague promises. Asked in the
            same turn — no state-machine wait. Daniel can answer in the
            next utterance to sharpen, or ignore and the promise stays
            vague (no penalty, just lower-quality)."""
            if not prom.get("needs_clarification"):
                return ""
            return " — how often counts? say it specific or this stays mush."

        def _cadence_tail(prom: dict) -> str:
            """Recurring shapes read back their cadence so a wrong parse
            is visible in the ack ("gym 6x/wk" misread as daily should
            jump out)."""
            cad = prom.get("cadence") or "once"
            if cad == "daily":
                return " — daily"
            if cad == "n_per_week":
                n = prom.get("cadence_target")
                return f" — {n}x/wk" if n else " — weekly target"
            if cad == "permanent_do":
                return " — standing rule"
            if cad == "permanent_never":
                return " — standing no"
            return ""

        if len(captured_promises) == 1:
            p = captured_promises[0]
            slip = p.get("slip_count", 0) or 0
            summary = _trim(p.get("summary") or p.get("utterance") or "")
            tail = _cadence_tail(p) + _clarifier_tail(p) + _voice_tail(p)
            if slip > 0:
                parts.append(f"tracked, sir — slip #{slip + 1} on \"{summary}\"{tail}")
            else:
                parts.append(f"tracked \"{summary}\", sir{tail}")
        else:
            n = len(captured_promises)
            vague = sum(1 for p in captured_promises if p.get("needs_clarification"))
            phrase = f"tracked {n}, sir"
            if vague:
                phrase += f" ({vague} vague — sharpen or stay mush)"
            parts.append(phrase)

    # Ambient-loop v2: chat-side promise lifecycle acks. Verb-led,
    # text-quoted — Daniel needs to spot wrong cosine matches in the ack;
    # that's the safety net behind the auto-act pattern.
    completed_promises = completed_promises or []
    broken_promises = broken_promises or []
    failed_promise_actions = failed_promise_actions or []

    if completed_promises:
        texts = [
            f"\"{_trim(p.get('summary') or p.get('utterance'))}\""
            for p in completed_promises[:3]
        ]
        n = len(completed_promises)
        if n == 1:
            parts.append(f"closed {texts[0]}, sir.")
        elif n == 2:
            parts.append(f"closed {texts[0]} and {texts[1]}, sir.")
        else:
            parts.append(f"closed {n}, sir: {', '.join(texts)}")
    if broken_promises:
        texts = [
            f"\"{_trim(p.get('summary') or p.get('utterance'))}\""
            for p in broken_promises[:3]
        ]
        n = len(broken_promises)
        if n == 1:
            parts.append(f"scratched {texts[0]}, sir.")
        else:
            parts.append(f"scratched {n}, sir: {', '.join(texts)}")
    for f in failed_promise_actions[:3]:
        kind = f.get("kind", "")
        match = _trim(f.get("match", ""))
        cands = f.get("candidates") or []
        verb = {"complete": "close", "break": "scratch"}.get(kind, kind)
        if len(cands) >= 2:
            # Ambiguous — refuse to execute, ask. One wrong auto-action
            # erodes trust faster than ten correct ones.
            cand_texts = " or ".join(
                f"\"{_trim(c.get('text'))}\"" for c in cands[:2]
            )
            parts.append(f"which one to {verb} for \"{match}\"? {cand_texts}")
        elif len(cands) == 1:
            # Near miss — plausible but under the auto-close bar. Ask; do
            # NOT report it as "no match" (there is a real candidate) and
            # do NOT act (the whole point of the bar).
            parts.append(
                f"{verb} \"{_trim(cands[0].get('text'))}\" for \"{match}\", sir? "
                "not certain enough to do it myself"
            )
        else:
            # Surface no-match misses so wrong-shape extractions don't go
            # silent. Don't claim Gooni "tried" — be honest about the miss.
            parts.append(f"couldn't {verb} \"{match}\" — no match")

    # NB: fitness is no longer a router-captured signal — trackable logging
    # is an explicit log_trackable_entry tool call, so its "logged X" ack is
    # produced by the LLM reply path (backed by the tool call), not here.

    if not parts:
        return None
    return " · ".join(parts)


# ── Overlay surface — the ranked "what matters right now" block ───────
#
# overlay_service already computes the ONE deterministic ranking Gooni
# has (overdue → due ≤48h → important, each row carrying a `reason`) plus
# today's met/missed/pending trackable fold. Until this block existed
# none of it reached the model: the prompt carried an UNRANKED promise
# dump (state_block) and no target awareness at all, so "what should I
# focus on?" was answered by vibes and "how am I doing on calories?" by a
# shrug or a tool call.
#
# Read-only by contract — this block never re-implements a rule. It
# renders `overlay_service.build_overlay`'s output and the Promise
# Integrity Score route's output verbatim. If a ranking looks wrong, fix
# it in overlay_service; a second cascade here is how the two drift.
#
# Injected on EVERY source (web + bots) — same reason state_block is.
# It overlaps state_block's promise lines: same rows, so the two can
# restate but never contradict. Kept anyway because they answer
# different questions — state_block LISTS what's open, this one RANKS it
# and says why, and it is the only surface carrying today's trackable
# TARGETS (met vs missed vs still short of the floor).
OVERLAY_HORIZON_CAP = 4      # named horizon rows; the rest are counted
OVERLAY_TRACKABLE_CAP = 4    # named trackable rows; the rest are counted
OVERLAY_PENDING_CAP = 5      # names in the "not logged yet" list


def _cadence_tag(cadence: str | None, target=None) -> str:
    """Compact recurrence tag shared by every prompt block, so a promise
    reads the same whether state_block or the overlay block printed it."""
    cad = cadence or "once"
    if cad == "n_per_week":
        return f" [{target or '?'}x/wk]"
    if cad != "once":
        return f" [{cad}]"
    return ""


def _rel_span(delta_seconds: float) -> str:
    """Coarse '2d' / '5h' / '40m' for a due distance. Coarse on purpose —
    the model needs urgency, not a countdown, and precision here would
    invite it to recite a deadline to the minute.

    Rounds to nearest rather than flooring: a deadline 4h59m out reading
    'in 4h' understates urgency by an hour, and understating is the one
    direction that costs something on a horizon block."""
    mins = int(abs(delta_seconds) // 60)
    if mins >= 2880:
        return f"{int(mins / 1440 + 0.5)}d"
    if mins >= 60:
        return f"{int(mins / 60 + 0.5)}h"
    return f"{max(mins, 1)}m"


def _build_overlay_block(db) -> str:
    """Render overlay_service's ranked action horizon + today's trackable
    fold + the Promise Integrity Score as one bounded prompt block
    (~150 tokens at the caps above).

    Deterministic end to end: no LLM call, no scoring of its own. Caller
    wraps with try/except — a failure here must never block the reply.

    Only two of the four zones are rendered. `anchor` (the pinned note) is
    already reachable via the note tools and would cost prompt budget on
    every turn to restate; `whoop_select` is a display picker whose numbers
    ride the state block's feeds. Both are read and dropped on purpose —
    calling the public `build_overlay` keeps this a reader of the surface
    rather than a caller of overlay_service's privates.
    """
    from datetime import datetime as _dt

    from .. import overlay_service

    zones = overlay_service.build_overlay(db)
    now = _dt.utcnow()
    lines: list[str] = []

    # ── zone 1: the ranked action horizon ──
    horizon = zones.get("action_horizon") or []
    if horizon:
        lines.append(
            "- next up (ranked: overdue → due <=48h → important):"
        )
        for e in horizon[:OVERLAY_HORIZON_CAP]:
            summary = (e.get("summary") or e.get("utterance") or "").strip()
            if len(summary) > 50:
                summary = summary[:50].rstrip() + "…"
            reason = e.get("reason")
            due_raw = e.get("inferred_due")
            due = None
            if due_raw:
                try:
                    due = _dt.fromisoformat(due_raw)
                except (TypeError, ValueError):
                    due = None
            if reason == "overdue" and due:
                why = f"overdue by {_rel_span((now - due).total_seconds())}"
                # A due nobody chose must not read as a broken deadline —
                # same rule auto_mark_overdue honours by skipping these.
                if e.get("due_is_default"):
                    why += " (auto-set date, not his deadline)"
            elif reason == "due_soon" and due:
                why = f"due in {_rel_span((due - now).total_seconds())}"
            elif reason == "important":
                why = "flagged important"
            else:
                why = reason or ""
            tag = _cadence_tag(e.get("cadence"), e.get("cadence_target"))
            slip = e.get("slip_count") or 0
            slip_tail = f", slipped {slip}x" if slip else ""
            lines.append(f'  · "{summary}"{tag} — {why}{slip_tail}')
        cut = len(horizon) - OVERLAY_HORIZON_CAP
        if cut > 0:
            # No silent caps — a truncated list read as the whole list is
            # how "that's everything, sir" becomes a lie.
            lines.append(f"  · (+{cut} more in the horizon, lower priority)")

    # ── zone 2: today's trackables, met/missed/pending ──
    tracks = zones.get("trackables_today") or []
    if tracks:
        counts: dict[str, int] = {}
        for t in tracks:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        # 'logged' splits by whether there was a target to judge against:
        # a floor mid-day is in-progress, a target-less metric is just
        # logged. overlay_service collapses both into 'logged'.
        def _in_progress(t: dict) -> bool:
            return t["status"] == "logged" and t.get("target") is not None

        summary_bits = []
        if counts.get("met"):
            summary_bits.append(f"{counts['met']} met")
        if counts.get("missed"):
            summary_bits.append(f"{counts['missed']} missed")
        n_prog = sum(1 for t in tracks if _in_progress(t))
        if n_prog:
            summary_bits.append(f"{n_prog} in progress")
        n_logged = counts.get("logged", 0) - n_prog
        if n_logged > 0:
            summary_bits.append(f"{n_logged} logged")
        if counts.get("pending"):
            summary_bits.append(f"{counts['pending']} not logged")
        lines.append("- today's trackables: " + " · ".join(summary_bits))

        # Name the ones carrying a target — that's what turns "how am I
        # doing on calories?" into an answer instead of a tool call.
        rank = {"missed": 0, "logged": 1, "met": 2}
        judged = sorted(
            [t for t in tracks if t["status"] in ("missed", "met") or _in_progress(t)],
            key=lambda t: (rank.get(t["status"], 3), t["name"]),
        )
        for t in judged[:OVERLAY_TRACKABLE_CAP]:
            status = "in progress" if _in_progress(t) else t["status"]
            unit = f" {t['unit']}" if t.get("unit") else ""
            # overlay_service's `reason` is already "<value> vs limit
            # <target>" — rendering the value again beside it would be the
            # same number twice, and the two could only ever agree.
            lines.append(
                f"  · {t['name']}: {status} — {t.get('reason', '')}{unit}"
            )
        cut = len(judged) - OVERLAY_TRACKABLE_CAP
        if cut > 0:
            lines.append(f"  · (+{cut} more tracked today)")
        pending = [t["name"] for t in tracks if t["status"] == "pending"]
        if pending:
            shown = ", ".join(pending[:OVERLAY_PENDING_CAP])
            extra = len(pending) - OVERLAY_PENDING_CAP
            if extra > 0:
                shown += f", +{extra} more"
            lines.append(f"  · nothing logged today: {shown}")

    # ── zone 3: Promise Integrity Score ──
    # Owned by GET /promises/pis — called, not re-derived. The weighting
    # (kept +1.0 / broken -1.5) lives in exactly one place and this is a
    # read of it.
    try:
        from ...routers.promises import promise_integrity_score

        pis = promise_integrity_score(db=db)
        if pis.get("score") is not None:
            tail = ""
            if pis.get("kept_streak"):
                tail = f" · {pis['kept_streak']} kept in a row"
            lines.append(
                f"- promise integrity: {pis['score']}/100 over the last "
                f"{pis['sample_size']} resolved{tail}"
            )
    except Exception as e:
        print(f"[overlay_block] integrity score failed: {e}")

    if not lines:
        return ""
    return (
        "[what matters right now — deterministic, off Daniel's own rows. "
        "Answer \"what should I focus on\" / \"how am I doing on X\" from "
        "this, no tool call needed. Don't recite it verbatim; don't turn "
        "it into an unprompted nag.]\n" + "\n".join(lines)
    )


# ── the initiative block ──────────────────────────────────────────────
# The third altitude in the prompt, and the only one that is SYNTHESIZED
# rather than listed. state_block LISTS what is open, overlay_block RANKS
# it and says why — both answer "what is on the plate today". Neither can
# answer "what is he actually working on this month", because that is not
# a property of any row: it lives in the shape of the whole corpus.
# initiative_service clusters memories + thought-batches + active promises
# in embedding space once a day and names each cluster; this renders the
# cached result.
#
# Read-only over the cache, ALWAYS. It never clusters and never calls a
# model — a synthesis on the request path would put N model calls in front
# of every reply, which is the whole reason the snapshot exists.
#
# Injected on EVERY source, same as the other two. A bot turn is where
# this matters most: there is no UI on WhatsApp, so the model's only route
# to "you've been on interview prep all week" is the prompt.
INITIATIVE_CAP = 5           # named initiatives; the rest are counted
INITIATIVE_SUMMARY_CHARS = 130
# Past this the synthesis describes a week that has moved on. Rendered, not
# suppressed — a labeled corpus from four days ago is still broadly true
# about what Daniel is working on, and saying how old it is costs six words.
INITIATIVE_STALE_DAYS = 3


def _build_initiative_block(db) -> str:
    """Render the cached initiative snapshot as one bounded prompt block
    (~120 tokens at the cap above). Empty string when nothing has been
    synthesized yet — the block is absent rather than announcing its own
    emptiness, which would spend budget on a non-fact.

    Caller wraps with try/except: a failure here must never block a reply.
    """
    from datetime import datetime as _dt, timezone as _tz

    from .. import initiative_service

    snap = initiative_service.get_snapshot(db)
    if not snap:
        return ""
    clusters = snap.get("clusters") or []
    if not clusters:
        return ""

    lines: list[str] = []
    for i, c in enumerate(clusters[:INITIATIVE_CAP], start=1):
        label = (c.get("label") or "").strip()
        if not label:
            continue
        summary = (c.get("summary") or "").strip()
        if len(summary) > INITIATIVE_SUMMARY_CHARS:
            summary = summary[:INITIATIVE_SUMMARY_CHARS].rstrip() + "…"
        size = c.get("size") or len(c.get("items") or [])
        tail = f" ({size} items)" if size else ""
        lines.append(f"{i}. {label}{tail}" + (f": {summary}" if summary else ""))

    if not lines:
        return ""

    # No silent caps — the same rule the horizon and trackable lists follow.
    total = snap.get("total_clusters") or len(clusters)
    if total > INITIATIVE_CAP:
        lines.append(f"(+{total - INITIATIVE_CAP} more, smaller)")
    noise = (snap.get("uncategorized") or {}).get("count") or 0
    if noise:
        lines.append(f"({noise} items belong to no initiative)")

    # Age, when it is old enough to matter. A synthesis presented without a
    # date is a claim about right now, and this one is at most a day fresh
    # by construction.
    age_note = ""
    built_raw = snap.get("built_at")
    if built_raw:
        try:
            built = _dt.fromisoformat(built_raw)
            if built.tzinfo is None:
                built = built.replace(tzinfo=_tz.utc)
            days = (_dt.now(_tz.utc) - built).days
            if days >= INITIATIVE_STALE_DAYS:
                age_note = f" Synthesized {days}d ago — may have moved on."
            elif days >= 1:
                age_note = f" Synthesized {days}d ago."
        except (TypeError, ValueError):
            pass

    return (
        "[your current initiatives — synthesized from your memories, "
        "thoughts, and commitments. Use it to place what he says in "
        "context (\"this is the interview thread again\"). Don't recite "
        "the list and don't turn it into a status report."
        + age_note
        + "]\n"
        + "\n".join(lines)
    )


def _build_state_block(db) -> str:
    """Snapshot of Daniel's actionable state, injected into the master
    prompt for bot channels. Fixes the segment-#209 failure mode where
    Gooni opened "Yo" turns with a scolding guess instead of an answer
    grounded in actual todo / promise state.

    Cheap: primary todo + open count + done-today count + pending promises
    due within 24h. Caller wraps with try/except — failure here must never
    block the chat reply.
    """
    from ..promise_service import list_pending as _list_pending_promises

    lines: list[str] = []
    # Slice 6: Todo/Backlog/Friction died — active Promises ARE the
    # actionable state. Named lines for the soonest-due + important so
    # the LLM can cross-reference "imma X" utterances before claiming a
    # new capture; count line for the rest.
    try:
        promises = _list_pending_promises(db, limit=25)
    except Exception:
        promises = []
    if promises:
        from datetime import datetime as _dt, timedelta as _td
        cutoff = _dt.utcnow() + _td(hours=24)

        def _cad_tag(p) -> str:
            # Shared renderer — a promise must read the same here as in
            # the overlay block, so the format has one owner.
            return _cadence_tag(p.cadence, p.cadence_target)

        due_soon = [p for p in promises if p.inferred_due and p.inferred_due <= cutoff]
        named_ids = set()
        if due_soon:
            lines.append(f"- {len(due_soon)} promise(s) due <=24h:")
            for p in due_soon[:4]:
                named_ids.add(p.id)
                summary = p.summary or p.utterance or ""
                if len(summary) > 60:
                    summary = summary[:60].rstrip() + "…"
                slip = f", slipped {p.slip_count}x" if p.slip_count else ""
                lines.append(f'  · "{summary}"{_cad_tag(p)}{slip}')
        starred = [p for p in promises if p.is_important and p.id not in named_ids]
        if starred:
            lines.append(f"- {len(starred)} important promise(s):")
            for p in starred[:4]:
                named_ids.add(p.id)
                summary = p.summary or p.utterance or ""
                if len(summary) > 60:
                    summary = summary[:60].rstrip() + "…"
                lines.append(f'  · "{summary}"{_cad_tag(p)}')
        rest = [p for p in promises if p.id not in named_ids]
        if rest:
            named = ", ".join(
                f'"{(p.summary or p.utterance or " ")[:40]}"' for p in rest[:5]
            )
            lines.append(f"- {len(rest)} other active promise(s): {named}")

    # G3.1: lock-in is gone. Vague promises (needs_clarification=True)
    # are still active — Gooni already pushed back in the ack at create
    # time. Surface them here as a separate line so chat can re-nudge
    # if Daniel keeps ignoring the clarifier: "you've got 3 vague
    # promises sitting open. nail down what counts as kept."
    try:
        from ...db.models import Promise as _PromiseModel
        vague_rows = (
            db.query(_PromiseModel)
            .filter(
                _PromiseModel.state == "active",
                _PromiseModel.needs_clarification.is_(True),
            )
            .order_by(_PromiseModel.created_at.desc())
            .limit(5)
            .all()
        )
    except Exception:
        vague_rows = []
    if vague_rows:
        lines.append(
            f"- {len(vague_rows)} vague active promise(s) — Daniel hasn't sharpened these yet:"
        )
        for p in vague_rows[:3]:
            summary = p.summary or p.utterance or ""
            if len(summary) > 60:
                summary = summary[:60].rstrip() + "…"
            lines.append(f"  · \"{summary}\"")

    # Cal snapshot — today + next ~24h. Proactive Gooni phase 0: bot turns
    # become schedule-aware so "what's my afternoon" answers from cal, not
    # a shrug. Cached 5 min at module scope so we don't hammer Google on
    # every chat turn. Skip silently when cal is disconnected.
    try:
        cal_lines = _build_calendar_lines(db)
        for cl in cal_lines:
            lines.append(cl)
    except Exception as e:
        print(f"[state_block] calendar surface failed: {e}")

    # G4: recent-activity surface. Daniel called this out 2026-05-22 —
    # state_block was point-in-time only, so when he closed a todo via
    # dashboard then texted "finished leetcode" 2min later, Gooni had no
    # signal about the recent close and hallucinated a "match missed"
    # failure. Recent activity = signal. NO raw ids in this section
    # (alfred-voice contract); the LLM uses verb + quoted text + age to
    # reconcile what just happened with the new utterance.
    try:
        from .. import recent_activity
        recent_lines = recent_activity.build_recent_activity_lines(db)
        if recent_lines:
            lines.append("[recent — last 1h]")
            for rl in recent_lines:
                lines.append(f"- {rl}")
    except Exception as e:
        print(f"[state_block] recent_activity surface failed: {e}")

    # Life-log Phase 3: what Daniel is DOING, from the device sensors.
    #
    # Its own section rather than more lines in `[recent — last 1h]`, because
    # that block's ~8-line budget is for STATE CHANGES Gooni has to reconcile a
    # reply against (a promise closed, a trackable logged) — which is exactly
    # why `recent_activity` excludes device rows at source. Attention is a
    # different question with a different window, and folding it in would push
    # out the events the recent block exists to carry.
    #
    # Read-only and deterministic: a bounded fold over browser_intervals +
    # app_intervals plus the focus-cam control blob. It STATES what the sensors
    # saw and what the running session is FOR; it never scores the window or
    # calls the two aligned — reading alignment off the pair is the model's job.
    try:
        from .. import activity_context
        suffix, doing_lines = activity_context.build_activity_context(db)
        if doing_lines:
            header = f"[doing — last {activity_context.WINDOW_MINUTES}m, from device sensors"
            header += f" — {suffix}]" if suffix else "]"
            lines.append(header)
            lines.extend(doing_lines)
    except Exception as e:
        print(f"[state_block] activity_context surface failed: {e}")

    # Today's food ledger — the read-back surface chat was missing (conv
    # #1412-1417, 5/27). A fresh SUM each turn, so even on a turn with no new
    # fitness log Gooni can answer "did you add the cherries?" / cite the
    # running total instead of "i can't verify" or hallucinating from
    # scrollback. Item lines let it confirm a specific food landed.
    try:
        from .. import daily_metric_service as _dms
        ledger = _dms.today_food_ledger(db)
        if ledger["items"]:
            cal = f"{ledger['calories']:g}"
            prot = f"{ledger['protein']:g}"
            lines.append(f"- today's food so far: {cal} cal / {prot}g (items below)")
            for it in ledger["items"][:12]:
                lbl = (it["label"] or "")[:40]
                ic = f"{it['calories']:g}" if it["calories"] else "?"
                ip = f" / {it['protein']:g}g" if it["protein"] else ""
                lines.append(f"  · {lbl}: {ic} cal{ip}")
    except Exception as e:
        print(f"[state_block] food ledger failed: {e}")

    if not lines:
        return ""
    return "[your state right now]\n" + "\n".join(lines)


# ── Calendar surface (state_block helper) ─────────────────────────────


# Module-level cache for calendar fetches. Key is unused for now
# (single-tenant), value is (fetched_at_utc, list_of_formatted_lines).
_CAL_CACHE: dict[str, tuple[datetime, list[str]]] = {}
_CAL_TTL_SECONDS = 300  # 5 min


def _format_cal_event(ev: dict, tz: ZoneInfo) -> str | None:
    """Format one Google event row as a one-line state_block entry.
    Returns None on garbage / events we don't want surfaced (cancelled,
    declined). Prose-shape: '3:00pm — Lunch with Maya'."""
    if not isinstance(ev, dict):
        return None
    if ev.get("status") == "cancelled":
        return None
    # Skip events Daniel explicitly declined. attendees is a list of
    # {email, self: true, responseStatus: ...}.
    for att in (ev.get("attendees") or []):
        if att.get("self") and att.get("responseStatus") == "declined":
            return None
    summary = (ev.get("summary") or "(no title)").strip()
    if len(summary) > 60:
        summary = summary[:60].rstrip() + "…"
    start = ev.get("start") or {}
    if start.get("date"):
        # All-day event — render as "all-day".
        return f"all-day — {summary}"
    dt_str = start.get("dateTime")
    if not dt_str:
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        local = dt.astimezone(tz)
        time_part = local.strftime("%I:%M%p").lstrip("0").lower()
    except Exception:
        return None
    return f"{time_part} — {summary}"


def _build_calendar_lines(db) -> list[str]:
    """Pull today + next ~24h of cal events, format up to 5 for the
    state_block. Module-cached 5 min. Empty list when cal disconnected
    or the cal API errors."""
    from .. import google_calendar as gcal

    now_utc = datetime.utcnow()
    cached = _CAL_CACHE.get("primary")
    if cached and (now_utc - cached[0]).total_seconds() < _CAL_TTL_SECONDS:
        return cached[1]

    try:
        # Only fetch if cal is connected. get_valid_access_token returns
        # None when no row exists; skip silently in that case.
        if gcal.get_valid_access_token(db) is None:
            _CAL_CACHE["primary"] = (now_utc, [])
            return []
    except Exception:
        # Network blip or refresh fail — don't poison state_block with
        # a cal error. Cache empty so we don't retry on every turn.
        _CAL_CACHE["primary"] = (now_utc, [])
        return []

    tz = ZoneInfo("America/Los_Angeles")
    time_min = now_utc.replace(tzinfo=ZoneInfo("UTC")).isoformat()
    time_max = (now_utc + timedelta(hours=24)).replace(
        tzinfo=ZoneInfo("UTC")
    ).isoformat()

    try:
        events = gcal.list_events(db, time_min, time_max, max_results=10)
    except Exception as e:
        print(f"[state_block] cal list_events failed: {e}")
        _CAL_CACHE["primary"] = (now_utc, [])
        return []

    formatted: list[str] = []
    for ev in events[:5]:
        line = _format_cal_event(ev, tz)
        if line:
            formatted.append(f"  · {line}")

    if not formatted:
        result = ["- next 24h on calendar: nothing scheduled"]
    else:
        result = ["- next 24h on calendar:"] + formatted

    _CAL_CACHE["primary"] = (now_utc, result)
    return result


def _build_time_block(db) -> str:
    """Inject Daniel's current local date+time into the master prompt for
    bot channels. Fixes the WA failure mode where Gooni had no idea what
    timezone Daniel was in and either defaulted to UTC or refused to commit
    to a local time when asked.

    Pulls Settings.nudge_tz (already zoneinfo-aware for the daily scheduler).
    Caller wraps with try/except — never blocks the reply.
    """
    from ...db.models import Settings
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        return ""
    from datetime import datetime

    settings = db.query(Settings).first()
    tz_name = settings.nudge_tz if settings and settings.nudge_tz else "America/Los_Angeles"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/Los_Angeles")
    now = datetime.now(tz)
    return (
        "[current time]\n"
        f"{now.strftime('%A %b %d %Y, %I:%M %p %Z')} (Daniel's local: {tz_name})"
    )


def _build_just_extracted_block(routed: "RouterResult") -> str:
    """Tells the LLM what already got routed this turn. Without this the
    LLM either re-announces ("Logged feature request:…") or doesn't know
    its work was redundant. Used as injected master-prompt context.

    IDs are surfaced explicitly here so the PERSONA "never say 'tracked'
    without an id this turn" rule has something concrete to cite. Every
    kind+id pair printed here is a write the LLM is licensed to confirm.
    """
    # See _build_ack — unpack so the rendering body below stays as-is.
    captured_features = routed.captured_features
    captured_promises = routed.captured_promises
    completed_promises = routed.completed_promises
    broken_promises = routed.broken_promises
    failed_promise_actions = routed.failed_promise_actions

    lines: list[str] = []
    for f in captured_features[:3]:
        title = (f.get("title") or "").strip()
        # `Note`, not `BacklogTicket`. BacklogTicket has not existed since the
        # v2 nuke and is absent from OBJECT_KINDS in this same prompt — so the
        # block whose whole job is to license write-claims was licensing a
        # claim about a primitive the adjacent block forbids. Feature requests
        # are `feature-request`-tagged Notes (intent_handlers/features.py).
        note_id = f.get("note_id")
        if note_id is not None:
            lines.append(
                f"- Note #{note_id} created (feature request): \"{title}\""
            )
        else:
            lines.append(f"- Note created (feature request, id unknown): \"{title}\"")
    for p in captured_promises[:3]:
        summary = p.get("summary") or p.get("utterance") or ""
        if len(summary) > 60:
            summary = summary[:60].rstrip() + "…"
        slip = p.get("slip_count", 0) or 0
        slip_tail = f" (slip #{slip + 1})" if slip > 0 else ""
        pid = p.get("id")
        # G3.1: all promises are `active` on create. needs_clarification
        # flags vague utterances so the LLM knows Gooni already asked the
        # sharpener question in this turn — don't ask it again.
        needs_c = bool(p.get("needs_clarification"))
        verb = "tracked (VAGUE — Gooni asked for clarification)" if needs_c else "tracked"
        # Voice-of-reason — when set, the LLM should treat the
        # suggestion as Gooni's pushback to acknowledge naturally in
        # its reply, NOT as a separate announcement.
        voice = p.get("voice_of_reason") or {}
        voice_tail = ""
        if voice:
            flag = voice.get("primary") or ""
            sug = (voice.get("suggestion") or "").strip()
            if sug:
                voice_tail = f" — voice-of-reason flag '{flag}': {sug}"
        # Ambient-loop v2: cadence is part of the parse — surface it so
        # the LLM can reference the recurrence shape without guessing.
        cad = p.get("cadence") or "once"
        cad_tail = ""
        if cad == "n_per_week":
            cad_tail = f" [cadence: {p.get('cadence_target') or '?'}x/week]"
        elif cad != "once":
            cad_tail = f" [cadence: {cad}]"
        if pid is not None:
            lines.append(
                f"- Promise #{pid} {verb}: \"{summary}\"{cad_tail}{slip_tail}{voice_tail}"
            )
        else:
            lines.append(f"- Promise {verb}: \"{summary}\"{cad_tail}{slip_tail}{voice_tail}")
    # Slice 3 glow: commitments NOTICED but NOT tracked. The log view
    # shows the dot; Daniel promotes. The reply may acknowledge seeing
    # the commitment conversationally but must NEVER claim it's tracked/
    # logged/saved — no row exists yet.
    for sp in (routed.noticed_promises or [])[:3]:
        summary = (sp.get("summary") or sp.get("utterance") or "").strip()
        if len(summary) > 60:
            summary = summary[:60].rstrip() + "…"
        lines.append(
            f"- Commitment NOTICED (glow annotation, NOT tracked): \"{summary}\". "
            "No Promise row exists — do NOT say 'tracked'/'logged'/'noted "
            "down'. Daniel promotes it from the log if he wants it held."
        )
    # Ambient-loop v2 lifecycle lines. Each names kind+id so the PERSONA
    # "never claim without id this turn" rule has the anchor to cite.
    # Reply must NOT recite the id number — speak plainly.
    for p in (completed_promises or [])[:3]:
        summary = (p.get("summary") or p.get("utterance") or "").strip()
        if len(summary) > 60:
            summary = summary[:60].rstrip() + "…"
        lines.append(f"- Promise #{p.get('id')} KEPT (closed): \"{summary}\"")
    for p in (broken_promises or [])[:3]:
        summary = (p.get("summary") or p.get("utterance") or "").strip()
        if len(summary) > 60:
            summary = summary[:60].rstrip() + "…"
        lines.append(f"- Promise #{p.get('id')} BROKEN (scratched): \"{summary}\"")
    for f in (failed_promise_actions or [])[:3]:
        kind = f.get("kind", "")
        match = (f.get("match") or "").strip()
        cands = f.get("candidates") or []
        verb = {"complete": "close", "break": "scratch"}.get(kind, kind)
        if len(cands) >= 2:
            cand_str = " | ".join(
                f"\"{c.get('text')}\" (#{c.get('id')}, {c.get('score'):.2f})"
                for c in cands[:3]
            )
            lines.append(
                f"- AMBIGUOUS promise {verb} for \"{match}\" — candidates: "
                f"{cand_str}. ASK Daniel which one before doing anything."
            )
        elif len(cands) == 1:
            c = cands[0]
            score = c.get("score")
            score_str = f"{score:.2f}" if isinstance(score, (int, float)) else "?"
            lines.append(
                f"- Promise {verb} NOT done for \"{match}\" — closest active "
                f"commitment is \"{c.get('text')}\" (#{c.get('id')}, {score_str}), "
                "under the auto-close bar. Nothing changed: ASK whether that's "
                "the one before claiming anything was closed."
            )
        else:
            lines.append(
                f"- Promise {verb} ATTEMPTED but NO MATCH for: \"{match}\". "
                "Acknowledge the miss honestly."
            )
    # NB: fitness/trackable logging is a tool call now (log_trackable_entry),
    # not a router capture — the tool result already tells the LLM what
    # landed, so there's nothing to surface here.
    if not lines:
        return ""
    return (
        "[just extracted from this message — Gooni's separate ack stub "
        "ALREADY confirmed the capture to the user (\"tracked X, sir\" / "
        "\"closed X, sir\" / etc.) and that ack gets prepended to your "
        "reply automatically. Do NOT also say \"tracked\", \"noted\", "
        "\"logged\", \"on it\", \"got it\", \"saved\", \"added\", \"on "
        "the pile\", or similar capture-confirmation phrasing — that's "
        "double-narration. Kind+id pairs below are INTERNAL grounding "
        "only — NEVER recite the raw id number to the user. Your reply "
        "should continue the conversation (answer a question, push back, "
        "ask a sharpener) as if no logging happened. If the user's "
        "message is JUST a capture statement with nothing to respond to, "
        "the orchestrator already short-circuited and your reply won't "
        "be called.]\n"
        + "\n".join(lines)
    )


def _summarize_entry(text: str) -> str:
    """Cheap LLM rollup of a long note's plaintext, used as entry_context.
    Returns the summary or the raw text on failure (better than nothing).
    """
    prompt = (
        "Summarize this note in 5-8 short bullet points capturing what Daniel "
        "wrote, decisions, open questions, and anything he committed to. "
        "Skip pleasantries.\n\nNote:\n"
        f"{text[:8000]}\n\nSummary:"
    )
    try:
        out = llm_client.generate_simple_completion(prompt, max_tokens=300)
    except Exception as e:
        print(f"entry_content summarize error: {e}")
        return text[:ENTRY_SUMMARIZE_THRESHOLD]
    return (out or "").strip() or text[:ENTRY_SUMMARIZE_THRESHOLD]

