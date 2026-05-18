"""Capability inventory: Gooni's self-knowledge, 4 layers, evidence-based.

Layers
------
- mechanical    — tool / route / channel primitives derived from the
                  codebase. Auto-populated via boot-time introspection.
- functional    — composed "what I can do for you" facets. Human-curated
                  via PR audit or manual_seed.
- behavioral    — emergent patterns from per-turn reflection clustering
                  ("I keep logging instead of acting"). Auto-promoted.
- architectural — model, runtime, memory window, ambient-sensing status.
                  manual_seed; rarely changes.

Sources
-------
- code_introspection — boot-time scan of tool registry + FastAPI routes +
                       messaging channels.
- pr_audit           — Claude Code `/capability-audit` slash command edits.
- reflection_cluster — auto-promotion from ReflexionService when N similar
                       gap_exposed reflections accumulate.
- manual_seed        — once-only seeding by Daniel for architectural facets.
- chat_tool_update   — orchestrator/Gooni edits via UpdateCapabilityFacetTool.

Status transitions are idempotent and non-destructive: facets never get
deleted at runtime. A tool removed from the registry becomes status='removed'
(history preserved for reflection lookbacks); telemetry can downgrade a
facet to 'broken' or 'unverified' but never erases it.

The boot scan hashes the relevant source files and short-circuits when
unchanged — avoids hammering the DB on every uvicorn --reload restart.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy.orm import Session

from ..db.models import CapabilityFacet, ToolCall


# Files whose contents define mechanical-layer facets. Hashing them at boot
# lets us skip a full re-scan when nothing has changed.
_SCAN_PATHS = [
    "app/tools/__init__.py",
    "app/tools",
    "app/services/messaging/__init__.py",
]


def _hash_paths(repo_root: str, paths: Iterable[str]) -> str:
    """Stable hash of file mtimes + sizes across the given paths. Cheap;
    doesn't open the files. mtime catches edits + sentinels file moves.
    """
    h = hashlib.sha256()
    for rel in paths:
        full = os.path.join(repo_root, rel)
        if os.path.isfile(full):
            st = os.stat(full)
            h.update(f"{rel}:{st.st_size}:{st.st_mtime_ns}".encode())
        elif os.path.isdir(full):
            for name in sorted(os.listdir(full)):
                if not name.endswith(".py"):
                    continue
                sub = os.path.join(full, name)
                st = os.stat(sub)
                h.update(f"{rel}/{name}:{st.st_size}:{st.st_mtime_ns}".encode())
    return h.hexdigest()


def _upsert(
    db: Session,
    *,
    facet_key: str,
    layer: str,
    facet_text: str,
    source: str,
    status: str = "claimed",
    evidence: dict | None = None,
) -> CapabilityFacet:
    """Idempotent upsert on facet_key. Returns the live row.

    Preserves status when a row already exists — only the introspection
    sources promote/demote status. facet_text + source are always updated
    to reflect the current best description.
    """
    row = (
        db.query(CapabilityFacet)
        .filter(CapabilityFacet.facet_key == facet_key)
        .one_or_none()
    )
    evidence_json = json.dumps(evidence) if evidence else None
    if row is None:
        row = CapabilityFacet(
            facet_key=facet_key,
            layer=layer,
            facet_text=facet_text,
            status=status,
            source=source,
            evidence_json=evidence_json,
        )
        db.add(row)
    else:
        row.facet_text = facet_text
        row.source = source
        if evidence_json is not None:
            row.evidence_json = evidence_json
        # Status is preserved across re-scans; only telemetry / explicit
        # updates change it.
        if row.layer != layer:
            row.layer = layer
    return row


class CapabilityService:
    """Singleton. Reach into via `capability_service` at module bottom."""

    # ── Boot-time mechanical scan ────────────────────────────────────────
    def refresh_mechanical_layer(self, db: Session) -> dict:
        """Walk the tool registry + FastAPI routes + messaging channels and
        upsert mechanical-layer facets. Idempotent; safe to call every boot.

        Source-hash short-circuit: if nothing relevant changed since last
        scan, skip the loop and just return counters.
        """
        from .. import main as _main_mod  # imported lazily for routes

        repo_root = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        new_hash = _hash_paths(repo_root, _SCAN_PATHS)

        # Stash hash in a sentinel facet — avoids touching Settings just to
        # cache one string. The row never appears in user-facing lists since
        # `layer='_meta'` is filtered out at the API boundary.
        meta = (
            db.query(CapabilityFacet)
            .filter(CapabilityFacet.facet_key == "_meta.scan_hash")
            .one_or_none()
        )
        if meta is not None and meta.facet_text == new_hash:
            return {"skipped": True, "hash": new_hash}

        from ..tools import registry as tool_registry
        from .messaging import (  # noqa: F401 — channel singletons import
            telegram_channel,
            whatsapp_channel,
            imessage_channel,
        )

        seen_keys: set[str] = set()

        # Tools: facet_text = tool.description (the same string the OpenAI
        # function-calling layer sees — already semantic).
        for tool in tool_registry:
            key = f"tool.{tool.name}"
            seen_keys.add(key)
            _upsert(
                db,
                facet_key=key,
                layer="mechanical",
                facet_text=tool.description,
                source="code_introspection",
            )

        # Routes: facet_text = endpoint docstring's first line (or the path
        # itself if no doc). Skip OPTIONS/HEAD; skip dynamic prefix routers.
        try:
            routes = getattr(_main_mod.app, "routes", [])
        except Exception:
            routes = []
        for r in routes:
            methods = getattr(r, "methods", None)
            path = getattr(r, "path", None)
            endpoint = getattr(r, "endpoint", None)
            if not methods or not path or not endpoint:
                continue
            for m in methods:
                if m in {"OPTIONS", "HEAD"}:
                    continue
                key = f"route.{m}.{path}"
                seen_keys.add(key)
                doc = (endpoint.__doc__ or "").strip().splitlines()
                text = doc[0] if doc else f"{m} {path}"
                _upsert(
                    db,
                    facet_key=key,
                    layer="mechanical",
                    facet_text=text[:500],
                    source="code_introspection",
                )

        # Messaging channels.
        for ch_name in ("telegram", "whatsapp", "imessage"):
            key = f"channel.{ch_name}"
            seen_keys.add(key)
            _upsert(
                db,
                facet_key=key,
                layer="mechanical",
                facet_text=f"Inbound/outbound {ch_name} messaging channel.",
                source="code_introspection",
            )

        # Anything we previously scanned but didn't see this time → removed.
        stale = (
            db.query(CapabilityFacet)
            .filter(
                CapabilityFacet.source == "code_introspection",
                CapabilityFacet.layer == "mechanical",
                ~CapabilityFacet.facet_key.in_(seen_keys),
                CapabilityFacet.status != "removed",
            )
            .all()
        )
        for row in stale:
            row.status = "removed"

        # Update or insert the scan-hash sentinel.
        if meta is None:
            db.add(
                CapabilityFacet(
                    facet_key="_meta.scan_hash",
                    layer="_meta",
                    facet_text=new_hash,
                    status="claimed",
                    source="code_introspection",
                )
            )
        else:
            meta.facet_text = new_hash

        db.commit()
        return {
            "skipped": False,
            "hash": new_hash,
            "seen": len(seen_keys),
            "marked_removed": len(stale),
        }

    # ── Reflection-cluster behavioral promotion ──────────────────────────
    def promote_behavioral_facet(
        self,
        db: Session,
        *,
        centroid_text: str,
        evidence_reflection_ids: list[int],
    ) -> CapabilityFacet:
        """Called by ReflexionService when a gap-cluster crosses the
        threshold. The facet_key is derived from a hash of the centroid so
        re-firing on the same cluster idempotently updates the same row.

        Evidence list grows over time — caller passes the full set, we
        store the latest IDs. Status starts at 'claimed'; PR-audit or
        manual edit can promote to 'verified' once Daniel agrees.
        """
        key = "behavioral." + hashlib.sha1(
            centroid_text.encode("utf-8")
        ).hexdigest()[:12]
        row = _upsert(
            db,
            facet_key=key,
            layer="behavioral",
            facet_text=centroid_text,
            source="reflection_cluster",
            evidence={"reflection_ids": evidence_reflection_ids[-20:]},
        )
        db.commit()
        return row

    # ── Runtime telemetry rollup ─────────────────────────────────────────
    def run_telemetry_rollup(self, db: Session) -> dict:
        """Walk mechanical tool facets, count ToolCall rows by status over
        the last 30/7 days, and flip facet.status accordingly.

        Rules:
          ≥1 status='done' in last 30d → status='verified', last_verified_at=now
          0 invocations in last 30d    → status='unverified'
          ≥3 status='failed' in last 7d → status='broken', evidence snapshots
        """
        now = datetime.utcnow()
        d30 = now - timedelta(days=30)
        d7 = now - timedelta(days=7)
        promoted = demoted = broken = 0

        tool_facets = (
            db.query(CapabilityFacet)
            .filter(
                CapabilityFacet.layer == "mechanical",
                CapabilityFacet.facet_key.like("tool.%"),
                CapabilityFacet.status != "removed",
            )
            .all()
        )
        for facet in tool_facets:
            tool_name = facet.facet_key.removeprefix("tool.")
            done_30d = (
                db.query(ToolCall)
                .filter(
                    ToolCall.tool_name == tool_name,
                    ToolCall.status == "done",
                    ToolCall.started_at >= d30,
                )
                .count()
            )
            failed_7d = (
                db.query(ToolCall)
                .filter(
                    ToolCall.tool_name == tool_name,
                    ToolCall.status == "failed",
                    ToolCall.started_at >= d7,
                )
                .count()
            )
            if failed_7d >= 3:
                facet.status = "broken"
                facet.evidence_json = json.dumps(
                    {"failed_7d": failed_7d, "at": now.isoformat()}
                )
                broken += 1
            elif done_30d >= 1:
                if facet.status != "verified":
                    promoted += 1
                facet.status = "verified"
                facet.last_verified_at = now
            else:
                if facet.status != "unverified":
                    demoted += 1
                facet.status = "unverified"

        db.commit()
        return {
            "tools_scanned": len(tool_facets),
            "promoted": promoted,
            "demoted": demoted,
            "broken": broken,
            "ran_at": now.isoformat(),
        }

    # ── Master-prompt injection helper ───────────────────────────────────
    # Per-layer caps stop one layer from drowning out the others. Behavioral
    # was the offender on prod — reflexion-promoted facets cluster on
    # near-duplicate gap text and stack 6× ("I tend to: lack support" repeated
    # almost verbatim). Real fix is cosine-dedup at promotion time; this is
    # the render-time guard until that ships.
    _LAYER_CAPS = {
        "architectural": 5,
        "functional": 12,
        "behavioral": 2,
    }

    def build_prompt_block(self, db: Session, max_lines: int = 30) -> str:
        """Compact 'Who I am right now' block for master prompt injection.

        Strategy: pull verified+claimed facets across functional/behavioral/
        architectural layers; mechanical layer is implicit in the tool
        schemas the LLM already sees so we don't repeat it here. Each layer
        capped via _LAYER_CAPS; behavioral takes the 2 MOST-RECENT (by
        updated_at desc) to surface the freshest patterns rather than the
        oldest clusters.
        """
        # Pull behavioral separately so we can sort by updated_at desc.
        # The other layers stay in id order — they're hand-curated, so id
        # already reflects intentional ordering.
        behavioral_rows = (
            db.query(CapabilityFacet)
            .filter(
                CapabilityFacet.layer == "behavioral",
                CapabilityFacet.status.in_(["verified", "claimed"]),
            )
            .order_by(CapabilityFacet.updated_at.desc())
            .limit(self._LAYER_CAPS["behavioral"])
            .all()
        )
        other_rows = (
            db.query(CapabilityFacet)
            .filter(
                CapabilityFacet.layer.in_(["functional", "architectural"]),
                CapabilityFacet.status.in_(["verified", "claimed"]),
            )
            .order_by(CapabilityFacet.layer, CapabilityFacet.id)
            .all()
        )
        # Per-layer caps on the rest.
        capped: list[CapabilityFacet] = []
        seen: dict[str, int] = {}
        for r in other_rows:
            seen[r.layer] = seen.get(r.layer, 0) + 1
            if seen[r.layer] > self._LAYER_CAPS.get(r.layer, max_lines):
                continue
            capped.append(r)

        rows = capped + behavioral_rows
        rows = rows[:max_lines]
        if not rows:
            return ""

        lines = ["Who I am right now:"]
        for r in rows:
            tag = {
                "functional": "I can",
                "behavioral": "I tend to",
                "architectural": "I am",
            }.get(r.layer, "")
            lines.append(f"- {tag}: {r.facet_text}")
        return "\n".join(lines)


capability_service = CapabilityService()
