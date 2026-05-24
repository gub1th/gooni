
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import (
    CapabilityFacet,
)

from ..serializers import (
    _serialize_capability_facet
)


router = APIRouter()


@router.get("/capabilities")
def list_capabilities(db: Session = Depends(get_db)):
    """List all user-visible capability facets grouped by layer.

    Skips the `_meta` layer (internal scan-hash sentinel). Status='removed'
    rows are returned so the FE can render them dimmed — useful for "Gooni
    used to do X but a refactor removed it."
    """
    rows = (
        db.query(CapabilityFacet)
        .filter(CapabilityFacet.layer != "_meta")
        .order_by(CapabilityFacet.layer, CapabilityFacet.id)
        .all()
    )
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.layer, []).append(_serialize_capability_facet(r))
    return {"by_layer": out, "total": len(rows)}


@router.patch("/capabilities/{facet_id}")
def patch_capability(facet_id: int, body: dict, db: Session = Depends(get_db)):
    """Hand-edit a facet. Allowed fields: facet_text, status, layer.
    Source flips to 'chat_tool_update' to mark provenance.
    """
    row = db.query(CapabilityFacet).filter(CapabilityFacet.id == facet_id).one_or_none()
    if row is None:
        raise HTTPException(404, "facet not found")
    if "facet_text" in body:
        new_text = (body["facet_text"] or "").strip()
        if new_text:
            row.facet_text = new_text
    if "status" in body:
        new_status = str(body["status"])
        if new_status not in {"claimed", "verified", "unverified", "broken", "removed"}:
            raise HTTPException(400, "invalid status")
        row.status = new_status
    if "layer" in body:
        new_layer = str(body["layer"])
        if new_layer not in {"mechanical", "functional", "behavioral", "architectural"}:
            raise HTTPException(400, "invalid layer")
        row.layer = new_layer
    row.source = "chat_tool_update"
    db.commit()
    return _serialize_capability_facet(row)


@router.post("/capabilities")
def create_capability(body: dict, db: Session = Depends(get_db)):
    """Create a facet manually (Daniel-seeded functional/architectural rows).
    facet_key must be unique; conflicts return 409.
    """
    facet_key = (body.get("facet_key") or "").strip()
    layer = (body.get("layer") or "").strip()
    facet_text = (body.get("facet_text") or "").strip()
    if not facet_key or not layer or not facet_text:
        raise HTTPException(400, "facet_key, layer, facet_text required")
    if layer not in {"mechanical", "functional", "behavioral", "architectural"}:
        raise HTTPException(400, "invalid layer")
    existing = db.query(CapabilityFacet).filter(CapabilityFacet.facet_key == facet_key).one_or_none()
    if existing is not None:
        raise HTTPException(409, "facet_key already exists")
    row = CapabilityFacet(
        facet_key=facet_key,
        layer=layer,
        facet_text=facet_text,
        status=str(body.get("status") or "claimed"),
        source=str(body.get("source") or "manual_seed"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_capability_facet(row)


@router.post("/capabilities/telemetry/refresh")
def trigger_capability_telemetry(db: Session = Depends(get_db)):
    """Manual trigger for the runtime-telemetry rollup. Same op the nightly
    lifespan loop fires at 03:00 local. Useful for FE-driven 'refresh now'.
    """
    from ..services.capability_service import capability_service
    return capability_service.run_telemetry_rollup(db)


@router.post("/capabilities/boot-scan/refresh")
def trigger_capability_boot_scan(db: Session = Depends(get_db)):
    """Manual trigger for the boot-time mechanical-layer scan. Same op the
    lifespan startup hook fires. Use when you've added a tool/route mid-session
    without restarting uvicorn."""
    from ..services.capability_service import capability_service
    return capability_service.refresh_mechanical_layer(db)


@router.post("/capabilities/dedup-behavioral")
def trigger_capability_dedup_behavioral(db: Session = Depends(get_db)):
    """One-shot cleanup over existing behavioral facets — cosine-clusters them
    and merges semantic dups into the oldest canonical row. Use after the
    cosine-dedup-at-promotion-time fix lands to clean the historical bloat
    (prod was carrying ~6 near-identical "I tend to: lack support" facets
    because the old promote path keyed on text hash, not embedding).

    Returns {scanned, kept, merged, clusters} — clusters lists the canon
    row + merged ids so the audit is auditable.
    """
    from ..services.capability_service import capability_service
    return capability_service.dedup_existing_behavioral(db)
