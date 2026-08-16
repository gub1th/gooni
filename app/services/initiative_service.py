"""The initiative synthesizer — Gooni's first inference layer.

Every other surface in this codebase answers a question about ONE row or one
window: what is due, what did the sensors see, what did he say. This one asks a
question no single row can answer — *what is Daniel actually working on right
now* — by reading across three primitives at once (memories, thought-batches,
active promises), clustering them in embedding space, and naming each cluster.

**Why clustering and not an LLM pass over everything.** The obvious version is
one big call: dump every memory and promise into a prompt and ask for themes.
That is expensive on every refresh, unstable between runs (the same corpus
yields different themes on Tuesday), and unauditable — a theme with no rows
under it cannot be checked. Clustering inverts it: the GROUPING is deterministic
(DBSCAN over cosine distance, same answer for the same corpus every time) and
the model is only allowed to do the one thing a matcher genuinely cannot, which
is put a name on a pile it is shown. Every initiative therefore carries its
member rows, and a label that does not match them is visibly wrong rather than
merely unverifiable. Same split as the rest of the app: deterministic for
anything that ranks/groups/surfaces, LLM only to parse or phrase.

**The deps question, and why there is a fallback.** DBSCAN is a scikit-learn
one-liner, and sklearn+numpy is ~100MB of image and tens of MB of resident
memory on a 512MB Fly machine that already runs a watchdog because it has been
OOM-killed before (`background._memory_watchdog_loop`). The algorithm itself is
~40 lines and exactly specified, so this module implements it directly and uses
numpy/sklearn ONLY if they happen to be importable — same clusters either way,
verified by `tests/test_initiatives.py` running the pure path. Neither import is
at module level: `tests/test_imports.py` walks every module under `app/`, so a
hard import of an optional dep would fail the smoke test wherever it is absent.

**Costs.** One embedding read per row (already stored), zero embedding calls
(rows without an embedding are skipped, not embedded — this is a reader), and
one cheap model call PER CLUSTER, capped. The refresh runs once a day on a
background thread; nothing on a request path ever computes.

**Honesty rules, each the inverse of a way a synthesizer lies.**

  1. **Noise is named, not hidden.** DBSCAN's -1 label is a real answer — "this
     row belongs to nothing" — so it becomes an `uncategorized` bucket with a
     count rather than being dropped. A synthesis that silently discards a third
     of the corpus reads as complete coverage of it.
  2. **A label is never invented over an empty pile.** If the model returns
     nothing usable, the cluster keeps a deterministic fallback name derived
     from its own representative item. It is never dropped, because dropping it
     would remove its rows from the picture too.
  3. **Caps are announced.** `MAX_ITEMS`, `MAX_CLUSTERS` and the per-cluster
     item cap all record what they cut into the snapshot (`truncated`,
     `total_clusters`, `item_count`), and the prompt block renders "+N more".
  4. **A stale snapshot says how old it is.** `built_at` rides in the blob and
     every reader can see it; nothing presents yesterday's synthesis as today's.
  5. **It writes nothing but its own cache.** No Trackable, no Promise, no Note,
     no Memory. Read-only over the corpus it summarizes.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..common import local_now
from ..db.models import Memory, Note, Promise, Settings
# The Note tag marking a thought-batch (a run of Claude's thinking, titled with
# its own label). Imported rather than restated so the two can't drift —
# focus_service owns the tag vocabulary. Module-level on purpose: a broken
# import must fail `tests/test_imports.py` at boot rather than hide inside a
# background loop's except (the 2026-08-11 feature-handler failure).
from .focus_service import BATCH_TAG

# ── corpus ───────────────────────────────────────────────────────────────────

# How far back thought-batches count. Memories and promises are deliberately
# NOT windowed: a memory is a standing fact about Daniel and an active promise
# is open until it isn't, while a thought-batch is a moment and a six-month-old
# one says nothing about what he is doing now.
THOUGHT_WINDOW_DAYS = 30

# Raw system-prompt dumps that got saved as memories (the first production run
# surfaced rows starting `{ "system": "Daniel's current intent:` …). They are
# not thoughts, and their JSON scaffolding pollutes the embedding space —
# every dump is near every other dump, so they seed a fake cluster and drag
# real rows toward it. Matched on the RAW content before `_clean`, since the
# JSON structure is exactly what identifies them. Filtered rows are COUNTED
# and logged, never silently dropped.
_PROMPT_DUMP_RE = re.compile(r'^\s*\{\s*"(?:system|messages|prompt|role)"\s*:')


def _is_prompt_dump(content: str | None) -> bool:
    return bool(content) and _PROMPT_DUMP_RE.match(content) is not None


# Hard ceiling on rows fed to the clusterer, newest-first per source. Pairwise
# cosine is O(n²), and the pure-Python path costs ~90µs a pair at 1536 dims —
# 1200 items is ~700k pairs, about a minute on a background thread and instant
# under numpy. Exceeding it is RECORDED (`truncated`), never silent.
MAX_ITEMS = 1200

# ── clustering ───────────────────────────────────────────────────────────────

# DBSCAN's neighbourhood radius in COSINE DISTANCE (1 - cosine similarity), so
# 0.30 means "similarity ≥ 0.70". That is deliberately looser than any matcher
# in this codebase (promise auto-close sits at 0.85) because those decide
# whether two texts mean the SAME thing and this decides whether they are about
# the same AREA OF LIFE — "mercor onsite thursday" and "grind system design"
# are not paraphrases and belong in one initiative. Shipped at 0.40 and
# tightened 2026-08-16 after the first production run: on a corpus dominated by
# one topic, 0.40 chained 552 of 982 rows into a single "Gooni development"
# mega-cluster via DBSCAN's transitive absorption. 0.30 asks for enough
# within-cluster coherence that sub-areas (focus sessions, orchestrator, UI)
# separate instead of bridging.
EPS = 0.30

# Minimum neighbours (INCLUDING the point itself) for a core point. 2 would make
# any coincidental pair an initiative; 3 asks for a little corroboration while
# staying reachable on a small corpus.
MIN_SAMPLES = 3

# Named clusters kept in the snapshot, ranked by size. The tail is counted, not
# dropped (see `total_clusters`).
MAX_CLUSTERS = 12

# Items shown to the labeler per cluster — the ones nearest the centroid, which
# is what "representative" means here.
LABEL_SAMPLE = 8

# Items retained per cluster in the snapshot. Enough for the graph to colour by
# and for a summary line; the full membership is re-derivable by re-running.
MAX_ITEMS_PER_CLUSTER = 40

# ── labeling ─────────────────────────────────────────────────────────────────

# Cheap by design: naming a pile you are shown is not a reasoning task, and the
# deterministic fallback catches a bad answer.
LABEL_MODEL = "gpt-5.4-mini"
MAX_LABEL_CHARS = 42
LABEL_ITEM_CHARS = 140

LABEL_PROMPT = """These items all come from one person's notes, memories and commitments. They were grouped together automatically because they are semantically related.

