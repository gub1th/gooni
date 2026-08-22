import json
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    Note,
)
from ..llm.client import llm_client
from ..services.memory_service import memory_service
from ..services.note_service import note_service

from ..serializers import (
    _excerpt_from_html, _strip_html_to_visible_text, _normalize_tags, _serialize_note, _serialize_note_lite, _notes_order, _archived_order, _not_archived, _memory_to_dashboard
)
from ..common import (
    _unique_viewers_for_note,
    _parse_iso_date,
)
from ..deps import note_or_404


router = APIRouter()


def _encode_home_pos(raw) -> str | None:
    """Validate + JSON-encode a sticky placement for storage. Accepts
    {"x","y"} (viewport fractions) + optional {"w","h"} (px size); returns
    None for anything else so a bad payload clears the placement rather than
    corrupting it."""
    if not isinstance(raw, dict) or "x" not in raw or "y" not in raw:
        return None
    try:
        out = {"x": float(raw["x"]), "y": float(raw["y"])}
        for k in ("w", "h"):
            if raw.get(k) is not None:
                out[k] = float(raw[k])
        return json.dumps(out)
    except (TypeError, ValueError):
        return None


# Leaf thoughts (focus convergence, 2026-08-08) are real Notes, but they arrive
# at conversation velocity — dozens a day, none of them written to be reopened.
# Left unfiltered they bury 268 hand-written notes within a month.
#
# Their PARENT batch notes stay visible on purpose: one card per run of thinking,
# carrying Claude's third-person label and any pinned image. That's the row worth
# seeing in a browsing surface, and it's the one that makes photo cards render
# again. `?tag=thought` still returns the leaves for anyone who asks directly.
_BROWSE_HIDDEN_TAG = "thought"


def _hide_thought_leaves(q):
    return q.filter(
        (Note.tags.is_(None)) | (~Note.tags.like(f'%"{_BROWSE_HIDDEN_TAG}"%'))
    )


@router.get("/notes")
def list_notes(tag: str | None = None, db: Session = Depends(get_db)):
    """All notes, newest first (Slice 6: Spaces died — this replaces
    GET /spaces/{id}/notes; optional ?tag= filters server-side).

    Leaf `thought` notes are excluded unless explicitly asked for by tag —
    see `_hide_thought_leaves`.

    Archived notes are excluded, and unlike the thought-leaf rule that holds
    even under `?tag=`: an explicit tag is a narrowing of what to browse, not
    a request to see what was put away, so `?tag=idea` must not resurrect an
    archived note. `GET /notes/archived` is the one door."""
    q = _not_archived(db.query(Note))
    if tag:
        q = q.filter(Note.tags.is_not(None), Note.tags.like(f'%"{tag.strip().lower()}"%'))
    else:
        q = _hide_thought_leaves(q)
    notes = q.order_by(_notes_order()).all()
    return [_serialize_note_lite(n) for n in notes]


