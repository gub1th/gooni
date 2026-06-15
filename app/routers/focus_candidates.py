
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db



router = APIRouter()


@router.post("/focus-synthesis/run")
def focus_synthesis_run(body: dict | None = None, db: Session = Depends(get_db)):
    """Probe endpoint — runs the focus synthesizer over recent notes /
    todos / deduped facts / chat messages and returns candidate clusters
    as JSON. Does NOT persist anything; this is a quality probe.

    Body (all optional):
      {
        "include_kinds": ["note","todo","fact","message"],
        "threshold": float (cosine join floor, default 0.48),
        "merge_threshold": float (centroid-merge floor, default 0.62; set
            to 1.1 to disable the merge pass),
        "sub_threshold": float (tighter cosine for within-parent sub-cluster,
            default 0.62),
        "min_parent_for_subcluster": int (only parents this size or larger
            get sub-clustered; default 8, set to 9999 to disable),
        "min_sub_size": int (drop sub-clusters smaller than this; default 3),
        "min_cluster_size": int (default 3),
        "classify": bool (default true; false skips every per-cluster LLM call),
        "classify_model": str (override the classify model, e.g. "gpt-4o" for
            higher-fidelity comparison runs; defaults to the cheap classifier),
        "state_bind_sim": float (absolute cosine floor for state→focus binding;
            default 0.38, set to 1.1 to disable),
        "state_bind_margin": float (minimum gap best focus must beat runner-up
            by for the bind to take; default 0.10)
      }
    """
    from ..services.focus_synthesizer import synthesize
    body = body or {}
    kwargs: dict = {}
    if "include_kinds" in body and body["include_kinds"]:
        kwargs["include_kinds"] = list(body["include_kinds"])
    if "threshold" in body and body["threshold"] is not None:
        kwargs["threshold"] = float(body["threshold"])
    if "merge_threshold" in body and body["merge_threshold"] is not None:
        kwargs["merge_threshold"] = float(body["merge_threshold"])
    if "sub_threshold" in body and body["sub_threshold"] is not None:
        kwargs["sub_threshold"] = float(body["sub_threshold"])
    if "min_parent_for_subcluster" in body and body["min_parent_for_subcluster"] is not None:
        kwargs["min_parent_for_subcluster"] = int(body["min_parent_for_subcluster"])
    if "min_sub_size" in body and body["min_sub_size"] is not None:
        kwargs["min_sub_size"] = int(body["min_sub_size"])
    if "min_cluster_size" in body and body["min_cluster_size"] is not None:
        kwargs["min_cluster_size"] = int(body["min_cluster_size"])
    if "classify" in body and body["classify"] is not None:
        kwargs["classify"] = bool(body["classify"])
    if "classify_model" in body and body["classify_model"]:
        kwargs["classify_model"] = str(body["classify_model"])
    if "state_bind_sim" in body and body["state_bind_sim"] is not None:
        kwargs["state_bind_sim"] = float(body["state_bind_sim"])
    if "state_bind_margin" in body and body["state_bind_margin"] is not None:
        kwargs["state_bind_margin"] = float(body["state_bind_margin"])
    return synthesize(db, **kwargs)


@router.post("/focus-candidates/run")
def focus_candidates_run(body: dict | None = None, db: Session = Depends(get_db)):
    """Run synthesizer → bind clusters to existing Focuses → persist
    the unbound focus-shaped clusters as candidates.

    Binding pass runs FIRST so clusters that match an existing Focus
    don't duplicate as candidates. Updates current_signature +
    evidence + last_seen_in_synth + missed_run_count on the bound
    Focus; flags drift; auto-marks dormant after DORMANCY_THRESHOLD
    consecutive missed runs.

    Same body shape as /focus-synthesis/run. Returns:
      {synth_stats, binding: {bound, dormant_focus_ids,
       newly_drifted_focus_ids}, persisted}
    """
    from ..services.focus_synthesizer import synthesize
    from ..services import focus_candidate_service
    from ..services.focus_service import bind_to_clusters

    body = body or {}
    kwargs: dict = {}
    for key in (
        "include_kinds", "threshold", "merge_threshold", "sub_threshold",
        "min_parent_for_subcluster", "min_sub_size", "min_cluster_size",
        "classify", "classify_model", "state_bind_sim", "state_bind_margin",
    ):
        if key in body and body[key] is not None:
            kwargs[key] = body[key]

    out = synthesize(db, **kwargs)
    binding = bind_to_clusters(db, out)
    persisted = focus_candidate_service.persist_run(db, out)
    return {
        "synth_stats": out["stats"],
        "binding": binding,
        "persisted": persisted,
    }


@router.get("/focus-candidates")
def focus_candidates_list(
    status: str | None = "proposed", db: Session = Depends(get_db)
):
    """List candidates, default filter status='proposed'. Pass
    status='' or status='all' to skip the filter.
    """
    from ..services import focus_candidate_service
    filter_status: str | None = status
    if status in ("", "all"):
        filter_status = None
    rows = focus_candidate_service.list_candidates(db, status=filter_status)
    return [focus_candidate_service.serialize_candidate(r) for r in rows]


@router.post("/focus-candidates/{candidate_id}/promote")
def focus_candidates_promote(candidate_id: int, db: Session = Depends(get_db)):
    """Promote a candidate into a real Focus row. Idempotent on a
    candidate already promoted (returns the existing pair). Refuses
    candidates that are dismissed.
    """
    from ..services import focus_candidate_service
    result = focus_candidate_service.promote(db, candidate_id)
    if not result:
        raise HTTPException(404, "candidate not found or not promotable")
    cand, focus = result
    return {
        "candidate": focus_candidate_service.serialize_candidate(cand),
        "focus_id": focus.id,
    }


@router.post("/focus-candidates/{candidate_id}/dismiss")
def focus_candidates_dismiss(candidate_id: int, db: Session = Depends(get_db)):
    from ..services import focus_candidate_service
    cand = focus_candidate_service.dismiss(db, candidate_id)
    if not cand:
        raise HTTPException(404, "candidate not found or already settled")
    return focus_candidate_service.serialize_candidate(cand)
