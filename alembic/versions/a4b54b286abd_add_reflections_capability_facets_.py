"""add reflections + capability_facets + settings.capability_telemetry_last_run_day

Revision ID: a4b54b286abd
Revises: 3d057ff39f90
Create Date: 2026-05-15 18:09:47.909961

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4b54b286abd'
down_revision: Union[str, Sequence[str], None] = '3d057ff39f90'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema. Idempotent against partial prior runs.

    Adds:
      - `reflections` — per-turn self-evaluation rows (Reflexion pattern).
      - `capability_facets` — Gooni's self-knowledge inventory, UNIQUE on
        facet_key so all 4 audit sources upsert against the same row.
      - `settings.capability_telemetry_last_run_day` — daily idempotency
        token for the telemetry rollup loop, same shape as
        `nudge_last_sent_day`.

    Autogenerate also surfaced SQLite-cosmetic drift on focuses/habits/notes
    (server_default reads back as None) and FK drift on list_items/memories
    /notes — scrubbed because none of that is introduced by this change.

    Idempotency pattern mirrors `3d057ff39f90_add_wa_processed_ids_table`:
    guard each DDL op via inspect() so a partial prior run on prod (e.g.
    after a crash) recovers cleanly on the next deploy.
    """
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if 'capability_facets' not in existing_tables:
        op.create_table(
            'capability_facets',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('layer', sa.String(), nullable=False),
            sa.Column('facet_key', sa.String(), nullable=False),
            sa.Column('facet_text', sa.Text(), nullable=False),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('source', sa.String(), nullable=False),
            sa.Column('evidence_json', sa.Text(), nullable=True),
            sa.Column('last_verified_at', sa.DateTime(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('facet_key', name='uq_capability_facet_key'),
        )

    cf_indexes = (
        {ix['name'] for ix in inspect(bind).get_indexes('capability_facets')}
        if 'capability_facets' in set(inspect(bind).get_table_names())
        else set()
    )
    with op.batch_alter_table('capability_facets', schema=None) as batch_op:
        if 'ix_capability_facets_facet_key' not in cf_indexes:
            batch_op.create_index(
                batch_op.f('ix_capability_facets_facet_key'),
                ['facet_key'], unique=False,
            )
        if 'ix_capability_facets_id' not in cf_indexes:
            batch_op.create_index(
                batch_op.f('ix_capability_facets_id'),
                ['id'], unique=False,
            )
        if 'ix_capability_facets_layer' not in cf_indexes:
            batch_op.create_index(
                batch_op.f('ix_capability_facets_layer'),
                ['layer'], unique=False,
            )

    if 'reflections' not in existing_tables:
        op.create_table(
            'reflections',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('message_id', sa.Integer(), nullable=False),
            sa.Column('conversation_id', sa.Integer(), nullable=False),
            sa.Column('user_critique_present', sa.Boolean(), nullable=False),
            sa.Column('critique_summary', sa.Text(), nullable=True),
            sa.Column('action_vs_described', sa.String(), nullable=False),
            sa.Column('gap_exposed', sa.Text(), nullable=True),
            sa.Column('gap_embedding', sa.Text(), nullable=True),
            sa.Column('proposed_self_fix', sa.Text(), nullable=True),
            sa.Column('severity', sa.Integer(), nullable=False),
            sa.Column('model', sa.String(), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'],),
            sa.ForeignKeyConstraint(
                ['message_id'], ['messages.id'], ondelete='CASCADE',
            ),
            sa.PrimaryKeyConstraint('id'),
        )

    r_indexes = (
        {ix['name'] for ix in inspect(bind).get_indexes('reflections')}
        if 'reflections' in set(inspect(bind).get_table_names())
        else set()
    )
    with op.batch_alter_table('reflections', schema=None) as batch_op:
        if 'ix_reflections_conversation_id' not in r_indexes:
            batch_op.create_index(
                batch_op.f('ix_reflections_conversation_id'),
                ['conversation_id'], unique=False,
            )
        if 'ix_reflections_created_at' not in r_indexes:
            batch_op.create_index(
                batch_op.f('ix_reflections_created_at'),
                ['created_at'], unique=False,
            )
        if 'ix_reflections_id' not in r_indexes:
            batch_op.create_index(
                batch_op.f('ix_reflections_id'), ['id'], unique=False,
            )
        if 'ix_reflections_message_id' not in r_indexes:
            batch_op.create_index(
                batch_op.f('ix_reflections_message_id'),
                ['message_id'], unique=False,
            )

    settings_cols = {c['name'] for c in inspect(bind).get_columns('settings')}
    if 'capability_telemetry_last_run_day' not in settings_cols:
        with op.batch_alter_table('settings', schema=None) as batch_op:
            batch_op.add_column(
                sa.Column(
                    'capability_telemetry_last_run_day',
                    sa.String(),
                    nullable=True,
                )
            )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('settings', schema=None) as batch_op:
        batch_op.drop_column('capability_telemetry_last_run_day')

    with op.batch_alter_table('reflections', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_reflections_message_id'))
        batch_op.drop_index(batch_op.f('ix_reflections_id'))
        batch_op.drop_index(batch_op.f('ix_reflections_created_at'))
        batch_op.drop_index(batch_op.f('ix_reflections_conversation_id'))
    op.drop_table('reflections')

    with op.batch_alter_table('capability_facets', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_capability_facets_layer'))
        batch_op.drop_index(batch_op.f('ix_capability_facets_id'))
        batch_op.drop_index(batch_op.f('ix_capability_facets_facet_key'))
    op.drop_table('capability_facets')
