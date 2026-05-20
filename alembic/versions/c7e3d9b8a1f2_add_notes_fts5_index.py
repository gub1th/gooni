"""add SQLite FTS5 virtual table for notes keyword search

Notes are currently only cosine-searchable via the deferred Note.embedding
column. That misses exact-phrase queries Daniel actually types ("that tax
note", "what I wrote about forge"). FTS5 catches those.

Setup:
  - Virtual table notes_fts(title, content) using external content (rowid
    references notes.id). Single source of truth — fts mirrors notes.
  - Three triggers (insert/update/delete on notes) keep notes_fts in sync.
  - One-time backfill from existing rows so prod notes are searchable
    immediately after the migration runs.

No new Python deps. SQLite ships FTS5 in stdlib since 3.9.

Revision ID: c7e3d9b8a1f2
Revises: a843ba2b74a7
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa


revision = "c7e3d9b8a1f2"
down_revision = "a843ba2b74a7"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    # Virtual tables don't show up in get_table_names() on every dialect,
    # but SQLite includes them. Re-create guard.
    existing = set(inspector.get_table_names())
    if "notes_fts" in existing:
        return

    op.execute("""
        CREATE VIRTUAL TABLE notes_fts USING fts5(
            title,
            content,
            content='notes',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)

    # Triggers — keep notes_fts in sync with notes.
    op.execute("""
        CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content)
            VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.content, ''));
        END
    """)
    op.execute("""
        CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES('delete', old.id, COALESCE(old.title, ''), COALESCE(old.content, ''));
        END
    """)
    op.execute("""
        CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES('delete', old.id, COALESCE(old.title, ''), COALESCE(old.content, ''));
            INSERT INTO notes_fts(rowid, title, content)
            VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.content, ''));
        END
    """)

    # Backfill from existing notes so the index isn't empty on first boot.
    op.execute("""
        INSERT INTO notes_fts(rowid, title, content)
        SELECT id, COALESCE(title, ''), COALESCE(content, '') FROM notes
    """)


def downgrade():
    op.execute("DROP TRIGGER IF EXISTS notes_fts_au")
    op.execute("DROP TRIGGER IF EXISTS notes_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS notes_fts_ai")
    op.execute("DROP TABLE IF EXISTS notes_fts")
