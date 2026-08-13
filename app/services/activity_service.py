"""Unified activity stream — the "true log" substrate (PRD note #397).

Merges the heterogeneous signals of Daniel's day into ONE recency-ordered
feed: chat messages (every channel), notes, promise lifecycle events,
trackable measurements (which is how Whoop / LeetCode and the iOS Shortcuts
device pings land too, since they store as trackable entries), and the
`opened X` rows DERIVED from the two attention sensors — browser tab focus and
frontmost macOS app (see device_activity, which owns the shared 5-minute gap
rule and the shared phrasing so all three device layers read as one
vocabulary). Query-time union — NO new table — each source is over-fetched then
k-way merged by timestamp in Python.

The point of the union is that ONE stream powers two consumers: the always-on
activity rail on the ambient home AND the pre-reply context feed (the
`[recent — last 1h]` state-block section — see recent_activity.py, which is a
thin renderer over this feed), so what Daniel sees and what Gooni reads before
it answers are the same thing. That second consumer passes `exclude_kinds`
(messages are already in Gooni's conversation history — re-injecting them would
just be scrollback), and filtering at the source keeps a chatty hour from
blowing the item cap on messages and starving the trackable/promise lines.

Timestamp hazard: Message.created_at is tz-AWARE (DateTime(timezone=True)),
while Note/Promise/TrackableEntry use naive utcnow(). Sorting the two kinds
together raises TypeError, so every ts is normalized to tz-aware UTC before
the merge. Each source is wrapped defensively — one model's schema drift
can't take down the whole feed (same posture as recent_activity.py).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..common import stale_day_label as _stale_day_label
from .device_activity import event_phrase as _event_phrase


def _utc(dt: datetime | None) -> datetime | None:
    """Normalize to tz-aware UTC. Naive values in this app are all utcnow(),
    so we treat naive as UTC; aware values are converted."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_before(raw: str | None) -> datetime | None:
    """Parse the pagination cursor (an ISO `at` from the prior page) into
    tz-aware UTC. Tolerant of a trailing 'Z' and of naive strings."""
    if not raw:
        return None
    try:
        s = raw.strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return _utc(dt)
    except (TypeError, ValueError):
        return None


def _num(value: float | None) -> str:
    """Trim a float for display: 70.0 → '70', 70.234 → '70.2'.

    Round to ONE decimal — `:g` kept 6 sig-figs, so a raw Whoop reading leaked
    as "hrv 92.2238 ms" / "strain 20.4936". The rail is a glance, not a lab.
    """
    if value is None:
        return ""
    r = round(float(value), 1)
    if r.is_integer():
        return str(int(r))
    return f"{r:.1f}"


def _messages(db: Session, before_aware, limit: int) -> list[dict]:
    from ..db.models import Conversation, Message

    try:
        q = (
            db.query(Message, Conversation.source)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .filter(Message.is_feedback == False)  # noqa: E712 — internal feedback rows aren't "activity"
        )
        if before_aware is not None:
            q = q.filter(Message.created_at < before_aware)
        rows = q.order_by(Message.id.desc()).limit(limit).all()
    except Exception as e:  # pragma: no cover — defensive
        print(f"[activity] messages query failed: {e}")
        return []

    out = []
    for m, source in rows:
        out.append({
            "key": f"message-{m.id}",
            "kind": "message",
            "at": _utc(m.created_at),
            "text": m.content or "",
            "role": m.role,
            "source": source or "web",
            "message_id": m.id,
            "conversation_id": m.conversation_id,
            # only assistant turns carry a trace worth auditing
            "has_trace": bool(m.trace) and m.role == "assistant",
        })
    return out


