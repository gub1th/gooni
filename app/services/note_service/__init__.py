"""Note embedding, search, classification and the idle sweeper.

A package rather than one 300-line module, but the import surface is
UNCHANGED — every existing `from ..services.note_service import X` still
resolves, because everything public is re-exported here. Six call sites
across routers, tools, background and mcp_surface depend on that.

  service  — NoteService: embedding writes, FTS5 + semantic search
  classify — classify_note: extractor + intent_router dispatch
  sweep    — sweep_stale_notes: the idle gate that decides when either runs
"""

from .classify import classify_note
from .service import NoteService, note_service
from .sweep import SWEEP_BATCH, SWEEP_IDLE_SECONDS, sweep_stale_notes

# `memory_service` imports this name from here. The implementation now lives
# in app/utils/embeddings (one owner, see that module) — this alias keeps the
# historical import working.
from ...utils.embeddings import cosine_similarity as _cosine_similarity

__all__ = [
    "NoteService",
    "note_service",
    "classify_note",
    "sweep_stale_notes",
    "SWEEP_IDLE_SECONDS",
    "SWEEP_BATCH",
    "_cosine_similarity",
]
