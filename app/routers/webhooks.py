import hashlib
import hmac
import json
import os
import re
import time

from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, Header, HTTPException, Request, UploadFile
from sqlalchemy import bindparam, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..db.database import engine, get_db, SessionLocal
from ..db.models import (
    Attachment,
    CapabilityFacet,
    Conversation,
    GooniTake,
    McpCall,
    Memory,
    Message,
    List as ListModel,
    ListItem,
    Note,
    NoteComment,
    PublicProfile,
    Reaction,
    Reflection,
    Settings,
    Space,
    Visit,
    WaProcessedId,
)
from ..db.schemas import ChatRequest
from ..llm.client import llm_client
from ..services.conversation_service import conversation_service
from ..services.item_service import item_service
from ..services.memory_service import memory_service
from ..services.messaging import (
    dispatch_inbound,
    imessage_channel,
    telegram_channel,
    whatsapp_channel,
)
from ..services.note_service import note_service
from ..services.orchestrator import Orchestrator
from ..services.todo_nudge import (
    DEFAULT_PROMPT as NUDGE_DEFAULT_PROMPT,
    compose_message as compose_nudge_message,
)

from ..serializers import (
    _TAG_RE, _IMG_TAG_RE, _WHITESPACE_RE, _EXTERNAL_IMG_SRC_RE, _REACTION_TARGETS, _REACTION_MAX_EMOJI_LEN, _REACTION_MAX_REACTOR_LEN, _excerpt_from_html, _strip_html_to_visible_text, _external_thumb_from_html, _note_excerpt, _parse_tags, _normalize_tags, _serialize_note, _serialize_note_lite, _notes_order, _serialize_list, _serialize_list_item, _serialize_item, _serialize_space, _serialize_settings, _serialize_promise, _serialize_comment, _validate_reaction_target, _serialize_reactions, _serialize_conversation, _serialize_message, _serialize_capability_facet, _serialize_reflection
)
from ..common import (
    _AUTH_PASSWORD, _expected_token, _parse_iso_date, _parse_optional_due, _parse_optional_dt, _validate_health, _validate_status, _validate_scale, _VALID_STATUS, _VALID_SCALE, _unique_viewers_for_note
)
from ..deps import _fire_nudge_once, _settings_row, _next_fire
from ..services import whoop


router = APIRouter()


@router.post("/webhooks/imessage")
async def imessage_webhook(
    payload: dict,
    x_secret: str | None = Header(None, alias="X-Secret"),
    db: Session = Depends(get_db),
):
    """Receive a BlueBubbles 'new-message' event, route it through the
    orchestrator, and POST a reply back via BlueBubbles. Auth: shared-secret
    header configured in BlueBubbles' webhook settings.

    Inbound events from the user's own Apple ID (i.e. messages Daniel sent FROM
    his Mac/iPhone) carry isFromMe=true on the BlueBubbles payload. We treat
    those as the user talking TO Gooni only when they originate from an
    allowlisted handle on the recipient side — i.e. Daniel iMessage'ing his own
    number from a different device. For now we drop isFromMe events to avoid
    feedback loops where Gooni's own outbound message triggers a webhook back.
    """
    expected = os.getenv("IMESSAGE_WEBHOOK_SECRET")
    if not expected or x_secret != expected:
        raise HTTPException(status_code=401, detail="bad secret")

    data = payload.get("data") or {}
    if data.get("isFromMe"):
        return {"ok": True, "skipped": "from_me"}

    handle = (data.get("handle") or {}).get("address") or ""
    text = data.get("text") or ""
    if not handle or not text:
        return {"ok": True, "skipped": "missing handle or text"}

    result = dispatch_inbound(imessage_channel, handle, text, db)
    if result is None:
        return {"ok": True, "skipped": "not_allowlisted"}
    _raw, segments = result
    # Multi-bubble cadence: each segment goes out as its own iMessage with a
    # short delay so the reply feels like texting, not bot dump.
    for idx, segment in enumerate(segments):
        if idx > 0:
            time.sleep(0.6)
        imessage_channel.send(handle, segment)
    return {"ok": True}


