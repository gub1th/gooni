"""LLM-driven extraction + reconciliation for memories,
and feature requests.

Single unified extractor (`extract_signals`) emits all three signal types in
one LLM call so the orchestrator and note-save path don't run overlapping
classifiers per turn.

Pipeline:
1. extract_signals(text, prev_assistant?) → {feature_requests, promises, memories}
2. for each memory candidate:
     cosine-search similar active memories of the same type
     reconcile_candidate (LLM) — decide ADD / UPDATE / DELETE / NONE
     apply the decision

Reconcile is what makes memory self-clean. Without it, contradictory facts
pile up forever and confidence numbers stop meaning anything.
"""

from .extract import extract_signals, reconcile_candidate
from .parsers import VALID_TYPES, _parse_json_object

__all__ = [
    "VALID_TYPES",
    "extract_signals",
    "reconcile_candidate",
    "_parse_json_object",
]
