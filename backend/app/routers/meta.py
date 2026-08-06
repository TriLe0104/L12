from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import board_service
from ..db import get_db
from ..models import (
    PRIORITY_META,
    ROLE_RANK,
    Inspection,
    role_label,
    roles_high_to_low,
)
from ..schemas import RoleMeta, StageMeta, StatusMeta

router = APIRouter(prefix="/api/meta", tags=["meta"])


@router.get("/priorities", response_model=list[StatusMeta])
def priorities() -> list[StatusMeta]:
    return [
        StatusMeta(value=priority.value, label=meta["label"], tone=meta["tone"])
        for priority, meta in PRIORITY_META.items()
    ]


@router.get("/stages", response_model=list[StageMeta])
def stages(db: Session = Depends(get_db)) -> list[StageMeta]:
    """Kanban columns from published board settings (seeded from the old stage catalog)."""
    doc = board_service.get_document(db)
    return [StageMeta(**row) for row in board_service.stages_for_meta(doc)]


@router.get("/statuses", response_model=list[StatusMeta])
def statuses(db: Session = Depends(get_db)) -> list[StatusMeta]:
    """Status catalog from published board settings."""
    doc = board_service.get_document(db)
    return [StatusMeta(**row) for row in board_service.statuses_for_meta(doc)]


@router.get("/roles", response_model=list[RoleMeta])
def roles() -> list[RoleMeta]:
    """Most authority first, with the rank so callers can order and compare too."""
    return [
        RoleMeta(value=r.value, label=role_label(r), rank=ROLE_RANK[r])
        for r in roles_high_to_low()
    ]


@router.get("/inspections")
def inspections() -> list[dict[str, str]]:
    return [{"value": i.value, "label": i.value.upper()} for i in Inspection]
