"""TraceBuilder — single source of truth for the structured-trace shape that
the orchestrator stamps onto every assistant Message.

Why a class instead of inline dict construction:
  - One place to pin the schema. Adding a new step type means one new helper
    method + corresponding UI render — no schema migration, no scattered dict
    keys to keep in sync across orchestrator branches.
  - Pipeline version is captured automatically at construction so every trace
    is tagged. Eval scores can later be filtered "ratings on PROMPT_VERSION = v2".
  - Keeps the orchestrator readable: `tb.intent(text)` reads better than a
    raw `steps.append({"type": "intent", "label": ...})` everywhere.

Schema each step:
  {
    "key": str,           # 'intent' | 'memory_recall' | 'master_prompt' | ...
    "label": str,         # human-readable one-liner for the eval grid
    "input": Any | None,  # what fed into this step (string, list, dict)
    "output": Any | None, # what came out of this step
    "meta": dict | None,  # latency_ms, sizes, source markers, etc.
  }

The very first entry in every built trace is a `pipeline_version` step so the
eval UI can filter ratings by pipeline iteration. Bump PROMPT_VERSION when
you change orchestrator flow, master prompt assembly, or the memory pipeline
in a way that makes prior ratings less comparable.
"""

from __future__ import annotations

import time
from typing import Any


# Bump this when the chat pipeline changes in a way that should invalidate
# (or at least segregate) prior eval ratings. Stays a manual constant rather
# than a git SHA so unrelated commits don't churn the version.
PROMPT_VERSION = "v1"


