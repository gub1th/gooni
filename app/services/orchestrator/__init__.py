"""Orchestrator package.

Split out of the former single-file ``app/services/orchestrator.py`` (pure
mechanical refactor — no behavior change). The class + locked identity prompt
live in ``core``; reasoning-step helpers live in ``steps``; prompt-block
builders live in ``prompt_blocks``. This ``__init__`` re-exports the public
surface so existing imports keep working unchanged:

    from .services.orchestrator import Orchestrator   # app/main.py
    from ..orchestrator import Orchestrator            # messaging/base.py
    from .orchestrator import Orchestrator             # fly_revive.py (lazy)
"""

from .core import Orchestrator, PERSONA_BLOCK
from .prompt_blocks import OBJECT_KINDS_BLOCK, ENTRY_SUMMARIZE_THRESHOLD

__all__ = [
    "Orchestrator",
    "PERSONA_BLOCK",
    "OBJECT_KINDS_BLOCK",
    "ENTRY_SUMMARIZE_THRESHOLD",
]
