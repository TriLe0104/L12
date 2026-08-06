"""Published board settings — Admin writes, every signed-in user reads."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import board_service
from ..db import get_db
from ..models import User
from ..schemas import BoardSettingsOut, BoardSettingsUpdate
from ..security import get_current_user, require_admin

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/board", response_model=BoardSettingsOut)
def get_board_settings(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> BoardSettingsOut:
    row = board_service.ensure_row(db)
    return BoardSettingsOut(**board_service.document_out(row))


@router.put("/board", response_model=BoardSettingsOut)
def put_board_settings(
    payload: BoardSettingsUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
) -> BoardSettingsOut:
    row = board_service.save_document(db, payload.document, actor)
    return BoardSettingsOut(**board_service.document_out(row))
