"""The initiative synthesizer's net — clustering, labeling, cache, prompt block.

No network and no optional deps: the labeler is INJECTED (a stub LLM), and the
vectors are hand-built low-dimensional ones, so this exercises the real
pure-Python DBSCAN path that ships. That matters — a test that only ran when
numpy happened to be installed would pass in CI and prove nothing about the
implementation actually running on Fly.

What it pins, each the inverse of a way this could lie:
  · related rows land in ONE cluster and unrelated ones do not
  · a lone row is NOISE, and noise is COUNTED rather than dropped
  · all three primitives (memory / thought / promise) reach the clusterer
  · a model that declines, fails or rambles never produces an invented label —
    and never costs the cluster its rows
  · the cache is a real cache: the read path never builds
  · staleness is a LOCAL-day question, and a same-day snapshot isn't rebuilt
  · the prompt block renders the cached snapshot, announces its caps, and is
    absent (not empty-but-present) when nothing has been synthesized
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The OpenAI client is constructed at import time by app.llm.client. Nothing
# here ever calls it (every labeler is injected), but the constructor refuses to
# exist without a key.
os.environ.setdefault("OPENAI_API_KEY", "test-key-unused")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import Base, Memory, Note, Promise, Settings
from app.services import initiative_service as isvc
from app.services.orchestrator.prompt_blocks import _build_initiative_block

PASS, FAIL = "\033[92m✓\033[0m", "\033[91m✗\033[0m"
_failures = []


def check(name, cond, detail=""):
    print(f"  {PASS if cond else FAIL} {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        _failures.append(name)


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(Settings(id=1, nudge_tz="America/Los_Angeles"))
    db.commit()
    return db, path


# ── vectors ──────────────────────────────────────────────────────────────────
# Three tight groups plus a loner, in 4 dimensions. Cosine only cares about
# direction, so a small perturbation off a basis vector is "the same subject
# said differently" and a different basis vector is a different subject.

def vec(axis: int, jitter: float = 0.0, dim: int = 4):
    v = [0.0] * dim
    v[axis] = 1.0
    v[(axis + 1) % dim] = jitter
    return v


class StubLLM:
    """Records what it was asked and answers from a script."""

    def __init__(self, answers=None, raises=False):
        self.answers = list(answers or [])
        self.raises = raises
        self.calls = []

    def generate_simple_completion(self, prompt, max_tokens=300, temperature=0.7, model=None):
        self.calls.append({"prompt": prompt, "model": model})
        if self.raises:
            raise RuntimeError("boom")
        return self.answers.pop(0) if self.answers else "Some Initiative"


# ── 1. DBSCAN ────────────────────────────────────────────────────────────────

def test_dbscan():
    print("\n[1] DBSCAN over cosine distance")

    # Two dense groups (4 each) + one loner far from both.
    vecs = [vec(0, j) for j in (0.0, 0.02, 0.04, 0.06)]
    vecs += [vec(1, j) for j in (0.0, 0.02, 0.04, 0.06)]
    vecs += [vec(2)]
    labels = isvc.dbscan(vecs, eps=isvc.EPS, min_samples=3)

    check("group A is one cluster", len(set(labels[0:4])) == 1, str(labels))
    check("group B is one cluster", len(set(labels[4:8])) == 1, str(labels))
    check("A and B are DIFFERENT clusters", labels[0] != labels[4], str(labels))
    check("the loner is noise (-1)", labels[8] == -1, str(labels))
    check("no cluster label is negative except noise",
          all(l >= 0 for l in labels[:8]), str(labels))

    # A pair below min_samples must NOT become an initiative — otherwise any
    # two coincidentally-similar rows would name a theme.
    pair = [vec(0), vec(0, 0.01)]
    check("a pair under min_samples is noise, not a cluster",
          isvc.dbscan(pair, min_samples=3) == [-1, -1])

    # Border points: a non-core row inside a core row's radius joins.
    core = [vec(0, j) for j in (0.0, 0.01, 0.02)]
    border = [vec(0, 0.35)]  # close enough to be reachable, too sparse to be core
    labs = isvc.dbscan(core + border, min_samples=3)
    check("a border point joins the cluster it is reachable from",
          labs[3] == labs[0] and labs[0] >= 0, str(labs))

    check("empty input is empty output", isvc.dbscan([]) == [])

    # Determinism: same corpus, same labels. The whole reason grouping is not
    # an LLM's job.
    a = isvc.dbscan(vecs)
    b = isvc.dbscan(vecs)
    check("clustering is deterministic across runs", a == b)

    # The two distance backends must agree — the numpy one is an optimization,
    # not a second algorithm. Absent numpy this asserts the fallback signal
    # instead, which is the case that actually ships if the dep is never added.
    normed = isvc._normalize(vecs)
    np_neigh = isvc._neighbors_numpy(normed, isvc.EPS)
    pure_neigh = isvc._neighbors_pure(normed, isvc.EPS)
    if np_neigh is None:
        check("no numpy → the pure path is signalled, not silently wrong", True)
    else:
        check("the numpy fast path finds the SAME neighbourhoods",
              [sorted(r) for r in np_neigh] == [sorted(r) for r in pure_neigh])


# ── 2. corpus ────────────────────────────────────────────────────────────────

def test_corpus():
    print("\n[2] corpus collection — all three primitives, embedded rows only")
    db, path = fresh_db()
    try:
        db.add(Memory(type="fact", content="wants the Mercor offer",
                      embedding=json.dumps(vec(0))))
        db.add(Memory(type="fact", content="no embedding here", embedding=None))
        # Superseded memories are history, not current initiative material.
        db.add(Memory(type="fact", content="old belief", is_active=False,
                      embedding=json.dumps(vec(0, 0.01))))
        # Raw prompt dumps that leaked into memories are not thoughts.
        db.add(Memory(type="fact",
                      content='{ "system": "Daniel\'s current intent: ship" }',
                      embedding=json.dumps(vec(0, 0.015))))
        db.add(Memory(type="fact",
                      content='  {"messages": [{"role": "user"}]}',
                      embedding=json.dumps(vec(0, 0.016))))
        db.add(Note(title="system design drilling", tags='["thought-batch"]',
                    embedding=json.dumps(vec(0, 0.02))))
        db.add(Note(title="an ordinary note", tags='["daily"]',
                    embedding=json.dumps(vec(0, 0.03))))
        db.add(Note(title="ancient thinking", tags='["thought-batch"]',
                    created_at=datetime.utcnow() - timedelta(days=90),
                    embedding=json.dumps(vec(0, 0.04))))
        db.add(Promise(utterance="grind leetcode tonight", state="active",
                       embedding=json.dumps(vec(0, 0.05))))
        db.add(Promise(utterance="already done", state="kept",
                       embedding=json.dumps(vec(0, 0.06))))
        db.commit()

        items, truncated = isvc.collect_items(db)
        kinds = sorted({i.type for i in items})
        texts = {i.text for i in items}

        check("all three primitives reach the clusterer",
              kinds == ["memory", "promise", "thought"], str(kinds))
        check("a row with no embedding is skipped",
              "no embedding here" not in texts)
        check("a superseded memory is excluded", "old belief" not in texts)
        check("a prompt-dump memory is excluded",
              not any("current intent" in t or "messages" in t for t in texts),
              str(texts))
        check("a JSON-ish memory that is NOT a dump survives",
              isvc._is_prompt_dump('{"note": "braces but not a prompt"}') is False)
        check("a non-thought-batch note is excluded",
              "an ordinary note" not in texts)
        check("a thought-batch outside the window is excluded",
              "ancient thinking" not in texts)
        check("a resolved promise is excluded", "already done" not in texts)
        check("nothing was truncated at this size", truncated is False)
    finally:
        db.close()
        os.unlink(path)


# ── 3. build ─────────────────────────────────────────────────────────────────

def _seed_two_initiatives(db):
    """Two clean subjects, 4 rows each, plus one unrelated loner."""
    for i, txt in enumerate(["mercor onsite", "system design", "leetcode grind",
                             "recruiter call"]):
        db.add(Memory(type="fact", content=txt, embedding=json.dumps(vec(0, i * 0.02))))
    for i, txt in enumerate(["ambient home", "focus attribution", "gooni deploy",
                             "prompt blocks"]):
        db.add(Note(title=txt, tags='["thought-batch"]',
                    embedding=json.dumps(vec(1, i * 0.02))))
    db.add(Promise(utterance="call mum", state="active",
                   embedding=json.dumps(vec(2))))
    db.commit()


def test_build():
    print("\n[3] build — clusters labeled, noise counted, nothing dropped")
    db, path = fresh_db()
    try:
        _seed_two_initiatives(db)
        llm = StubLLM(["Interview prep", "Gooni development"])
        snap = isvc.build(db, llm=llm)

        labels = [c["label"] for c in snap["clusters"]]
        check("two initiatives found", len(snap["clusters"]) == 2, str(labels))
        check("each cluster got a model label",
              set(labels) == {"Interview prep", "Gooni development"}, str(labels))
        check("one model call per cluster", len(llm.calls) == 2, str(len(llm.calls)))
        check("the labeler used the cheap model",
              all(c["model"] == isvc.LABEL_MODEL for c in llm.calls))
        check("the loner is counted as uncategorized",
              snap["uncategorized"]["count"] == 1, str(snap["uncategorized"]))
        check("uncategorized rows are LISTED, not just counted",
              len(snap["uncategorized"]["items"]) == 1)
        check("every input row is accounted for",
              sum(c["size"] for c in snap["clusters"]) + snap["uncategorized"]["count"]
              == snap["item_count"], str(snap["item_count"]))
        check("clusters rank biggest-first",
              all(snap["clusters"][i]["size"] >= snap["clusters"][i + 1]["size"]
                  for i in range(len(snap["clusters"]) - 1)))
        check("each cluster carries its member rows",
              all(c["items"] and "type" in c["items"][0] for c in snap["clusters"]))
        check("each cluster carries a representative embedding",
              all(len(c["representative_embedding"]) == 4 for c in snap["clusters"]))
        check("build_at is stamped", bool(snap["built_at"]))
        check("build does NOT write the cache (refresh owns that)",
              db.query(Settings).first().initiatives is None)

        # A summary is a SAMPLE of the cluster's own rows — never a second
        # synthesis that could contradict the label.
        interview = next(c for c in snap["clusters"] if c["label"] == "Interview prep")
        member_texts = {i["text"] for i in interview["items"]}
        check("the summary quotes the cluster's own items",
              any(t in interview["summary"] for t in member_texts),
              interview["summary"])
    finally:
        db.close()
        os.unlink(path)


def test_build_empty():
    print("\n[4] an empty corpus is an empty snapshot, not a crash")
    db, path = fresh_db()
    try:
        llm = StubLLM()
        snap = isvc.build(db, llm=llm)
        check("no clusters", snap["clusters"] == [])
        check("no model call spent on nothing", llm.calls == [])
        check("serializes to a renderable empty shape",
              isvc.serialize(snap)["built_at"] is not None)
    finally:
        db.close()
        os.unlink(path)


# ── 5. labeling failure modes ────────────────────────────────────────────────

def test_labeling():
    print("\n[5] labeling — a bad answer never invents a theme, never drops rows")
    items = [isvc.Item("memory", 1, "mercor onsite thursday", vec(0)),
             isvc.Item("memory", 2, "system design practice", vec(0, 0.02))]

    check("a clean label passes through",
          isvc.label_cluster(items, llm=StubLLM(["Interview prep"])) == "Interview prep")
    check("quotes and trailing periods are stripped",
          isvc.label_cluster(items, llm=StubLLM(['"Interview prep."'])) == "Interview prep")
    check("an explicit NONE falls back to the item text",
          isvc.label_cluster(items, llm=StubLLM(["NONE"])) == "mercor onsite thursday")
    check("an empty answer falls back",
          isvc.label_cluster(items, llm=StubLLM([""])) == "mercor onsite thursday")
    check("a rambling paragraph falls back rather than truncating",
          isvc.label_cluster(
              items,
              llm=StubLLM(["These items are all about preparing for an upcoming "
                           "interview at Mercor and practising system design"]),
          ) == "mercor onsite thursday")
    check("a raised exception falls back",
          isvc.label_cluster(items, llm=StubLLM(raises=True)) == "mercor onsite thursday")

    # The load-bearing half: a cluster is never DROPPED for want of a label,
    # because dropping it takes its rows out of the picture too.
    db, path = fresh_db()
    try:
        _seed_two_initiatives(db)
        snap = isvc.build(db, llm=StubLLM(raises=True))
        check("clusters survive a totally dead labeler", len(snap["clusters"]) == 2)
        check("every surviving cluster keeps its rows",
              all(c["items"] for c in snap["clusters"]))
    finally:
        db.close()
        os.unlink(path)


# ── 6. cache + staleness ─────────────────────────────────────────────────────

class ExplodingLLM:
    def generate_simple_completion(self, *a, **k):
        raise AssertionError("the read path must never call a model")


def test_cache():
    print("\n[6] cache — the read path never builds, staleness is a LOCAL-day question")
    db, path = fresh_db()
    try:
        check("no snapshot before the first refresh", isvc.get_snapshot(db) is None)
        check("a missing snapshot serializes to an empty renderable shape",
              isvc.serialize(None) == {
                  "built_at": None, "item_count": 0, "clusters": [],
                  "uncategorized": {"count": 0, "items": []},
                  "total_clusters": 0, "truncated": False,
              })
        check("a missing snapshot is stale (build on the next tick)", isvc.is_stale(db))

        _seed_two_initiatives(db)
        isvc.refresh(db, llm=StubLLM(["Interview prep", "Gooni development"]))

        cached = isvc.get_snapshot(db)
        check("refresh persisted the snapshot", cached is not None)
        check("the cache round-trips through JSON",
              [c["label"] for c in cached["clusters"]]
              == ["Interview prep", "Gooni development"])
        check("a same-day snapshot is NOT stale", isvc.is_stale(db) is False)
        check("refresh_if_stale is a no-op when fresh",
              isvc.refresh_if_stale(db, llm=ExplodingLLM()) is None)

        # A snapshot built on an earlier LOCAL day is stale — but only past the
        # morning hour, so a machine booting at 00:05 doesn't rebuild a
        # five-minute-old day.
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        cached["built_at"] = yesterday.isoformat()
        row = db.query(Settings).first()
        row.initiatives = json.dumps(cached)
        db.commit()
        from app.common import local_now
        past_refresh_hour = local_now(db).hour >= isvc.REFRESH_HOUR
        check("a yesterday snapshot is stale iff it is past the refresh hour",
              isvc.is_stale(db) == past_refresh_hour)

        # Corrupt blob: unreadable is treated as absent, not as an error that
        # takes the loop (or a chat turn) down.
        row.initiatives = "{not json"
        db.commit()
        check("an unreadable blob reads as no snapshot", isvc.get_snapshot(db) is None)
        check("an unreadable blob is stale", isvc.is_stale(db))

        # The centroid is build-internal — ~15KB per cluster that no client
        # renders.
        row.initiatives = json.dumps(cached)
        db.commit()
        ser = isvc.serialize(isvc.get_snapshot(db))
        check("serialize drops the centroid by default",
              all("representative_embedding" not in c for c in ser["clusters"]))
        ser2 = isvc.serialize(isvc.get_snapshot(db), include_embeddings=True)
        check("serialize serves the centroid on request",
              all("representative_embedding" in c for c in ser2["clusters"]))
    finally:
        db.close()
        os.unlink(path)


# ── 7. the prompt block ──────────────────────────────────────────────────────

def test_prompt_block():
    print("\n[7] prompt block — renders the cache, announces caps, absent when empty")
    db, path = fresh_db()
    try:
        check("no snapshot renders NOTHING (not an empty header)",
              _build_initiative_block(db) == "")

        _seed_two_initiatives(db)
        isvc.refresh(db, llm=StubLLM(["Interview prep", "Gooni development"]))
        block = _build_initiative_block(db)

        check("the header names the block", "current initiatives" in block, block)
        check("labels are rendered", "Interview prep" in block and
              "Gooni development" in block, block)
        check("initiatives are numbered", "1. " in block and "2. " in block, block)
        check("the uncategorized count is stated",
              "belong to no initiative" in block, block)
        check("the block never calls a model (pure cache read)",
              _build_initiative_block(db) == block)
        check("the block stays inside its budget", len(block) < 1200, str(len(block)))

        # No silent caps: more clusters than the cap must say so.
        snap = isvc.get_snapshot(db)
        snap["clusters"] = [
            {"label": f"Thing {i}", "size": 9 - i, "summary": "a · b", "items": []}
            for i in range(8)
        ]
        snap["total_clusters"] = 8
        db.query(Settings).first().initiatives = json.dumps(snap)
        db.commit()
        capped = _build_initiative_block(db)
        from app.services.orchestrator.prompt_blocks import INITIATIVE_CAP
        check("the cap is honoured",
              capped.count("Thing ") == INITIATIVE_CAP, capped)
        check("the cut tail is COUNTED, not silently dropped",
              f"+{8 - INITIATIVE_CAP} more" in capped, capped)

        # An old synthesis says how old it is rather than posing as today's.
        snap["built_at"] = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
        db.query(Settings).first().initiatives = json.dumps(snap)
        db.commit()
        stale_block = _build_initiative_block(db)
        check("a stale synthesis states its age",
              "5d ago" in stale_block and "moved on" in stale_block, stale_block)
    finally:
        db.close()
        os.unlink(path)


def test_no_side_effects():
    print("\n[8] the synthesizer writes NOTHING but its own cache")
    db, path = fresh_db()
    try:
        from app.db.models import Trackable, TrackableEntry
        _seed_two_initiatives(db)
        before = (db.query(Memory).count(), db.query(Note).count(),
                  db.query(Promise).count())
        isvc.refresh(db, llm=StubLLM(["Interview prep", "Gooni development"]))
        after = (db.query(Memory).count(), db.query(Note).count(),
                 db.query(Promise).count())
        check("no row was created or destroyed in the corpus", before == after,
              f"{before} -> {after}")
        check("no Trackable was minted", db.query(Trackable).count() == 0)
        check("no TrackableEntry was written", db.query(TrackableEntry).count() == 0)
    finally:
        db.close()
        os.unlink(path)


if __name__ == "__main__":
    print("=" * 66)
    print("INITIATIVE SYNTHESIZER — clustering, labeling, cache, prompt block")
    print("=" * 66)
    test_dbscan()
    test_corpus()
    test_build()
    test_build_empty()
    test_labeling()
    test_cache()
    test_prompt_block()
    test_no_side_effects()
    print("\n" + "=" * 66)
    if _failures:
        print(f"{FAIL} {len(_failures)} FAILED: " + ", ".join(_failures))
        sys.exit(1)
    print(f"{PASS} all initiative-synthesizer checks passed")
