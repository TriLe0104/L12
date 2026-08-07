from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Activity, User
from ..schemas import ModelUploadOut, UploadOut, UserOut
from ..security import require_editor, require_self_photo
from ..storage import store_bytes

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

MAX_BYTES = 8 * 1024 * 1024
ALLOWED = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}

# ---------------------------------------------------------------- 3D models --
# Stored and served byte-for-byte as uploaded: the browser translates CAD with
# WASM, so nothing here parses or rewrites geometry.
#
# 64 MB. The reference parts top out at 2.6 MB (a high-poly OBJ), so this leaves
# room for something an order of magnitude heavier without letting a mistaken
# upload sit in the uploads directory.
MODEL_MAX_BYTES = 64 * 1024 * 1024
MODEL_MAX_LABEL = "64 MB"

MODEL_FORMATS: dict[str, str] = {
    ".obj": "obj",
    ".fbx": "fbx",
    ".stp": "step",
    ".step": "step",
    ".3dm": "3dm",
}

# Keywords that open a line in a Wavefront OBJ. Enough of one has to appear in
# the head of the file for it to count as OBJ rather than "some text".
_OBJ_KEYWORDS = ("v ", "vn ", "vt ", "vp ", "f ", "o ", "g ", "s ", "usemtl ", "mtllib ")


def _looks_like_obj(head: bytes) -> bool:
    # OBJ is text; a NUL in the first block means something binary was renamed.
    if b"\x00" in head:
        return False
    try:
        text = head.decode("utf-8")
    except UnicodeDecodeError:
        return False
    # A truncated final line can still only start with a keyword if the real line
    # did, so there is nothing to gain by discarding it.
    return any(line.lstrip().startswith(_OBJ_KEYWORDS) for line in text.splitlines())


def _sniff(extension: str, head: bytes) -> bool:
    """Does the file's leading bytes agree with the extension it claims?

    The declared MIME type is ignored entirely -- browsers send
    `application/octet-stream`, or nothing at all, for every one of these.
    """
    if extension == ".fbx":
        # binary FBX carries a fixed signature; the ASCII flavour names itself
        # inside its opening comment block
        return head.startswith(b"Kaydara FBX Binary") or b"FBXHeaderExtension" in head
    if extension in (".stp", ".step"):
        return b"ISO-10303-21" in head[:512]
    if extension == ".3dm":
        return head.startswith(b"3D Geometry File Format")
    if extension == ".obj":
        return _looks_like_obj(head)
    return False


async def _read_image(file: UploadFile) -> tuple[bytes, str, str]:
    """Type and size validation shared by every image route.

    Returns the bytes, the extension to store them under, and the content type
    so no caller can accept an image on looser terms than any other.
    """
    if file.content_type not in ALLOWED:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Upload a PNG, JPEG, WebP or GIF image"
        )

    payload = await file.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Image must be under 8 MB")
    return payload, ALLOWED[file.content_type], file.content_type


@router.post("", response_model=UploadOut, status_code=status.HTTP_201_CREATED)
async def upload_image(
    file: UploadFile = File(...), _: User = Depends(require_editor)
) -> UploadOut:
    """A free-standing image for whoever asked for it -- today, a part photo.

    Editor-floor, because the only things you can hang one on are purchase
    orders. Profile photos go through /avatar instead.
    """
    payload, extension, content_type = await _read_image(file)
    url = store_bytes(payload, extension, content_type)
    name = url.rsplit("/", 1)[-1]
    return UploadOut(url=url, filename=file.filename or name)


@router.post("/avatar", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def upload_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: User = Depends(require_self_photo),
) -> User:
    """Store an image and hang it on the caller's own account, in one step.

    Deliberately not "hand out a URL and trust the caller to PATCH only their own
    record": this route takes no user id, so the sole record it can write is the
    caller's own avatar, and the sole thing it can produce is that avatar. That
    narrowness is what lets it sit open to every rank while the general image
    route above stays at EDITOR_FLOOR. Same type and size rules either way.
    """
    payload, extension, content_type = await _read_image(file)
    url = store_bytes(payload, extension, content_type)

    actor.avatar_url = url
    db.add(
        Activity(
            actor_id=actor.id,
            action="Photo updated",
            entity_type="user",
            entity_id=actor.id,
            detail=f"{actor.name}: {url}",
        )
    )
    db.commit()
    db.refresh(actor)
    return actor


@router.post("/model", response_model=ModelUploadOut, status_code=status.HTTP_201_CREATED)
async def upload_model(
    file: UploadFile = File(...), _: User = Depends(require_editor)
) -> ModelUploadOut:
    """The one 3D model an order may carry, stored exactly as uploaded.

    Editor-floor like the part photo, and for the same reason: a purchase order is
    the only thing a model can hang on. Nothing here converts geometry -- the
    viewer translates CAD in the browser with WASM -- so validation is the whole
    job, and it trusts neither the declared MIME type nor the extension on its
    own.
    """
    original = (file.filename or "").strip()
    extension = Path(original).suffix.lower()
    if extension not in MODEL_FORMATS:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Upload an OBJ, FBX, STEP (.stp/.step) or Rhino (.3dm) model",
        )

    payload = await file.read(MODEL_MAX_BYTES + 1)
    if len(payload) > MODEL_MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Model must be under {MODEL_MAX_LABEL}",
        )
    if not payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty")

    if not _sniff(extension, payload[:4096]):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"That file does not look like a {extension.lstrip('.').upper()} model - "
            f"its contents do not match the extension",
        )

    # A UUID on disk, same as images: the original name may contain spaces and
    # anything else a filesystem or URL would have an opinion about, so it is
    # carried in the response (and the PO row) rather than in the path.
    url = store_bytes(payload, extension)
    stored = url.rsplit("/", 1)[-1]
    return ModelUploadOut(
        url=url,
        filename=original or stored,
        size=len(payload),
        format=MODEL_FORMATS[extension],
    )
