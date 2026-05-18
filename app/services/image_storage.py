"""Cloudflare R2 image upload service.

R2 is S3-compatible — same boto3 client, custom endpoint, no egress fees.
We host pasted/dropped images here so note bodies stay tiny (just URLs)
instead of carrying multi-MB base64 data: URLs that blow up localStorage
and Fly RAM (see PR #134 postmortem).

Required env (route returns 503 when any of these are missing):
    R2_ACCOUNT_ID    Cloudflare account ID
    R2_ACCESS_KEY    R2 API token access key
    R2_SECRET        R2 API token secret
    R2_BUCKET        target bucket name
    R2_PUBLIC_HOST   public-read host, e.g. cdn.example.com or
                     pub-<hash>.r2.dev (NO scheme, NO trailing slash)
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from typing import Optional

# boto3 is heavy — import lazily so unit tests / dev mode without R2 don't
# pay the import cost or the dep requirement at module load.
_client = None


class R2NotConfigured(RuntimeError):
    """Raised when an upload is attempted without all R2 env vars set."""


def _config() -> dict[str, str]:
    keys = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY", "R2_SECRET", "R2_BUCKET", "R2_PUBLIC_HOST")
    cfg = {k: (os.getenv(k) or "").strip() for k in keys}
    missing = [k for k, v in cfg.items() if not v]
    if missing:
        raise R2NotConfigured(f"R2 env vars not set: {', '.join(missing)}")
    return cfg


def is_configured() -> bool:
    try:
        _config()
        return True
    except R2NotConfigured:
        return False


def _get_client(cfg: dict[str, str]):
    """Return a memoized boto3 S3 client pointed at R2's endpoint.

    R2 endpoint format: https://<account_id>.r2.cloudflarestorage.com
    `region_name='auto'` is the documented value for R2 — it has one global
    region, but boto3 still requires the param to construct signing URLs.
    """
    global _client
    if _client is not None:
        return _client
    import boto3
    from botocore.config import Config

    _client = boto3.client(
        "s3",
        endpoint_url=f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=cfg["R2_ACCESS_KEY"],
        aws_secret_access_key=cfg["R2_SECRET"],
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )
    return _client


def _safe_extension(content_type: str, filename: Optional[str]) -> str:
    """Pick a stable extension. Trust the content-type first; fall back to
    the filename suffix if the type is generic. Returns '' for unknown
    types so the caller can decide whether to reject."""
    ct = (content_type or "").lower()
    by_ct = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/heic": "heic",
        "image/heif": "heif",
    }
    if ct in by_ct:
        return by_ct[ct]
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if 1 <= len(ext) <= 5 and ext.isalnum():
            return ext
    return ""


def upload_file(
    data: bytes,
    content_type: str,
    filename: Optional[str] = None,
    *,
    prefix: str = "attachments",
) -> dict[str, str]:
    """Generic R2 upload — used by /uploads/file for note attachments. Same
    semantics as upload_image() but with a configurable key prefix and no
    image-only extension whitelist. Returns {url, key, ext}."""
    cfg = _config()
    client = _get_client(cfg)

    ext = _safe_extension(content_type, filename) or "bin"
    today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    rand = secrets.token_urlsafe(12)[:16]
    key = f"{prefix}/{today}/{rand}.{ext}"

    client.put_object(
        Bucket=cfg["R2_BUCKET"],
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
        CacheControl="public, max-age=31536000, immutable",
    )

    host = cfg["R2_PUBLIC_HOST"].rstrip("/")
    for prefix_str in ("https://", "http://", "https//", "http//"):
        if host.startswith(prefix_str):
            host = host[len(prefix_str):]
            break
    url = f"https://{host}/{key}"
    return {"url": url, "key": key, "ext": ext}


def upload_image(
    data: bytes,
    content_type: str,
    filename: Optional[str] = None,
) -> dict[str, str]:
    """Push `data` to R2 under a date-prefixed random key. Returns the
    public URL plus the storage key so callers can later delete or audit.

    Raises R2NotConfigured when env is incomplete (route translates this
    to a 503 so the frontend can fall back to the legacy base64 path).
    """
    cfg = _config()
    client = _get_client(cfg)

    ext = _safe_extension(content_type, filename) or "bin"
    today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    # Random URL-safe id (16 chars from 12 bytes) keeps keys short and
    # unguessable. Gooni is single-user so collisions across notes are
    # vanishingly rare; the prefix isolates by day for easier inspection.
    rand = secrets.token_urlsafe(12)[:16]
    key = f"images/{today}/{rand}.{ext}"

    client.put_object(
        Bucket=cfg["R2_BUCKET"],
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
        # R2 honors CacheControl on the object; long max-age is fine because
        # keys are immutable (we never overwrite).
        CacheControl="public, max-age=31536000, immutable",
    )

    # Strip any scheme prefix the user pasted into the env var so we don't
    # end up with `https://https://...` (or `https://https//...` for the
    # missing-colon variant). Bare host is the contract; this just means
    # bad input no longer breaks every uploaded image.
    host = cfg["R2_PUBLIC_HOST"].rstrip("/")
    for prefix in ("https://", "http://", "https//", "http//"):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    url = f"https://{host}/{key}"
    return {"url": url, "key": key}
