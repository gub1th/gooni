"""Focus synthesizer — probe version.

Clusters recent signal across notes, todos, deduped memory facts, and recent
user chat messages, then asks an LLM whether each cluster represents a
focus-shaped theme. Returns candidates as JSON; does NOT write to the DB.

This is a probe — the goal is to validate whether HDBSCAN-style clustering
over Daniel's corpus can surface meaningful focuses before we invest in a
FocusCandidate table, dashboard UI, or scheduled runs.

Clustering is a greedy single-link cosine pass (no sklearn / hdbscan dep).
If signal quality looks real, swap to HDBSCAN for better density handling
in v2.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..db.models import Memory, Message, Note, Space, Todo
from ..llm.client import llm_client
from .note_service import _cosine_similarity


RECENT_DAYS_NOTES = 60
RECENT_DAYS_MESSAGES = 60
RECENT_DAYS_TODOS_DONE = 14
NOTE_MIN_LEN = 100
MESSAGE_MIN_LEN = 50
MESSAGE_GATHER_CAP = 200
FACT_DEDUP_FLOOR = 0.85
# Cosine threshold for greedy single-link join. Lower = looser join =
# fewer, larger clusters. Tuned down from 0.55 → 0.48 after the v1 probe
# split the build-Gooni theme into 4 sub-clusters because centroids
# drifted apart at init.
CLUSTER_SIM_THRESHOLD = 0.48
# Second pass: after initial greedy join, merge any two clusters whose
# centroids exceed this similarity. Catches over-fragmentation that
# the single-pass greedy can't undo. Iterative until no merges remain.
POST_MERGE_CENTROID_SIM = 0.62
MIN_CLUSTER_SIZE = 3
# Sub-clustering: any parent cluster at least this large gets re-clustered
# at a tighter cosine threshold to surface mini-themes. e.g. the "Build
# Gooni" parent splits into markdown / todo-workflow / session-summaries.
# Set MIN_PARENT_FOR_SUBCLUSTER to a high number (e.g. 9999) to disable.
SUB_CLUSTER_THRESHOLD = 0.62
MIN_PARENT_FOR_SUBCLUSTER = 8
MIN_SUB_SIZE = 3
SNIPPET_LEN = 200

# State→focus binding uses a compound test: a state cluster's centroid
# must clear BOTH an absolute cosine floor and beat the runner-up focus
# by a margin. Pure abs-floor binds noisily because intent/activity
# centroids sit at lower-than-expected sims (~0.40 even for clearly
# matched pairs like "Get Jacked" intent ↔ weight/rep logs); meanwhile
# unrelated state clusters often score ~0.45 against an arbitrary focus.
# The margin requirement is what discriminates real homes from
# coincidence — the right focus tends to dominate by a 0.15+ gap, while
# ambiguous state clusters land within 0.01-0.05 of multiple focuses.
STATE_BIND_SIM = 0.38  # absolute floor — best match must clear this
STATE_BIND_MARGIN = 0.10  # best match must beat the runner-up by this

# Cheap model for the per-cluster classify call. Task is short-context
# multi-class classification (focus / state / noise) with a one-sentence
# reasoning — well within 4o-mini's capability and ~25x cheaper than the
# default chat model. Override via the `classify_model` kwarg / endpoint
# body if quality regresses.
CLASSIFY_MODEL = "gpt-4o-mini"

# Thread-pool size for parallel embed + classify calls. OpenAI's default
# request rate easily handles 10 concurrent connections from one tenant;
# any higher risks 429s on cold accounts. Bottleneck is now network RTT,
# not per-call CPU.
LLM_WORKERS = 10

# Spaces whose notes are meta-noise about Gooni itself, not Daniel's
# signal. Filtering them keeps the synthesizer from clustering on its own
# audit notes / dispatched eval payloads.
EXCLUDED_SPACE_NAMES = {"Claude Code", "Gooni Backlog"}


def _strip_html(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html or "").strip()


def _parse_vec(emb: str | None) -> list[float] | None:
    if not emb:
        return None
    try:
        v = json.loads(emb)
        return v if isinstance(v, list) and v else None
    except Exception:
        return None


def _gather_notes(db: Session) -> list[dict]:
    """Pull recent unprocessed notes for synthesizer clustering.

    Filter on `Note.status == 'unprocessed'` so already-graduated notes
    don't re-surface as fresh focus candidates — once a note has spawned
    a Promise/Todo/Habit/Focus, it shouldn't drag its old cluster back
    into the candidate pool. Archived notes also excluded (manual
    tombstone). `_promote_candidate_graduates_notes` (in
    focus_candidate_service) flips the status when a candidate promotes.
    """
    cutoff = datetime.utcnow() - timedelta(days=RECENT_DAYS_NOTES)
    space_names = {s.id: s.name for s in db.query(Space.id, Space.name).all()}
    rows = (
        db.query(Note.id, Note.title, Note.content, Note.embedding, Note.space_id, Note.updated_at, Note.status)
        .filter(Note.embedding.isnot(None))
        .filter(Note.updated_at >= cutoff)
        .filter(Note.status == "unprocessed")
        .all()
    )
    items: list[dict] = []
    for nid, title, content, emb, space_id, _, _status in rows:
        if space_names.get(space_id, "") in EXCLUDED_SPACE_NAMES:
            continue
        body = _strip_html(content or "")
        text = f"{title or ''}\n{body}".strip()
        if len(text) < NOTE_MIN_LEN:
            continue
        vec = _parse_vec(emb)
        if not vec:
            continue
        items.append({
            "kind": "note",
            "id": nid,
            "text": text,
            "embedding": vec,
        })
    return items


def _gather_todos(db: Session) -> list[dict]:
    cutoff_done = datetime.utcnow() - timedelta(days=RECENT_DAYS_TODOS_DONE)
    rows = (
        db.query(
            Todo.id, Todo.text, Todo.subtitle, Todo.embedding,
            Todo.state, Todo.completed_at,
        )
        .filter(Todo.embedding.isnot(None), Todo.deleted_at.is_(None))
        .all()
    )
    items: list[dict] = []
    for tid, text, subtitle, emb, state, completed_at in rows:
        if state == "done" and completed_at and completed_at < cutoff_done:
            continue
        vec = _parse_vec(emb)
        if not vec:
            continue
        full = (text or "").strip()
        if subtitle:
            full = f"{full} — {subtitle.strip()}"
        if not full:
            continue
        items.append({
            "kind": "todo",
            "id": tid,
            "text": full,
            "embedding": vec,
        })
    return items



def _gather_facts_deduped(db: Session) -> list[dict]:
    """Pull active fact memories; cosine-collapse near-dupes (≥0.85).
    Keep the highest-confidence representative per dupe-cluster. Skip
    feedback-derived rows (they're style prefs, not focus material)."""
    rows = (
        db.query(
            Memory.id, Memory.content, Memory.embedding,
            Memory.confidence, Memory.key,
        )
        .filter(
            Memory.is_active == True,  # noqa: E712 — SQLA needs ==
            Memory.type == "fact",
            Memory.embedding.isnot(None),
        )
        .all()
    )
    parsed: list[dict] = []
    for mid, content, emb, conf, key in rows:
        if key and key.startswith("feedback__"):
            continue
        vec = _parse_vec(emb)
        if not vec or not content:
            continue
        parsed.append({
            "id": mid,
            "content": content,
            "embedding": vec,
            "confidence": float(conf or 0.8),
        })
    # Highest confidence first → its embedding wins the dedup race.
    parsed.sort(key=lambda x: x["confidence"], reverse=True)
    accepted: list[dict] = []
    for p in parsed:
        if any(
            _cosine_similarity(p["embedding"], a["embedding"]) >= FACT_DEDUP_FLOOR
            for a in accepted
        ):
            continue
        accepted.append(p)
    return [
        {
            "kind": "fact",
            "id": p["id"],
            "text": p["content"],
            "embedding": p["embedding"],
        }
        for p in accepted
    ]


def _gather_messages(db: Session) -> list[dict]:
    """Recent user messages over the length floor.

    Messages are immutable after creation, so we cache their embeddings
    in the `messages.embedding` deferred column. On every run we pull
    the stored vector when present; on a miss we embed via the API,
    persist back to the row, and use the fresh vector. First run after
    the migration eats the full cost; subsequent runs are zero API
    calls in this gather. Misses are embedded in parallel via a thread
    pool — turns ~17s of sequential RTT into ~2s.
    """
    cutoff = datetime.utcnow() - timedelta(days=RECENT_DAYS_MESSAGES)
    rows = (
        db.query(Message.id, Message.content, Message.embedding)
        .filter(Message.role == "user")
        .filter(Message.created_at >= cutoff)
        .order_by(Message.id.desc())
        .limit(MESSAGE_GATHER_CAP)
        .all()
    )

    cached: list[tuple[int, str, list[float]]] = []
    misses: list[tuple[int, str]] = []
    for mid, content, emb_str in rows:
        text = (content or "").strip()
        if len(text) < MESSAGE_MIN_LEN:
            continue
        cached_vec = _parse_vec(emb_str)
        if cached_vec:
            cached.append((mid, text, cached_vec))
        else:
            misses.append((mid, text))

    # Embed only the misses, in parallel.
    fresh: list[tuple[int, str, list[float]]] = []
    if misses:
        def _embed(text: str) -> list[float]:
            emb, _ = llm_client.generate_embedding(text[:2000])
            return emb or []

        with ThreadPoolExecutor(max_workers=LLM_WORKERS) as ex:
            embeddings = list(ex.map(_embed, [t for _, t in misses]))

        for (mid, text), vec in zip(misses, embeddings):
            if not vec:
                continue
            fresh.append((mid, text, vec))

        # Persist the fresh embeddings so next run hits the cache.
        # Wrapped in a try/except + flush — gather must never break the
        # synth pipeline if the write fails (read-only fallback is fine).
        if fresh:
            try:
                for mid, _, vec in fresh:
                    db.query(Message).filter(Message.id == mid).update(
                        {"embedding": json.dumps(vec)},
                        synchronize_session=False,
                    )
                db.commit()
            except Exception:
                db.rollback()

    items: list[dict] = []
    for mid, text, vec in cached:
        items.append({
            "kind": "message",
            "id": mid,
            "text": text,
            "embedding": vec,
        })
    for mid, text, vec in fresh:
        items.append({
            "kind": "message",
            "id": mid,
            "text": text,
            "embedding": vec,
        })
    return items


def _greedy_cluster(
    items: list[dict], threshold: float = CLUSTER_SIM_THRESHOLD
) -> list[list[int]]:
    """Single-link greedy cluster by cosine similarity to running centroid.

    For each item: find the cluster whose centroid has the highest sim;
    if that sim ≥ threshold, join (centroid updated as weighted mean);
    else open a new cluster.

    Cheap, deterministic given input order. Roughly equivalent to DBSCAN
    with eps=threshold and min_pts=1. Real HDBSCAN would handle varying
    densities better, but for a probe this is enough to tell us if the
    corpus carries any focus-shaped signal at all.
    """
    clusters: list[dict] = []
    for idx, item in enumerate(items):
        best_ci = -1
        best_sim = threshold
        for ci, c in enumerate(clusters):
            sim = _cosine_similarity(item["embedding"], c["centroid"])
            if sim >= best_sim:
                best_sim = sim
                best_ci = ci
        if best_ci >= 0:
            c = clusters[best_ci]
            n = c["count"]
            c["centroid"] = [
                (a * n + b) / (n + 1)
                for a, b in zip(c["centroid"], item["embedding"])
            ]
            c["items"].append(idx)
            c["count"] = n + 1
        else:
            clusters.append({
                "centroid": list(item["embedding"]),
                "items": [idx],
                "count": 1,
            })
    return [c["items"] for c in clusters]


_CLASSIFY_PROMPT = """You will see a cluster of items pulled from a user's notes, todos, memory facts, and chat messages.

Classify the cluster as ONE of: "focus", "state", or "noise". Judge by SHAPE, not topic.

DEFINITIONS

"focus" — items share a forward-pointing intent. The throughline is a verb pointing at a future end-state the user wants to reach, build, become, or change. Time horizon is weeks-to-months, not a single session. Items read like commitments, goals, or sustained projects.

"state" — items are records of what already happened or what is currently true. Measurements, logs, activity recaps, session summaries, snapshots. Past or present tense. No forward verb. Even if the items relate to a real focus, a cluster of pure RECORDS is state, not focus.

"noise" — items are stylistic / tone preferences, greetings, template-shaped repeats, one-off facts with no shared throughline, or a mixed bag with no coherent theme.

CRITICAL DISCRIMINATORS

- INTENT STATEMENTS vs ACTIVITY LOGS. Cluster of "wants to X" / "goal is Y" / "plans to Z" = focus. Cluster of measurements, numbers, dated entries, or "did X today" recaps = state. These often split apart even when the underlying topic is the same.
- TEMPLATE-SHAPED REPEATS = noise. If items share an identical sentence skeleton with only a topic variable swapped, that is a system-generated template repeating, not user intent.
- PREFERENCES ABOUT TONE / FORMAT / OUTPUT STYLE = noise. Not focus, even if the subject is a system the user is building.
- MIXED-TOPIC CLUSTER = noise. If you can't write one name that covers every item without straining, the cluster is incoherent — classify as noise rather than forcing a label.

GENERIC ARCHETYPES (illustrative only — do not bias toward these topics)

- focus: "Apply to grad school", "Learn Mandarin to conversational level", "Train for a marathon", "Launch side project", "Quit a habit", "Move to a new city".
- state: workout numbers, meal logs, weight readings, mood entries, "what shipped today" recaps, raw measurement clusters.
- noise: "respond concisely" prefs, greeting templates, "use markdown" prefs, daily check-in templates with topic variables.

Cluster items ({n}):
{evidence}

Respond with strict JSON only — no markdown fences, no prose:
{{
  "category": "focus" | "state" | "noise",
  "is_focus": <bool — true iff category == "focus">,
  "name": "<short label derived from the items themselves, not the archetypes>",
  "endgoal": "<concrete outcome if focus, else empty string>",
  "confidence": <float 0-1, how confident in the category>,
  "reasoning": "<one sentence on the category choice>"
}}"""


def _merge_close_clusters(
    items: list[dict],
    cluster_indices: list[list[int]],
    merge_threshold: float = POST_MERGE_CENTROID_SIM,
) -> list[list[int]]:
    """Iteratively merge clusters whose centroids exceed merge_threshold.

    Greedy single-link in a single pass leaves over-fragmentation when
    centroids drift at cluster birth — e.g. note#38 and fact#126 both
    belong to the build-Gooni theme but seeded different clusters. This
    pass computes pairwise centroid similarities and merges the closest
    pair above threshold each iteration until none remain.
    """
    if len(cluster_indices) < 2:
        return [list(c) for c in cluster_indices]

    def centroid_of(idxs: list[int]) -> list[float]:
        n = len(idxs)
        dim = len(items[idxs[0]]["embedding"])
        acc = [0.0] * dim
        for i in idxs:
            vec = items[i]["embedding"]
            for d in range(dim):
                acc[d] += vec[d]
        return [x / n for x in acc]

    current = [list(c) for c in cluster_indices]
    while True:
        centroids = [centroid_of(c) for c in current]
        best_pair: tuple[int, int] | None = None
        best_sim = merge_threshold
        for i in range(len(current)):
            for j in range(i + 1, len(current)):
                sim = _cosine_similarity(centroids[i], centroids[j])
                if sim >= best_sim:
                    best_sim = sim
                    best_pair = (i, j)
        if not best_pair:
            return current
        i, j = best_pair
        current[i].extend(current[j])
        current.pop(j)


def _subcluster_parent(
    parent_items: list[dict],
    sub_threshold: float = SUB_CLUSTER_THRESHOLD,
    min_sub_size: int = MIN_SUB_SIZE,
) -> list[list[int]]:
    """Re-cluster items within a parent at a tighter cosine threshold to
    expose mini-themes. Returns sub-clusters as lists of indices INTO
    parent_items (caller maps back to original items). No merge pass —
    sub-clustering wants to preserve fine-grained splits, since the merge
    behavior is what coalesced them into one parent in the first place.

    Dropping sub-clusters below min_sub_size keeps the output readable —
    a parent of 44 might naturally yield ~6-10 size-1 leftover sub-clusters
    that aren't worth surfacing alongside the real sub-themes.
    """
    sub_clusters = _greedy_cluster(parent_items, threshold=sub_threshold)
    return [s for s in sub_clusters if len(s) >= min_sub_size]


def _centroid_of_items(items: list[dict]) -> list[float]:
    """Mean of item embeddings. Used by the state→focus binding pass to
    measure cosine distance between cluster centroids after classify."""
    if not items:
        return []
    dim = len(items[0]["embedding"])
    acc = [0.0] * dim
    for it in items:
        vec = it["embedding"]
        for d in range(dim):
            acc[d] += vec[d]
    return [x / len(items) for x in acc]


def _bind_state_to_focus(
    parent_payloads: list[dict],
    threshold: float = STATE_BIND_SIM,
    margin: float = STATE_BIND_MARGIN,
) -> None:
    """For each state cluster, attach it to the focus cluster with the
    closest centroid — but only when the match is unambiguously the
    best home. Two conditions must hold:
      1. best_sim ≥ threshold (absolute cosine floor)
      2. best_sim − second_best_sim ≥ margin (decisive winner)

    The margin is what discriminates real binds from coincidence. State
    clusters that genuinely belong to a focus tend to dominate the
    runner-up by ≥0.15 (e.g. weight logs ↔ Get Jacked = 0.40 vs next
    0.16, gap 0.24). State clusters with no clear home land within
    0.01-0.05 of multiple focuses and should orphan.

    When only one focus exists, the margin test passes trivially (no
    runner-up to beat). The absolute floor is the only gate.

    State cluster gets `bound_to_index` set; focus cluster gains a
    `bound_state` entry carrying the state items + classification +
    bind sim. Mutates parent_payloads in place.
    """
    focus_meta: list[tuple[int, list[float]]] = []
    state_meta: list[tuple[int, list[float]]] = []
    for idx, p in enumerate(parent_payloads):
        cls = p.get("classification") or {}
        cat = cls.get("category")
        if cat == "focus":
            focus_meta.append((idx, _centroid_of_items(p["items"])))
        elif cat == "state":
            state_meta.append((idx, _centroid_of_items(p["items"])))

    if not (focus_meta and state_meta):
        return

    for s_idx, s_centroid in state_meta:
        sims = [
            (f_idx, _cosine_similarity(s_centroid, f_centroid))
            for f_idx, f_centroid in focus_meta
        ]
        sims.sort(key=lambda x: -x[1])
        best_f_idx, best_sim = sims[0]
        if best_sim < threshold:
            continue
        second_best_sim = sims[1][1] if len(sims) > 1 else -1.0
        if best_sim - second_best_sim < margin:
            continue

        state_payload = parent_payloads[s_idx]
        target = parent_payloads[best_f_idx]
        target.setdefault("bound_state", []).append({
            "items": state_payload["items"],
            "classification": state_payload.get("classification"),
            "bind_sim": round(best_sim, 3),
            "bind_margin": round(best_sim - second_best_sim, 3),
        })
        state_payload["bound_to_index"] = best_f_idx


def _classify_cluster(items: list[dict], model: str = CLASSIFY_MODEL) -> dict:
    evidence = "\n".join(
        f"- [{it['kind']}] {it['text'][:SNIPPET_LEN]}" for it in items
    )
    prompt = _CLASSIFY_PROMPT.format(n=len(items), evidence=evidence)
    raw = llm_client.generate_simple_completion(
        prompt, max_tokens=400, temperature=0.2, model=model
    )
    if not raw:
        return {
            "is_focus": False, "name": "", "endgoal": "",
            "confidence": 0.0, "reasoning": "classify: empty response",
        }
    cleaned = raw.strip()
    # Strip markdown fences if the model wrapped despite instructions.
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except Exception as e:
        return {
            "is_focus": False, "name": "", "endgoal": "",
            "confidence": 0.0,
            "reasoning": f"classify parse error: {e} | raw: {cleaned[:120]}",
        }


def synthesize(
    db: Session,
    include_kinds: list[str] | None = None,
    threshold: float = CLUSTER_SIM_THRESHOLD,
    merge_threshold: float = POST_MERGE_CENTROID_SIM,
    sub_threshold: float = SUB_CLUSTER_THRESHOLD,
    min_parent_for_subcluster: int = MIN_PARENT_FOR_SUBCLUSTER,
    min_sub_size: int = MIN_SUB_SIZE,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
    classify: bool = True,
    classify_model: str = CLASSIFY_MODEL,
    state_bind_sim: float = STATE_BIND_SIM,
    state_bind_margin: float = STATE_BIND_MARGIN,
) -> dict:
    """Run the full synthesis pass and return JSON.

    Args:
        include_kinds: subset of {"note","todo","fact","message"}.
            Defaults to all four.
        threshold: cosine cutoff to join an item to an existing cluster
            during the greedy single-link pass.
        merge_threshold: cosine cutoff for the post-merge pass that
            coalesces clusters whose centroids are still close after the
            initial join. Set to 1.1 to disable merging entirely.
        sub_threshold: tighter cosine cutoff used when re-clustering
            within a parent to expose mini-themes.
        min_parent_for_subcluster: only parents this size or larger get
            sub-clustered. Smaller parents are already readable as-is.
        min_sub_size: drop sub-clusters smaller than this from the
            children payload.
        min_cluster_size: drop top-level clusters smaller than this
            before classify.
        classify: when False, skip every per-cluster LLM call (cheap
            dry-run to inspect raw cluster shape).
        state_bind_sim: absolute cosine floor for state→focus binding.
            The state cluster's centroid must score at least this high
            against the best-matching focus cluster's centroid. Set to
            1.1 to disable binding entirely.
        state_bind_margin: minimum lead the best focus must have over
            the runner-up for the bind to take. Discriminates real
            "this is the home" matches from "tied between multiple
            focuses" — empirically a ≥0.10 gap means the right focus
            is decisively the home; smaller gaps mean ambiguity and
            the state cluster should orphan rather than be force-bound.
    """
    include_kinds = include_kinds or ["note", "todo", "fact", "message"]
    items: list[dict] = []
    if "note" in include_kinds:
        items.extend(_gather_notes(db))
    if "todo" in include_kinds:
        items.extend(_gather_todos(db))
    if "fact" in include_kinds:
        items.extend(_gather_facts_deduped(db))
    if "message" in include_kinds:
        items.extend(_gather_messages(db))

    counts: dict[str, int] = {}
    for it in items:
        counts[it["kind"]] = counts.get(it["kind"], 0) + 1

    if not items:
        return {
            "candidates": [],
            "stats": {
                "item_counts": counts,
                "raw_cluster_count": 0,
                "merged_cluster_count": 0,
                "kept_count": 0,
                "classified_count": 0,
            },
        }

    raw_clusters = _greedy_cluster(items, threshold=threshold)
    cluster_indices = _merge_close_clusters(
        items, raw_clusters, merge_threshold=merge_threshold
    )

    kept: list[list[int]] = [c for c in cluster_indices if len(c) >= min_cluster_size]

    # Build the full structure (parents + sub-clusters) BEFORE any LLM
    # call, then fan classify out across a thread pool. Nested loops
    # would have to wait on every per-cluster RTT serially; flat-then-
    # batch turns ~28s of sequential classify calls into ~3s parallel.
    parent_payloads: list[dict] = []
    for cluster in kept:
        cluster_items = [items[i] for i in cluster]
        children_payloads: list[dict] = []
        if len(cluster_items) >= min_parent_for_subcluster:
            sub_index_lists = _subcluster_parent(
                cluster_items,
                sub_threshold=sub_threshold,
                min_sub_size=min_sub_size,
            )
            for sub_idx_list in sub_index_lists:
                sub_items = [cluster_items[i] for i in sub_idx_list]
                children_payloads.append({"items": sub_items})
        parent_payloads.append({
            "items": cluster_items,
            "children": children_payloads,
        })

    subcluster_total = sum(len(p["children"]) for p in parent_payloads)

    # Flat job list — each entry is (payload_ref, items). The payload_ref
    # is the dict whose "classification" key we'll write back to once the
    # parallel call returns. Single sweep covers parents + children so the
    # thread pool stays saturated.
    if classify:
        jobs: list[tuple[dict, list[dict]]] = []
        for p in parent_payloads:
            jobs.append((p, p["items"]))
            for ch in p["children"]:
                jobs.append((ch, ch["items"]))

        def _classify_one(items_list: list[dict]) -> dict:
            return _classify_cluster(items_list, model=classify_model)

        with ThreadPoolExecutor(max_workers=LLM_WORKERS) as ex:
            results = list(ex.map(_classify_one, [j[1] for j in jobs]))
        for (ref, _), classification in zip(jobs, results):
            ref["classification"] = classification
    else:
        for p in parent_payloads:
            p["classification"] = None
            for ch in p["children"]:
                ch["classification"] = None

    # State→focus binding pass — only meaningful when classify ran, since
    # we key off the category labels. Intent statements ("get jacked")
    # and activity logs ("185 lbs 8 reps") cluster apart at the embedding
    # level due to language shape, but they describe the same focus.
    # This pass re-attaches state clusters to their nearest focus.
    bound_state_count = 0
    if classify:
        _bind_state_to_focus(
            parent_payloads,
            threshold=state_bind_sim,
            margin=state_bind_margin,
        )
        bound_state_count = sum(
            len(p.get("bound_state") or []) for p in parent_payloads
        )

    candidates: list[dict] = []
    for p in parent_payloads:
        # Skip payloads that were bound to another focus — they no longer
        # belong at the top level; they live nested as bound_state on
        # their parent focus.
        if p.get("bound_to_index") is not None:
            continue
        evidence = [
            {
                "kind": it["kind"],
                "id": it["id"],
                "snippet": it["text"][:SNIPPET_LEN],
            }
            for it in p["items"]
        ]
        children: list[dict] = []
        for ch in p["children"]:
            sub_evidence = [
                {
                    "kind": it["kind"],
                    "id": it["id"],
                    "snippet": it["text"][:SNIPPET_LEN],
                }
                for it in ch["items"]
            ]
            children.append({
                "size": len(ch["items"]),
                "classification": ch["classification"],
                "evidence": sub_evidence,
                "centroid_embedding": _centroid_of_items(ch["items"]),
            })
        bound_state_payload: list[dict] = []
        for bs in p.get("bound_state") or []:
            bs_items = bs["items"]
            bound_state_payload.append({
                "size": len(bs_items),
                "classification": bs.get("classification"),
                "bind_sim": bs.get("bind_sim"),
                "bind_margin": bs.get("bind_margin"),
                "evidence": [
                    {
                        "kind": it["kind"],
                        "id": it["id"],
                        "snippet": it["text"][:SNIPPET_LEN],
                    }
                    for it in bs_items
                ],
            })
        candidate = {
            "size": len(p["items"]),
            "classification": p["classification"],
            "evidence": evidence,
            "children": children,
            # Centroid emitted so downstream consumers (FocusCandidate
            # persistence, hybrid binding to existing Focus rows) can
            # compute cosine sims without re-loading per-item embeddings.
            "centroid_embedding": _centroid_of_items(p["items"]),
        }
        if bound_state_payload:
            candidate["bound_state"] = bound_state_payload
        candidates.append(candidate)

    # Order: classified-as-focus first by confidence desc, then unclassified
    # by size desc. Lets the eyeball test focus on what the LLM endorsed.
    def _sort_key(c: dict) -> tuple[int, float, int]:
        cls = c.get("classification") or {}
        is_focus = 1 if cls.get("is_focus") else 0
        conf = float(cls.get("confidence") or 0.0)
        return (is_focus, conf, c["size"])

    candidates.sort(key=_sort_key, reverse=True)

    return {
        "candidates": candidates,
        "stats": {
            "item_counts": counts,
            "raw_cluster_count": len(raw_clusters),
            "merged_cluster_count": len(cluster_indices),
            "kept_count": len(kept),
            "classified_count": sum(1 for c in candidates if c["classification"] is not None),
            "subcluster_count": subcluster_total,
            "bound_state_count": bound_state_count,
            "params": {
                "threshold": threshold,
                "merge_threshold": merge_threshold,
                "sub_threshold": sub_threshold,
                "min_parent_for_subcluster": min_parent_for_subcluster,
                "min_sub_size": min_sub_size,
                "min_cluster_size": min_cluster_size,
                "include_kinds": include_kinds,
                "classify": classify,
                "classify_model": classify_model,
                "state_bind_sim": state_bind_sim,
                "state_bind_margin": state_bind_margin,
            },
        },
    }
