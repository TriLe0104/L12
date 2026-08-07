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
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlparse

from fastapi import HTTPException, status
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse

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


def _clean_endpoint(raw: str) -> str:
    # Render / dotenv pastes often wrap values in quotes; those break TLS SNI.
    value = raw.strip().strip("\"'")
    return value.rstrip("/")


def _enable_r2_sni_workaround() -> None:
    """Cloudflare sometimes has no cert for `<account>.r2.cloudflarestorage.com`.

    Presenting that hostname as SNI yields `SSLV3_ALERT_HANDSHAKE_FAILURE`.
    Presenting `r2.cloudflarestorage.com` instead completes TLS against the
    shared cert, while the HTTP Host header (and SigV4) still use the account
    endpoint. urllib3 honours `HTTPSConnection.server_hostname` for both SNI
    and certificate hostname checks.
    """
    import urllib3.connection as conn

    if getattr(conn.HTTPSConnection, "_po_r2_sni_patched", False):
        return

    original_init = conn.HTTPSConnection.__init__

    def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        original_init(self, *args, **kwargs)
        host = getattr(self, "host", "") or ""
        if host.endswith(".r2.cloudflarestorage.com") and host != "r2.cloudflarestorage.com":
            self.server_hostname = "r2.cloudflarestorage.com"

    conn.HTTPSConnection.__init__ = patched_init  # type: ignore[method-assign]
    conn.HTTPSConnection._po_r2_sni_patched = True  # type: ignore[attr-defined]


@lru_cache(maxsize=1)
def _s3_client():
    # Imported lazily so a laptop without boto3 still boots on the local path.
    import boto3
    from botocore.config import Config

    endpoint = _clean_endpoint(settings.s3_endpoint_url or "")
    host = (urlparse(endpoint).hostname or "").lower()
    #if host.endswith(".r2.cloudflarestorage.com"):
    #    _enable_r2_sni_workaround()

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=(settings.s3_access_key_id or "").strip().strip("\"'"),
        aws_secret_access_key=(settings.s3_secret_access_key or "").strip().strip("\"'"),
        region_name=(settings.s3_region or "auto").strip().strip("\"'") or "auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )


def _content_type_for(name: str, fallback: str | None = None) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return fallback or guessed or "application/octet-stream"


def _public_url(name: str) -> str | None:
    base = (settings.s3_public_base_url or "").strip().strip("\"'").rstrip("/")
    return f"{base}/{name}" if base else None


def _raise_storage(exc: Exception, *, action: str) -> None:
    logger.exception("object storage %s failed", action)
    raise HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        f"Object storage {action} failed — check S3_* / R2 credentials and endpoint",
    ) from exc


def store_bytes(payload: bytes, extension: str, content_type: str | None = None) -> str:
    """Persist `payload` and return the URL the API should hang on the row.

    Relative `/uploads/…` when serving through this app (local disk, or S3
    behind the same origin). Absolute when `S3_PUBLIC_BASE_URL` is set so the
    browser can hit the bucket directly.
    """
    name = f"{uuid.uuid4().hex}{extension}"
    media_type = _content_type_for(name, content_type)

    if object_storage_configured():
        try:
            _s3_client().put_object(
                Bucket=(settings.s3_bucket or "").strip().strip("\"'"),
                Key=name,
                Body=payload,
                ContentType=media_type,
                CacheControl="public, max-age=31536000, immutable",
            )
        except Exception as exc:  # noqa: BLE001 — surface every boto failure as 502
            _raise_storage(exc, action="upload")
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
        return FileResponse(local, media_type=media_type, headers=_cache_headers())

    public = _public_url(name)
    # Public base is the CDN path for bytes that never landed on this disk.
    # Redirect rather than proxy so cold Render instances don't pay the transfer.
    if public and object_storage_configured():
        return RedirectResponse(public, status_code=status.HTTP_302_FOUND)

    if not object_storage_configured():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    try:
        obj = _s3_client().get_object(
            Bucket=(settings.s3_bucket or "").strip().strip("\"'"),
            Key=name,
        )
    except Exception as exc:  # noqa: BLE001 — botocore raises many shapes for missing keys
        # Missing object → 404; TLS / auth / network → 502 so the dashboard shows why.
        error_name = type(exc).__name__
        if "NoSuchKey" in error_name or "404" in str(exc):
            logger.info("upload miss %s: %s", name, exc)
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc
        _raise_storage(exc, action="download")

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