Items:
{items}

Name this life initiative in 2-4 words. Examples of the right shape: "Interview prep", "Gooni development", "Fitness routine", "Job search", "Apartment hunt".

Rules:
- 2-4 words, no punctuation, no quotes, no trailing period.
- Name what the items are ABOUT, not what they are ("Notes about work" is wrong).
- If the items have no coherent shared subject, answer exactly: NONE

Answer with the name only."""

# ── snapshot cache ───────────────────────────────────────────────────────────

# Local hour at or after which a new day's refresh is allowed. Morning, so the
# synthesis Daniel reads over coffee was built from everything through
# yesterday.
REFRESH_HOUR = 6

SNAPSHOT_VERSION = 1


# ═════════════════════════════════════════════════════════════════════════════
# Corpus
# ═════════════════════════════════════════════════════════════════════════════


class Item:
    """One clusterable row, flattened out of whichever primitive it came from.

    Deliberately not a dataclass over the ORM object: the clusterer must never
    be able to write, and downstream (the prompt block, the graph) only ever
    needs `type`/`id`/`text`.
    """

    __slots__ = ("type", "id", "text", "vec", "at")

    def __init__(self, type: str, id: int, text: str, vec: list[float], at=None):
        self.type = type
        self.id = id
        self.text = text
        self.vec = vec
        self.at = at

    def as_dict(self) -> dict:
        return {"type": self.type, "id": self.id, "text": self.text}


def _parse_vec(raw) -> list[float] | None:
    """Embeddings are stored as JSON text. A row whose vector is missing or
    unparseable is SKIPPED, never zero-filled — a zero vector is equidistant
    from everything and would drag unrelated clusters together."""
    if not raw:
        return None
    try:
        vec = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(vec, list) or not vec:
        return None
    try:
        return [float(x) for x in vec]
    except (TypeError, ValueError):
        return None


def _clean(text: str | None, limit: int = 240) -> str:
    """Flatten a row's text to one line. Notes carry HTML; memories and
    promises are plain, so this is a cheap strip rather than a parser."""
    if not text:
        return ""
    s = re.sub(r"<[^>]+>", " ", text)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def collect_items(db: Session) -> tuple[list[Item], bool]:
    """Load every embedded memory, recent thought-batch and active promise.

    Returns `(items, truncated)`. Each source is tuple-queried on
    `(…, embedding)` so the deferred embedding column is the only fat data
    pulled — the same reason memory_service retrieval does it that way.
    """
    items: list[Item] = []
    truncated = False

    # Memories — standing knowledge, no window. Active only: a superseded row
    # is a fact that stopped being true, and clustering it would keep a dead
    # initiative alive.
    rows = (
        db.query(Memory.id, Memory.content, Memory.updated_at, Memory.embedding)
        .filter(Memory.is_active.is_(True), Memory.embedding.isnot(None))
        .order_by(Memory.updated_at.desc())
        .limit(MAX_ITEMS)
        .all()
    )
    dumps_skipped = 0
    for mid, content, at, emb in rows:
        if _is_prompt_dump(content):
            dumps_skipped += 1
            continue
        vec = _parse_vec(emb)
        text = _clean(content)
        if vec and text:
            items.append(Item("memory", mid, text, vec, at))
    if dumps_skipped:
        print(f"[initiatives] skipped {dumps_skipped} prompt-dump memor(y/ies)")

    # Thought-batches — a run of Claude's thinking, `title` is its label. LIKE
    # against the JSON tags column is the documented pattern for low-cardinality
    # note subtypes (see focus_service._tagged).
    cutoff = datetime.utcnow() - timedelta(days=THOUGHT_WINDOW_DAYS)
    rows = (
        db.query(Note.id, Note.title, Note.excerpt, Note.created_at, Note.embedding)
        .filter(
            Note.tags.like(f'%"{BATCH_TAG}"%'),
            Note.created_at >= cutoff,
            Note.embedding.isnot(None),
        )
        .order_by(Note.created_at.desc())
        .limit(MAX_ITEMS)
        .all()
    )
    for nid, title, excerpt, at, emb in rows:
        vec = _parse_vec(emb)
        text = _clean(title) or _clean(excerpt)
        if vec and text:
            items.append(Item("thought", nid, text, vec, at))

    # Promises — active only. A kept or broken promise is history, and an
    # initiative is a claim about the present.
    rows = (
        db.query(
            Promise.id,
            Promise.summary,
            Promise.utterance,
            Promise.created_at,
            Promise.embedding,
        )
        .filter(Promise.state == "active", Promise.embedding.isnot(None))
        .order_by(Promise.created_at.desc())
        .limit(MAX_ITEMS)
        .all()
    )
    for pid, summary, utterance, at, emb in rows:
        vec = _parse_vec(emb)
        text = _clean(summary) or _clean(utterance)
        if vec and text:
            items.append(Item("promise", pid, text, vec, at))

    # Mixed dimensions cannot be compared. In practice everything embeds with
    # text-embedding-3-small, but a model swap would leave old rows behind, and
    # a silent cosine of 0.0 between two 1536-dim and 3072-dim vectors would
    # scatter them into noise with no explanation. Keep the majority dimension.
    if items:
        dims: dict[int, int] = {}
        for it in items:
            dims[len(it.vec)] = dims.get(len(it.vec), 0) + 1
        keep = max(dims, key=lambda d: dims[d])
        if len(dims) > 1:
            dropped = sum(n for d, n in dims.items() if d != keep)
            print(
                f"[initiatives] dropped {dropped} row(s) with off-dimension "
                f"embeddings (keeping dim={keep})"
            )
            items = [it for it in items if len(it.vec) == keep]

    if len(items) > MAX_ITEMS:
        # Newest-first across the merged corpus, so the cut costs the oldest
        # rows rather than a whole source. Recorded, never silent.
        items.sort(key=lambda i: (i.at or datetime.min), reverse=True)
        print(f"[initiatives] corpus capped at {MAX_ITEMS} (had {len(items)})")
        items = items[:MAX_ITEMS]
        truncated = True

    return items, truncated


# ═════════════════════════════════════════════════════════════════════════════
# Clustering — DBSCAN over cosine distance
# ═════════════════════════════════════════════════════════════════════════════


def _normalize(vecs: list[list[float]]) -> list[list[float]]:
    """Unit-length every vector once, so cosine similarity is a plain dot
    product for the rest of the run. OpenAI already returns unit vectors, but
    normalizing is cheap and makes the maths true rather than assumed."""
    out = []
    for v in vecs:
        n = math.sqrt(sum(x * x for x in v))
        out.append([x / n for x in v] if n else v)
    return out


def _neighbors_pure(vecs: list[list[float]], eps: float) -> list[list[int]]:
    """Pure-Python neighbourhood lists. O(n²) dot products over pre-normalized
    vectors, computed once per unordered pair."""
    n = len(vecs)
    neigh: list[list[int]] = [[i] for i in range(n)]
    thresh = 1.0 - eps  # cosine distance ≤ eps  ⇔  similarity ≥ 1 - eps
    for i in range(n):
        vi = vecs[i]
        for j in range(i + 1, n):
            vj = vecs[j]
            dot = 0.0
            for a, b in zip(vi, vj):
                dot += a * b
            if dot >= thresh:
                neigh[i].append(j)
                neigh[j].append(i)
    return neigh


def _neighbors_numpy(vecs: list[list[float]], eps: float):
    """numpy fast path. Same neighbourhoods, one matmul instead of n² loops.
    Returns None when numpy is absent so the caller falls back."""
    try:
        import numpy as np
    except ImportError:
        return None
    m = np.asarray(vecs, dtype=np.float64)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    m = m / norms
    sim = m @ m.T
    mask = sim >= (1.0 - eps)
    return [list(map(int, row.nonzero()[0])) for row in mask]


def dbscan(
    vecs: list[list[float]], eps: float = EPS, min_samples: int = MIN_SAMPLES
) -> list[int]:
    """DBSCAN over cosine distance. Returns one label per vector; -1 is noise.

    Textbook DBSCAN, matching `sklearn.cluster.DBSCAN(metric="cosine")`:
    a point with ≥ `min_samples` neighbours within `eps` (itself included) is
    a CORE point and seeds a cluster; its neighbourhood is absorbed, and any
    absorbed point that is itself core expands the frontier. A non-core point
    reachable from a core one joins as a border point; everything else is
    noise. Implemented here rather than imported because sklearn+numpy is a
    ~100MB image on a machine with a documented OOM history — see the module
    docstring. numpy alone, if present, is used for the distance matrix.
    """
    n = len(vecs)
    if n == 0:
        return []
    if min_samples <= 1:
        min_samples = 2

    normed = _normalize(vecs)
    neigh = _neighbors_numpy(normed, eps)
    if neigh is None:
        neigh = _neighbors_pure(normed, eps)

    labels = [-1] * n
    cluster = 0
    for i in range(n):
        if labels[i] != -1:
            continue  # already assigned
        if len(neigh[i]) < min_samples:
            continue  # not a core point — may still be claimed as a border
        labels[i] = cluster
        # BFS over the reachable core frontier. A list-as-queue is fine: each
        # index enters at most once (guarded by its label).
        queue = [j for j in neigh[i] if j != i]
        qi = 0
        while qi < len(queue):
            j = queue[qi]
            qi += 1
            if labels[j] != -1:
                continue
            labels[j] = cluster
            if len(neigh[j]) >= min_samples:
                queue.extend(k for k in neigh[j] if labels[k] == -1)
        cluster += 1
    return labels


def _centroid(vecs: list[list[float]]) -> list[float]:
    dim = len(vecs[0])
    acc = [0.0] * dim
    for v in vecs:
        for i, x in enumerate(v):
            acc[i] += x
    return [x / len(vecs) for x in acc]


def _rank_by_centroid(items: list[Item]) -> list[Item]:
    """Cluster members ordered by closeness to the centroid — "representative"
    is defined here and nowhere else, so the labeler's sample and the snapshot's
    retained items are drawn from the same ordering."""
    if len(items) <= 2:
        return list(items)
    normed = _normalize([i.vec for i in items])
    c = _centroid(normed)
    cn = math.sqrt(sum(x * x for x in c)) or 1.0
    scored = []
    for it, v in zip(items, normed):
        scored.append((sum(a * b for a, b in zip(v, c)) / cn, it))
    scored.sort(key=lambda p: -p[0])
    return [it for _, it in scored]


# ═════════════════════════════════════════════════════════════════════════════
# Labeling
# ═════════════════════════════════════════════════════════════════════════════


def _fallback_label(items: list[Item]) -> str:
    """Deterministic name from the most representative item, used when the
    model declines or fails. A cluster is NEVER dropped for want of a label —
    dropping it would take its rows out of the picture too, which is the one
    thing a synthesizer must not do quietly."""
    head = _clean(items[0].text, 40) if items else ""
    return head or "unnamed"


def label_cluster(items: list[Item], llm=None) -> str:
    """One cheap model call naming the cluster it is shown.

    `llm` is injectable so tests exercise the real path without a network call.
    Every failure mode — exception, empty answer, an explicit NONE, a model
    that ignored the format and wrote a paragraph — lands on the deterministic
    fallback rather than on a fabricated theme.
    """
    if llm is None:
        from ..llm.client import llm_client as llm

    sample = items[:LABEL_SAMPLE]
    rendered = "\n".join(f"- {_clean(i.text, LABEL_ITEM_CHARS)}" for i in sample)
    try:
        raw = llm.generate_simple_completion(
            LABEL_PROMPT.format(items=rendered),
            max_tokens=24,
            temperature=0.0,
            model=LABEL_MODEL,
        )
    except Exception as e:
        print(f"[initiatives] label call failed: {e}")
        return _fallback_label(items)

    name = (raw or "").strip().strip('"').strip("'").rstrip(".")
    name = re.sub(r"\s+", " ", name)
    if not name or name.upper() == "NONE":
        return _fallback_label(items)
    # A model that wrote a sentence instead of a name has not answered the
    # question; the fallback is more honest than a truncated paragraph.
    if len(name) > MAX_LABEL_CHARS or len(name.split()) > 6:
        return _fallback_label(items)
    return name


def _summary_line(items: list[Item]) -> str:
    """One line under the label, built from the cluster's own representative
    items. Deterministic on purpose — it is a sample of what is IN the
    initiative, not a second synthesis that could contradict the first."""
    bits: list[str] = []
    used = 0
    for it in items[:4]:
        t = _clean(it.text, 60)
        if not t:
            continue
        if used + len(t) > 150:
            break
        bits.append(t)
        used += len(t)
    return " · ".join(bits)


# ═════════════════════════════════════════════════════════════════════════════
# Build
# ═════════════════════════════════════════════════════════════════════════════


def build(db: Session, llm=None) -> dict:
    """Cluster the corpus, label each cluster, return the snapshot dict.

    Pure compute + one model call per cluster. Does NOT write — `refresh()`
    owns persistence, so a caller can inspect a build without replacing the
    cached one.
    """
    items, truncated = collect_items(db)
    now = datetime.now(timezone.utc)
    if not items:
        return {
            "version": SNAPSHOT_VERSION,
            "built_at": now.isoformat(),
            "item_count": 0,
            "clusters": [],
            "uncategorized": {"count": 0, "items": []},
            "total_clusters": 0,
            "truncated": truncated,
        }

    labels = dbscan([i.vec for i in items])

    grouped: dict[int, list[Item]] = {}
    noise: list[Item] = []
    for it, lab in zip(items, labels):
        if lab < 0:
            noise.append(it)
        else:
            grouped.setdefault(lab, []).append(it)

    # Rank clusters by size — the biggest pile is the most of Daniel's life
    # this corpus is about. Ties break on label-stability grounds (lowest
    # DBSCAN id) so the same corpus renders in the same order twice.
    ordered = sorted(grouped.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    total_clusters = len(ordered)

    clusters = []
    for _, members in ordered[:MAX_CLUSTERS]:
        ranked = _rank_by_centroid(members)
        label = label_cluster(ranked, llm=llm)
        kept = ranked[:MAX_ITEMS_PER_CLUSTER]
        by_type: dict[str, int] = {}
        for it in members:
            by_type[it.type] = by_type.get(it.type, 0) + 1
        clusters.append(
            {
                "label": label,
                "size": len(members),
                "summary": _summary_line(ranked),
                "by_type": by_type,
                "items": [i.as_dict() for i in kept],
                # The centroid the cluster was named over, kept so a future
                # reader can ask "which initiative is this new row nearest?"
                # without re-running the whole build. Rounded to 4dp: full
                # float64 precision on 1536 dims is ~35KB per cluster, and this
                # blob lives on the singleton Settings row (which is why the
                # column is `deferred` — see the model). 4dp is far below the
                # noise floor of any cosine comparison this would feed.
                "representative_embedding": [
                    round(x, 4) for x in _centroid(_normalize([i.vec for i in ranked]))
                ],
            }
        )

    return {
        "version": SNAPSHOT_VERSION,
        "built_at": now.isoformat(),
        "item_count": len(items),
        "clusters": clusters,
        "uncategorized": {
            "count": len(noise),
            "items": [i.as_dict() for i in noise[:MAX_ITEMS_PER_CLUSTER]],
        },
        "total_clusters": total_clusters,
        "truncated": truncated,
    }


# ═════════════════════════════════════════════════════════════════════════════
# Cache — Settings.initiatives
# ═════════════════════════════════════════════════════════════════════════════
#
# A Text JSON blob on the singleton Settings row, exactly like `focus_cam` and
# `display`: one current snapshot, no history, shape free to grow without a
# migration. NOT a module-level dict — Fly suspends and restarts machines, and a
# once-a-day job whose cache dies with the process would leave the prompt block
# and the graph empty for most of the day. NOT a table either: unlike
# ProactiveObservation there is nothing to dismiss, no per-row lifecycle and no
# tuning question that needs a week of history — the snapshot IS the state.


def _settings_row(db: Session) -> Settings:
    row = db.query(Settings).first()
    if row is None:
        row = Settings(id=1)
        db.add(row)
        db.flush()
    return row


def get_snapshot(db: Session) -> dict | None:
    """The cached snapshot, or None if there has never been one.

    Read-only and cheap by contract: this NEVER builds. Every reader (the
    prompt block on a chat turn, `GET /initiatives`, the graph) is on a request
    path, and building means N model calls — the refresh loop owns that.
    """
    row = db.query(Settings).first()
    if not row or not row.initiatives:
        return None
    try:
        snap = json.loads(row.initiatives)
    except (TypeError, ValueError):
        return None
    return snap if isinstance(snap, dict) else None


def _store(db: Session, snapshot: dict) -> None:
    row = _settings_row(db)
    row.initiatives = json.dumps(snapshot)
    db.commit()


def refresh(db: Session, llm=None) -> dict:
    """Build and cache. The one writer."""
    snapshot = build(db, llm=llm)
    _store(db, snapshot)
    print(
        f"[initiatives] refreshed: {len(snapshot['clusters'])} initiative(s) "
        f"over {snapshot['item_count']} item(s), "
        f"{snapshot['uncategorized']['count']} uncategorized",
        flush=True,
    )
    return snapshot


def _built_local_day(db: Session, snapshot: dict):
    """The LOCAL calendar day a snapshot was built on, or None if unreadable.

    Local, not UTC: "has today's refresh run" is a question about Daniel's day,
    and after ~5pm PT the UTC date has already rolled — the exact trap
    `common.local_today` exists for.
    """
    raw = snapshot.get("built_at")
    if not raw:
        return None
    try:
        built = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if built.tzinfo is None:
        built = built.replace(tzinfo=timezone.utc)
    return built.astimezone(local_now(db).tzinfo).date()


def is_stale(db: Session, snapshot: dict | None = None) -> bool:
    """Should the loop rebuild right now?

    Two gates, and the hour one matters: without it a machine that boots at
    00:05 rebuilds immediately, so "the daily synthesis" would routinely be
    built from a day that is five minutes old. With it, the first tick at or
    after `REFRESH_HOUR` on a new local day does the work — which also covers
    the "first request after midnight" case without putting a build on a
    request path.
    """
    if snapshot is None:
        snapshot = get_snapshot(db)
    if not snapshot:
        return True  # never built — do it on the next tick, whatever the hour
    now = local_now(db)
    built_day = _built_local_day(db, snapshot)
    if built_day is None:
        return True
    return built_day < now.date() and now.hour >= REFRESH_HOUR


def refresh_if_stale(db: Session, llm=None) -> dict | None:
    """The background loop's entry point. Returns the new snapshot, or None
    when nothing was due — the steady state."""
    if not is_stale(db):
        return None
    return refresh(db, llm=llm)


# ═════════════════════════════════════════════════════════════════════════════
# Serialization
# ═════════════════════════════════════════════════════════════════════════════

# The centroid is build-internal: ~1500 floats per cluster is ~15KB of JSON
# each, and no client renders it. `GET /initiatives` drops it by default and
# serves it only on request.


def serialize(snapshot: dict | None, include_embeddings: bool = False) -> dict:
    """Snapshot → API shape. A missing snapshot serializes to an EMPTY one with
    `built_at: null` rather than a 404 or an error: "nothing has been
    synthesized yet" is a real, renderable state, and every client already has
    to handle zero initiatives."""
    if not snapshot:
        return {
            "built_at": None,
            "item_count": 0,
            "clusters": [],
            "uncategorized": {"count": 0, "items": []},
            "total_clusters": 0,
            "truncated": False,
        }
    clusters = []
    for c in snapshot.get("clusters") or []:
        out = {k: v for k, v in c.items() if k != "representative_embedding"}
        if include_embeddings and "representative_embedding" in c:
            out["representative_embedding"] = c["representative_embedding"]
        clusters.append(out)
    return {
        "built_at": snapshot.get("built_at"),
        "item_count": snapshot.get("item_count", 0),
        "clusters": clusters,
        "uncategorized": snapshot.get("uncategorized") or {"count": 0, "items": []},
        "total_clusters": snapshot.get("total_clusters", len(clusters)),
        "truncated": bool(snapshot.get("truncated")),
    }
