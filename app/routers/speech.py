from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..llm.client import llm_client

router = APIRouter()

_MAX_TTS_CHARS = 4000


class TTSRequest(BaseModel):
    text: str


@router.post("/tts")
def tts_route(req: TTSRequest):
    # Plain `def` on purpose: synthesize_speech is a sync 1-3s OpenAI call.
    # As `async def` it ran ON the event loop and froze every request for
    # the duration — Starlette threadpools sync handlers automatically.
    """Synthesize speech for a reply the user triggered by VOICE — the web
    client plays the returned MP3 through an <audio> blob (see
    frontend/services/speech.ts). TTS is never load-bearing: on any synthesis
    error we 502 and the client stays silent, so a bad key / rate limit / API
    hiccup degrades to text-only rather than breaking the turn.
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    try:
        audio = llm_client.synthesize_speech(text[:_MAX_TTS_CHARS])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"tts failed: {e}")
    return Response(content=audio, media_type="audio/mpeg")
