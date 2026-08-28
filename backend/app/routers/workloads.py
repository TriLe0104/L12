from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Role, User, Workload, has_rank
from ..schemas import WorkloadCreate, WorkloadOut, WorkloadUpdate
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/workloads", tags=["workloads"])

ALLOWED_KIND = {"mlperf", "inference", "training", "workspace", "network", "nccl"}
ALLOWED_STATUS = {"pending", "running", "completed", "failed", "stopped"}


@router.get("", response_model=list[WorkloadOut])
def list_workloads(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[WorkloadOut]:
    rows = list(db.scalars(select(Workload).order_by(Workload.created_at.desc())).all())
    return [WorkloadOut.model_validate(w) for w in rows]


@router.post("", response_model=WorkloadOut, status_code=status.HTTP_201_CREATED)
def create_workload(
    payload: WorkloadCreate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> WorkloadOut:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
    kind = payload.kind if payload.kind in ALLOWED_KIND else "mlperf"
    now = datetime.now(timezone.utc)
    running = kind in ("mlperf", "training", "inference", "network", "nccl")
    work = Workload(
        name=name,
        kind=kind,
        status="running" if running else "pending",
        project=payload.project.strip() or "firmus",
        department=payload.department.strip() or "default",
        node_pool=payload.node_pool,
        pods_running=payload.pods_requested if running else 0,
        pods_requested=max(1, payload.pods_requested),
        gpu_request=max(0, payload.gpu_request),
        gpu_allocation=payload.gpu_request if running else 0,
        gpu_mem_gb_request=max(0, payload.gpu_mem_gb_request),
        gpu_mem_gb_alloc=payload.gpu_mem_gb_request if running else 0,
        started_at=now if running else None,
        detail=payload.detail
        or ("Queued on Firmus GB300" if not running else "Scheduled on Firmus GB300 pool"),
    )
    db.add(work)
    db.commit()
    db.refresh(work)
    return WorkloadOut.model_validate(work)


@router.patch("/{workload_id}", response_model=WorkloadOut)
def update_workload(
    workload_id: str,
    payload: WorkloadUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkloadOut:
    if not has_rank(user.role, Role.MANAGER):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires Manager or above")
    work = db.get(Workload, workload_id)
    if work is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workload not found")
    data = payload.model_dump(exclude_unset=True)
    if "status" in data:
        st = data["status"]
        if st not in ALLOWED_STATUS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown status")
        work.status = st
        now = datetime.now(timezone.utc)
        if st == "running":
            work.started_at = work.started_at or now
            work.finished_at = None
            work.pods_running = work.pods_requested
            work.gpu_allocation = work.gpu_request
            work.gpu_mem_gb_alloc = work.gpu_mem_gb_request
        elif st in ("completed", "failed", "stopped"):
            work.finished_at = now
            work.pods_running = 0
            work.gpu_allocation = 0
            work.gpu_mem_gb_alloc = 0
        elif st == "pending":
            work.pods_running = 0
            work.gpu_allocation = 0
            work.gpu_mem_gb_alloc = 0
    for key in ("pods_running", "gpu_allocation", "gpu_mem_gb_alloc", "detail"):
        if key in data and data[key] is not None:
            setattr(work, key, data[key])
    db.commit()
    db.refresh(work)
    return WorkloadOut.model_validate(work)


@router.delete("/{workload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workload(
    workload_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
):
    work = db.get(Workload, workload_id)
    if work is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workload not found")
    db.delete(work)
    db.commit()
