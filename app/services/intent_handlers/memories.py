"""Memory candidate routing.

Phase 3: owns the per-candidate reconcile orchestration.
memory_service exposes primitives (embed / cosine_search / key search /
apply_add / apply_update / apply_delete / apply_none / normalize_for_dedup);
this handler composes them into the ADD/UPDATE/DELETE/NONE decision loop.

Per-candidate dance:
  1. Cheap normalize-dedup against same-type-active rows → apply_none, done
  2. Embed candidate (None ok — still ADD it so the memory isn't lost)
  3. Key-based search for same-key + same-type + active rows
  4. Cosine search top-K above floor (per-type tuned)
  5. Call reconcile_candidate LLM → ADD / UPDATE / DELETE / NONE + target?
  6. Apply
"""

from __future__ import annotations


def handle(candidates: list[dict], ctx, result) -> None:
    if not candidates:
        return

    from ..memory_service import memory_service

    written = []
    sess, owns = memory_service._scoped(ctx.db)
    try:
        for c in candidates:
            try:
                m = _reconcile_one(sess, c, source_note_id=ctx.source_note_id)
            except Exception as e:
                print(f"[memories handler] reconcile error: {e}")
                continue
            if m is not None:
                written.append(m)
        if candidates:
            memory_service._has_memories_cache = True
    finally:
        if owns:
            sess.close()

    result.memories_written.extend(written)
    if written:
        result.tools_used.append("router:memory")
        if ctx.on_tool_call:
            try:
                ctx.on_tool_call(
                    "router:memory",
                    label=f"Routed {len(written)} memory candidate(s)",
                    args={"count": len(written)},
                )
            except Exception as e:
                print(f"[memories handler] trace hook error: {e}")


def _reconcile_one(sess, candidate: dict, source_note_id: int | None = None):
    """Per-candidate reconcile + apply. Returns the Memory row written
    (ADD/UPDATE), or None when the decision was NONE / DELETE-only / no
    new row was created.
    """
    from ..memory_extraction import reconcile_candidate
    from ..memory_service import (
        Memory,
        RECONCILE_PREFERENCE_FLOOR,
        RECONCILE_PREFERENCE_TOP_K,
        RECONCILE_SIMILARITY_FLOOR,
        RECONCILE_TOP_K,
        _normalize_for_dedup,
        _serialize,
        memory_service,
    )

    # 1. Cheap deterministic dedup. Catches exact + near-exact dupes
    # (case, punctuation, whitespace, leading "User prefers" vs lowercase)
    # so the LLM reconcile isn't paid for paraphrases that are obvious.
    cand_norm = _normalize_for_dedup(candidate.get("content", ""))
    if cand_norm:
        same_type_active = (
            sess.query(Memory)
            .filter(
                Memory.type == candidate["type"],
                Memory.is_active == True,  # noqa: E712 — SQLAlchemy column
            )
            .all()
        )
        for m in same_type_active:
            if _normalize_for_dedup(m.content or "") == cand_norm:
                memory_service._apply_none(sess, m.id)
                return None

    # 2. Embed candidate. None embedding is OK — we still ADD so the
    # memory isn't lost, just skip the cosine pass.
    embedding = memory_service._embed(candidate["content"])

    # 3. Build existing-candidate list: key-search + cosine, dedup by id.
    existing: list[dict] = []
    seen_ids: set[int] = set()

    is_pref = candidate.get("type") == "preference"
    floor = RECONCILE_PREFERENCE_FLOOR if is_pref else RECONCILE_SIMILARITY_FLOOR
    top_k = RECONCILE_PREFERENCE_TOP_K if is_pref else RECONCILE_TOP_K

    candidate_key = candidate.get("key")
    if candidate_key:
        # Key search catches "prefers dark mode" → "prefers light mode"
        # contradictions where cosine sim is misleadingly low (opposing
        # facts share less language than they should).
        key_matches = (
            sess.query(Memory)
            .filter(
                Memory.key == candidate_key,
                Memory.type == candidate["type"],
                Memory.is_active == True,  # noqa: E712
            )
            .all()
        )
        for m in key_matches:
            if m.id not in seen_ids:
                seen_ids.add(m.id)
                existing.append(_serialize(m))

    if embedding:
        similar = memory_service._cosine_search(
            sess,
            embedding,
            type_filter=[candidate["type"]],
            limit=top_k,
            floor=floor,
        )
        for m, _ in similar:
            if m.id not in seen_ids:
                seen_ids.add(m.id)
                existing.append(_serialize(m))
        existing = existing[: top_k + 2]  # cap so reconcile prompt stays bounded

    # 4. LLM reconcile decision. Empty existing → defaults to ADD.
    decision = reconcile_candidate(candidate, existing)
    if not decision:
        return memory_service._apply_add(
            sess, candidate, embedding or [], source_note_id=source_note_id
        )

    action = decision["action"]
    target = decision.get("target_id")
    if action == "ADD":
        return memory_service._apply_add(
            sess, candidate, embedding or [], source_note_id=source_note_id
        )
    if action == "UPDATE" and isinstance(target, int):
        return memory_service._apply_update(
            sess, candidate, embedding or [], target, source_note_id=source_note_id
        )
    if action == "DELETE" and isinstance(target, int):
        memory_service._apply_delete(sess, target)
        return memory_service._apply_add(
            sess, candidate, embedding or [], source_note_id=source_note_id
        )
    if action == "NONE" and isinstance(target, int):
        memory_service._apply_none(sess, target)
        return None
    # Fallback: invalid decision shape → ADD so we don't silently drop.
    return memory_service._apply_add(
        sess, candidate, embedding or [], source_note_id=source_note_id
    )
