from datetime import datetime as _dt, timedelta as _td

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..services import ultrahuman


router = APIRouter()


# ── OAuth 2.0 ────────────────────────────────────────────────────────────
# Note: these two paths (`/ultrahuman/oauth/authorize`, `/ultrahuman/oauth/callback`)
# are exempt from the Bearer-auth middleware in main.py — Ultrahuman's redirect
# carries no bearer, and the authorize hop is a plain browser navigation, not
# a fetch() the frontend can attach a token to.

@router.get("/ultrahuman/oauth/authorize")
def ultrahuman_oauth_authorize():
    """Redirects straight to Ultrahuman's authorize page — a plain 302, not
    JSON, so `window.open(f"{BASE}/ultrahuman/oauth/authorize")` (or a plain
    link) just works without a fetch() round trip first."""
    if not ultrahuman.is_oauth_configured():
        raise HTTPException(status_code=503, detail="Ultrahuman OAuth env vars not set")
    return RedirectResponse(ultrahuman.build_authorize_url())


@router.get("/ultrahuman/oauth/callback")
def ultrahuman_oauth_callback(code: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    """Ultrahuman redirects the user here with ?code=... — exchange it for
    tokens, stash them, and auto-close the tab (mirrors the whoop/google
    callback pattern in app/routers/auth.py)."""
    if error:
        return HTMLResponse(f"<p>Ultrahuman OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = ultrahuman.exchange_code_for_tokens(code)
        ultrahuman.save_tokens_from_exchange(db, tokens)
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>Ultrahuman connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>Ultrahuman connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@router.get("/ultrahuman/status")
def ultrahuman_status(db: Session = Depends(get_db)):
    return ultrahuman.connection_status(db)


@router.delete("/ultrahuman/oauth")
def ultrahuman_disconnect(db: Session = Depends(get_db)):
    return {"disconnected": ultrahuman.disconnect(db)}


@router.get("/ultrahuman/today")
def ultrahuman_today(refresh: bool = False, db: Session = Depends(get_db)):
    """Same lazy-cache shape as /whoop/today: serve the cached master-
    trackable entry if it's under 2h old, else refetch."""
    doc = ultrahuman.get_today(db)
    updated_at = None
    if doc:
        try:
            updated_at = _dt.fromisoformat(doc.get("updated_at") or "")
        except (ValueError, TypeError):
            updated_at = None
    stale = (
        doc is None
        or updated_at is None
        or (_dt.utcnow() - updated_at) > _td(hours=2)
    )
    if refresh or stale:
        if not ultrahuman.is_configured():
            raise HTTPException(status_code=401, detail="Ultrahuman not configured")
        try:
            payload = ultrahuman.fetch_today_snapshot(db)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Ultrahuman fetch failed: {e}")
        if payload is None:
            raise HTTPException(status_code=401, detail="Ultrahuman not configured")
        doc = ultrahuman.upsert_today_snapshot(db, payload)

    doc = doc or {}
    return {
        "date": ultrahuman._local_today(db).isoformat(),
        "sleep_score": doc.get("sleep_score"),
        "sleep_minutes": doc.get("sleep_minutes"),
        "sleep_efficiency": doc.get("sleep_efficiency"),
        "recovery_score": doc.get("recovery_score"),
        "recovery_index": doc.get("recovery_index"),
        "hrv_ms": doc.get("hrv_ms"),
        "resting_hr": doc.get("resting_hr"),
        "steps": doc.get("steps"),
        "active_minutes": doc.get("active_minutes"),
        "active_calories": doc.get("active_calories"),
        "vo2_max": doc.get("vo2_max"),
        "spo2": doc.get("spo2"),
        "updated_at": doc.get("updated_at"),
    }
