#!/usr/bin/env python3
"""One-shot migration: rescue valuable notes (+ all todos) from the local
dev SQLite into the deployed prod Gooni backend.

Flow:
  1. `python scripts/migrate_dev_to_prod.py --list`
        Reads local dev notes and writes a triage file at
        `/tmp/gooni-migration.txt`. Every note is prefixed [KEEP]. Flip any
        you don't want to SKIP. Spaces + todos aren't triaged (they always
        migrate) and don't appear in the file.

  2. Edit `/tmp/gooni-migration.txt` as needed.

  3. `python scripts/migrate_dev_to_prod.py --execute`
        - Logs into prod via /auth using GOONI_PROD_PASSWORD (env var)
        - Creates any missing spaces on prod (match by name, case-insensitive)
        - POSTs every KEEP note, skipping ones that already look like duplicates
          on prod (same title + same created_at within 60s)
        - POSTs every dev todo (always) and tries to preserve ordering

What it does NOT touch:
  - Conversations / messages — ephemeral chat history, not worth migrating
  - Visits — analytics noise
  - Mem0 memories — those live in the Mem0 cloud already (not local SQLite),
    so dev and prod share them automatically if both use the same MEM0_API_KEY.
  - PublicProfile — manually copy your bio if it differs on prod.

Assumptions:
  - Local SQLite is at `./db/gooni.db` (default from app/db/database.py).
  - Prod URL is `https://gooni-bot.fly.dev` (override with --prod-url).
  - Run from the repo root so the `app` package imports work.
"""

import argparse
import getpass
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

# Make the app package importable when running as a script from the repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from app.db.database import SessionLocal  # noqa: E402
from app.db.models import Note, Space, TodoItem  # noqa: E402


TRIAGE_PATH = Path("/tmp/gooni-migration.txt")
DEFAULT_PROD_URL = "https://gooni-bot.fly.dev"

# One line per note in the triage file.
# Format:  [KEEP] #<dev_id> "<title>" (<space>, <created>) — <snippet>
NOTE_LINE_RE = re.compile(
    r"^\[(KEEP|SKIP)\]\s+#(\d+)\s+",
    re.IGNORECASE,
)


def _strip_html(html: str | None) -> str:
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()


def _fmt_dt(dt: datetime | None) -> str:
    if not dt:
        return "—"
    return dt.strftime("%Y-%m-%d %H:%M")


# ── Triage file generation ────────────────────────────────────────────────


def write_triage_file() -> None:
    db = SessionLocal()
    try:
        spaces = {s.id: s for s in db.query(Space).all()}
        notes = (
            db.query(Note)
            .order_by(Note.updated_at.desc().nulls_last(), Note.created_at.desc())
            .all()
        )
        todo_count = db.query(TodoItem).count()
    finally:
        db.close()

    lines: list[str] = []
    lines.append("# Gooni dev → prod migration triage")
    lines.append("# Edit this file: change [KEEP] to [SKIP] for notes you don't want migrated.")
    lines.append("# Save, then run: python scripts/migrate_dev_to_prod.py --execute")
    lines.append("#")
    lines.append(f"# Notes in dev: {len(notes)}")
    lines.append(f"# Todos in dev (ALL will migrate, not triaged): {todo_count}")
    lines.append(f"# Spaces in dev (missing ones will be auto-created on prod): {len(spaces)}")
    lines.append("#")
    lines.append("# Conversations/messages, visits, and Mem0 memories are NOT touched.")
    lines.append("")

    for n in notes:
        space_name = spaces[n.space_id].name if n.space_id in spaces else "General"
        title = (n.title or "").strip() or "(untitled)"
        # Single-line, safe for the triage file
        title = title.replace("\n", " ").replace('"', '\\"')[:80]
        snippet = _strip_html(n.content)[:80]
        created = _fmt_dt(n.created_at)
        lines.append(
            f'[KEEP] #{n.id} "{title}" ({space_name}, {created}) — {snippet}'
        )

    TRIAGE_PATH.write_text("\n".join(lines) + "\n")
    print(f"Wrote triage file: {TRIAGE_PATH}")
    print(f"  {len(notes)} notes listed (all marked [KEEP]).")
    print(f"  {todo_count} todos will migrate automatically (not in triage file).")
    print()
    print(f"Next: edit {TRIAGE_PATH} to flip [KEEP] → [SKIP] on anything you don't want.")
    print("Then: python scripts/migrate_dev_to_prod.py --execute")


def read_triage_file() -> set[int]:
    if not TRIAGE_PATH.exists():
        print(f"ERROR: {TRIAGE_PATH} doesn't exist. Run --list first.", file=sys.stderr)
        sys.exit(2)
    keepers: set[int] = set()
    for line in TRIAGE_PATH.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        m = NOTE_LINE_RE.match(line)
        if not m:
            continue
        verdict, note_id = m.group(1).upper(), int(m.group(2))
        if verdict == "KEEP":
            keepers.add(note_id)
    return keepers


