"""Regression net for the CHAT-SIDE AUTO-CLOSE bar (`find_active_match`).

Born from the loose-match bug: closure fired at cosine ≥ 0.60, which on
text-embedding-3-small is the *loosely related* band, not the paraphrase
band — "went to the store" lands there against "go to the gym". The router
runs BEFORE the model sees the turn, and `patchPromiseState` has no UI
caller, so a wrong flip is a silent lie in the record with no undo path.
The bar is now `CLOSE_MATCH_THRESHOLD` (0.85, the same "this is the same
commitment" bar create-dedup uses) and a near miss is ASKED about rather
than either acted on or silently dropped.

No LLM, no network: `promise_service._embed` is stubbed to a fixed unit
vector and each promise's stored embedding is hand-built to sit at an
exact cosine from it, so every case names the score it is testing.

Usage:
  source venv/bin/activate
  python tests/test_promise_match_threshold.py
"""

import json
import math
import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_ROOT, ".env"))
except Exception:
    pass

# Throwaway DB BEFORE importing app db modules.
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
# The OpenAI client is constructed at import time and refuses to exist
# without a key. Nothing here calls it — the one embed is stubbed below —
# so a placeholder keeps the net runnable on a machine with no .env.
os.environ.setdefault("OPENAI_API_KEY", "test-key-unused")

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, Conversation, Message, Promise  # noqa: E402
from app.services import intent_router, promise_service  # noqa: E402
from app.services.orchestrator.prompt_blocks import _build_ack  # noqa: E402

Base.metadata.create_all(bind=engine)

# The query vector every stubbed embed returns. Promise embeddings are then
# built as [c, sqrt(1-c²), 0], which sits at EXACTLY cosine c from it.
_QUERY_VEC = [1.0, 0.0, 0.0]
promise_service._embed = lambda text: list(_QUERY_VEC)  # type: ignore[assignment]


def _emb_at(c: float) -> str:
    return json.dumps([c, math.sqrt(max(0.0, 1.0 - c * c)), 0.0])


def _empty_signals() -> dict:
    return {
        "tone_corrections": [],
        "feature_requests": [],
        "promises": [],
        "reply_intent": "acknowledge",
        "memories": [],
    }