class TraceBuilder:
    def __init__(self, pipeline_version: str = PROMPT_VERSION):
        self._pipeline_version = pipeline_version
        self._started_at = time.perf_counter()
        self._steps: list[dict] = [
            {
                "key": "pipeline_version",
                "label": f"pipeline {pipeline_version}",
                "input": None,
                "output": pipeline_version,
                "meta": {"started_at": time.time()},
            }
        ]

    # ── Generic helper ────────────────────────────────────────────────────────
    def step(
        self,
        key: str,
        label: str,
        input: Any = None,
        output: Any = None,
        meta: dict | None = None,
    ) -> None:
        """Append an arbitrary step. New step types ride this — they don't
        need a dedicated method, but typed helpers below are preferred where
        they exist for readability + label consistency.

        Backward-compat: also writes legacy `{type, detail, args}` keys so the
        existing chat MessageBubble (which consumes the old shape) keeps
        rendering. New eval UI consumes the canonical `{key, input, output,
        meta}` shape. Drop the legacy keys when MessageBubble is migrated.
        """
        # Compute a short string representation of `output` for the legacy
        # `detail` field. Strings pass through; dicts/lists get json'd & truncated.
        if output is None:
            detail = None
        elif isinstance(output, str):
            detail = output
        else:
            try:
                import json as _json
                detail = _json.dumps(output, default=str)[:600]
            except Exception:
                detail = str(output)[:600]
        legacy_args = None
        if isinstance(input, dict):
            legacy_args = {k: v for k, v in input.items() if not isinstance(v, (list, dict)) or len(str(v)) < 200}
        self._steps.append({
            # Canonical shape (eval UI)
            "key": key,
            "label": label,
            "input": input,
            "output": output,
            "meta": meta or {},
            # Legacy shape (MessageBubble) — alias of the same step
            "type": key,
            "detail": detail,
            "args": legacy_args,
        })

    # ── Typed helpers ─────────────────────────────────────────────────────────
    def intent(self, query: str, intention_text: str | None) -> None:
        # Step key intentionally `intention` (not `intent`) so the existing
        # MessageBubble TRACE_ICON map matches.
        self.step(
            "intention",
            "Read intent" if intention_text else "(intent skipped)",
            input={"query": query},
            output=intention_text,
        )

    def memory_recall(self, query: str, recalled: list[dict]) -> None:
        """`recalled` comes from memory_service.build_memory_context_with_debug —
        a list of {id, type, content, similarity, always_inject}. Stored
        verbatim so the eval UI can render similarity bars + flag preferences
        distinctly from cosine hits.
        """
        n = len(recalled)
        self.step(
            "memory_recall",
            f"Recalled {n} memor{'y' if n == 1 else 'ies'}",
            input={"query": query},
            output={"recalled": recalled},
            meta={"count": n},
        )

    def master_prompt(self, system_prompt: str, recent_history: list[dict]) -> None:
        """Capture the assembled system prompt + history window the LLM saw.
        Truncated to keep payloads sane; the eval UI can show first/last N chars.
        """
        max_len = 12000
        truncated = system_prompt[:max_len]
        truncated_flag = len(system_prompt) > max_len
        self.step(
            "master_prompt",
            f"Assembled prompt ({len(system_prompt)} chars)",
            input={"history_messages": len(recent_history)},
            output={
                "system": truncated,
                "system_truncated": truncated_flag,
                "system_total_chars": len(system_prompt),
                "history_window": [
                    {"role": m.get("role"), "preview": (m.get("content") or "")[:200]}
                    for m in recent_history
                ],
            },
        )

    def extracted_signals(self, message: str, signals: dict) -> None:
        """`signals` from extract_signals: tone_corrections + feature_requests +
        memory candidates. Stored as one step instead of fanning out into many
        tool_call steps so the reviewer can rate the extractor as a unit.
        """
        tone = signals.get("tone_corrections") or []
        features = signals.get("feature_requests") or []
        memories = signals.get("memories") or []
        parts = []
        if tone:
            parts.append(f"{len(tone)} tone")
        if features:
            parts.append(f"{len(features)} feature")
        if memories:
            parts.append(f"{len(memories)} memory")
        label = "Extracted signals: " + (", ".join(parts) if parts else "none")
        self.step(
            "extracted_signals",
            label,
            input={"message_preview": message[:300]},
            output={
                "tone_corrections": tone,
                "feature_requests": features,
                "memory_candidates": memories,
            },
            meta={
                "tone_count": len(tone),
                "feature_count": len(features),
                "memory_count": len(memories),
            },
        )

    def memories_applied(self, applied: dict) -> None:
        """Reconcile outcome: which candidates landed as ADD/UPDATE/DELETE/NONE.
        `applied` shape: {"added": [...], "updated": [...], "deleted": [...], "noop": [...]}.
        Captured after reconcile so the reviewer can see what actually moved.
        Note: reconcile runs off-thread in the current orchestrator, so this
        step won't always be populated — use a placeholder when missing.
        """
        added = applied.get("added") or []
        updated = applied.get("updated") or []
        deleted = applied.get("deleted") or []
        noop = applied.get("noop") or []
        label = (
            f"Memory updates: +{len(added)} ~{len(updated)} -{len(deleted)} "
            f"({len(noop)} noop)"
        )
        self.step(
            "memories_applied",
            label,
            input=None,
            output=applied,
            meta={
                "added_count": len(added),
                "updated_count": len(updated),
                "deleted_count": len(deleted),
                "noop_count": len(noop),
            },
        )

    def tool_call(self, name: str, label: str | None = None, args: dict | None = None,
                  result: Any = None) -> None:
        """A tool/router action the orchestrator took (tone capture, feature
        request log, undo feedback, etc.). The legend popup in the eval UI
        sources its descriptions from a static dict in main.py.
        """
        self.step(
            "tool_call",
            label or f"Called tool: {name}",
            input={"name": name, "args": args},
            output=result,
            meta={"tool": name},
        )

    def reply(self, response: str, usage: dict | None = None) -> None:
        """The assistant text + token/latency usage. Last step, always present."""
        elapsed_ms = int((time.perf_counter() - self._started_at) * 1000)
        self.step(
            "reply",
            f"Replied ({elapsed_ms}ms)",
            input=None,
            output={"text": response, "preview": response[:300]},
            meta={
                "elapsed_ms": elapsed_ms,
                "usage": usage or {},
            },
        )

    # ── Output ────────────────────────────────────────────────────────────────
    def build(self) -> list[dict]:
        """Return the trace ready for JSON serialization onto Message.trace."""
        return list(self._steps)