# ── Prod client ───────────────────────────────────────────────────────────


class ProdClient:
    def __init__(self, base_url: str, password: str | None, dry_run: bool):
        self.base_url = base_url.rstrip("/")
        self.dry_run = dry_run
        self.client = httpx.Client(timeout=20)
        self.token: str | None = None
        if password:
            self._login(password)

    def _login(self, password: str) -> None:
        r = self.client.post(f"{self.base_url}/auth", json={"password": password})
        if r.status_code != 200:
            raise SystemExit(
                f"Login failed ({r.status_code}). Check GOONI_PROD_PASSWORD."
            )
        self.token = r.json()["token"]

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def get(self, path: str) -> Any:
        r = self.client.get(f"{self.base_url}{path}", headers=self._headers())
        r.raise_for_status()
        return r.json()

    def post(self, path: str, payload: dict) -> Any:
        if self.dry_run:
            print(f"  [DRY] POST {path} <- {list(payload.keys())}")
            return {"id": -1, **payload}
        r = self.client.post(
            f"{self.base_url}{path}", json=payload, headers=self._headers()
        )
        r.raise_for_status()
        return r.json()

    def patch(self, path: str, payload: dict) -> Any:
        if self.dry_run:
            print(f"  [DRY] PATCH {path} <- {list(payload.keys())}")
            return {"id": -1, **payload}
        r = self.client.patch(
            f"{self.base_url}{path}", json=payload, headers=self._headers()
        )
        r.raise_for_status()
        return r.json()


# ── Execute migration ─────────────────────────────────────────────────────


