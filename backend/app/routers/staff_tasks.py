"""Custom staff tasks: assigned by Manager/Admin, shown on the Task calendar."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..models import StaffTask, User, has_rank
from ..schemas import StaffTaskCreate, StaffTaskOut, StaffTaskUpdate
from ..security import EDITOR_FLOOR, get_current_user, require_editor

router = APIRouter(prefix="/api/staff-tasks", tags=["staff-tasks"])

CHECKLIST_MAX = 40
ITEM_TEXT_MAX = 200
COMMENT_MAX = 1000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_checklist(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    items: list[dict[str, Any]] = []
    for entry in raw:
        comment = ""
        completed_at = None
        if isinstance(entry, str):
            text = entry.strip()
            done = False
            item_id = str(uuid.uuid4())
        elif isinstance(entry, dict):
            text = str(entry.get("text") or "").strip()
            done = bool(entry.get("done"))
            raw_id = str(entry.get("id") or "").strip()
            item_id = raw_id or str(uuid.uuid4())
            comment = str(entry.get("comment") or "").strip()[:COMMENT_MAX]
            stamp = str(entry.get("completed_at") or "").strip() or None
            completed_at = stamp if done else None
            if done and not completed_at:
                completed_at = _now_iso()
        else:
            continue
        if not text:
            continue
        items.append(
            {
                "id": item_id,
                "text": text[:ITEM_TEXT_MAX],
                "done": done,
                "comment": comment,
                "completed_at": completed_at,
            }
        )
        if len(items) >= CHECKLIST_MAX:
            break
    return items


def _checklist_done(items: list[dict[str, Any]]) -> bool:
    return bool(items) and all(bool(item.get("done")) for item in items)


def _to_out(row: StaffTask) -> StaffTaskOut:
    return StaffTaskOut(
        id=row.id,
        title=row.title,
        description=row.description,
        due_date=row.due_date,
        done=row.done,
        checklist=_norm_checklist(row.checklist),
        assignee=row.assignee,
        creator=row.creator,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _load(db: Session, task_id: str) -> StaffTask:
    row = db.scalars(
        select(StaffTask)
        .options(selectinload(StaffTask.assignee), selectinload(StaffTask.creator))
        .where(StaffTask.id == task_id)
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    return row


def _get_assignee(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick an active person to assign")
    return user


def _can_edit_all(actor: User, task: StaffTask) -> bool:
    return has_rank(actor.role, EDITOR_FLOOR) or actor.id == task.creator_id


def _can_check_off(actor: User, task: StaffTask) -> bool:
    return actor.id == task.assignee_id or _can_edit_all(actor, task)


@router.get("", response_model=list[StaffTaskOut])
def list_tasks(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    mine: bool = False,
    start: date | None = Query(None),
    end: date | None = Query(None),
    q: str | None = Query(None),
) -> list[StaffTaskOut]:
    stmt = select(StaffTask).options(
        selectinload(StaffTask.assignee),
        selectinload(StaffTask.creator),
    )
    if mine:
        stmt = stmt.where(StaffTask.assignee_id == actor.id)
    if start:
        stmt = stmt.where(StaffTask.due_date >= start)
    if end:
        stmt = stmt.where(StaffTask.due_date <= end)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(StaffTask.title.ilike(like))
    rows = list(db.scalars(stmt.order_by(StaffTask.due_date, StaffTask.title)))
    return [_to_out(row) for row in rows]


@router.post("", response_model=StaffTaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: StaffTaskCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_editor),
) -> StaffTaskOut:
    _get_assignee(db, payload.assignee_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Title is required")
    row = StaffTask(
        title=title,
        description=(payload.description or "").strip() or None,
        due_date=payload.due_date,
        assignee_id=payload.assignee_id,
        creator_id=actor.id,
        checklist=_norm_checklist(payload.checklist),
    )
    row.done = _checklist_done(row.checklist or [])
    db.add(row)
    db.commit()
    return _to_out(_load(db, row.id))


@router.get("/{task_id}", response_model=StaffTaskOut)
def get_task(
    task_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> StaffTaskOut:
    return _to_out(_load(db, task_id))


@router.patch("/{task_id}", response_model=StaffTaskOut)
def update_task(
    task_id: str,
    payload: StaffTaskUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> StaffTaskOut:
    row = _load(db, task_id)
    data = payload.model_dump(exclude_unset=True)
    full_keys = {"title", "description", "due_date", "assignee_id"}
    if full_keys & data.keys() and not _can_edit_all(actor, row):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only a manager or the person who created this task can edit it",
        )
    if "checklist" in data and not _can_check_off(actor, row):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the assignee or a manager can update the checklist",
        )
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Title is required")
        row.title = title
    if "description" in data:
        row.description = (data["description"] or "").strip() or None
    if "due_date" in data and data["due_date"] is not None:
        row.due_date = data["due_date"]
    if "assignee_id" in data and data["assignee_id"]:
        _get_assignee(db, data["assignee_id"])
        row.assignee_id = data["assignee_id"]
    if "checklist" in data:
        row.checklist = _norm_checklist(data["checklist"])
    row.done = _checklist_done(_norm_checklist(row.checklist))
    db.commit()
    return _to_out(_load(db, row.id))


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: str,
    db: Session = Depends(get_db),
    actor: User = Depends(require_editor),
) -> Response:
    row = _load(db, task_id)
    db.delete(row)
    db.commit()
    del actor
    return Response(status_code=status.HTTP_204_NO_CONTENT)
