from fastapi import APIRouter

from ..models import (
    PRIORITY_META,
    ROLE_RANK,
    STAGE_BY_STATUS,
    STAGE_META,
    STATUS_META,
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
def stages() -> list[StageMeta]:
    return [
        StageMeta(
            value=stage.value,
            label=meta["label"],
            tone=meta["tone"],
            statuses=[s.value for s, st in STAGE_BY_STATUS.items() if st == stage],
        )
        for stage, meta in STAGE_META.items()
    ]


@router.get("/statuses", response_model=list[StatusMeta])
def statuses() -> list[StatusMeta]:
    return [
        StatusMeta(value=status.value, label=meta["label"], tone=meta["tone"])
        for status, meta in STATUS_META.items()
    ]


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