def execute(prod_url: str, dry_run: bool) -> None:
    # Prefer env var; fall back to interactive prompt so the password never
    # hits your shell history. Needed for both live runs and dry-runs since
    # the dry-run still has to READ prod state to compute what would happen.
    password = os.getenv("GOONI_PROD_PASSWORD") or getpass.getpass(
        "Prod password (deployed AUTH_PASSWORD): "
    )
    if not password:
        print("ERROR: no password provided.", file=sys.stderr)
        sys.exit(2)

    keepers = read_triage_file()
    print(f"Triage: {len(keepers)} notes marked KEEP.")

    prod = ProdClient(prod_url, password, dry_run=dry_run)

    # Pre-flight snapshot of prod state as a safety net. If the migration ends
    # up wrong, the JSON dump below contains every space/note/todo on prod at
    # the moment we started, so you can always diff or manually restore.
    if not dry_run:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        snapshot_path = Path(f"/tmp/gooni-prod-snapshot-{ts}.json")
        print(f"\n── Safety snapshot → {snapshot_path} ──")
        snapshot: dict = {}
        try:
            snapshot["spaces"] = prod.get("/spaces")
            snapshot["todos"] = prod.get("/todos")
            # Pull every note via the 'general' notes aggregation endpoint.
            snapshot["notes"] = prod.get("/spaces/general/notes")
            snapshot["taken_at"] = ts
            snapshot_path.write_text(json.dumps(snapshot, indent=2, default=str))
            print(
                f"  captured: {len(snapshot['spaces'])} spaces, "
                f"{len(snapshot['notes'])} notes, "
                f"{len(snapshot['todos'])} todos"
            )
        except Exception as e:
            print(f"  ! snapshot failed: {e}")
            print("  Refusing to proceed without a backup — rerun with --dry-run if you want to skip.")
            sys.exit(3)

    db = SessionLocal()
    try:
        # 1. Spaces — create any that prod doesn't already have (name match, case-insensitive)
        dev_spaces = db.query(Space).all()
        prod_spaces = prod.get("/spaces")
        prod_space_by_name = {s["name"].lower(): s for s in prod_spaces}
        space_id_map: dict[int, int] = {}  # dev_space_id → prod_space_id

        print("\n── Spaces ──")
        for s in dev_spaces:
            name_l = s.name.lower()
            if name_l in prod_space_by_name:
                space_id_map[s.id] = prod_space_by_name[name_l]["id"]
                print(f"  exists on prod: #{prod_space_by_name[name_l]['id']} {s.name}")
                continue
            created = prod.post(
                "/spaces",
                {"name": s.name, "emoji": s.emoji},
            )
            space_id_map[s.id] = created["id"]
            print(f"  created on prod: #{created['id']} {s.name} {s.emoji or ''}")

        # 2. Notes — triage keepers only, dedupe against prod by (title, ~created_at)
        print("\n── Notes ──")
        # Dedup index is built lazily, one space at a time, as we encounter notes.
        prod_notes_by_space: dict[int, list[dict]] = {}
        dev_notes = db.query(Note).all()
        notes_to_migrate = [n for n in dev_notes if n.id in keepers]
        print(f"  migrating {len(notes_to_migrate)}/{len(dev_notes)} notes")
        # Track newly-created prod note IDs so we can embed them in a final pass.
        # Embeddings can't be POSTed directly (API whitelist); we trigger /embed
        # per note to have prod regenerate via OpenAI.
        created_note_ids: list[int] = []

        for n in notes_to_migrate:
            prod_space_id = space_id_map.get(n.space_id) if n.space_id else None
            target_space = prod_space_id if prod_space_id else "general"

            # Lazy-load prod notes for this space once, for dedup.
            cache_key = prod_space_id if prod_space_id else 0
            if cache_key not in prod_notes_by_space:
                try:
                    prod_notes_by_space[cache_key] = prod.get(
                        f"/spaces/{target_space}/notes"
                    )
                except Exception as e:
                    print(f"  ! couldn't list prod notes for space {target_space}: {e}")
                    prod_notes_by_space[cache_key] = []

            # Dedup: same title + same created_at within 60s counts as already there.
            dup = _find_dupe(prod_notes_by_space[cache_key], n)
            if dup:
                print(
                    f"  skip #{n.id} {(n.title or '(untitled)')[:40]} — dup of prod #{dup['id']}"
                )
                continue

            payload = {
                "title": n.title or "",
                "content": n.content or "",
            }
            try:
                created = prod.post(
                    f"/spaces/{target_space}/notes", payload
                )
                # Only queue real IDs for the embed pass. -1 sentinel comes
                # from dry-run's fake POST; those wouldn't embed anything.
                if created.get("id") and created["id"] > 0:
                    created_note_ids.append(created["id"])
                # Optionally flip is_pinned/is_public if set on dev.
                patch_fields: dict = {}
                if n.is_pinned:
                    patch_fields["is_pinned"] = True
                if n.is_public:
                    patch_fields["is_public"] = True
                if patch_fields:
                    prod.patch(f"/notes/{created['id']}", patch_fields)
                print(
                    f"  migrated #{n.id} → prod #{created['id']}: "
                    f"{(n.title or '(untitled)')[:50]}"
                )
            except httpx.HTTPStatusError as e:
                print(f"  ! failed #{n.id}: {e.response.status_code} {e.response.text[:120]}")

        # 3. Todos — migrate all. Backend auto-assigns sort_order on POST; we
        # write in dev's sort_order ascending so order is preserved.
        print("\n── Todos ──")
        todos = db.query(TodoItem).order_by(TodoItem.sort_order, TodoItem.id).all()
        print(f"  migrating {len(todos)} todos")
        for t in todos:
            try:
                created = prod.post("/todos", {"text": t.text})
                if t.done:
                    prod.patch(f"/todos/{created['id']}", {"done": True})
                print(
                    f"  migrated todo '{t.text[:50]}'"
                    + (" [done]" if t.done else "")
                )
            except httpx.HTTPStatusError as e:
                print(f"  ! failed '{t.text[:40]}': {e.response.status_code}")

        # 4. Embeddings — trigger /embed on each newly-created note so prod
        # regenerates via OpenAI. Can't copy dev's embeddings directly (PATCH
        # doesn't whitelist the field). Failures here are non-fatal: the note
        # still exists on prod, it just won't have semantic search until it's
        # next opened + blurred, which triggers embed on its own.
        if created_note_ids:
            print(f"\n── Embeddings ({len(created_note_ids)} notes) ──")
            ok = 0
            for nid in created_note_ids:
                try:
                    prod.post(f"/notes/{nid}/embed", {})
                    ok += 1
                except httpx.HTTPStatusError as e:
                    print(f"  ! embed failed for prod #{nid}: {e.response.status_code}")
                except Exception as e:
                    print(f"  ! embed failed for prod #{nid}: {e}")
            print(f"  embedded {ok}/{len(created_note_ids)}")

    finally:
        db.close()

    print("\nDone. Dev DB untouched — this was copy, not move.")


def _find_dupe(prod_notes: list[dict], dev_note: Note) -> dict | None:
    """Rough dedup: same title (case-insensitive) + created_at within 60s."""
    dev_title = (dev_note.title or "").strip().lower()
    dev_created = dev_note.created_at
    if dev_created and dev_created.tzinfo is None:
        dev_created = dev_created.replace(tzinfo=timezone.utc)
    for p in prod_notes:
        p_title = (p.get("title") or "").strip().lower()
        if p_title != dev_title:
            continue
        p_created_raw = p.get("created_at")
        if not p_created_raw:
            return p
        try:
            p_created = datetime.fromisoformat(p_created_raw.replace("Z", "+00:00"))
            if p_created.tzinfo is None:
                p_created = p_created.replace(tzinfo=timezone.utc)
        except ValueError:
            return p
        if dev_created and abs(p_created - dev_created) < timedelta(seconds=60):
            return p
    return None


# ── CLI ───────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="Write triage file.")
    group.add_argument("--execute", action="store_true", help="Run migration using triage file.")
    ap.add_argument("--prod-url", default=DEFAULT_PROD_URL)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="With --execute: print what would happen, make no writes.",
    )
    args = ap.parse_args()

    if args.list:
        write_triage_file()
    else:
        execute(args.prod_url, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