@router.get("/webhooks/whatsapp")
async def whatsapp_webhook_verify(request: Request):
    """Meta verification handshake. On webhook configuration save, Meta sends:

      GET /webhooks/whatsapp?hub.mode=subscribe
                            &hub.verify_token=<our shared secret>
                            &hub.challenge=<random string>

    We must echo `hub.challenge` as plain-text body with HTTP 200 if and only
    if the verify_token matches our env-configured one. Anything else → 403.
    """
    from fastapi.responses import PlainTextResponse
    expected = os.getenv("WHATSAPP_VERIFY_TOKEN")
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge") or ""
    if mode == "subscribe" and expected and token == expected:
        return PlainTextResponse(challenge, status_code=200)
    raise HTTPException(status_code=403, detail="verify failed")


def _verify_whatsapp_signature(raw_body: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256 verification. Header format: 'sha256=<hex>'.
    Computed as HMAC-SHA256(app_secret, raw_body). When app_secret isn't
    configured we accept everything (dev mode) but the allowlist still gates
    inbound — the cost of a stray forged event in that posture is at most a
    spammed conversation row, not auth bypass."""
    secret = os.getenv("WHATSAPP_APP_SECRET")
    if not secret:
        return True  # not configured; rely on allowlist + verify_token
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


def _wa_claim_msg_id(wamid: str, db: Session) -> bool:
    """Atomic first-write claim on a Meta-issued message id.

    Returns True if THIS handler invocation owns the message (insert succeeded);
    False if another delivery (a Meta retry, or a parallel webhook arrival)
    already claimed it. UNIQUE on `wa_processed_ids.wamid` is the race boundary
    — IntegrityError = lost the race = treat as duplicate.
    """
    if not wamid:
        return True  # malformed payload; let downstream skip on missing fields
    db.add(WaProcessedId(wamid=wamid))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _process_wa_message(sender: str, body: str) -> None:
    """Run the inbound WhatsApp message through the orchestrator + send replies.

    Spawned via BackgroundTasks so the HTTP handler can 200-ack Meta inside
    their (~20s) redelivery window even when the chat turn takes 30s+. Owns
    its own SessionLocal — the request-scoped session is gone by the time
    this runs.
    """
    bg_db = SessionLocal()
    try:
        result = dispatch_inbound(whatsapp_channel, sender, body, bg_db)
        if result is None:
            return  # not allowlisted; silent drop
        _raw, segments = result
        for idx, segment in enumerate(segments):
            if idx > 0:
                time.sleep(0.6)
            try:
                whatsapp_channel.send(sender, segment)
            except Exception as e:
                print(f"[wa] send failed for {sender}: {e}")
    except Exception as e:
        print(f"[wa] orchestrator failed for {sender}: {e}")
    finally:
        bg_db.close()


@router.post("/webhooks/whatsapp")
async def whatsapp_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    db: Session = Depends(get_db),
):
    """Receive a WhatsApp Cloud API event.

    Meta delivers two kinds of events under `entry[].changes[].value`:
      - `messages`  — actual user-sent text/media (what we care about)
      - `statuses`  — delivery/read receipts for messages WE sent (ignore;
                      otherwise every reply triggers an echo and we'd loop)

    Two layers protect against double-processing:
      1. `_wa_claim_msg_id` — Meta redelivers any webhook we don't 200-ack
         within ~20s; one orchestrator turn often blows past that. The claim
         table is a UNIQUE(wamid) PK so a retry hits IntegrityError and we
         skip. This is the load-bearing one.
      2. `BackgroundTasks` — pushes the (slow) dispatch + send out of the
         request lifecycle so we return 200 fast and Meta stops retrying.

    Auth layers (defense in depth):
      1. HMAC-SHA256 signature header (Meta-issued; verified against app secret)
      2. Allowlist on inbound `from` handle
      3. Skip non-text message types for v1
    """
    raw_body = await request.body()
    if not _verify_whatsapp_signature(raw_body, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="bad signature")

    try:
        payload = json.loads(raw_body or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid json")

    # Meta wraps each event in entry[].changes[]. There can be multiple, but
    # for a single inbound message it's typically one change with one message.
    entries = payload.get("entry") or []
    queued = 0
    duplicates = 0
    for entry in entries:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            messages = value.get("messages") or []
            if not messages:
                continue  # status update or other non-message event
            for msg in messages:
                if msg.get("type") != "text":
                    continue  # v1: text only
                wamid = msg.get("id") or ""
                sender = msg.get("from") or ""
                body = (msg.get("text") or {}).get("body") or ""
                if not sender or not body:
                    continue
                if not _wa_claim_msg_id(wamid, db):
                    duplicates += 1
                    continue
                background_tasks.add_task(_process_wa_message, sender, body)
                queued += 1
    return {"ok": True, "queued": queued, "duplicates": duplicates}


def _verify_whoop_signature(raw_body: bytes, signature: str | None, timestamp: str | None) -> bool:
    secret = os.getenv("WHOOP_CLIENT_SECRET")
    if not secret:
        # Defaults to "open in dev" so webhook can be exercised locally
        # without setting the secret. Production must set WHOOP_CLIENT_SECRET.
        return True
    if not signature or not timestamp:
        return False
    try:
        ts_ms = int(timestamp)
    except ValueError:
        return False
    # Reject events older than 5 minutes (replay guard).
    now_ms = int(time.time() * 1000)
    if abs(now_ms - ts_ms) > 5 * 60 * 1000:
        return False
    import base64
    digest = hmac.new(
        secret.encode(), (timestamp + raw_body.decode("utf-8", errors="replace")).encode(), hashlib.sha256
    ).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature)


@router.post("/webhooks/whoop")
async def whoop_webhook(
    request: Request,
    x_whoop_signature: str | None = Header(None, alias="X-WHOOP-Signature"),
    x_whoop_signature_timestamp: str | None = Header(None, alias="X-WHOOP-Signature-Timestamp"),
    db: Session = Depends(get_db),
):
    """Receive a Whoop webhook event.

    Whoop fires on `recovery.updated`, `sleep.updated`, `workout.updated`,
    `cycle.updated`. Payload carries metadata only (event type + record id)
    — actual data must be fetched via the API. We don't fetch per-record;
    we just refresh the daily snapshot once any event lands so the dashboard
    is always within one webhook of truth.

    Auth: HMAC-SHA256 signature. See `_verify_whoop_signature`.
    """
    raw_body = await request.body()
    if not _verify_whoop_signature(raw_body, x_whoop_signature, x_whoop_signature_timestamp):
        raise HTTPException(status_code=401, detail="bad whoop signature")

    try:
        payload = json.loads(raw_body or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid json")

    event_type = payload.get("type") or ""
    # Only refresh on the events that actually move the snapshot. Workout
    # events don't change recovery/strain/sleep, so we skip them to avoid
    # burning the API rate budget for nothing.
    relevant = event_type.startswith(("recovery.", "sleep.", "cycle."))
    if not relevant:
        return {"ok": True, "ignored": event_type}

    try:
        snapshot = whoop.fetch_today_snapshot(db)
    except Exception as e:
        # Don't 500 — Whoop will keep retrying which doesn't help us; log
        # and move on. Daniel can hit ?refresh=1 manually to recover.
        print(f"whoop webhook fetch error: {e}")
        return {"ok": True, "warn": str(e)}
    if snapshot:
        whoop.upsert_today_snapshot(db, snapshot)
    return {"ok": True, "type": event_type}
