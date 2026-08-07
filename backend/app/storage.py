"""Upload persistence: local disk for development, S3-compatible for deploy.

Free Render (and any container without a volume) wipes its filesystem on every
idle wake and redeploy. Neon keeps the URL rows; the bytes have to live
somewhere else. When S3_* is configured the bytes go to the bucket and
`/uploads/{name}` streams them back, so existing relative URLs keep working
and a private bucket needs no public CORS setup. Local disk remains the
default so `docker compose` and a bare laptop stay zero-config.
"""

from __future__ import annotations

import logging
import mimetypes
import uuid
from pathlib import Path
from typing import BinaryIO

from fastapi import HTTPException, status
from fastapi.responses import RedirectResponse, Response, StreamingResponse

from .config import settings

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads"

# Teach the stdlib about CAD types Starlette would otherwise call text/plain.
for _extension, _media_type in {
    ".obj": "model/obj",
    ".fbx": "application/octet-stream",
    ".stp": "model/step",
    ".step": "model/step",
    ".3dm": "model/vnd.3dm",
}.items():
    mimetypes.add_type(_media_type, _extension)


def object_storage_configured() -> bool:
    return bool(
        settings.s3_bucket
        and settings.s3_access_key_id
        and settings.s3_secret_access_key
        and settings.s3_endpoint_url
    )


def _s3_client():
    # Imported lazily so a laptop without boto3 still boots on the local path.
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        region_name=settings.s3_region or "auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def _content_type_for(name: str, fallback: str | None = None) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return fallback or guessed or "application/octet-stream"


def _public_url(name: str) -> str | None:
    base = (settings.s3_public_base_url or "").rstrip("/")
    return f"{base}/{name}" if base else None


def store_bytes(payload: bytes, extension: str, content_type: str | None = None) -> str:
    """Persist `payload` and return the URL the API should hang on the row.

    Relative `/uploads/…` when serving through this app (local disk, or S3
    behind the same origin). Absolute when `S3_PUBLIC_BASE_URL` is set so the
    browser can hit the bucket directly.
    """
    name = f"{uuid.uuid4().hex}{extension}"
    media_type = _content_type_for(name, content_type)

    if object_storage_configured():
        client = _s3_client()
        client.put_object(
            Bucket=settings.s3_bucket,
            Key=name,
            Body=payload,
            ContentType=media_type,
            CacheControl="public, max-age=31536000, immutable",
        )
        public = _public_url(name)
        if public:
            return public
        return f"/uploads/{name}"

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / name).write_bytes(payload)
    return f"/uploads/{name}"


def _safe_name(name: str) -> str:
    # Only the basename we mint ourselves — refuse anything that looks like a path.
    if not name or "/" in name or "\\" in name or name.startswith(".") or ".." in name:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return name


def serve_upload(name: str) -> Response:
    """Serve a previously stored object, preferring local then falling back to S3."""
    name = _safe_name(name)
    local = UPLOAD_DIR / name
    media_type = _content_type_for(name)

    if local.is_file():
        from fastapi.responses import FileResponse

        return FileResponse(local, media_type=media_type, headers=_cache_headers())

    public = _public_url(name)
    # Public base is the CDN path for bytes that never landed on this disk.
    # Redirect rather than proxy so cold Render instances don't pay the transfer.
    if public and object_storage_configured():
        return RedirectResponse(public, status_code=status.HTTP_302_FOUND)

    if not object_storage_configured():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    try:
        obj = _s3_client().get_object(Bucket=settings.s3_bucket, Key=name)
    except Exception as exc:  # noqa: BLE001 — botocore raises many shapes for missing keys
        logger.info("upload miss %s: %s", name, exc)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc

    body: BinaryIO = obj["Body"]
    headers = _cache_headers()
    if "ContentLength" in obj:
        headers["Content-Length"] = str(obj["ContentLength"])
    return StreamingResponse(
        body.iter_chunks(chunk_size=64 * 1024),
        media_type=obj.get("ContentType") or media_type,
        headers=headers,
    )


def _cache_headers() -> dict[str, str]:
    # UUIDs never reuse a name, so browsers may keep them forever.
    return {"Cache-Control": "public, max-age=31536000, immutable"}