def _notes(db: Session, before_naive, limit: int) -> list[dict]:
    from ..db.models import Note

    try:
        q = db.query(
            Note.id, Note.title, Note.excerpt, Note.created_at, Note.updated_at
        ).filter(
            # exclude structural notes: stickies (home_pos) + daily-matrix cells (log_date)
            Note.home_pos.is_(None),
            Note.log_date.is_(None),
        )
        if before_naive is not None:
            q = q.filter(Note.updated_at < before_naive)
        rows = q.order_by(Note.updated_at.desc()).limit(limit).all()
    except Exception as e:  # pragma: no cover
        print(f"[activity] notes query failed: {e}")
        return []

    out = []
    for nid, title, excerpt, created_at, updated_at in rows:
        ts = updated_at or created_at
        edited = bool(created_at and updated_at and (updated_at - created_at).total_seconds() > 2)
        out.append({
            "key": f"note-{nid}",
            "kind": "note",
            "at": _utc(ts),
            "text": (title or excerpt or "untitled").strip(),
            "note_id": nid,
            "verb": "edited" if edited else "created",
        })
    return out


def _promises(db: Session, before_naive, limit: int) -> list[dict]:
    from ..db.models import Promise

    try:
        q = db.query(
            Promise.id, Promise.summary, Promise.utterance,
            Promise.state, Promise.created_at, Promise.resolved_at,
        )
        # bound by created_at (<= the effective ts) so paging can't miss rows;
        # the exact ts is recomputed + filtered in Python below.
        if before_naive is not None:
            q = q.filter(Promise.created_at < before_naive)
        rows = q.order_by(Promise.created_at.desc()).limit(limit * 2).all()
    except Exception as e:  # pragma: no cover
        print(f"[activity] promises query failed: {e}")
        return []

    out = []
    for pid, summary, utterance, state, created_at, resolved_at in rows:
        ts = _utc(resolved_at if (state in ("kept", "broken") and resolved_at) else created_at)
        if ts is None:
            continue
        verb = {"kept": "kept", "broken": "broken"}.get(state, "new")
        out.append({
            "key": f"promise-{pid}",
            "kind": "promise",
            "at": ts,
            "text": (summary or utterance or "").strip(),
            "state": state,
            "verb": verb,
        })
    return out[:limit]


# Feed sources fan a single poll into a json "master" row + several numeric
# mirror rows, all stamped within the same second. Collapse them into ONE line
# so a Whoop/LeetCode sync reads as "whoop · strain 20.7, recovery 62" instead
# of five rows of mirror-spam. Manual logs are genuine distinct events → kept
# individual.
_FEED_SOURCES = {"whoop", "leetcode", "derived"}


