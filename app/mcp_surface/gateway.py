"""The data-access seam under the converged MCP tool surface.

Two implementations, one interface:

- `DirectGateway` — calls `focus_service` / `note_service` / `memory_service` /
  `trackable_service` against a DB session in the SAME process. Used by the
  `/mcp` mount inside the FastAPI app.
- `HttpGateway` — Bearer-authed httpx calls to a Gooni backend. Used by the
  stdio server, which runs on Daniel's laptop pointed at PROD
  (`GOONI_URL=https://gooni-bot.fly.dev`, see `.mcp.json.example`).

Why the seam exists at all, rather than every tool just calling the services:
the stdio server is NOT in-process. Prod's SQLite lives on a Fly volume with no
route from the laptop, so direct service calls there would silently repoint
every Claude Code write into a local database file — writes that look like they
succeeded and land where nothing reads them. The seam is what keeps one tool
definition serving both without that trade.

The rule that keeps the two from drifting: gateways do DATA ACCESS ONLY. No
argument coercion, no response formatting, no defaulting of user-facing
values — all of that lives once in `tools.py`. A gateway method is a verb
against storage and nothing else, and wherever a tool needs two writes to be
atomic (create-a-promise-then-set-its-cadence) the composite is ONE gateway
method so it is one transaction on both sides.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime
from typing import Any


class Gateway:
    """Interface. Every method raises here so a half-built implementation
    fails loudly at the call rather than returning None into a response."""

    #: Value written to `ToolCall.source` for calls made through this gateway.
    source_label = "mcp"

    def _todo(self, name: str):
        raise NotImplementedError(f"{type(self).__name__}.{name}")

    # ── notes ────────────────────────────────────────────────────────────────
    def create_note(self, *, title, content, tags, is_pinned) -> dict: self._todo("create_note")
    def log_thought(self, *, content, topic, new_batch, label, at) -> dict: self._todo("log_thought")
    def search_notes_semantic(self, *, q, limit) -> list[dict]: self._todo("search_notes_semantic")
    def list_notes(self, *, tag, limit) -> list[dict]: self._todo("list_notes")
    def recent_notes(self, *, limit) -> list[dict]: self._todo("recent_notes")
    def query_thoughts(self, *, topic, since, text, limit) -> list[dict]: self._todo("query_thoughts")
    def get_note(self, note_id: int) -> dict | None: self._todo("get_note")
    def update_note(self, note_id: int, patch: dict) -> dict | None: self._todo("update_note")
    def delete_note(self, note_id: int) -> dict | None: self._todo("delete_note")
    def attach_file(self, *, note_id, filename, data, mime, block_html_fn) -> dict: self._todo("attach_file")

    # ── promises ─────────────────────────────────────────────────────────────
    def create_promise(
        self, *, content, due, owed_to, from_thought, cadence, cadence_target, is_important
    ) -> dict:
        self._todo("create_promise")

    def list_promises(self, *, day, state, limit) -> list[dict]: self._todo("list_promises")
    def set_promise_state(self, *, promise_id, state) -> dict | None: self._todo("set_promise_state")

    # ── focus sessions ───────────────────────────────────────────────────────
    def start_focus_session(self, *, title, promise_id, style, target_ms) -> dict:
        self._todo("start_focus_session")

    def stop_focus_session(self) -> dict | None: self._todo("stop_focus_session")
    def active_focus_session(self) -> dict | None: self._todo("active_focus_session")

    # ── topics ───────────────────────────────────────────────────────────────
    def create_topic(self, *, name, parent) -> dict: self._todo("create_topic")
    def list_topics(self) -> list[dict]: self._todo("list_topics")

    # ── trackables ───────────────────────────────────────────────────────────
    def list_trackables(self) -> list[dict]: self._todo("list_trackables")
    def create_trackable(self, payload: dict) -> dict: self._todo("create_trackable")
    def log_trackable_entry(self, *, trackable_id, body) -> dict: self._todo("log_trackable_entry")
    def trackable_pivot(self, *, trackable_id, days) -> list[dict]: self._todo("trackable_pivot")

    # ── memory ───────────────────────────────────────────────────────────────
    def memory_context(self, *, q) -> str: self._todo("memory_context")
    def add_memory(self, *, content) -> dict: self._todo("add_memory")
    def search_memories(self, *, q, limit) -> list[dict]: self._todo("search_memories")
    def edit_memory(self, *, memory_id, content) -> bool: self._todo("edit_memory")
    def forget_memory(self, *, memory_id) -> bool: self._todo("forget_memory")
    def list_preferences(self, *, limit) -> dict: self._todo("list_preferences")

    # ── audit ────────────────────────────────────────────────────────────────
    def log_tool_call(self, *, tool_name, args, status, result, error) -> None:
        """Best-effort. Must never raise — see mcp_logging.record_call."""


# ─────────────────────────────────────────────────────────────────────────────
# In-process
# ─────────────────────────────────────────────────────────────────────────────


class DirectGateway(Gateway):
    """Same-process implementation: a session per operation, committed on
    success. Mirrors what `focus_mcp` did before the convergence."""

    source_label = "mcp-http"

    @contextmanager
    def _session(self):
        from ..db.database import SessionLocal

        db = SessionLocal()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    # ── notes ────────────────────────────────────────────────────────────────
    def create_note(self, *, title, content, tags, is_pinned) -> dict:
        from ..db.models import Note
        from ..serializers import _excerpt_from_html, _normalize_tags

        with self._session() as db:
            note = Note(
                title=title or "",
                content=content or "",
                excerpt=_excerpt_from_html(content or ""),
                tags=json.dumps(_normalize_tags(tags or [])),
                is_pinned=bool(is_pinned),
            )
            db.add(note)
            db.flush()
            return {
                "id": note.id,
                "title": note.title,
                "tags": json.loads(note.tags or "[]"),
                "is_pinned": bool(note.is_pinned),
            }

    def log_thought(self, *, content, topic, new_batch, label, at) -> dict:
        from ..services import focus_service

        with self._session() as db:
            return focus_service.log_thought(
                db, content=content, topic_name=topic,
                new_batch=new_batch, label=label, at=at,
            )

    def search_notes_semantic(self, *, q, limit) -> list[dict]:
        from ..serializers import _serialize_note
        from ..services.note_service import note_service

        with self._session() as db:
            return [_serialize_note(n) for n in note_service.search_by_query(q, limit, db)]

    def list_notes(self, *, tag, limit) -> list[dict]:
        # Mirrors GET /notes exactly, archive exclusion included (even under
        # `tag` — see that route's docstring).
        from ..db.models import Note
        from ..routers.notes import _hide_thought_leaves
        from ..serializers import _not_archived, _notes_order, _serialize_note_lite

        with self._session() as db:
            query = _not_archived(db.query(Note))
            if tag:
                query = query.filter(
                    Note.tags.is_not(None), Note.tags.like(f'%"{tag.strip().lower()}"%')
                )
            else:
                query = _hide_thought_leaves(query)
            rows = query.order_by(_notes_order()).limit(limit).all()
            return [_serialize_note_lite(n) for n in rows]

    def recent_notes(self, *, limit) -> list[dict]:
        # Same query as GET /notes/recent, thought-leaf and archive exclusions
        # included — at conversation velocity logged thoughts would otherwise
        # be the only thing this ever returns.
        from ..db.models import Note
        from ..routers.notes import _hide_thought_leaves
        from ..serializers import _not_archived, _notes_order, _serialize_note_lite

        with self._session() as db:
            rows = (
                _hide_thought_leaves(_not_archived(db.query(Note)))
                .order_by(_notes_order())
                .limit(limit)
                .all()
            )
            return [_serialize_note_lite(n) for n in rows]

    def archived_notes(self, *, limit) -> list[dict]:
        # Same query as GET /notes/archived — the ONE read that shows them.
        from ..db.models import Note
        from ..serializers import _archived_order, _serialize_note_lite

        with self._session() as db:
            rows = (
                db.query(Note)
                .filter(Note.is_archived == True)  # noqa: E712
                .order_by(_archived_order())
                .limit(limit)
                .all()
            )
            return [_serialize_note_lite(n) for n in rows]

    def query_thoughts(self, *, topic, since, text, limit) -> list[dict]:
        from ..services import focus_service

        with self._session() as db:
            return focus_service.query_thoughts(
                db, topic=topic, since=since, text=text, limit=limit
            )

    def get_note(self, note_id: int) -> dict | None:
        from ..db.models import Note
        from ..serializers import _serialize_note

        with self._session() as db:
            note = db.query(Note).filter(Note.id == note_id).first()
            return _serialize_note(note) if note else None

    def update_note(self, note_id: int, patch: dict) -> dict | None:
        from ..db.models import Note
        from ..serializers import _excerpt_from_html, _normalize_tags
        from ..serializers import _serialize_note

        with self._session() as db:
            note = db.query(Note).filter(Note.id == note_id).first()
            if note is None:
                return None
            if "title" in patch:
                note.title = patch["title"]
            if "content" in patch:
                note.content = patch["content"]
                note.excerpt = _excerpt_from_html(patch["content"] or "")
            if "is_pinned" in patch:
                note.is_pinned = bool(patch["is_pinned"])
            if "is_archived" in patch:
                # Same transition rules as PATCH /notes/{id}: stamp
                # `archived_at` only on the way IN (so a repeated archive
                # can't rewrite the original date) and clear it on the way out.
                want_archived = bool(patch["is_archived"])
                if want_archived and not note.is_archived:
                    note.archived_at = datetime.utcnow()
                elif not want_archived:
                    note.archived_at = None
                note.is_archived = want_archived
            if "tags" in patch:
                note.tags = json.dumps(_normalize_tags(patch["tags"] or []))
            # An archive-only patch does NOT bump updated_at — putting a note
            # away isn't an edit, and bumping would send it straight to the
            # top of every recency list the moment it is restored. Matches
            # PATCH /notes/{id}, so both gateways answer identically.
            if set(patch) - {"is_archived"}:
                note.updated_at = datetime.utcnow()
            db.flush()
            return _serialize_note(note)

    def delete_note(self, note_id: int) -> dict | None:
        from ..db.models import Note

        with self._session() as db:
            note = db.query(Note).filter(Note.id == note_id).first()
            if note is None:
                return None
            snapshot = {"id": note.id, "title": note.title}
            db.delete(note)
            return snapshot

    def attach_file(self, *, note_id, filename, data, mime, block_html_fn) -> dict:
        from ..db.models import Attachment, Note
        from ..services import image_storage

        if not image_storage.is_configured():
            raise RuntimeError("R2 storage not configured (R2_ACCOUNT_ID etc unset)")
        result = image_storage.upload_file(data, mime, filename)
        with self._session() as db:
            note = db.query(Note).filter(Note.id == note_id).first()
            if note is None:
                raise LookupError(f"note #{note_id} not found")
            row = Attachment(
                note_id=note_id, filename=filename, mime_type=mime,
                size_bytes=len(data), storage_key=result["key"],
                public_url=result["url"],
            )
            db.add(row)
            db.flush()
            block = block_html_fn(
                url=result["url"], filename=filename, mime=mime,
                size=len(data), attachment_id=row.id,
            )
            note.content = (note.content or "") + block
            note.updated_at = datetime.utcnow()
            db.flush()
            return {
                "url": result["url"], "filename": filename, "mime_type": mime,
                "size_bytes": len(data), "attachment_id": row.id,
            }

    # ── promises ─────────────────────────────────────────────────────────────
    def create_promise(
        self, *, content, due, owed_to, from_thought, cadence, cadence_target, is_important
    ) -> dict:
        """One transaction: the base commitment plus its cadence/importance.

        Two steps because `set_reminder` owns dedup, person resolution and the
        thought edge but has no cadence parameter (it grew out of the focus
        system, which had no recurrence), while `update_reminder` owns the
        recurrence rules. Both run inside ONE transaction — split across two
        commits, a failure after the first would leave a promise standing with
        the wrong recurrence, silently meaning something other than what Daniel
        said.
        """
        from ..services import focus_service

        with self._session() as db:
            row = focus_service.set_reminder(
                db, content=content, due_at=due, owed_to=owed_to,
                from_thought=from_thought,
            )
            if not _needs_cadence_patch(cadence, cadence_target, is_important):
                return row
            updated = focus_service.update_reminder(
                db, row["id"], cadence=cadence, cadence_target=cadence_target,
                is_important=True if is_important else None,
            )
            return updated or row

    def list_promises(self, *, day, state, limit) -> list[dict]:
        from ..common import local_today
        from ..services import focus_service

        with self._session() as db:
            # The "today" sentinel resolves HERE, in Settings.nudge_tz — the
            # server runs UTC, so a 5pm-PT call asking for "today" would
            # otherwise get UTC-tomorrow's bucket.
            if day == "today":
                today = local_today(db)
                day = datetime(today.year, today.month, today.day)
            return focus_service.list_reminders(db, day=day, state=state, limit=limit)

    def set_promise_state(self, *, promise_id, state) -> dict | None:
        from ..services import focus_service

        with self._session() as db:
            return focus_service.set_reminder_state(db, promise_id, state)

    # ── focus sessions ───────────────────────────────────────────────────────
    # Camera control is NOT reconciled here: `focus_session_service` does it on
    # every lifecycle transition, so a session started from Claude, from the
    # home, or from `/focus` points the sidecar at the same thing. Doing it in
    # the gateway too would be a second owner of one rule — and the HTTP side
    # could not honour it without a second round trip anyway.
    def start_focus_session(self, *, title, promise_id, style, target_ms) -> dict:
        from ..services import focus_session_service

        with self._session() as db:
            s = focus_session_service.start(
                db, title=title, promise_id=promise_id, style=style, target_ms=target_ms
            )
            return focus_session_service.serialize(db, s)

    def stop_focus_session(self) -> dict | None:
        from ..services import focus_session_service

        with self._session() as db:
            s = focus_session_service.active(db)
            if s is None:
                return None
            stopped = focus_session_service.stop(db, s)
            out = focus_session_service.serialize(db, stopped)
            out["activity"] = focus_session_service.activity(db, stopped)
            return out

    def active_focus_session(self) -> dict | None:
        from ..services import focus_session_service

        with self._session() as db:
            s = focus_session_service.active(db)
            if s is None:
                return None
            out = focus_session_service.serialize(db, s)
            out["activity"] = focus_session_service.activity(db, s)
            return out

    # ── topics ───────────────────────────────────────────────────────────────
    def create_topic(self, *, name, parent) -> dict:
        from ..services import focus_service

        with self._session() as db:
            topic = focus_service.create_topic(db, name=name, parent=parent)
            return {
                "id": topic.id, "name": topic.name, "parent_id": topic.parent_id,
                "color": topic.color, "salience": topic.salience,
            }

    def list_topics(self) -> list[dict]:
        from ..services import focus_service

        with self._session() as db:
            return focus_service.list_topics(db)

    # ── trackables ───────────────────────────────────────────────────────────
    def list_trackables(self) -> list[dict]:
        from ..services import trackable_service

        with self._session() as db:
            return [trackable_service.serialize(t) for t in trackable_service.list_all(db)]

    def create_trackable(self, payload: dict) -> dict:
        from ..services import trackable_service

        with self._session() as db:
            t = trackable_service.create(db, **payload)
            return trackable_service.serialize(t)

    def log_trackable_entry(self, *, trackable_id, body) -> dict:
        from ..services import trackable_service

        with self._session() as db:
            t = trackable_service.get(db, trackable_id)
            if t is None:
                raise LookupError(f"no trackable #{trackable_id}")
            day = body.get("date")
            if isinstance(day, str) and day:
                from ..common import _parse_iso_date

                day = _parse_iso_date(day)
            entry = trackable_service.log_entry(
                db, t,
                day=day or None,
                value_boolean=body.get("value_boolean"),
                value_numeric=body.get("value_numeric"),
                value_json=body.get("value_json"),
                source=body.get("source") or "manual",
                replace=bool(body.get("replace")),
            )
            if entry is None:
                return {"cleared": True}
            return {"entry": trackable_service.serialize_entry(entry)}

    def trackable_pivot(self, *, trackable_id, days) -> list[dict]:
        from ..services import trackable_service

        with self._session() as db:
            return trackable_service.pivot(db, trackable_id, days=days)

    # ── memory ───────────────────────────────────────────────────────────────
    def memory_context(self, *, q) -> str:
        from ..services.memory_service import memory_service

        with self._session() as db:
            return memory_service.build_memory_context(q, db=db) or ""

    def add_memory(self, *, content) -> dict:
        from ..services.memory_service import memory_service

        with self._session() as db:
            m = memory_service.add_memory(content, db=db)
            if m is None:
                raise RuntimeError("memory write failed")
            return {"id": m.id}

    def search_memories(self, *, q, limit) -> list[dict]:
        from ..services.memory_service import memory_service

        with self._session() as db:
            hits = memory_service.search(q, limit=limit, db=db)
            return [{"id": h.get("id"), "memory": h.get("memory")} for h in hits]

    def edit_memory(self, *, memory_id, content) -> bool:
        from ..services.memory_service import memory_service

        with self._session() as db:
            return bool(memory_service.update_memory(memory_id, content, db=db))

    def forget_memory(self, *, memory_id) -> bool:
        from ..services.memory_service import memory_service

        with self._session() as db:
            return bool(memory_service.delete(memory_id, db=db))

    def list_preferences(self, *, limit) -> dict:
        from ..db.models import Memory
        from ..serializers import _memory_to_dashboard

        with self._session() as db:
            query = db.query(Memory).filter(
                Memory.is_active == True,  # noqa: E712
                Memory.type == "preference",
            )
            total = query.count()
            rows = query.order_by(Memory.id.desc()).limit(limit).all()
            return {"total": total, "memories": [_memory_to_dashboard(m) for m in rows]}

    # ── audit ────────────────────────────────────────────────────────────────
    def log_tool_call(self, *, tool_name, args, status, result, error) -> None:
        try:
            from ..services.mcp_logging import record_call

            with self._session() as db:
                record_call(
                    db, tool_name=tool_name, source=self.source_label,
                    args=args, status=status, result=result, error=error,
                )
        except Exception as exc:  # noqa: BLE001 — audit must not break the call
            print(f"[mcp] audit write failed for {tool_name}: {exc}")


def _needs_cadence_patch(cadence, cadence_target, is_important) -> bool:
    """Is a second step needed at all?

    `set_reminder` already creates a cadence='once', not-important row, so a
    plain one-shot commitment is complete after one call. Both gateways ask this
    the same way, which is what keeps them from taking different numbers of
    round-trips for identical input.
    """
    return bool(
        (cadence and cadence != "once") or cadence_target is not None or is_important
    )


# ─────────────────────────────────────────────────────────────────────────────
# Over HTTP
# ─────────────────────────────────────────────────────────────────────────────


class HttpGateway(Gateway):
    """Talks to a Gooni backend over HTTP. This is the stdio server's path,
    and it is deliberately NOT interchangeable with DirectGateway at runtime:
    `GOONI_URL` may point at prod, which is the whole reason this class exists.

    Endpoint choices mirror what the pre-convergence stdio server already
    called and my audit proved working, EXCEPT the memory + note-search paths,
    which move off the shadowed `/mcp/*` prefix onto `/memories/*` and
    `/notes/search`.
    """

    source_label = "mcp-stdio"

    def __init__(self, base_url: str, session: Any, source_label: str | None = None):
        self.base_url = base_url.rstrip("/")
        self._session = session
        if source_label:
            self.source_label = source_label

    # ── plumbing ─────────────────────────────────────────────────────────────
    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _get(self, path: str, params: dict | None = None):
        r = self._session.get(self._url(path), params=params or {})
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict):
        r = self._session.post(self._url(path), json=body)
        r.raise_for_status()
        return r.json()

    def _patch(self, path: str, body: dict):
        r = self._session.patch(self._url(path), json=body)
        r.raise_for_status()
        return r.json()

    def _delete(self, path: str):
        r = self._session.delete(self._url(path))
        r.raise_for_status()
        return r.json() if r.content else {}

    # ── notes ────────────────────────────────────────────────────────────────
    def create_note(self, *, title, content, tags, is_pinned) -> dict:
        payload = {
            "title": title, "content": content, "tags": tags or [],
            "is_pinned": bool(is_pinned),
        }
        n = self._post("/notes", payload)
        return {
            "id": n["id"], "title": n.get("title"), "tags": n.get("tags") or [],
            "is_pinned": bool(n.get("is_pinned")),
        }

    def log_thought(self, *, content, topic, new_batch, label, at) -> dict:
        return self._post("/focus/thoughts", {
            "content": content, "topic": topic, "new_batch": new_batch,
            "label": label, "at": at.isoformat() if at else None,
        })

    def search_notes_semantic(self, *, q, limit) -> list[dict]:
        return self._get("/notes/search", {"q": q, "limit": limit})

    def list_notes(self, *, tag, limit) -> list[dict]:
        params = {"tag": tag.strip().lower()} if tag else {}
        return self._get("/notes", params)[:limit]

    def recent_notes(self, *, limit) -> list[dict]:
        return self._get("/notes/recent", {"limit": limit})

    def archived_notes(self, *, limit) -> list[dict]:
        # The route serves the whole archive; slice here, same as list_notes.
        return self._get("/notes/archived")[:limit]

    def query_thoughts(self, *, topic, since, text, limit) -> list[dict]:
        params: dict = {}
        if topic:
            params["topic"] = topic
        if since is not None:
            params["since"] = since.date().isoformat()
        if text:
            params["text"] = text
        rows = self._get("/focus/thoughts", params)
        return rows[:limit]

    def get_note(self, note_id: int) -> dict | None:
        r = self._session.get(self._url(f"/notes/{note_id}"))
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def update_note(self, note_id: int, patch: dict) -> dict | None:
        r = self._session.patch(self._url(f"/notes/{note_id}"), json=patch)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def delete_note(self, note_id: int) -> dict | None:
        pre = self.get_note(note_id)
        if pre is None:
            return None
        r = self._session.delete(self._url(f"/notes/{note_id}"))
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return {"id": note_id, "title": pre.get("title")}

    def attach_file(self, *, note_id, filename, data, mime, block_html_fn) -> dict:
        up = self._session.post(
            self._url("/uploads/file"),
            files={"file": (filename, data, mime)},
            data={"note_id": str(note_id)},
        )
        if up.status_code == 503:
            raise RuntimeError(f"R2 storage not configured on backend ({up.text})")
        up.raise_for_status()
        payload = up.json()
        note = self.get_note(note_id)
        if note is None:
            raise LookupError(f"note #{note_id} not found")
        block = block_html_fn(
            url=payload["url"], filename=payload["filename"],
            mime=payload["mime_type"], size=payload["size_bytes"],
            attachment_id=payload.get("attachment_id"),
        )
        self.update_note(note_id, {"content": (note.get("content") or "") + block})
        return payload

    # ── promises ─────────────────────────────────────────────────────────────
    def create_promise(
        self, *, content, due, owed_to, from_thought, cadence, cadence_target, is_important
    ) -> dict:
        body: dict = {"content": content}
        if due is not None:
            body["due_at"] = due.isoformat()
        if owed_to:
            body["owed_to"] = owed_to
        if from_thought:
            body["from_thought"] = int(from_thought)
        # Same two steps, same order, same endpoints as DirectGateway calls in
        # process: POST owns dedup + person resolution + the thought edge; the
        # PATCH owns the recurrence rules. Both return `_reminder_dict`, so the
        # response shape is identical by construction rather than by agreement
        # between two hand-written serializers — which is what drifted in #458.
        row = self._post("/focus/reminders", body)
        if not _needs_cadence_patch(cadence, cadence_target, is_important):
            return row
        patch: dict = {"cadence": cadence or "once"}
        if cadence_target is not None:
            patch["cadence_target"] = int(cadence_target)
        if is_important:
            patch["is_important"] = True
        return self._patch(f"/focus/reminders/{row['id']}", patch)

    def list_promises(self, *, day, state, limit) -> list[dict]:
        params: dict = {}
        if day is not None:
            # "today" is forwarded verbatim — the route resolves it in Daniel's
            # timezone, which this process does not know.
            params["day"] = day if isinstance(day, str) else day.date().isoformat()
        if state:
            params["state"] = state
        if limit:
            params["limit"] = limit
        return self._get("/focus/reminders", params)

    def set_promise_state(self, *, promise_id, state) -> dict | None:
        r = self._session.patch(
            self._url(f"/focus/reminders/{promise_id}"), json={"state": state}
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    # ── focus sessions ───────────────────────────────────────────────────────
    def start_focus_session(self, *, title, promise_id, style, target_ms) -> dict:
        return self._post(
            "/focus/sessions",
            {
                "title": title,
                "promise_id": promise_id,
                "style": style,
                "target_ms": target_ms,
            },
        )

    def stop_focus_session(self) -> dict | None:
        # Two hops, because the stop verb needs an id and only the server knows
        # which session is live. Read-then-write rather than a `/stop-active`
        # convenience route: the id is what makes the write idempotent, and a
        # session that ended between the two calls comes back already-stopped
        # rather than stopping a different one.
        active = self._get("/focus/sessions/active").get("session")
        if not active:
            return None
        return self._post(f"/focus/sessions/{active['id']}/stop", {})

    def active_focus_session(self) -> dict | None:
        active = self._get("/focus/sessions/active").get("session")
        if not active:
            return None
        active["activity"] = self._get(f"/focus/sessions/{active['id']}/activity")
        return active

    # ── topics ───────────────────────────────────────────────────────────────
    def create_topic(self, *, name, parent) -> dict:
        return self._post("/focus/topics", {"name": name, "parent": parent})

    def list_topics(self) -> list[dict]:
        return self._get("/focus/topics")

    # ── trackables ───────────────────────────────────────────────────────────
    def list_trackables(self) -> list[dict]:
        return self._get("/trackables")

    def create_trackable(self, payload: dict) -> dict:
        return self._post("/trackables", payload)

    def log_trackable_entry(self, *, trackable_id, body) -> dict:
        return self._post(f"/trackables/{trackable_id}/entries", body)

    def trackable_pivot(self, *, trackable_id, days) -> list[dict]:
        return self._get(f"/trackables/{trackable_id}/entries", {"days": days})["days"]

    # ── memory ───────────────────────────────────────────────────────────────
    def memory_context(self, *, q) -> str:
        return self._get("/memories/context", {"q": q}).get("context") or ""

    def add_memory(self, *, content) -> dict:
        return self._post("/memories", {"content": content})

    def search_memories(self, *, q, limit) -> list[dict]:
        return self._get("/memories/search", {"q": q, "limit": limit})

    def edit_memory(self, *, memory_id, content) -> bool:
        r = self._session.patch(
            self._url(f"/memories/{memory_id}"), json={"content": content}
        )
        if r.status_code == 404:
            return False
        r.raise_for_status()
        return True

    def forget_memory(self, *, memory_id) -> bool:
        r = self._session.delete(self._url(f"/memories/{memory_id}"))
        if r.status_code == 404:
            return False
        r.raise_for_status()
        return True

    def list_preferences(self, *, limit) -> dict:
        return self._get("/memories", {"type": "preference", "limit": limit})

    # ── audit ────────────────────────────────────────────────────────────────
    def log_tool_call(self, *, tool_name, args, status, result, error) -> None:
        try:
            self._session.post(self._url("/tool-calls/mcp"), json={
                "tool_name": tool_name, "source": self.source_label,
                "args": args, "status": status, "result": result, "error": error,
            })
        except Exception as exc:  # noqa: BLE001 — audit must not break the call
            print(f"[mcp] audit post failed for {tool_name}: {exc}")


def build_http_gateway(source_label: str = "mcp-stdio") -> HttpGateway:
    """HttpGateway from the environment — the config scheme both standalone
    servers already used (`GOONI_URL` + `GOONI_AUTH_PASSWORD` → sha256 →
    Bearer, matching the backend's password auth middleware).

    `source_label` is what lands in `ToolCall.source`, so each entry point
    reports itself honestly — the column exists to answer "which client calls
    this tool", and two clients sharing a label would answer it wrong.
    """
    import hashlib
    import os

    import httpx

    base = os.getenv("GOONI_URL", "http://localhost:8000")
    headers = {"X-Gooni-Source": "mcp"}
    password = os.getenv("GOONI_AUTH_PASSWORD", "").strip()
    if password:
        headers["Authorization"] = f"Bearer {hashlib.sha256(password.encode()).hexdigest()}"
    return HttpGateway(base, httpx.Client(headers=headers, timeout=30), source_label)
