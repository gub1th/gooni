"""extend FTS5 keyword index to todos + memories

Same pattern as notes_fts (migration c7e3d9b8a1f2):
  - virtual table mirrors the source table via external content rowid
  - 3 triggers (insert/update/delete) keep FTS in sync
  - one-time backfill from existing rows

Why both:
  - todos: todo_service.search was doing python-side LIKE over EVERY row.
    FTS5 BM25 ranking + O(log N) lookup is a strict win.
  - memories: memory_service retrieval is cosine-only. Adds an FTS
    companion so the chat prompt picks up exact-phrase hits cosine
    smushes ("the irs thing I told you about").

Revision ID: d8e4ca09b2f3
Revises: c7e3d9b8a1f2
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa


revision = "d8e4ca09b2f3"
down_revision = "c7e3d9b8a1f2"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())

    # ── todos_fts ─────────────────────────────────────────────────────
    if "todos_fts" not in existing:
        op.execute("""
            CREATE VIRTUAL TABLE todos_fts USING fts5(
                text,
                subtitle,
                content='todos',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )
        """)
        op.execute("""
            CREATE TRIGGER todos_fts_ai AFTER INSERT ON todos BEGIN
                INSERT INTO todos_fts(rowid, text, subtitle)
                VALUES (new.id, COALESCE(new.text, ''), COALESCE(new.subtitle, ''));
            END
        """)
        op.execute("""
            CREATE TRIGGER todos_fts_ad AFTER DELETE ON todos BEGIN
                INSERT INTO todos_fts(todos_fts, rowid, text, subtitle)
                VALUES('delete', old.id, COALESCE(old.text, ''), COALESCE(old.subtitle, ''));
            END
        """)
        op.execute("""
            CREATE TRIGGER todos_fts_au AFTER UPDATE ON todos BEGIN
                INSERT INTO todos_fts(todos_fts, rowid, text, subtitle)
                VALUES('delete', old.id, COALESCE(old.text, ''), COALESCE(old.subtitle, ''));
                INSERT INTO todos_fts(rowid, text, subtitle)
                VALUES (new.id, COALESCE(new.text, ''), COALESCE(new.subtitle, ''));
            END
        """)
        # Backfill — soft-deleted rows included so historical search hits
        # them; service layer filters deleted_at downstream.
        op.execute("""
            INSERT INTO todos_fts(rowid, text, subtitle)
            SELECT id, COALESCE(text, ''), COALESCE(subtitle, '') FROM todos
        """)

    # ── memories_fts ──────────────────────────────────────────────────
    if "memories_fts" not in existing:
        op.execute("""
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                content,
                content='memories',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )
        """)
        op.execute("""
            CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content)
                VALUES (new.id, COALESCE(new.content, ''));
            END
        """)
        op.execute("""
            CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content)
                VALUES('delete', old.id, COALESCE(old.content, ''));
            END
        """)
        op.execute("""
            CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content)
                VALUES('delete', old.id, COALESCE(old.content, ''));
                INSERT INTO memories_fts(rowid, content)
                VALUES (new.id, COALESCE(new.content, ''));
            END
        """)
        op.execute("""
            INSERT INTO memories_fts(rowid, content)
            SELECT id, COALESCE(content, '') FROM memories
        """)


def downgrade():
    op.execute("DROP TRIGGER IF EXISTS memories_fts_au")
    op.execute("DROP TRIGGER IF EXISTS memories_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS memories_fts_ai")
    op.execute("DROP TABLE IF EXISTS memories_fts")
    op.execute("DROP TRIGGER IF EXISTS todos_fts_au")
    op.execute("DROP TRIGGER IF EXISTS todos_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS todos_fts_ai")
    op.execute("DROP TABLE IF EXISTS todos_fts")
