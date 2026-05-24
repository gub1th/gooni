from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from ...llm.client import llm_client


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
    "add_to_list": "ListItem",
    "add_note": "Note",
    "add_todo": "Todo",
    "add_focus": "Focus",
    "log_habit": "HabitEntry",
    "request_feature": "BacklogTicket",
    "create_calendar_event": "CalendarEvent",
}
_ROUTER_CREATED_KINDS: tuple[str, ...] = ("Promise", "DailyMetric")


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


def _build_ack(
    *,
    tone_rules: list[str],
    captured_features: list[dict],
    captured_promises: list[dict],
    captured_todos: list[dict],
    killed_todos: list[dict] | None = None,
    completed_todos: list[dict] | None = None,
    merged_todos: list[dict] | None = None,
    failed_todo_actions: list[dict] | None = None,
    edited_todos: list[dict] | None = None,
    implicit_done_todos: list[dict] | None = None,
    disambiguation_needed: list[dict] | None = None,
    captured_metrics: list[dict] | None = None,
) -> str | None:
    """Alfred-voice ack — terse, casual, no clinical receipts.

    Contract:
      - Every persisted-object arg is a structured dict carrying the real
        DB id. The id is the INTERNAL grounding contract (so the ack helper
        can't be called for a write that didn't land) — it is NOT rendered
        to the user. Daniel called the prior "ticket #281 logged" /
        "backlog: X" formats clinical; Alfred speaks plainly, not in jira-
        bot syntax. The id flows into just_extracted_block so the next-
        turn LLM has a verifiable anchor for "did this land?" reasoning,
        but the user-facing bubble stays warm.
      - One bubble. Multi-signal turns chain w/ " · " for compactness.
      - Multi-feature uses "+N more" with the category tag instead of the
        opaque "(+N)" suffix Daniel flagged.

    Returns None when no signals fired (caller falls through to LLM).
    """
    def _trim(s: str, n: int = 60) -> str:
        s = (s or "").strip()
        return s if len(s) <= n else s[:n].rstrip() + "…"

    parts: list[str] = []
    if tone_rules:
        if len(tone_rules) > 1:
            parts.append(f"{len(tone_rules)} rules sharpened")
        else:
            parts.append(_trim(tone_rules[0]).lower().rstrip("."))
    if captured_features:
        titles = [
            f"\"{_trim(f.get('title'))}\""
            for f in captured_features[:3]
        ]
        n = len(captured_features)
        if n == 1:
            parts.append(f"on the backlog, sir: {titles[0]}")
        elif n == 2:
            parts.append(f"on the backlog, sir: {titles[0]}, {titles[1]}")
        else:
            parts.append(
                f"on the backlog, sir ({n}): {', '.join(titles)}"
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

        if len(captured_promises) == 1:
            p = captured_promises[0]
            slip = p.get("slip_count", 0) or 0
            summary = _trim(p.get("summary") or p.get("utterance") or "")
            tail = _clarifier_tail(p) + _voice_tail(p)
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
    # G3.5: filter out spawned children — they'll be rendered alongside
    # their parent's close phrase below. Bare creates still show here.
    bare_creates = [t for t in (captured_todos or []) if not t.get("spawned_from_id")]
    if bare_creates:
        # G3 accountability tone: if Daniel re-mentioned a todo that already
        # exists, todo_service.create returned the bumped existing row
        # instead of inserting a dupe. captured_todos carries mention_count;
        # at ≥3 we drop the "noted" register and call out the laziness.
        # This is the whole reason we collect the counter — silence on a
        # 4th mention is enabling, not helpful.
        bumped = [t for t in bare_creates if t.get("bumped") and (t.get("mention_count") or 1) >= 3]
        fresh = [t for t in bare_creates if not (t.get("bumped") and (t.get("mention_count") or 1) >= 3)]

        for t in bumped[:2]:
            text_q = f"\"{_trim(t.get('text'))}\""
            count = t.get("mention_count") or 1
            if count >= 5:
                parts.append(
                    f"{text_q} again. that's {count} mentions and it's still open. you're stalling — do it tonight or kill it."
                )
            elif count == 4:
                parts.append(
                    f"{text_q} — fourth mention. you keep saying this. tonight, or kill the todo."
                )
            else:  # count == 3
                parts.append(
                    f"{text_q} — third mention. either move on it tonight or kill it. talking about it isn't the work."
                )
        if len(bumped) > 2:
            parts.append(f"+{len(bumped) - 2} more stale repeats")

        if fresh:
            # Light "second mention" surface for count==2 — neutral, just a
            # nudge that Gooni's seen this before. Count==1 is the default
            # fresh-create voice.
            two_count_idx = next(
                (i for i, t in enumerate(fresh) if t.get("bumped") and (t.get("mention_count") or 1) == 2),
                None,
            )
            texts = [
                f"\"{_trim(t.get('text'))}\""
                + (" (second mention)" if (t.get("bumped") and (t.get("mention_count") or 1) == 2) else "")
                for t in fresh[:3]
            ]
            n = len(fresh)
            if n == 1:
                parts.append(f"noted {texts[0]}, sir.")
            elif n == 2:
                parts.append(f"noted {texts[0]} and {texts[1]}, sir.")
            else:
                parts.append(f"noted all {n}: {', '.join(texts)}, sir.")
            _ = two_count_idx  # signal kept for traceability; rendering inline above

    # G1.1 destructive-action acks. Verb-led, text-quoted, no opaque
    # "(+N)" suffix. Daniel needs to spot wrong cosine matches in the
    # ack — that's the safety net behind the auto-act pattern.
    killed_todos = killed_todos or []
    completed_todos = completed_todos or []
    merged_todos = merged_todos or []
    failed_todo_actions = failed_todo_actions or []
    edited_todos = edited_todos or []
    implicit_done_todos = implicit_done_todos or []
    disambiguation_needed = disambiguation_needed or []

    if killed_todos:
        texts = [f"\"{_trim(t.get('text'))}\"" for t in killed_todos[:3]]
        n = len(killed_todos)
        if n == 1:
            parts.append(f"killed {texts[0]}, sir.")
        elif n == 2:
            parts.append(f"killed {texts[0]} and {texts[1]}, sir.")
        else:
            parts.append(f"killed {n}, sir: {', '.join(texts)}")
    if completed_todos:
        # G3.5: rendering varies by whether closure_note + spawned[] present.
        # Per Surface F spec: "closed X, sir. outcome logged. spawned: A, B."
        # Multiple closes condense, but a SINGLE close with outcome/spawn
        # gets the richer per-line phrasing.
        if len(completed_todos) == 1:
            ct = completed_todos[0]
            text = _trim(ct.get("text"))
            outcome_present = bool((ct.get("closure_note") or "").strip())
            # Find any spawned_todos in captured_todos that point at this close
            close_id = ct.get("todo_id")
            spawned_for_this = [
                t for t in (captured_todos or [])
                if t.get("spawned_from_id") == close_id
            ]
            # Slice 5: warmer close voice + Todo #id grounding on each
            # spawn. The id stays internal (PERSONA prompt forbids reciting
            # raw ids in user replies), but the ack composer surfaces it so
            # frontend chat-chip rendering + downstream LLM reasoning have
            # a verifiable anchor. ", sir" honorific anchors the line to
            # Alfred voice. Comma-joined intentionally — newlines would
            # split into separate segments under _MAX_SEGMENTS=2 on bots.
            phrase = f"closed \"{text}\", sir"
            if outcome_present:
                phrase += ". outcome logged"
            if spawned_for_this:
                # id stays internal — surfaces via just_extracted_block for
                # LLM grounding, NEVER in user-facing ack. Daniel called the
                # "(Todo #N)" leak jira-bot syntax 2026-05-22.
                spawn_texts = ", ".join(
                    f"\"{_trim(t.get('text'))}\"" for t in spawned_for_this[:3]
                )
                phrase += f". spawned {spawn_texts}"
            parts.append(phrase)
        else:
            texts = [f"\"{_trim(t.get('text'))}\"" for t in completed_todos[:3]]
            n = len(completed_todos)
            if n == 2:
                parts.append(f"closed {texts[0]} and {texts[1]}, sir.")
            else:
                parts.append(f"closed {n}, sir: {', '.join(texts)}")
    if merged_todos:
        # Render each merge as `"from" → "into"` so the direction is clear
        # (which text was kept vs absorbed).
        pieces = [
            f"\"{_trim(m.get('from_text'))}\" → \"{_trim(m.get('into_text'))}\""
            for m in merged_todos[:3]
        ]
        n = len(merged_todos)
        if n == 1:
            parts.append(f"merged {pieces[0]}")
        else:
            parts.append(f"merged {n}: {', '.join(pieces)}")
    if failed_todo_actions:
        # Surface no-match failures so wrong-shape extractions don't go
        # silent. Don't claim Gooni "tried" — be honest about the miss.
        misses = []
        for f in failed_todo_actions[:3]:
            kind = f.get("kind", "")
            match = _trim(f.get("match", ""))
            verb = {"delete": "kill", "complete": "close", "merge": "merge", "edit": "edit"}.get(kind, kind)
            misses.append(f"couldn't {verb} \"{match}\" — no match")
        parts.append("; ".join(misses))

    # G3.9 edit-action ack. Each edit carries a `changes` list of
    # human-readable diffs — render verb-led + comma-joined.
    for ed in edited_todos[:3]:
        text = _trim(ed.get("text"))
        changes = ed.get("changes") or []
        if not changes:
            continue
        # First change leads the phrase; rest comma-join in parens.
        head = changes[0]
        if len(changes) > 1:
            extra = ", ".join(changes[1:])
            parts.append(f"\"{text}\": {head} ({extra})")
        else:
            parts.append(f"\"{text}\": {head}")
    if len(edited_todos) > 3:
        parts.append(f"+{len(edited_todos) - 3} more edits")

    # G3.9 implicit-done ack. Daniel said "just called papi" → Gooni
    # closed the matching open todo. Surface what + why + undo hint.
    if implicit_done_todos:
        if len(implicit_done_todos) == 1:
            done = implicit_done_todos[0]
            text = _trim(done.get("text"))
            phrase = _trim(done.get("phrase", ""), 80)
            parts.append(f"closed \"{text}\". you said \"{phrase}\". undo if wrong.")
        else:
            n = len(implicit_done_todos)
            texts = [f"\"{_trim(d.get('text'))}\"" for d in implicit_done_todos[:3]]
            parts.append(f"closed {n} from what you said: {', '.join(texts)}. undo if wrong.")

    # G3.9 disambiguation ack. Cosine returned 2+ candidates within
    # 0.05 of each other — refuse to execute, ask Daniel to clarify.
    # One wrong auto-action erodes trust faster than ten correct ones.
    for amb in disambiguation_needed[:2]:
        action = amb.get("action", "")
        match = _trim(amb.get("match", ""))
        cands = amb.get("candidates") or []
        verb = {
            "delete": "kill", "complete": "close", "edit": "edit",
            "done_signal": "close (you said done)",
            "edit_parent_link": "link as parent",
        }.get(action, action)
        if len(cands) >= 2:
            cand_texts = " or ".join(f"\"{_trim(c.get('text'))}\"" for c in cands[:2])
            scores = " / ".join(f"{c.get('score'):.2f}" for c in cands[:2])
            parts.append(
                f"which one to {verb} for \"{match}\"? {cand_texts} (both ~{scores})"
            )

    # PR-1 fitness ack. Diet logs render the running daily total (Daniel
    # wants to know where he stands — the ONE place a number belongs in the
    # ack). Weight + exercise get their own terse phrasing. A single message
    # can carry all three (food + weight + gym).
    captured_metrics = captured_metrics or []
    if captured_metrics:
        def _fmt_cal(c) -> str:
            try:
                return f"{int(round(float(c))):,}"
            except (TypeError, ValueError):
                return "0"

        diet = [m for m in captured_metrics if m.get("log_type") in ("food", "macros_explicit")]
        weight = next((m for m in captured_metrics if m.get("log_type") == "weight"), None)
        exercise = next((m for m in captured_metrics if m.get("log_type") == "exercise"), None)

        if diet:
            last = diet[-1]
            cal = _fmt_cal(last.get("running_calories", 0))
            prot = int(round(float(last.get("running_protein", 0) or 0)))
            corrected = any(m.get("correction") for m in diet)
            lead = "fixed — " if corrected else "noted, sir. "
            parts.append(f"{lead}{cal} cal, {prot}g so far today.")
        if weight is not None:
            val = weight.get("value")
            unit = weight.get("unit") or "lb"
            try:
                vtxt = f"{float(val):g}"
            except (TypeError, ValueError):
                vtxt = str(val)
            parts.append(f"{vtxt} {unit} logged, sir.")
        if exercise is not None:
            label = _trim(exercise.get("exercise_label") or "")
            parts.append(f"trained, sir — {label}." if label else "trained, sir.")

    if not parts:
        return None
    return " · ".join(parts)


# Back-compat alias. _build_jarvis_ack name retained for any external imports;
# the alfred-voice rewrite happens in _build_ack above.
_build_jarvis_ack = _build_ack


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
    from ..todo_service import todo_service

    lines: list[str] = []
    try:
        primary = todo_service.get_primary(db)
    except Exception:
        primary = None
    if primary is not None:
        lines.append(
            f"- primary todo: \"{primary.text}\" (state: {primary.state or 'not_yet'})"
        )

    try:
        open_todos = todo_service.list_open(db)
    except Exception:
        open_todos = []
    open_count = sum(1 for t in open_todos if not t.is_primary)
    if open_count:
        lines.append(f"- {open_count} other open todo(s)")

    # G3 priority ranking surface — revised to hoist active todos.
    #
    # Anti-hallucination motivation (conv #1136): Daniel said "imma do a
    # little leetcode" and Gooni claimed "tracked" without checking that
    # an active "do a little leetcode" todo already existed. The todo was
    # unranked, so state_block rendered it as part of an opaque count
    # line, and the LLM was effectively blind to it. The fix surfaces
    # ALL state='doing' todos by name regardless of rank, because doing
    # todos are the most likely match for any "imma X" / "gonna X"
    # utterance — they need to be name-level visible so the LLM can
    # cross-reference before claiming a new write.
    #
    # Render order:
    #   1. primary (if any)
    #   2. ALL state='doing' non-primary, flagged [doing]
    #   3. state='not_yet' ranked (sort_order asc), filling remaining slots
    #   4. count line for whatever was clipped
    # Cap total named lines at 8 to keep the block scannable.
    try:
        non_primary = [t for t in open_todos if not t.is_primary]
        doing = [t for t in non_primary if (t.state or "") == "doing"]
        not_yet = [t for t in non_primary if (t.state or "") != "doing"]
        not_yet_ranked = sorted(
            [t for t in not_yet if (t.sort_order or 0) > 0],
            key=lambda t: t.sort_order or 0,
        )
        not_yet_unranked = [t for t in not_yet if (t.sort_order or 0) == 0]
        total_open = open_count + (1 if primary is not None else 0)

        MAX_NAMED = 8
        primary_slot = 1 if primary is not None else 0
        doing_to_show = doing[:max(0, MAX_NAMED - primary_slot)]
        remaining = max(0, MAX_NAMED - primary_slot - len(doing_to_show))
        not_yet_to_show = not_yet_ranked[:remaining]
        clipped_count = (
            (len(doing) - len(doing_to_show))
            + (len(not_yet_ranked) - len(not_yet_to_show))
            + len(not_yet_unranked)
        )

        # G3.9 atom #8: chain context inline. Build bulk_chain_summary for
        # all visible todos so each line can carry "↗N · M done" + "← from:
        # X" without an N+1 traversal. Orphans get no chain line — pay
        # the ~25 token cost only when there's info.
        try:
            chain_ids = []
            if primary is not None:
                chain_ids.append(primary.id)
            chain_ids.extend(t.id for t in doing_to_show)
            chain_ids.extend(t.id for t in not_yet_to_show)
            chain_summary = (
                todo_service.bulk_chain_summary(db, chain_ids)
                if chain_ids else {}
            )
        except Exception:
            chain_summary = {}

        def _chain_inline(t) -> str:
            meta = chain_summary.get(t.id)
            if not meta:
                return ""
            bits = []
            ct = meta.get("children_total") or 0
            cd = meta.get("children_done") or 0
            if ct:
                bits.append(f"↗{ct}" + (f" ✓{cd}" if cd else ""))
            ptext = meta.get("parent_text")
            if ptext:
                bits.append(f"← from: \"{(ptext or '')[:40]}\"")
            return f" [{' · '.join(bits)}]" if bits else ""

        if primary or doing_to_show or not_yet_to_show or clipped_count:
            lines.append(
                f"- priority order (Daniel-set via drag; {total_open} total open):"
            )
            slot = 1
            if primary is not None:
                tail = _chain_inline(primary)
                lines.append(f"  · #{slot} (primary): \"{primary.text}\"{tail}")
                slot += 1
            for t in doing_to_show:
                text = (t.text or "")[:60]
                mc = t.mention_count or 1
                mention_tag = f" [×{mc} mentions]" if mc > 1 else ""
                chain_tail = _chain_inline(t)
                lines.append(
                    f"  · #{slot} [doing]: \"{text}\"{mention_tag}{chain_tail}"
                )
                slot += 1
            for t in not_yet_to_show:
                text = (t.text or "")[:60]
                mc = t.mention_count or 1
                mention_tag = f" [×{mc} mentions]" if mc > 1 else ""
                chain_tail = _chain_inline(t)
                lines.append(f"  · #{slot}: \"{text}\"{mention_tag}{chain_tail}")
                slot += 1
            if clipped_count:
                lines.append(
                    f"  · {clipped_count} more open todo(s) not shown"
                )
    except Exception as e:
        print(f"[state_block] priority surface failed: {e}")

    try:
        done_today = todo_service.list_done_today(db)
    except Exception:
        done_today = []
    if done_today:
        lines.append(f"- {len(done_today)} todo(s) done today")

    try:
        promises = _list_pending_promises(db, limit=10)
    except Exception:
        promises = []
    if promises:
        from datetime import datetime as _dt, timedelta as _td
        cutoff = _dt.utcnow() + _td(hours=24)
        due_soon = [p for p in promises if p.inferred_due and p.inferred_due <= cutoff]
        if due_soon:
            lines.append(f"- {len(due_soon)} promise(s) due ≤24h:")
            for p in due_soon[:3]:
                summary = p.summary or p.utterance or ""
                if len(summary) > 60:
                    summary = summary[:60].rstrip() + "…"
                slip = f", slipped {p.slip_count}x" if p.slip_count else ""
                lines.append(f"  · \"{summary}\"{slip}")
        elif promises:
            lines.append(f"- {len(promises)} pending promise(s)")

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

    # G2 self-PM: surface Gooni's own top workflow blocker so the LLM
    # can reference it when context warrants. Capped at 1 line — the
    # whole state_block stays scannable. Only fires when urgency_score
    # is above a floor (otherwise every backlog ticket would parade
    # through here on slow days).
    try:
        from ..backlog_service import backlog_service as _backlog
        top_blockers = _backlog.list_by_urgency(db, limit=1, min_score=2.0)
    except Exception:
        top_blockers = []
    if top_blockers:
        t = top_blockers[0]
        # Count friction events in last 7d to surface the "hit Nx" signal —
        # repeated pain compounds; the LLM should know this is a session-
        # killer not a one-off annoyance.
        try:
            from ...db.models import FrictionEvent as _FE
            from datetime import datetime as _dt2, timedelta as _td2
            cutoff_7d = _dt2.utcnow() - _td2(days=7)
            recent_hits = (
                db.query(_FE)
                .filter(
                    _FE.backlog_ticket_id == t.id,
                    _FE.created_at >= cutoff_7d,
                )
                .count()
            )
        except Exception:
            recent_hits = 0
        text = (t.text or "")[:60]
        hits_phrase = f"hit {recent_hits}x in 7d" if recent_hits >= 2 else "active blocker"
        lines.append(
            f"- top workflow blocker: \"{text}\" ({hits_phrase}, "
            f"blast {t.blast_radius or '?'}/5)"
        )

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


def _build_just_extracted_block(
    *,
    tone_rules: list[str],
    captured_features: list[dict],
    captured_promises: list[dict],
    captured_todos: list[dict],
    killed_todos: list[dict] | None = None,
    completed_todos: list[dict] | None = None,
    merged_todos: list[dict] | None = None,
    failed_todo_actions: list[dict] | None = None,
    edited_todos: list[dict] | None = None,
    implicit_done_todos: list[dict] | None = None,
    disambiguation_needed: list[dict] | None = None,
    captured_metrics: list[dict] | None = None,
) -> str:
    """Tells the LLM what already got routed this turn. Without this the
    LLM either re-announces ("Logged feature request:…") or doesn't know
    its work was redundant. Used as injected master-prompt context.

    IDs are surfaced explicitly here so the PERSONA "never say 'tracked'
    without an id this turn" rule has something concrete to cite. Every
    kind+id pair printed here is a write the LLM is licensed to confirm.
    """
    lines: list[str] = []
    if tone_rules:
        lines.append(f"- {len(tone_rules)} tone rule(s) logged")
    for f in captured_features[:3]:
        title = (f.get("title") or "").strip()
        ticket_id = f.get("ticket_id")
        if ticket_id is not None:
            lines.append(
                f"- BacklogTicket #{ticket_id} created: \"{title}\""
            )
        else:
            lines.append(f"- BacklogTicket created (id unknown): \"{title}\"")
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
        if pid is not None:
            lines.append(
                f"- Promise #{pid} {verb}: \"{summary}\"{slip_tail}{voice_tail}"
            )
        else:
            lines.append(f"- Promise {verb}: \"{summary}\"{slip_tail}{voice_tail}")
    for t in captured_todos[:3]:
        text = (t.get("text") or "").strip()
        if len(text) > 60:
            text = text[:60].rstrip() + "…"
        tid = t.get("todo_id")
        spawn_parent = t.get("spawned_from_id")
        if spawn_parent is not None:
            # G3.5: a child todo spawned from a close. Surface the lineage
            # so the LLM understands it's a follow-up, not a fresh chore.
            parent_text = (t.get("spawned_from_text") or "").strip()
            if len(parent_text) > 40:
                parent_text = parent_text[:40].rstrip() + "…"
            anchor = f"#{tid}" if tid is not None else "?"
            parent_anchor = f"#{spawn_parent}"
            lines.append(
                f"- Todo {anchor} spawned: \"{text}\" "
                f"(from Todo {parent_anchor} \"{parent_text}\")"
            )
        elif tid is not None:
            lines.append(f"- Todo #{tid} added: \"{text}\"")
        else:
            lines.append(f"- Todo added (id unknown): \"{text}\"")
    # G1.1 destructive todo actions. Each line names the kind+id so the
    # PERSONA "never claim without id this turn" rule has the anchor to
    # cite. Reply must NOT recite the id number — speak plainly.
    for t in (killed_todos or [])[:3]:
        text = (t.get("text") or "").strip()
        if len(text) > 60:
            text = text[:60].rstrip() + "…"
        tid = t.get("todo_id")
        if tid is not None:
            lines.append(f"- Todo #{tid} killed: \"{text}\" (24h undo window)")
        else:
            lines.append(f"- Todo killed: \"{text}\"")
    for t in (completed_todos or [])[:3]:
        text = (t.get("text") or "").strip()
        if len(text) > 60:
            text = text[:60].rstrip() + "…"
        tid = t.get("todo_id")
        # G3.5: closure_note on the completed todo. Surface verbatim so the
        # LLM has the outcome context the user just shared — useful for any
        # follow-up question or summary they ask later in the turn.
        outcome = (t.get("closure_note") or "").strip()
        outcome_tail = f" · outcome: \"{outcome[:80]}\"" if outcome else ""
        if tid is not None:
            lines.append(f"- Todo #{tid} completed: \"{text}\"{outcome_tail}")
        else:
            lines.append(f"- Todo completed: \"{text}\"{outcome_tail}")
    for m in (merged_todos or [])[:3]:
        into_text = (m.get("into_text") or "").strip()
        from_text = (m.get("from_text") or "").strip()
        into_id = m.get("into_id")
        if into_id is not None:
            lines.append(
                f"- Todos merged into #{into_id}: \"{from_text}\" → \"{into_text}\""
            )
        else:
            lines.append(f"- Todos merged: \"{from_text}\" → \"{into_text}\"")
    for f in (failed_todo_actions or [])[:3]:
        kind = f.get("kind", "")
        match = (f.get("match") or "").strip()
        verb = {"delete": "kill", "complete": "close", "merge": "merge", "edit": "edit"}.get(
            kind, kind
        )
        lines.append(
            f"- Todo {verb} ATTEMPTED but NO MATCH for: \"{match}\". Acknowledge the miss honestly."
        )
    # G3.9 edit-action surfacing.
    for ed in (edited_todos or [])[:3]:
        text = (ed.get("text") or "").strip()
        tid = ed.get("todo_id")
        changes = ", ".join(ed.get("changes") or [])
        lines.append(
            f"- Todo #{tid} edited: \"{text}\" — {changes}"
        )
    # G3.9 implicit-done surfacing.
    for d in (implicit_done_todos or [])[:3]:
        text = (d.get("text") or "").strip()
        tid = d.get("todo_id")
        phrase = (d.get("phrase") or "").strip()
        lines.append(
            f"- Todo #{tid} CLOSED implicitly (\"{phrase}\"): \"{text}\". Surface that you closed it + offer undo."
        )
    # G3.9 disambiguation surfacing — tell LLM to surface the candidate
    # list as a clarifying question, NOT to pick one.
    for amb in (disambiguation_needed or [])[:2]:
        match = (amb.get("match") or "").strip()
        action = amb.get("action", "")
        cands = amb.get("candidates") or []
        cand_str = " | ".join(
            f"\"{c.get('text')}\" (#{c.get('id')}, {c.get('score'):.2f})"
            for c in cands[:3]
        )
        lines.append(
            f"- AMBIGUOUS {action} for \"{match}\" — candidates within 0.05: {cand_str}. ASK Daniel which one before doing anything."
        )
    # PR-1 fitness metric surfacing. The ack stub already told Daniel the
    # running total — these lines just license the LLM to reference it
    # without re-announcing the log.
    for m in (captured_metrics or [])[:4]:
        lt = m.get("log_type")
        if lt in ("food", "macros_explicit"):
            cal = m.get("running_calories")
            prot = m.get("running_protein")
            verb = "corrected" if m.get("correction") else "logged"
            lines.append(
                f"- DailyMetric {verb} (diet) — running today: "
                f"{cal} cal, {prot}g"
            )
        elif lt == "weight":
            lines.append(f"- DailyMetric logged: weight {m.get('value')}{m.get('unit') or ''}")
        elif lt == "exercise":
            label = m.get("exercise_label") or ""
            lines.append(f"- DailyMetric logged: exercise \"{label}\" (+ exercise HabitEntry)")
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

