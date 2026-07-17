"""Unified activity stream — the "true log" substrate (PRD note #397).

Merges the heterogeneous signals of Daniel's day into ONE recency-ordered
feed: chat messages (every channel), notes, promise lifecycle events, and
trackable measurements (which is how Whoop / LeetCode land too, since they
store as trackable entries). Query-time union — NO new table — each source
is over-fetched then k-way merged by timestamp in Python.

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

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..common import stale_day_label as _stale_day_label


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
    """Trim a float for display: 70.0 → '70', 70.2 → '70.2'."""
    if value is None:
        return ""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}"


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

    try:
        q = (
            db.query(
                TrackableEntry.id, TrackableEntry.value_boolean,
                TrackableEntry.value_numeric, TrackableEntry.created_at,
                TrackableEntry.date, TrackableEntry.source,
                Trackable.name, Trackable.unit, Trackable.kind,
            )
            .join(Trackable, TrackableEntry.trackable_id == Trackable.id)
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
    for (src, sec_iso), g in groups.items():
        # consistency-over-availability: name the subject-day when it isn't today
        # ("whoop (yesterday) · …") so a stale feed never reads as a fresh reading.
        lbl = _stale_day_label(today, g.get("date"))
        head = f"{src} ({lbl})" if lbl else src
        text = f"{head} · " + ", ".join(g["frags"]) if g["frags"] else f"{head} synced"
        out.append({
            "key": f"feed-{src}-{sec_iso}",
            "kind": "trackable",
            "at": _utc(g["at"]),
            "text": text,
            "name": src,
            "source": src,
            "day_label": lbl,  # '' when current — consumed by recent_activity too
        })
    return out


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

    # drop anything undated, then k-way merge by the normalized UTC ts
    items = [it for it in items if it.get("at") is not None]
    # a Python-side before guard catches the promise computed-ts edge case
    if before is not None:
        items = [it for it in items if it["at"] < before]
    items.sort(key=lambda it: it["at"], reverse=True)
    return items[:limit]