def _trackables(db: Session, before_naive, limit: int) -> list[dict]:
    from ..db.models import Trackable, TrackableEntry
    from . import trackable_service

    try:
        q = (
            db.query(
                TrackableEntry.id, TrackableEntry.value_boolean,
                TrackableEntry.value_numeric, TrackableEntry.created_at,
                TrackableEntry.date, TrackableEntry.source,
                Trackable.name, Trackable.unit, Trackable.kind,
            )
            .join(Trackable, TrackableEntry.trackable_id == Trackable.id)
            # Wall off focus_cam telemetry from the rail (mirrors the list_all
            # exclusion the matrix/dots/overlay ride). Filter on the DEFINITION's
            # source since a stray entry-level source could still leak the row.
            .filter(Trackable.source.notin_(trackable_service.HIDDEN_SOURCES))
        )
        if before_naive is not None:
            q = q.filter(TrackableEntry.created_at < before_naive)
        # over-fetch: feed polls collapse many rows into one, so grab extra
        rows = q.order_by(TrackableEntry.created_at.desc()).limit(limit * 4).all()
    except Exception as e:  # pragma: no cover
        print(f"[activity] trackables query failed: {e}")
        return []

    # "today" in Daniel's tz — feed rows carry a subject-day (the day the data is
    # FOR), which lags created_at (when the poll wrote it). A Whoop poll re-upserts
    # the same snapshot every cycle, so created_at reads "1m ago" while the recovery
    # is still yesterday's. Tag the stale subject-day so the rail never implies today.
    try:
        from ..common import local_today
        today = local_today(db)
    except Exception:  # pragma: no cover — never let a tz lookup kill the feed
        today = None

    singles: list[dict] = []
    groups: dict[tuple, dict] = {}  # (source, second) → collapsed feed poll
    for eid, vbool, vnum, created_at, edate, source, name, unit, kind in rows:
        src = source or "manual"
        if kind == "boolean":
            frag = name if (vbool or vbool is None) else None
            single_text = name if (vbool or vbool is None) else f"{name} (skipped)"
        elif kind == "numeric":
            # feed mirrors are named "whoop strain" / "leetcode solved" — drop the
            # source prefix inside a collapsed "{source} · …" line so it reads
            # "whoop · strain 20.7" not "whoop · whoop strain 20.7"
            label = name
            if src in _FEED_SOURCES and label.lower().startswith(f"{src} "):
                label = label[len(src) + 1:]
            frag = f"{label} {_num(vnum)}{(' ' + unit) if unit else ''}".strip()
            if src == "shortcuts":
                single_text = _event_phrase(name)  # "instagram open 1" → "opened instagram"
            else:
                single_text = f"{name} {_num(vnum)}{(' ' + unit) if unit else ''}".strip()
        else:  # json master — its raw payload is noise; drop from the collapsed line
            frag = None
            single_text = f"{name} updated"

        if src in _FEED_SOURCES and created_at is not None:
            sec = created_at.replace(microsecond=0)
            g = groups.setdefault(
                (src, sec.isoformat()),
                {"at": created_at, "frags": [], "source": src, "id": eid, "date": edate},
            )
            if created_at > g["at"]:
                g["at"] = created_at
            if frag:
                g["frags"].append(frag)
        else:
            singles.append({
                "key": f"trackable-{eid}",
                "kind": "trackable",
                "at": _utc(created_at),
                "text": single_text,
                "name": name,
                "source": src,
            })

    out = list(singles)
    # Identical polls collapse: a Whoop/LeetCode re-sync that changed NOTHING
    # (same numbers) wrote a fresh mirror-set every poll, so the rail showed the
    # same "leetcode · streak 10, solved 312" twice. Keep only the most-recent
    # occurrence per (source, rendered text) — the stale-day label is part of the
    # text, so a genuinely different reading (or a day-tag flip) still stands.
    feed_rows: dict[tuple, dict] = {}
    for (src, sec_iso), g in groups.items():
        # consistency-over-availability: name the subject-day when it isn't today
        # ("whoop (yesterday) · …") so a stale feed never reads as a fresh reading.
        lbl = _stale_day_label(today, g.get("date"))
        head = f"{src} ({lbl})" if lbl else src
        text = f"{head} · " + ", ".join(g["frags"]) if g["frags"] else f"{head} synced"
        row = {
            "key": f"feed-{src}-{sec_iso}",
            "kind": "trackable",
            "at": _utc(g["at"]),
            "text": text,
            "name": src,
            "source": src,
            "day_label": lbl,  # '' when current — consumed by recent_activity too
        }
        prev = feed_rows.get((src, text))
        if prev is None or row["at"] > prev["at"]:
            feed_rows[(src, text)] = row
    out.extend(feed_rows.values())
    return out


# The MINIMUM span one page of the feed looks back for device opens.
#
# The other sources page by `ORDER BY … DESC LIMIT n`, which the gap rule can't
# use: deciding whether an interval is an OPEN needs the interval BEFORE it, and
# "before" is the direction a DESC-limited query throws away. So this source is
# WINDOWED instead — it derives every open in `[start, before)` and lets the
# merge take the newest. The cost of a page is bounded by a span of time rather
# than by however many tab switches happened to fit in it.
_DEVICE_LOOKBACK = timedelta(days=3)

# The absolute floor under that window.
#
# A fixed lookback is not enough on its own, because the paging cursor is the
# merged page's OLDEST item and the other sources can push it back further than
# the lookback IN ONE STEP. Away from the machine for five days: page 1's window
# is the last three days and finds nothing, the other sources return fewer than
# `limit` items and the oldest is a note from eight days ago, so page 2 asks
# `before = now-8d` and looks at `[now-11d, now-8d)`. Every device row in the
# skipped `[now-8d, now-3d)` span is then unreachable on any page.
#
# So the window FOLLOWS THE STEP: it extends down to the page's own oldest
# non-device item, and never further, so it can only grow when paging across a
# quiet stretch — which is the case it exists for. This constant is what stops
# "follows the step" from meaning "scans back to the beginning of time" when the
# other sources are empty or the one item they returned is years old. Same
# spirit as `browser_activity_service.MAX_SUMMARY_DAYS`.
_DEVICE_MAX_LOOKBACK = timedelta(days=31)