def _endpoint_host() -> str:
    return (urlparse(_clean_endpoint(settings.s3_endpoint_url or "")).hostname or "").lower()


def storage_diagnostics() -> dict[str, object]:
    """Round-trip a throwaway object so an admin can see the real R2 error.

    Never returns secret values — only whether each is present, the endpoint
    host, and the precise boto3/botocore failure for each step. Admin-gated by
    the route that calls it.
    """
    report: dict[str, object] = {
        "backend": "s3" if object_storage_configured() else "local",
        "endpoint_host": _endpoint_host(),
        "bucket": (settings.s3_bucket or "").strip().strip("\"'") or None,
        "region": (settings.s3_region or "auto").strip().strip("\"'") or "auto",
        "public_base_url": bool(settings.s3_public_base_url),
        "have_access_key_id": bool((settings.s3_access_key_id or "").strip()),
        "have_secret_access_key": bool((settings.s3_secret_access_key or "").strip()),
        "steps": {},
    }
    steps: dict[str, str] = report["steps"]  # type: ignore[assignment]

    if not object_storage_configured():
        report["ok"] = False
        report["hint"] = "Object storage is not configured; running on local disk."
        return report

    bucket = report["bucket"]
    key = f"_diagnostics/{uuid.uuid4().hex}.txt"
    payload = b"po-calendar storage check"

    def describe(exc: Exception) -> str:
        response = getattr(exc, "response", None)
        if isinstance(response, dict):
            err = response.get("Error", {})
            code = err.get("Code", "")
            message = err.get("Message", "")
            request_id = response.get("ResponseMetadata", {}).get("RequestId", "")
            host_id = response.get("ResponseMetadata", {}).get("HostId", "")
            return f"{type(exc).__name__}: code={code!r} message={message!r} request_id={request_id!r} host_id={host_id!r}"
        return f"{type(exc).__name__}: {str(exc)[:300]}"

    try:
        client = _s3_client()
    except Exception as exc:  # noqa: BLE001
        steps["client"] = describe(exc)
        report["ok"] = False
        return report
    steps["client"] = "ok"

    for label, call in (
        ("write", lambda: client.put_object(Bucket=bucket, Key=key, Body=payload)),
        ("read", lambda: client.get_object(Bucket=bucket, Key=key)),
        ("delete", lambda: client.delete_object(Bucket=bucket, Key=key)),
    ):
        try:
            call()
            steps[label] = "ok"
        except Exception as exc:  # noqa: BLE001
            steps[label] = describe(exc)
            report["ok"] = False
            report["hint"] = _diagnose_hint(label, steps[label])
            return report

    report["ok"] = True
    return report


def _diagnose_hint(step: str, message: str) -> str:
    low = message.lower()
    if "ssl" in low or "handshake" in low:
        return "TLS to the R2 endpoint failed — check S3_ENDPOINT_URL account id."
    if "403" in low or "forbidden" in low or "accessdenied" in low or "signature" in low:
        return "Auth rejected — check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and that the token has Object Read & Write on this bucket."
    if "nosuchbucket" in low or "404" in low or "notfound" in low:
        return "Bucket not found — check S3_BUCKET matches the R2 bucket exactly."
    if "endpoint" in low or "resolve" in low or "connection" in low:
        return "Could not reach the endpoint — check S3_ENDPOINT_URL host."
    return f"Failed on {step}."