def main() -> int:
    db = SessionLocal()
    fails: list[str] = []

    conv = Conversation(source="web")
    db.add(conv)
    db.commit()

    msg = Message(conversation_id=conv.id, role="user", content="all done")
    db.add(msg)
    db.commit()
    db.refresh(msg)

    def _reset(*rows: tuple[str, float]) -> list[Promise]:
        """Fresh active promises, each at a named cosine from the query."""
        db.query(Promise).delete()
        db.commit()
        made = []
        for text, score in rows:
            p = Promise(utterance=text, summary=text, state="active",
                        cadence="once", embedding=_emb_at(score))
            db.add(p)
            made.append(p)
        db.commit()
        for p in made:
            db.refresh(p)
        return made

    def _complete(match: str):
        """Route a `complete` emit exactly the way a chat turn does."""
        sig = _empty_signals()
        sig["promises"] = [{
            "kind": "complete", "match": match, "utterance": None,
            "summary": None, "cadence": "once", "cadence_target": None,
            "due_date": None, "due_hint": None, "is_important": False,
            "parent_hint": None,
        }]
        routed = intent_router.dispatch(
            {**sig, "memories": []},
            intent_router.RouterContext(db=db, source_message_id=msg.id),
        )
        db.expire_all()
        return routed

    # The match phrase shares no substring and no content word with any
    # promise text below, so every case lands in tier 3 (cosine) — the tier
    # the bar governs. Tiers 1 and 2 are deliberately untouched by this fix.
    MATCH = "wrapped up the errand"

    # (a) THE BUG: a loosely-related utterance at 0.72 used to auto-close.
    #     Now nothing moves, and the near miss is surfaced as a question.
    gym, = _reset(("go to the gym", 0.72))
    routed = _complete(MATCH)
    gym = db.query(Promise).filter(Promise.id == gym.id).first()
    if gym.state != "active":
        fails.append(f"near miss: promise auto-closed at 0.72, state={gym.state}")
    if routed.completed_promises:
        fails.append("near miss: routed.completed_promises should be empty")
    cands = (routed.failed_promise_actions or [{}])[0].get("candidates") or []
    if len(cands) != 1 or not cands[0].get("near_miss"):
        fails.append(f"near miss: expected 1 near_miss candidate, got {cands}")
    ack = _build_ack(routed) or ""
    if "no match" in ack or "not certain enough" not in ack:
        fails.append(f"near miss: ack should ask, not claim a miss — {ack!r}")
    print(f"[a] state={gym.state} cands={len(cands)} ack={ack!r}")

    # (b) A real paraphrase at 0.90 still closes automatically — the feature
    #     is valuable when the match is strong; only the bar moved.
    gym, = _reset(("go to the gym", 0.90))
    routed = _complete(MATCH)
    gym = db.query(Promise).filter(Promise.id == gym.id).first()
    if gym.state != "kept":
        fails.append(f"confident: expected kept at 0.90, got {gym.state}")
    if not routed.completed_promises:
        fails.append("confident: routed.completed_promises empty")
    print(f"[b] state={gym.state}")

    # (c) The bar itself: 0.84 holds, 0.85 acts. Pinned so a future tweak is
    #     a deliberate edit and not a silent drift.
    if promise_service.CLOSE_MATCH_THRESHOLD != 0.85:
        fails.append(
            f"bar: CLOSE_MATCH_THRESHOLD moved to "
            f"{promise_service.CLOSE_MATCH_THRESHOLD} — intentional?"
        )
    for score, want in ((0.84, "active"), (0.85, "kept")):
        p, = _reset(("go to the gym", score))
        _complete(MATCH)
        p = db.query(Promise).filter(Promise.id == p.id).first()
        if p.state != want:
            fails.append(f"bar: {score} → expected {want}, got {p.state}")
    print(f"[c] bar={promise_service.CLOSE_MATCH_THRESHOLD}")

    # (d) Two candidates inside AMBIGUITY_GAP → refuse and ask, even when
    #     both clear the bar. Unchanged behaviour, guarded here because the
    #     gap check now runs over the wider near-miss band.
    a, b = _reset(("go to the gym", 0.90), ("call mum about rent", 0.88))
    routed = _complete(MATCH)
    states = {
        r.id: r.state
        for r in db.query(Promise).filter(Promise.id.in_([a.id, b.id])).all()
    }
    if set(states.values()) != {"active"}:
        fails.append(f"ambiguous: something was closed — {states}")
    cands = (routed.failed_promise_actions or [{}])[0].get("candidates") or []
    if len(cands) != 2:
        fails.append(f"ambiguous: expected 2 candidates, got {cands}")
    print(f"[d] states={states} cands={len(cands)}")

    # (e) A clear winner over a far-behind runner-up still acts.
    a, b = _reset(("go to the gym", 0.90), ("call mum about rent", 0.62))
    _complete(MATCH)
    states = {
        r.id: r.state
        for r in db.query(Promise).filter(Promise.id.in_([a.id, b.id])).all()
    }
    if states.get(a.id) != "kept" or states.get(b.id) != "active":
        fails.append(f"clear winner: wrong states {states}")
    print(f"[e] states={states}")

    # (f) Nothing at all above the loose floor → honest no-match, no
    #     candidate invented.
    p, = _reset(("go to the gym", 0.40))
    routed = _complete(MATCH)
    p = db.query(Promise).filter(Promise.id == p.id).first()
    cands = (routed.failed_promise_actions or [{}])[0].get("candidates")
    if p.state != "active" or cands:
        fails.append(f"no match: state={p.state} cands={cands}")
    if "no match" not in (_build_ack(routed) or ""):
        fails.append("no match: ack should say so plainly")
    print(f"[f] state={p.state} cands={cands}")

    # (g) Parent-hint linking keeps the LOOSE bar — it only ADDS a link,
    #     never flips a lifecycle, so the strict closure bar must not have
    #     been applied globally.
    parent, = _reset(("gooni rewrite", 0.65))
    # No shared substring or content word — this has to land via cosine.
    got = promise_service.resolve_parent_hint(db, "that big project")
    if got != parent.id:
        fails.append(f"parent hint: expected #{parent.id} at 0.65, got {got}")
    print(f"[g] parent={got}")

    db.close()
    if fails:
        print("\nFAILURES:")
        for f in fails:
            print(f"  ✗ {f}")
        return 1
    print("\nAll promise match-threshold checks passed.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        try:
            os.unlink(_tmp.name)
        except OSError:
            pass
