"""Alembic environment.

Reuses the app's existing SQLAlchemy engine + Base.metadata so DATABASE_URL
stays the single source of truth and autogenerate sees the live model graph.

Important SQLite knobs:
- render_as_batch=True: SQLite can't ALTER TABLE for column drops, type
  changes, FK adds, etc. Batch mode rewrites the table behind the scenes.
- compare_type=True: detect column-type changes during autogenerate.
- compare_server_default=True: detect default-value drift.
"""
from logging.config import fileConfig
from pathlib import Path
import sys

from alembic import context

# Make `app` importable regardless of where alembic is invoked from.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.database import engine  # noqa: E402  — needs sys.path tweak first
from app.db import models  # noqa: F401, E402  — register all model classes
from app.db.models import Base  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Generate SQL without a live DB connection (for review)."""
    context.configure(
        url=str(engine.url),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations using the app's engine."""
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
