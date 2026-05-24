
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db.database import get_db

from ..common import (
    _AUTH_PASSWORD, _expected_token
)
from ..common import _AUTH_PASSWORD, _expected_token
from ..services import google_calendar as gcal
from ..services import whoop
from ..services import github as gh


router = APIRouter()


@router.post("/auth")
async def login(body: dict):
    """Exchange password for a token. Returns 401 if wrong."""
    if not _AUTH_PASSWORD:
        # Auth disabled — return a dummy token so the frontend still works
        return {"token": "dev"}
    if body.get("password") != _AUTH_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password")
    return {"token": _expected_token()}


from ..services import google_calendar as gcal  # noqa: E402


@router.get("/auth/google/start")
def auth_google_start():
    """Kick off the OAuth flow. Returns the URL the frontend should
    window.open() — we return JSON instead of 302 so the frontend keeps
    control (shows a spinner, knows if env vars are missing, etc.).
    """
    if not gcal.is_configured():
        raise HTTPException(status_code=503, detail="Google OAuth env vars not set")
    return {"authorize_url": gcal.build_authorize_url()}


@router.get("/auth/google/callback")
def auth_google_callback(code: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    """Google redirects the user here with ?code=... — we exchange it for
    tokens, stash them, and redirect the browser back to the app. The
    frontend polls /auth/google/status to know connection state.
    """
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>Google OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = gcal.exchange_code_for_tokens(code)
        info = {}
        try:
            info = gcal.fetch_userinfo(tokens.get("access_token", ""))
        except Exception:
            pass
        gcal.save_tokens_from_exchange(db, tokens, account_email=info.get("email"))
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    # Auto-close the popup / redirect tab. Include a small inline script so
    # both flows (popup and full-page redirect) work.
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>Calendar connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>Google Calendar connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@router.get("/auth/google/status")
def auth_google_status(db: Session = Depends(get_db)):
    return gcal.connection_status(db)


@router.delete("/auth/google")
def auth_google_disconnect(db: Session = Depends(get_db)):
    disconnected = gcal.disconnect(db)
    return {"disconnected": disconnected}


@router.get("/auth/whoop/start")
def auth_whoop_start():
    if not whoop.is_configured():
        raise HTTPException(status_code=503, detail="Whoop OAuth env vars not set")
    return {"authorize_url": whoop.build_authorize_url()}


@router.get("/auth/whoop/callback")
def auth_whoop_callback(code: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>Whoop OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = whoop.exchange_code_for_tokens(code)
        # Whoop's basic profile gives us first/last name + email for the
        # connected-as label.
        profile = {}
        try:
            profile = whoop.fetch_profile(tokens.get("access_token", ""))
        except Exception:
            pass
        whoop.save_tokens_from_exchange(db, tokens, account_email=profile.get("email"))
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>Whoop connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>Whoop connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@router.get("/auth/whoop/status")
def auth_whoop_status(db: Session = Depends(get_db)):
    return whoop.connection_status(db)


@router.delete("/auth/whoop")
def auth_whoop_disconnect(db: Session = Depends(get_db)):
    return {"disconnected": whoop.disconnect(db)}


@router.get("/auth/github/start")
def auth_github_start():
    if not gh.is_configured():
        raise HTTPException(status_code=503, detail="GitHub OAuth env vars not set")
    return {"authorize_url": gh.build_authorize_url()}


@router.get("/auth/github/callback")
def auth_github_callback(
    code: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    from fastapi.responses import HTMLResponse
    if error:
        return HTMLResponse(f"<p>GitHub OAuth returned: {error}. You can close this tab.</p>", status_code=400)
    if not code:
        return HTMLResponse("<p>Missing code parameter.</p>", status_code=400)
    try:
        tokens = gh.exchange_code_for_tokens(code)
        label = None
        try:
            info = gh.fetch_userinfo(tokens.get("access_token", ""))
            login = info.get("login")
            if login:
                label = f"@{login}"
        except Exception:
            pass
        gh.save_tokens_from_exchange(db, tokens, account_label=label)
    except Exception as e:
        return HTMLResponse(f"<p>Token exchange failed: {e}. You can close this tab.</p>", status_code=500)
    return HTMLResponse(
        """
        <!doctype html>
        <meta charset="utf-8">
        <title>GitHub connected</title>
        <style>body{font-family:system-ui;padding:40px;color:#1C1C1E;}</style>
        <p>GitHub connected. You can close this tab.</p>
        <script>
          try { window.opener && window.opener.postMessage({type:"gooni-oauth-done"}, "*"); } catch(e){}
          setTimeout(() => { window.close(); }, 600);
        </script>
        """,
        status_code=200,
    )


@router.get("/auth/github/status")
def auth_github_status(db: Session = Depends(get_db)):
    return gh.connection_status(db)


@router.delete("/auth/github")
def auth_github_disconnect(db: Session = Depends(get_db)):
    disconnected = gh.disconnect(db)
    return {"disconnected": disconnected}