@router.post("/notes")
def create_note(body: dict, db: Session = Depends(get_db)):
    """Create a note (Slice 6: replaces POST /spaces/{id}/notes — no
    space bucket; tags own organization)."""
    from datetime import datetime

    initial_content = body.get("content") or ""
    initial_tags = _normalize_tags(body.get("tags") or [])
    note = Note(
        title=body.get("title") or "",
        content=initial_content,
        excerpt=_excerpt_from_html(initial_content),
        is_pinned=bool(body.get("is_pinned", False)),
        tags=json.dumps(initial_tags) if initial_tags else None,
        # Sticky notes come in with a home_pos; log-day notes with a log_date.
        # Both null on ordinary captures.
        home_pos=_encode_home_pos(body.get("home_pos")),
        log_date=_parse_iso_date(body["log_date"]) if body.get("log_date") else None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@router.get("/notes/recent")
def get_recent_notes(limit: int = 5, db: Session = Depends(get_db)):
    """Newest notes for the dashboard's notes column. Leaf thoughts excluded —
    at conversation velocity they'd be the only thing this ever returns.
    Archived notes excluded: this is a browsing surface."""
    notes = (
        _hide_thought_leaves(_not_archived(db.query(Note)))
        .order_by(_notes_order())
        .limit(limit)
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@router.get("/notes/daily")
def list_daily_notes(days: int = 30, end: str | None = None, db: Session = Depends(get_db)):
    """Daily-log notes (the log-matrix note column) whose log_date lands in
    the [end-(days-1), end] window, newest first. Sparse — only dates that
    actually have a note. Frontend keys them by log_date. `end` (YYYY-MM-DD)
    defaults to today; page backwards to match the matrix's infinite scroll.

    Archived notes excluded — the matrix cell reads empty for that day, and
    `PUT /notes/daily/{date}` skips archived rows too, so typing into the
    cleared cell writes a FRESH note rather than silently filling an invisible
    one."""
    from datetime import timedelta

    from ..common import local_today

    days = max(1, min(days, 366))
    end_d = _parse_iso_date(end) if end else local_today(db)
    start_d = end_d - timedelta(days=days - 1)
    notes = (
        _not_archived(db.query(Note))
        .filter(
            Note.log_date.is_not(None),
            Note.log_date >= start_d,
            Note.log_date <= end_d,
        )
        .order_by(Note.log_date.desc())
        .all()
    )
    return [_serialize_note(n) for n in notes]


@router.get("/notes/sticky")
def list_sticky_notes(db: Session = Depends(get_db)):
    """Sticky notes parked on the ambient home canvas — the `sticky`-tagged
    notes that carry a home_pos. Full serialization (content included) so the
    home can render + edit them; the flat /notes list only ships lite rows.

    Archived notes excluded — a sticky is the most visible surface there is,
    so an archived one still parked on the canvas would be the loudest
    possible version of the bug this feature exists to prevent. `home_pos`
    is preserved on the row, so unarchiving puts it back where it was."""
    notes = (
        _not_archived(db.query(Note))
        .filter(Note.home_pos.is_not(None))
        .order_by(Note.created_at.asc())
        .all()
    )
    return [_serialize_note(n) for n in notes]


@router.put("/notes/daily/{date}")
def upsert_daily_note(date: str, body: dict, db: Session = Depends(get_db)):
    """Upsert the daily-log note for `date` (YYYY-MM-DD). Body {content}.
    Empty content deletes the note (cell-clear semantics, mirrors trackables).
    One note per date via the log_date key, carried by the `daily` tag;

    Archived rows are invisible to this lookup on purpose. `GET /notes/daily`
    drops them, so the cell renders empty — and if the upsert still ADOPTED
    the archived row, typing into that empty-looking cell would write into a
    note nothing displays. Skipping it means the write creates a fresh daily
    note for the date and the archived one stays exactly as it was put away.
    Same reason the empty-content clear only ever deletes the live row."""
    from datetime import datetime

    d = _parse_iso_date(date)
    content = body.get("content") or ""
    visible = _strip_html_to_visible_text(content).strip()
    existing = (
        _not_archived(db.query(Note))
        .filter(Note.log_date == d)
        .order_by(Note.id.asc())
        .first()
    )
    if not visible:
        if existing is not None:
            db.delete(existing)
            db.commit()
        return {"cleared": True}
    if existing is None:
        existing = Note(
            title=d.isoformat(),
            content=content,
            excerpt=_excerpt_from_html(content),
            log_date=d,
            tags=json.dumps(["daily"]),
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(existing)
    else:
        existing.content = content
        existing.excerpt = _excerpt_from_html(content)
        existing.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(existing)
    return _serialize_note(existing)


@router.patch("/notes/{note_id}")
def update_note(
    note_id: int,
    body: dict,
    db: Session = Depends(get_db),
):
    from datetime import datetime

    note = note_or_404(note_id, db)

    # Track whether title/content ACTUALLY differ from what's on disk. The
    # frontend's save-on-leave path PATCHes unconditionally to avoid losing
    # races (see NoteEditor's save-on-leave comment), so plenty of these
    # PATCHes carry identical values. Bumping updated_at on those would
    # promote the note to the top of the list every time it's opened —
    # that's the "no edits, but movement" bug. Only bump when something
    # actually changed.
    title_changed = False
    content_changed = False

    if "title" in body:
        new_title = body["title"]
        if (new_title or None) != (note.title or None):
            title_changed = True
        note.title = new_title
    if "content" in body:
        # Safety net for the empty-overwrite bug class (a frontend race or a
        # silently-failed request could otherwise wipe a populated note). Refuse
        # to replace non-trivial existing content with VISUALLY-empty content
        # unless the caller opts in via {"force": true}. Returns 409 so the
        # frontend can surface it in the save-status pill instead of pretending
        # the write succeeded. Title/space/visibility patches still apply.
        #
        # Visual emptiness (NOT byte emptiness): TipTap serializes a freshly-
        # cleared editor as `<p></p>` (7 bytes). The original guard used
        # `.strip()` on the raw HTML, which let `<p></p>` through and let
        # the editor wipe a populated note silently — the bug Daniel hit on
        # note 248. Strip HTML tags + common entity stand-ins before the
        # emptiness check so the guard catches every flavour of "user sees
        # nothing on screen."
        new_content = body["content"]
        prev_visible = _strip_html_to_visible_text(note.content or "")
        new_visible = _strip_html_to_visible_text(new_content) if isinstance(new_content, str) else ""
        force = bool(body.get("force"))
        if prev_visible and not new_visible and not force:
            raise HTTPException(
                status_code=409,
                detail=(
                    "refusing to overwrite non-empty note content with empty "
                    "content; pass force=true to override"
                ),
            )
        if (new_content or None) != (note.content or None):
            content_changed = True
        note.content = new_content
        # Refresh cached excerpt alongside content so list endpoints stay
        # in sync without a round-trip through the regex stripper.
        note.excerpt = _excerpt_from_html(new_content)
    if title_changed or content_changed:
        note.updated_at = datetime.utcnow()
    if "is_public" in body:
        new_public = bool(body["is_public"])
        note.is_public = new_public
    if "is_pinned" in body:
        note.is_pinned = bool(body["is_pinned"])
    if "is_public_pinned" in body:
        note.is_public_pinned = bool(body["is_public_pinned"])
    if "is_archived" in body:
        # Archive / unarchive. Deliberately touches NOTHING but the two
        # archive columns: no content, no tags, no pins, no children, no
        # attachments — restoring is the same bit flipped back and the note
        # returns exactly as it left. `archived_at` is stamped only on the
        # transition INTO archived so re-archiving an already-archived note
        # (an idempotent client retry) can't rewrite the original date, and
        # is cleared on the way out so a restored note carries no phantom
        # archive stamp. updated_at is NOT bumped — putting a note away is
        # not an edit, and bumping it would jump the note to the top of every
        # recency list the moment it comes back.
        want_archived = bool(body["is_archived"])
        if want_archived and not note.is_archived:
            note.archived_at = datetime.utcnow()
        elif not want_archived:
            note.archived_at = None
        note.is_archived = want_archived
    if "tags" in body:
        normalized = _normalize_tags(body["tags"])
        note.tags = json.dumps(normalized) if normalized else None
    if "home_pos" in body:
        # Sticky drag-reposition. Null clears the placement (note stops being
        # a sticky on the canvas). Doesn't bump updated_at — moving a note
        # isn't an edit, and we don't want it jumping the sidebar's recency
        # sort every drag.
        note.home_pos = _encode_home_pos(body.get("home_pos"))
    if "icon" in body:
        raw_icon = body.get("icon")
        if raw_icon is None or raw_icon == "":
            note.icon = None
        elif isinstance(raw_icon, str) and len(raw_icon) <= 64:
            note.icon = raw_icon
        else:
            raise HTTPException(status_code=400, detail="icon must be string ≤64 chars or null")
    db.commit()
    db.refresh(note)
    return _serialize_note(note)


@router.post("/notes/{note_id}/extract")
def extract_to_child_note(note_id: int, body: dict, db: Session = Depends(get_db)):
    """Carve a selection out of a parent note into a brand-new child note.

    Returns the new child note. The frontend is responsible for replacing
    the selected text in the parent's editor with a `noteLink` chip pointing
    to `child.id` and saving the updated parent. We don't mutate the parent
    here — the editor already has the in-memory state and a single PATCH
    round-trip after this avoids a content-conflict if the user kept typing.
    """
    from datetime import datetime

    parent = note_or_404(note_id, db, what="parent note")
    selected_html = body.get("selected_html") or ""
    if not selected_html.strip():
        raise HTTPException(status_code=400, detail="selected_html required")
    title = (body.get("title") or "").strip() or None
    # Anchor label = first ~40 chars of plain text from the selection. The
    # editor renders this on the chip; backend just stashes it for callers
    # that need it without parsing the child's HTML.
    plain = re.sub(r"<[^>]+>", " ", selected_html).strip()
    anchor = plain[:40].strip() if plain else None

    # Dedup window: if the same parent already produced a child with this
    # exact HTML in the last 30 seconds, return that child instead of
    # creating a duplicate. Protects against the click-spam Daniel hit in
    # PR #244 (latency + no loading state → flood of POSTs → 4 junk
    # children). Idempotency on (parent_id, content). 30s is generous —
    # long enough to swallow the worst latency spike, short enough that
    # an intentional re-extract of the same paragraph an hour later still
    # creates a fresh child.
    from datetime import timedelta as _td
    # Archived children can't win the dedup: returning one would hand the
    # editor a note that no surface displays, so the extraction would look
    # like it silently did nothing.
    cutoff = datetime.utcnow() - _td(seconds=30)
    existing = (
        _not_archived(db.query(Note))
        .filter(
            Note.parent_note_id == parent.id,
            Note.content == selected_html,
            Note.created_at >= cutoff,
        )
        .order_by(Note.created_at.desc())
        .first()
    )
    if existing is not None:
        return _serialize_note(existing)

    child = Note(
        title=title,
        content=selected_html,
        excerpt=_excerpt_from_html(selected_html),
        parent_note_id=parent.id,
        excerpt_anchor=anchor,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(child)
    db.commit()
    db.refresh(child)
    return _serialize_note(child)


@router.get("/notes/{note_id}/children")
def get_note_children(note_id: int, db: Session = Depends(get_db)):
    """Direct children of `note_id` (notes whose parent_note_id points here).
    Powers the related-notes panel + the chip-target preview.

    Archived CHILDREN are excluded — this is a browsing panel. Archiving a
    PARENT does not cascade: children are independent notes with their own
    lives (they're reachable from the sidebar, search and any other parent
    that links them), so hiding one because its parent went away would be a
    silent bulk archive nobody asked for. A noteLink chip pointing at an
    archived child still resolves, since fetch-by-id is unaffected."""
    children = (
        _not_archived(db.query(Note))
        .filter(Note.parent_note_id == note_id)
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in children]


@router.get("/notes/pinned")
def get_pinned_notes(db: Session = Depends(get_db)):
    """Archive BEATS pin. A pin says "keep this in front of me" and an archive
    says "stop showing me this"; the later instruction wins. `is_pinned` stays
    set on the row, so unarchiving puts it straight back in this section."""
    notes = (
        _not_archived(db.query(Note))
        .filter(Note.is_pinned == True)  # noqa: E712
        .order_by(_notes_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@router.get("/notes/archived")
def get_archived_notes(db: Session = Depends(get_db)):
    """The recovery read — the ONE surface that shows archived notes.

    Lite rows, no bodies — it is a filtered sidebar list you click into.
    Ordered by when
    they were archived rather than when they were last edited — see
    `_archived_order`. Unarchive is `PATCH /notes/{id} {is_archived: false}`."""
    notes = (
        db.query(Note)
        .filter(Note.is_archived == True)  # noqa: E712
        .order_by(_archived_order())
        .all()
    )
    return [_serialize_note_lite(n) for n in notes]


@router.get("/notes/graph")
def notes_graph(db: Session = Depends(get_db)):
    """Semantic graph of all embedded notes.

    Nodes = notes with embeddings, sized by log(word_count+1).
    Edges = pairs with cosine similarity above a threshold — these are the
    "you've written related things" connections that drive the physics-based
    clustering on the frontend.

    Clustering labels are intentionally NOT computed here — let the frontend's
    force-directed layout surface clumps visually first; labels can be a
    follow-up that queries this endpoint + hits the LLM for cluster names.
    """
    import json
    import math
    import re as _re

    # Tuple query — only the columns the graph builder needs, so we don't
    # hydrate the deferred classified_embedding or any other Note columns
    # (and we still get content for word_count). 6MB notes (cf. PR-#134
    # postmortem) make this materially cheaper than .query(Note).all().
    # Archived notes are excluded — this is a browsing surface over the whole
    # corpus, and an archived note left in it would show up as a node AND drag
    # its neighbours' clustering around. The embedding itself is KEPT on the
    # row, so unarchiving restores the node with no recompute.
    notes = (
        _not_archived(db.query(Note.id, Note.title, Note.content, Note.embedding))
        .filter(Note.embedding.isnot(None))
        .all()
    )

    # Parse embeddings + build node metadata.
    vectors: list[list[float]] = []
    nodes: list[dict] = []
    for nid, ntitle, ncontent, nemb in notes:
        try:
            v = json.loads(nemb)
            if not isinstance(v, list) or not v:
                continue
        except (ValueError, TypeError):
            continue
        # Word count for node size — strip HTML first.
        raw = (ntitle or "") + " " + (ncontent or "")
        raw = _re.sub(r"<[^>]+>", " ", raw)
        words = [w for w in raw.split() if w.strip()]
        word_count = len(words)
        vectors.append(v)
        nodes.append({
            "id": nid,
            "title": (ntitle or "").strip() or "(untitled)",
            "size": round(math.log2(word_count + 2), 3),
        })

    if len(vectors) < 2:
        return {"nodes": nodes, "edges": []}

    # Pre-compute norms so the pairwise loop doesn't repeat work.
    norms = [math.sqrt(sum(x * x for x in v)) or 1.0 for v in vectors]

    # Cosine-similarity edges. Threshold is deliberately moderate (0.62) so
    # we get visible clusters without the hairball-of-edges problem.
    SIM_THRESHOLD = 0.62
    edges: list[dict] = []
    n_count = len(vectors)
    for i in range(n_count):
        vi = vectors[i]
        ni = norms[i]
        for j in range(i + 1, n_count):
            vj = vectors[j]
            nj = norms[j]
            # Inner loop hot path — dimension is uniform, zip is fast enough
            # for ~200 notes; switch to numpy if this ever feels slow.
            dot = 0.0
            for a, b in zip(vi, vj):
                dot += a * b
            sim = dot / (ni * nj)
            if sim >= SIM_THRESHOLD:
                edges.append({
                    "from": nodes[i]["id"],
                    "to": nodes[j]["id"],
                    "weight": round(sim, 3),
                })

    return {"nodes": nodes, "edges": edges}


@router.post("/notes/cleanup")
def cleanup_empty_notes(dry_run: bool = False, db: Session = Depends(get_db)):
    """Delete only truly empty notes. "Real content" = ANY non-whitespace
    plaintext after stripping HTML (however short — "gym" is a real note),
    OR any embedded media (img/video/iframe), OR a real title. Pinned notes
    are always preserved (explicit user intent). Empty untitled notes are
    NOT preserved.

    The old >= 6-char plaintext threshold swept real few-word notes (a
    "decided to skip gym today" thought is content); length is no longer a
    criterion. The media carve-out matters because a note that's just a
    pasted screenshot strips down to "" plaintext. A titled-but-bodyless
    note is kept too — the title is content the user typed.
    """
    import re

    media_re = re.compile(r"<(img|video|iframe|figure)\b", re.IGNORECASE)
    tag_strip_re = re.compile(r"<[^>]+>")
    ws_re = re.compile(r"\s+")

    def _has_real_content(html: str | None, title: str | None = None) -> bool:
        if title and title.strip() and title.strip().lower() != "untitled":
            return True
        if not html:
            return False
        if media_re.search(html):
            return True
        text_only = ws_re.sub(" ", tag_strip_re.sub(" ", html)).strip()
        return len(text_only) > 0

    # Archived notes are never swept. Archiving is the NON-destructive action;
    # having it feed a delete sweep would make it destructive-with-a-delay,
    # which is the one thing this must never be. They're also exactly the
    # rows most likely to look empty (a scrap you put away), so excluding
    # them is load-bearing, not defensive.
    non_pinned = (
        _not_archived(db.query(Note))
        .filter((Note.is_pinned == False) | (Note.is_pinned.is_(None)))  # noqa: E712
        .all()
    )
    pinned_empty = (
        _not_archived(db.query(Note))
        .filter(Note.is_pinned == True)  # noqa: E712
        .all()
    )
    deleted_ids = []
    for n in non_pinned:
        if not _has_real_content(n.content, n.title):
            deleted_ids.append(n.id)
            if not dry_run:
                db.delete(n)
    preserved_pinned_empty = sum(
        1 for n in pinned_empty if not _has_real_content(n.content, n.title)
    )
    if not dry_run:
        db.commit()
    return {
        "deleted": len(deleted_ids),
        "ids": deleted_ids,
        "preserved_pinned_empty": preserved_pinned_empty,
        "dry_run": dry_run,
    }


@router.post("/notes/{note_id}/classify")
def classify_note_route(note_id: int, db: Session = Depends(get_db)):
    """Embed the note, then run the unified classifier off-thread.

    Named for the bigger half of what it does. It shipped as `/embed`, which
    described only the synchronous step and hid the part that actually writes:
    `classify_note` extracts signals and routes them through `intent_router`,
    minting memories and feature-request notes. Every adjacent identifier
    already says classify (`classified_embedding`, `classify_signals`,
    `NoteClassifySignals`), so the route now matches them.

    Called on blur / dirty-leave, never on every save — both halves cost an
    LLM call.
    """
    import threading

    note_or_404(note_id, db)
    note_service.update_embedding(note_id)  # opens/closes its own session

    # Unified extractor: runs in a daemon thread so the embed endpoint
    # returns fast. Internally dedup-gates via `Note.classified_embedding`
    # so trivial edits don't re-extract.
    from ..services.note_service import classify_note
    threading.Thread(
        target=classify_note,
        args=(note_id,),
        daemon=True,
    ).start()

    return {"ok": True}


@router.post("/notes/{note_id}/touch")
def touch_note(note_id: int, db: Session = Depends(get_db)):
    """Update last_opened_at. Called whenever a note is selected."""
    from datetime import datetime

    note = note_or_404(note_id, db)
    note.last_opened_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.post("/notes/{note_id}/auto-title")
async def auto_title_note(note_id: int, db: Session = Depends(get_db)):
    """Generate + save a short title for a note when Daniel hasn't named it.
    Uses gpt-4o-mini (`llm_client.generate_title`). Idempotent on the
    backend — repeat calls overwrite — but the frontend gates on a
    placeholder title so we don't clobber user-typed titles.
    Returns the new title or the existing one if the note is too short.
    """
    note = note_or_404(note_id, db)

    plaintext = note_service._strip_html(note.content or "").strip()
    # Below ~40 chars there isn't enough signal — return existing title.
    if len(plaintext) < 40:
        return {"title": note.title or "", "generated": False}

    title = await llm_client.generate_title(plaintext[:1500])
    title = (title or "").strip().strip('"').strip("'")
    if not title:
        return {"title": note.title or "", "generated": False}

    note.title = title
    db.commit()
    return {"title": title, "generated": True}


@router.delete("/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    from datetime import datetime

    note = note_or_404(note_id, db)
    # Sweep parent notes for any NoteLink chip pointing at this id and
    # replace it with its label as plain text — otherwise the parent
    # carries a dead chip that 404s when Daniel clicks it.
    # The chip HTML shape is:
    #   <a data-note-link="true" data-note-id="<id>" data-label="<label>"
    #      class="gooni-note-link" href="#" target="_self">label</a>
    # We match by `data-note-id="<id>"` to avoid touching unrelated chips.
    # Regex is the lightest tool — DOM parsing in BS4 here would add a
    # ~50ms tax on a high-traffic route, and the chip syntax is stable.
    pattern = re.compile(
        r'<a\b[^>]*\bdata-note-link="true"[^>]*\bdata-note-id="'
        + str(note.id)
        + r'"[^>]*>(.*?)</a>',
        flags=re.DOTALL | re.IGNORECASE,
    )
    # Archived parents are INCLUDED here — this is the one note query in the
    # file that deliberately reaches them. It isn't a surface; it's a
    # consistency repair, and skipping an archived parent would leave a chip
    # that 404s the day the note is unarchived.
    affected_parents = (
        db.query(Note)
        .filter(Note.content.like(f'%data-note-id="{note.id}"%'))
        .all()
    )
    for p in affected_parents:
        if not p.content:
            continue
        # Replace the chip with its inner text. We could also pull the
        # data-label attr; the inner text is identical post-#renderHTML so
        # it's the same string either way.
        rewritten = pattern.sub(lambda m: m.group(1), p.content)
        if rewritten != p.content:
            p.content = rewritten
            p.excerpt = _excerpt_from_html(rewritten)
            p.updated_at = datetime.utcnow()
    db.delete(note)
    db.commit()
    return {"ok": True, "orphan_links_rewritten": len(affected_parents)}


@router.get("/notes/{note_id}/memories")
def get_note_memories(note_id: int, limit: int = 6, db: Session = Depends(get_db)):
    """Memories linked to this note. Used by the
    editor's Memories pill section so Daniel sees what the note contributed."""
    from ..db.models import Memory
    rows = (
        db.query(Memory)
        .filter(Memory.source_note_id == note_id, Memory.is_active == True)  # noqa: E712
        .order_by(Memory.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_memory_to_dashboard(m) for m in rows]


@router.get("/notes/search-titles")
def search_note_titles(q: str = "", limit: int = 8, db: Session = Depends(get_db)):
    """Title-substring search for the @-mention note picker. Cheap (no
    embedding), prefix-friendly, recency-ordered. Empty q → recent notes.
    Returns list-shape (no body).

    Archived notes excluded (in `note_service.search_by_title`) — mentioning
    is authoring: the picker offers what you might link to, and an archived
    note is exactly what you have decided not to reach for."""
    notes = note_service.search_by_title(q, limit, db)
    return [_serialize_note_lite(n) for n in notes]


@router.get("/notes/search")
def search_notes(q: str, limit: int = 8, db: Session = Depends(get_db)):
    """Semantic note search (embedding cosine) for the home QuickFind bar.

    Same service call as the older `/mcp/notes/search`, re-homed under
    `/notes/*` because `app.mount("/mcp", focus_mcp.http_app)` in main.py
    swallows EVERY `/mcp/*` path — a Starlette mount shadows router routes
    sharing its prefix, so the mcp router's search endpoints 404. Declared
    before `/notes/{note_id}` so "search" isn't parsed as an id.

    Archived notes are excluded from RESULTS but keep their embeddings — see
    `note_service.search_by_query`.
    """
    notes = note_service.search_by_query(q, limit, db)
    return [_serialize_note_lite(n) for n in notes]


@router.get("/notes/{note_id}")
def get_note(note_id: int, db: Session = Depends(get_db)):
    """Return a single note by ID. Tacks on `unique_viewers` so the editor
    can show the count next to the Public toggle without a second round-trip.

    Archived notes ARE returned. Archiving hides a note from the surfaces that
    offer it up unasked; it does not make it unreachable, and the archive
    view's rows have to open somewhere. `is_archived` rides on the payload so
    the editor can show it's looking at an archived note."""
    note = note_or_404(note_id, db)
    payload = _serialize_note(note)
    payload["unique_viewers"] = _unique_viewers_for_note(db, note.id)
    return payload