def _page_reach(items: list[dict], limit: int, before) -> datetime | None:
    """The naive-UTC timestamp this page's NON-device sources reach back to.

    That is the `limit`-th newest of them (the oldest that can survive the
    merge), or simply the oldest they returned when they returned fewer than
    `limit` — in which case the next cursor lands exactly there. `None` when
    they returned nothing at all: there is no step to follow, and the caller
    falls back to the absolute floor.

    The `before` guard is applied here as well as after the merge, because a
    promise's effective ts is recomputed in Python and can land newer than the
    cursor; counting one of those would make the reach look shallower than the
    page's real step.
    """
    ats = sorted(
        (
            it["at"]
            for it in items
            if it.get("at") is not None and (before is None or it["at"] < before)
        ),
        reverse=True,
    )
    if not ats:
        return None
    at = ats[limit - 1] if len(ats) >= limit else ats[-1]
    return at.replace(tzinfo=None)


def _device(db: Session, before_naive, limit: int, *, reach=None) -> list[dict]:
    from . import device_activity

    end = before_naive or datetime.utcnow()
    # `reach` is how far this page's other sources actually extend back. None
    # means nothing bounds the step, so the window opens to the absolute floor
    # rather than to a lookback that could sit entirely inside the jump.
    start = end - _DEVICE_MAX_LOOKBACK if reach is None else min(end - _DEVICE_LOOKBACK, reach)
    start = max(start, end - _DEVICE_MAX_LOOKBACK)
    try:
        opens = device_activity.device_opens(db, start=start, end=end)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[activity] device opens failed: {e}")
        return []

    return [
        {
            "key": it["key"],
            "kind": "device",
            "at": _utc(it["at"]),
            "text": it["text"],
            "name": it["name"],
            # The LAYER, not a Trackable source — these rows have no Trackable.
            # The frontend renders every device layer identically (the Shortcuts
            # rows included), so this exists to make a row's origin greppable,
            # not to make it look different.
            "source": it["layer"],
        }
        for it in opens[:limit]
    ]


def build_activity_feed(
    db: Session,
    before: datetime | None = None,
    limit: int = 40,
    exclude_kinds: set[str] | None = None,
) -> list[dict]:
    """Return up to `limit` activity items, newest first, older than `before`.

    `before` is a tz-aware UTC cursor (use the prior page's last `at`). The
    client pages by re-sending it. Empty list = nothing older left.

    `exclude_kinds` skips whole sources at query time (e.g. {"message"} for the
    pre-reply context feed). Filtering here rather than after the merge means an
    excluded kind can't consume the item cap — the surviving kinds get the full
    `limit` budget.
    """
    limit = max(1, min(limit, 100))
    skip = exclude_kinds or set()
    before_aware = before  # Message.created_at is tz-aware
    before_naive = before.replace(tzinfo=None) if before is not None else None

    items: list[dict] = []
    if "message" not in skip:
        items += _messages(db, before_aware, limit)
    if "note" not in skip:
        items += _notes(db, before_naive, limit)
    if "promise" not in skip:
        items += _promises(db, before_naive, limit)
    if "trackable" not in skip:
        items += _trackables(db, before_naive, limit)
    if "device" not in skip:
        # Derived LAST, and that ordering is load-bearing: the device window has
        # to know how far back this page will actually reach, which is a fact
        # about what the other sources just returned.
        items += _device(db, before_naive, limit, reach=_page_reach(items, limit, before))

    # drop anything undated, then k-way merge by the normalized UTC ts
    items = [it for it in items if it.get("at") is not None]
    # a Python-side before guard catches the promise computed-ts edge case
    if before is not None:
        items = [it for it in items if it["at"] < before]
    items.sort(key=lambda it: it["at"], reverse=True)
    return items[:limit]
