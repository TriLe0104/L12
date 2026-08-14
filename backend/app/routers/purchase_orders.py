from __future__ import annotations

import enum
import time
from collections.abc import Sequence
from datetime import date
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.attributes import flag_modified

from sqlalchemy import case, func

from .. import board_service
from .. import traveler as traveler_svc
from ..db import get_db
from ..models import (
    Activity,
    POComment,
    PurchaseOrder,
    User,
    has_rank,
    role_label,
)
from ..schemas import (
    ActivityOut,
    COMMENT_MAX_LEN,
    CommentCreate,
    CommentOut,
    LastModified,
    OwnerBrief,
    POCreate,
    POOut,
    POUpdate,
    DisplayPartUpdate,
    PartCreate,
    PartUpdate,
    POWithPartUpdate,
    TravelerDraftOut,
    TravelerDraftUpdate,
    TravelerGenerateBody,
)
from ..security import (
    EDITOR_FLOOR,
    LOCKED_PO_FLOOR,
    PEOPLE_FLOOR,
    STATUS_FLOOR,
    get_current_user,
    require_editor,
)

router = APIRouter(prefix="/api/purchase-orders", tags=["purchase-orders"])

def _guard_locked(po: PurchaseOrder, actor: User) -> None:
    """Every write to an existing PO goes through here, unlocking included.

    Anyone who can edit may *set* a lock, but a locked order narrows to
    LOCKED_PO_FLOOR and above. The state that matters is the one already in the
    database, so clearing the lock counts as changing a locked order -- which is
    exactly the intent.
    """
    if po.locked and not has_rank(actor.role, LOCKED_PO_FLOOR):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"{po.job_no} is locked. Only an {role_label(LOCKED_PO_FLOOR).lower()} "
            f"can change or unlock it.",
        )


def _as_parts_list(po: PurchaseOrder) -> list[dict[str, Any]]:
    """Copy of the parts JSON. SQLAlchemy does not track in-place list mutation."""
    raw = getattr(po, "parts", None)
    if not isinstance(raw, list) or not raw:
        return []
    return [dict(p) if isinstance(p, dict) else p for p in raw]


def _top_level_as_part(po: PurchaseOrder) -> dict[str, Any]:
    return {
        "part_number": po.part_number,
        "part_name": po.part_number,
        "qty": po.qty,
        "dims": po.dims,
        "mat_dim": po.mat_dim,
        "material": po.material,
        "finish": po.finish,
        "inspection": po.inspection,
        "hardware": po.hardware,
        "priority": po.priority,
        "certificates": po.certificates
        or (
            (po.custom_fields or {}).get("certificates")
            if isinstance(po.custom_fields, dict)
            else None
        ),
        "custom_fields": dict(po.custom_fields) if isinstance(po.custom_fields, dict) else {},
        "thumbnail_url": po.thumbnail_url,
        "model_url": po.model_url,
        "model_filename": po.model_filename,
        "model_size": po.model_size,
        "status": po.status,
        "note": po.note,
    }


def _part_entry_from_create(payload: PartCreate) -> dict[str, Any]:
    return {
        "part_number": payload.part_number.strip() if isinstance(payload.part_number, str) else payload.part_number,
        "part_name": payload.part_name or payload.part_number,
        "qty": int(payload.qty) if payload.qty is not None else 1,
        "dims": payload.dims,
        "mat_dim": payload.mat_dim,
        "material": payload.material,
        "finish": payload.finish,
        "inspection": payload.inspection,
        "hardware": bool(payload.hardware) if payload.hardware is not None else False,
        "priority": payload.priority,
        "certificates": payload.certificates,
        "custom_fields": dict(payload.custom_fields) if isinstance(payload.custom_fields, dict) else {},
        "thumbnail_url": payload.thumbnail_url,
        "model_url": payload.model_url,
        "model_filename": payload.model_filename,
        "model_size": payload.model_size,
        "status": payload.status or "need_material_size",
        "note": payload.note or "",
    }


def _apply_part_update(part: dict[str, Any], payload: PartUpdate) -> dict[str, Any]:
    """Apply only fields the client actually sent, including explicit nulls."""
    data = payload.model_dump(exclude_unset=True)
    if "part_number" in data and isinstance(data["part_number"], str):
        data["part_number"] = data["part_number"].strip()
    if "qty" in data and data["qty"] is not None:
        data["qty"] = int(data["qty"])
    if "hardware" in data and data["hardware"] is not None:
        data["hardware"] = bool(data["hardware"])
    part.update(data)
    return part


def _adopt_part_media(po: PurchaseOrder, part: dict[str, Any]) -> None:
    """Fill empty PO-level media from a part, without overwriting another part's art."""
    if not po.thumbnail_url and part.get("thumbnail_url"):
        po.thumbnail_url = part.get("thumbnail_url")
    if not po.model_url and part.get("model_url"):
        po.model_url = part.get("model_url")
        po.model_filename = part.get("model_filename")
        po.model_size = part.get("model_size")


def _set_parts(po: PurchaseOrder, parts: list[dict[str, Any]]) -> None:
    po.parts = parts
    flag_modified(po, "parts")


def _copy_status_to_parts(po: PurchaseOrder, status: str) -> None:
    parts = _as_parts_list(po)
    if not parts:
        return
    for part in parts:
        if isinstance(part, dict):
            part["status"] = status
    _set_parts(po, parts)


def _freeze_part_statuses(po: PurchaseOrder) -> None:
    """Write the current PO status onto any part that never stored its own.

    After that, a later rollup of `po.status` cannot make sibling parts appear
    to change. Only missing values are filled.
    """
    parts = _as_parts_list(po)
    if len(parts) < 2:
        return
    current = _status_key(po.status)
    changed = False
    for part in parts:
        if isinstance(part, dict) and not part.get("status"):
            part["status"] = current
            changed = True
    if changed:
        _set_parts(po, parts)


def _set_part_status(po: PurchaseOrder, index: int, status: str) -> None:
    """Change one part's status and leave the others alone."""
    _freeze_part_statuses(po)
    parts = _as_parts_list(po)
    if not parts:
        return
    idx = min(max(index, 0), len(parts) - 1)
    if isinstance(parts[idx], dict):
        parts[idx]["status"] = status
        _set_parts(po, parts)


def _persist_rollup_status(db: Session, po: PurchaseOrder) -> None:
    doc = board_service.get_document(db)
    rollup = board_service.rollup_status(po, doc)
    if rollup and po.status != rollup:
        po.status = rollup


def _freeze_part_priorities(po: PurchaseOrder) -> None:
    """Stamp the current PO priority onto parts that never stored their own."""
    parts = _as_parts_list(po)
    if len(parts) < 2:
        return
    current = po.priority
    if hasattr(current, "value"):
        current = current.value  # type: ignore[assignment]
    current = str(current or "normal").casefold()
    changed = False
    for part in parts:
        if isinstance(part, dict) and not part.get("priority"):
            part["priority"] = current
            changed = True
    if changed:
        _set_parts(po, parts)


def _persist_rollup_priority(db: Session, po: PurchaseOrder) -> None:
    """Parent priority is the hottest of its parts."""
    parts = _as_parts_list(po)
    if len(parts) < 2:
        return
    opts = [str(o).casefold() for o in board_service.field_options(db=db, field_key="priority")]
    if not opts:
        opts = ["hot", "high", "normal", "low"]
    rank = {key: i for i, key in enumerate(opts)}
    best: str | None = None
    best_i = 10_000
    for part in parts:
        if not isinstance(part, dict):
            continue
        raw = part.get("priority") or po.priority or "normal"
        if hasattr(raw, "value"):
            raw = raw.value
        key = str(raw).casefold()
        i = rank.get(key, 10_000)
        if i < best_i:
            best_i = i
            best = key
    if best and str(getattr(po.priority, "value", po.priority)).casefold() != best:
        po.priority = best


def _traveler_part_index(po: PurchaseOrder, part: int | None) -> int | None:
    """Convert a 1-based `?part=` query into a 0-based index."""
    parts = _as_parts_list(po)
    if isinstance(part, int) and part > 0:
        return part - 1
    if parts:
        return 0
    return None


def _resolve_owner(db: Session, owner_id: str | None) -> User | None:
    """Turn a submitted owner id into a real person, or refuse it.

    SQLite does not enforce the foreign key by default, so without this an
    unknown id would be written straight through and leave the board showing an
    order nobody owns. The message is a plain string because the client only
    surfaces `detail` when it is one.
    """
    if owner_id is None:
        return None
    owner = db.get(User, owner_id)
    if owner is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "That person is no longer in the directory — pick someone else, or leave it unassigned.",
        )
    return owner


def _owner_name(owner: User | None) -> str:
    return owner.name if owner else "Unassigned"


def _attach_last_modified(db: Session, pos: Sequence[PurchaseOrder]) -> None:
    """Hang "who touched this last, and when" on each order from the activity trail.

    What counts as a modification is decided by the `entity_type` filter alone:
    only rows written against the order itself. That is what keeps a sign-in, an
    avatar change or a role edit -- all of which are `entity_type="user"` -- from
    making somebody the last modifier of an order they never opened.

    Creation counts. The first row in an order's trail is a write to that order,
    and on a board where half the jobs have not been edited since they were
    entered, "Tri Le, 4 Aug" is the true answer to who last touched it; an em
    dash there would claim we have no provenance when we do. The timestamp in
    the cell tells a manager whether that was data entry or a real edit.

    Rows with no actor cannot name a modifier, so they are skipped rather than
    winning and rendering blank -- the column answers "modified *by*". Deleting
    a person cascades their activity away (User.activity is delete-orphan), so a
    departed account cannot leave a dangling name here either.

    One statement for the whole page: row_number() over the trail, partitioned by
    order, newest first, with the activity id breaking ties so a re-seeded board
    with identical timestamps still resolves to exactly one row.
    """
    ids = [po.id for po in pos]
    for po in pos:  # a default, so POOut never has to fall back to its own
        po.last_modified = None
    if not ids:
        return

    ranked = (
        select(
            Activity.entity_id.label("po_id"),
            Activity.actor_id.label("actor_id"),
            Activity.action.label("action"),
            Activity.created_at.label("at"),
            func.row_number()
            .over(
                partition_by=Activity.entity_id,
                order_by=(Activity.created_at.desc(), Activity.id.desc()),
            )
            .label("rn"),
        )
        .where(
            Activity.entity_type == "purchase_order",
            Activity.entity_id.in_(ids),
            Activity.actor_id.is_not(None),
            # Traveler generate (and any future non-modifying actions) must not
            # move the dashboard Modified column.
            Activity.action.notin_(tuple(traveler_svc.NON_MODIFYING_ACTIONS)),
        )
        .subquery()
    )
    stmt = (
        select(ranked.c.po_id, ranked.c.action, ranked.c.at, User)
        .join(User, User.id == ranked.c.actor_id)
        .where(ranked.c.rn == 1)
    )
    # `at` arrives aware and in UTC: that is `UtcDateTime` in db.py doing it for
    # every datetime the app reads, rather than this column being a special case.
    latest = {
        po_id: LastModified(by=OwnerBrief.model_validate(actor), at=at, action=action)
        for po_id, action, at, actor in db.execute(stmt)
    }
    for po in pos:
        po.last_modified = latest.get(po.id)


def _attach_comment_counts(db: Session, pos: Sequence[PurchaseOrder]) -> None:
    """Hang `comment_count` on each order in one GROUP BY — dashboard badge fuel.

    Comments live on their own table and never write activity, so this count is
    independent of `_attach_last_modified` and cannot move the Modified column.
    """
    ids = [po.id for po in pos]
    for po in pos:
        po.comment_count = 0
        po.part_comment_counts = {}
    if not ids:
        return
    stmt = (
        select(POComment.purchase_order_id, POComment.part_index, func.count())
        .where(POComment.purchase_order_id.in_(ids))
        .group_by(POComment.purchase_order_id, POComment.part_index)
    )
    totals: dict[str, int] = {}
    by_part: dict[str, dict[str, int]] = {}
    for po_id, part_index, n in db.execute(stmt):
        totals[po_id] = totals.get(po_id, 0) + int(n)
        if part_index is not None:
            by_part.setdefault(po_id, {})[str(int(part_index))] = int(n)
    for po in pos:
        po.comment_count = totals.get(po.id, 0)
        po.part_comment_counts = by_part.get(po.id, {})


def _enrich(db: Session, pos: Sequence[PurchaseOrder]) -> None:
    board_service.apply_po_overlays(db, list(pos))
    _attach_last_modified(db, pos)
    _attach_comment_counts(db, pos)


def _status_key(value: object) -> str:
    if isinstance(value, enum.Enum):
        return str(value.value)
    return str(value)


def _assert_known_status(db: Session, key: str) -> None:
    doc = board_service.get_document(db)
    if key not in board_service.status_map(doc):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown status {key!r}. Pick one from the board catalog.",
        )


def _assert_known_column(db: Session, key: str) -> None:
    doc = board_service.get_document(db)
    if board_service.column_meta(doc, key) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown kanban column {key!r}.",
        )


def _log(db: Session, actor: User, action: str, po: PurchaseOrder, detail: str | None = None) -> None:
    db.add(
        Activity(
            actor_id=actor.id,
            action=action,
            entity_type="purchase_order",
            entity_id=po.id,
            detail=detail,
        )
    )


# Fields that earn a line of their own in the trail, and so are kept out of the
# generic "PO updated" list rather than being reported twice.
_OWN_LINE = frozenset({"status", "due_date", "locked", "owner_id"})

# An explicit null can never be a legitimate value for one of these.
_NOT_NULLABLE = frozenset(c.name for c in PurchaseOrder.__table__.columns if not c.nullable)


def _canonical(value: object) -> object:
    """One shape for a value however it arrived, so an echo is not read as an edit.

    The drawer PATCHes its whole draft on every save, so this side of the wire
    meets the same round-trip distortions `frontend/lib/dirty.ts` had to flatten
    on the other: a form control never hands back exactly what the API sent it.
    `None` and an empty string both mean "nothing here"; a string carries
    whatever whitespace was typed and deleted.

    Enums collapse to their *value*. The database stores the member NAME
    ("NORMAL" -- see the note at the top of migrations.py), but that spelling
    never reaches here: SQLAlchemy hands back a member and Pydantic parses one,
    so `.value` is the one representation both sides already share. `str()` would
    not be, since on a str-mixin enum it prints "Priority.NORMAL".

    A date is compared as its day. That covers a due date rendered as the instant
    at midnight and sent back that way -- Pydantic parses it to a `date` before it
    gets here, so the truncation happens on the typed value and never on free
    text, where a note that merely begins with a timestamp would otherwise hide a
    real edit.
    """
    if value is None:
        return ""
    if isinstance(value, bool):  # before int, because a bool is one
        return value
    if isinstance(value, enum.Enum):
        return _canonical(value.value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, date):  # datetime is a date; a due date has no time
        return value.isoformat()[:10]
    if isinstance(value, str):
        return value.strip()
    return value


def _same(before: object, after: object) -> bool:
    if before == after:
        return True
    before_blank, after_blank = before == "", after == ""
    # `null`, an absent value and an empty string all mean "nothing here", so one
    # standing in for another is not a change
    if before_blank and after_blank:
        return True
    # an absent boolean is an off boolean: a form that never drew the checkbox is
    # not asking for a lock to be cleared
    if before_blank or after_blank:
        return before is False or after is False
    if isinstance(before, bool) or isinstance(after, bool):
        return bool(before) == bool(after)
    # a numeric field can arrive as either, depending on which side of the input
    # it came from
    if isinstance(before, (int, float)) or isinstance(after, (int, float)):
        try:
            return float(before) == float(after)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
    return False


def _differs(po: PurchaseOrder, field: str, value: object) -> bool:
    """Has this field really moved away from what is stored?

    An explicit null for a column that cannot hold one is not an instruction --
    it is a payload that never carried the field meaningfully -- so it reads as
    "no change" rather than as a request to write NULL and fail the constraint.
    """
    if value is None and field in _NOT_NULLABLE:
        return False
    if field == "custom_fields":
        before = getattr(po, "custom_fields", None) or {}
        after = value or {}
        if not isinstance(after, dict):
            return True
        return before != after
    return not _same(_canonical(getattr(po, field)), _canonical(value))


@router.get("", response_model=list[POOut])
def list_pos(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
    start: date | None = Query(None, description="due_date >= start"),
    end: date | None = Query(None, description="due_date <= end"),
    status_in: list[str] | None = Query(None, alias="status"),
    stage: str | None = None,
    priority: str | None = None,
    owner_id: str | None = None,
    q: str | None = Query(None, description="search job / PO / part / material"),
    sort: str = Query(
        "due_asc",
        pattern="^(due_asc|due_desc|priority_desc|priority_asc|job)$",
        description="due_asc | due_desc | priority_desc | priority_asc | job",
    ),
) -> list[PurchaseOrder]:
    stmt = select(PurchaseOrder).options(selectinload(PurchaseOrder.owner))
    if start:
        stmt = stmt.where(PurchaseOrder.due_date >= start)
    if end:
        stmt = stmt.where(PurchaseOrder.due_date <= end)
    if status_in:
        stmt = stmt.where(PurchaseOrder.status.in_(status_in))
    if stage:
        doc = board_service.get_document(db)
        members = next(
            (col.get("statusKeys") or [] for col in doc.get("kanbanColumns", []) if col.get("key") == stage),
            None,
        )
        if members is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown stage {stage!r}")
        stmt = stmt.where(PurchaseOrder.status.in_(list(members)))
    if priority:
        stmt = stmt.where(PurchaseOrder.priority == priority.casefold())
    if owner_id:
        stmt = stmt.where(PurchaseOrder.owner_id == owner_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                PurchaseOrder.job_no.ilike(like),
                PurchaseOrder.po_number.ilike(like),
                PurchaseOrder.part_number.ilike(like),
                PurchaseOrder.material.ilike(like),
                PurchaseOrder.customer.ilike(like),
            )
        )
    # Rank from published priority options order (hot-first day-one seed).
    prio_opts = board_service.field_options(db=db, field_key="priority")
    rank = case(
        *[(PurchaseOrder.priority == opt.casefold(), i) for i, opt in enumerate(prio_opts)],
        else_=len(prio_opts) + 1,
    )
    order = {
        "due_asc": (PurchaseOrder.due_date.asc(), rank.asc()),
        "due_desc": (PurchaseOrder.due_date.desc(), rank.asc()),
        "priority_desc": (rank.asc(), PurchaseOrder.due_date.asc()),
        "priority_asc": (rank.desc(), PurchaseOrder.due_date.asc()),
        "job": (PurchaseOrder.job_no.asc(),),
    }[sort]

    rows = list(db.scalars(stmt.order_by(*order, PurchaseOrder.job_no)))
    _enrich(db, rows)
    return rows


@router.post("", response_model=POOut, status_code=status.HTTP_201_CREATED)
def create_po(
    payload: POCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_editor),
) -> PurchaseOrder:
    # New work can't be dated before today. This lives on the create route instead of
    # on POCreate so it cannot leak into PATCH: the board is full of overdue jobs that
    # still have to be editable, and the demo seed builds ORM rows directly anyway.
    today = date.today()
    if payload.due_date < today:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Due date cannot be in the past; pick {today.isoformat()} or later",
        )
    _assert_known_status(db, payload.status)
    board_service.assert_known_material(db, payload.material)
    board_service.assert_known_inspection(db, payload.inspection)
    board_service.assert_known_priority(db, payload.priority)
    board_service.assert_known_custom_selects(db, payload.custom_fields)
    data = payload.model_dump()
    if data.get("custom_fields") is None:
        data["custom_fields"] = {}
    # Normalize textual fields that affect identity/matching so creating a new
    # part with the same PO number but extra whitespace still appends rather
    # than creating a separate top-level PO.
    if isinstance(data.get("po_number"), str):
        data["po_number"] = data["po_number"].strip()
    if isinstance(data.get("part_number"), str):
        data["part_number"] = data["part_number"].strip()
    if isinstance(data.get("inspection"), str):
        data["inspection"] = data["inspection"].strip().casefold()
    if isinstance(data.get("priority"), str):
        data["priority"] = data["priority"].strip().casefold()

    # If a PO with the same po_number already exists, treat this create as
    # adding another part/component to that order rather than making a new top
    # level PO row. This keeps the dashboard grouped by PO and enables
    # multi-part orders without a migration to a parts table.
    existing = db.scalars(select(PurchaseOrder).where(PurchaseOrder.po_number == data.get("po_number"))).first()
    if existing is not None:
        part_entry = {
            "part_number": data.get("part_number"),
            "part_name": data.get("model_filename") or data.get("part_number"),
            "qty": data.get("qty"),
            "dims": data.get("dims"),
            "mat_dim": data.get("mat_dim"),
            "material": data.get("material"),
            "finish": data.get("finish"),
            "inspection": data.get("inspection"),
            "hardware": data.get("hardware"),
            "priority": data.get("priority"),
            "thumbnail_url": data.get("thumbnail_url"),
        }
        # If the existing PO has no `parts` array yet, promote the current
        # top-level part into the parts list so both the original and the new
        # part are preserved on the PO.
        parts = _as_parts_list(existing)
        if not parts and existing.part_number is not None:
            parts.append(_top_level_as_part(existing))
        parts.append(part_entry)
        _set_parts(existing, parts)
        # If the PO had no top-level thumbnail, adopt the new part's thumbnail so
        # the dashboard shows a photo at the order level.
        if not existing.thumbnail_url and part_entry.get("thumbnail_url"):
            existing.thumbnail_url = part_entry.get("thumbnail_url")
        db.add(
            Activity(
                actor_id=actor.id,
                action="Part added",
                entity_type="purchase_order",
                entity_id=existing.id,
                detail=f"Added part {part_entry.get('part_number')} to {existing.job_no} · {existing.po_number}",
            )
        )
        db.commit()
        db.refresh(existing)
        _enrich(db, [existing])
        return existing

    po = PurchaseOrder(**data)
    # No owner field at all means "mine", the old behaviour. An explicit null is
    # the picker saying Unassigned, and has to survive rather than snap back to
    # the creator.
    if "owner_id" not in payload.model_fields_set:
        po.owner_id = actor.id
    else:
        _resolve_owner(db, po.owner_id)
    db.add(po)
    db.flush()
    _log(db, actor, "PO created", po, f"{po.job_no} · {po.po_number}")
    db.commit()
    db.refresh(po)
    _enrich(db, [po])
    return po


@router.get("/{po_id}", response_model=POOut)
def get_po(
    po_id: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)
) -> PurchaseOrder:
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _enrich(db, [po])
    return po


@router.post("/{po_id}/parts", response_model=POOut, status_code=status.HTTP_201_CREATED)
def add_part(
    po_id: str,
    payload: PartCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PurchaseOrder:
    """Append a part to an existing PO's parts list.

    This endpoint makes appending parts explicit and robust for clients that
    are editing an existing order in-place.
    """
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _guard_locked(po, actor)

    part_entry = _part_entry_from_create(payload)

    _freeze_part_statuses(po)
    _freeze_part_priorities(po)
    parts = _as_parts_list(po)
    if not parts and po.part_number is not None:
        parts.append(_top_level_as_part(po))
    parts.append(part_entry)
    _set_parts(po, parts)
    _adopt_part_media(po, part_entry)
    _persist_rollup_status(db, po)
    _persist_rollup_priority(db, po)

    db.add(
        Activity(
            actor_id=actor.id,
            action="Part added",
            entity_type="purchase_order",
            entity_id=po.id,
            detail=f"Added part {part_entry.get('part_number')} to {po.job_no} · {po.po_number}",
        )
    )
    db.commit()
    db.refresh(po)
    _enrich(db, [po])
    return po


@router.patch("/{po_id}/parts/{index}", response_model=POOut)
def update_part(
    po_id: str,
    index: int,
    payload: PartUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PurchaseOrder:
    """Update a specific part within a PO.parts list.

    Index is zero-based. Only the provided fields are changed.
    """
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _guard_locked(po, actor)

    parts = _as_parts_list(po)
    if index < 0 or index >= len(parts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Part index out of range")

    _freeze_part_statuses(po)
    _freeze_part_priorities(po)
    parts = _as_parts_list(po)
    part = _apply_part_update(dict(parts[index] or {}), payload)
    parts[index] = part
    _set_parts(po, parts)
    _adopt_part_media(po, part)
    _persist_rollup_status(db, po)
    _persist_rollup_priority(db, po)

    db.add(
        Activity(
            actor_id=actor.id,
            action="Part updated",
            entity_type="purchase_order",
            entity_id=po.id,
            detail=f"Updated part {index + 1} on {po.job_no} · {po.po_number}",
        )
    )
    db.commit()
    db.refresh(po)
    _enrich(db, [po])
    return po


@router.patch("/{po_id}/display-part", response_model=POOut)
def set_display_part(
    po_id: str,
    payload: DisplayPartUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PurchaseOrder:
    """Choose which part the board cards show. Visible to every client.

    User+ may flip this even on a locked order: it is which face the card
    wears, not an edit of the order itself. Does not move Modified.
    """
    if not has_rank(actor.role, STATUS_FLOOR):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Requires {role_label(STATUS_FLOOR).lower()} or above",
        )
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    parts = _as_parts_list(po)
    if not parts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This order has no parts list")
    if payload.index < 0 or payload.index >= len(parts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Part index out of range")
    if po.display_part_index != payload.index:
        po.display_part_index = payload.index
        chosen = parts[payload.index] if isinstance(parts[payload.index], dict) else {}
        label = chosen.get("part_number") or chosen.get("part_name") or f"Part {payload.index + 1}"
        db.add(
            Activity(
                actor_id=actor.id,
                action="Display part set",
                entity_type="purchase_order",
                entity_id=po.id,
                detail=f"{po.job_no}: showing {label} ({payload.index + 1} of {len(parts)})",
            )
        )
        db.commit()
        db.refresh(po)
    _enrich(db, [po])
    return po


@router.patch("/{po_id}/with-part", response_model=POOut)
def update_po_with_part(
    po_id: str,
    payload: POWithPartUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PurchaseOrder:
    """Atomically update a PO and optionally a specific part in its parts list.

    The provided `fields` are treated like POUpdate (only set keys apply). If
    `part_index` and `part` are given, the part update is applied first. Both
    changes are committed together and a single PO is returned.
    """
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _guard_locked(po, actor)

    # Apply part update if requested
    part_status_applied = False
    if payload.part_index is not None and payload.part is not None:
        idx = payload.part_index
        parts = _as_parts_list(po)
        if idx < 0 or idx >= len(parts):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Part index out of range")
        _freeze_part_statuses(po)
        _freeze_part_priorities(po)
        parts = _as_parts_list(po)
        part = _apply_part_update(dict(parts[idx] or {}), payload.part)
        parts[idx] = part
        _set_parts(po, parts)
        _adopt_part_media(po, part)
        _persist_rollup_status(db, po)
        _persist_rollup_priority(db, po)
        part_dump = payload.part.model_dump(exclude_unset=True)
        part_status_applied = "status" in part_dump
        db.add(
            Activity(
                actor_id=actor.id,
                action="Part updated",
                entity_type="purchase_order",
                entity_id=po.id,
                detail=f"Updated part {idx + 1} on {po.job_no} · {po.po_number}",
            )
        )

    # Apply PO-level changes if provided
    if payload.fields is not None:
        changes = payload.fields.model_dump(exclude_unset=True) if hasattr(payload.fields, 'model_dump') else {}
        if part_status_applied:
            changes.pop("status", None)
            changes.pop("stage", None)
        # Handle stage -> status mapping similar to update_po
        moved_to = changes.pop("stage", None)
        if moved_to:
            _assert_known_column(db, moved_to)
            doc = board_service.get_document(db)
            current_col = board_service.column_for_status(doc, _status_key(po.status))
            if current_col != moved_to:
                default = board_service.default_status_for_column(doc, moved_to)
                if not default:
                    raise HTTPException(
                        status.HTTP_400_BAD_REQUEST,
                        f"Kanban column {moved_to!r} has no default status",
                    )
                changes.setdefault("status", default)

        if "status" in changes:
            _assert_known_status(db, _status_key(changes["status"]))

        # Apply simple attribute updates
        for key, val in changes.items():
            if hasattr(po, key):
                setattr(po, key, val)

        if changes:
            db.add(
                Activity(
                    actor_id=actor.id,
                    action="PO updated",
                    entity_type="purchase_order",
                    entity_id=po.id,
                    detail=f"Updated fields: {', '.join(changes.keys())}",
                )
            )

    db.commit()
    db.refresh(po)
    _enrich(db, [po])
    return po


# Fields a STATUS_FLOOR actor may actually move. `stage` is accepted on the
# wire (kanban drag) but resolves to a status change above, so it never appears
# in `changed` itself.
_STATUS_ONLY = frozenset({"status"})


@router.patch("/{po_id}", response_model=POOut)
def update_po(
    po_id: str,
    payload: POUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PurchaseOrder:
    # Viewer stays out. User clears STATUS_FLOOR for status/stage only; Manager+
    # keeps the full editor path. Checked up front so a Viewer never meets the
    # locked-order message for an edit they could not make either way.
    if not has_rank(actor.role, STATUS_FLOOR):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Requires {role_label(STATUS_FLOOR)} or above",
        )

    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _guard_locked(po, actor)

    changes = payload.model_dump(exclude_unset=True)

    moved_to = changes.pop("stage", None)
    if moved_to:
        _assert_known_column(db, moved_to)
        doc = board_service.get_document(db)
        current_col = board_service.column_for_status(doc, _status_key(po.status))
        if current_col != moved_to:
            default = board_service.default_status_for_column(doc, moved_to)
            if not default:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Kanban column {moved_to!r} has no default status",
                )
            changes.setdefault("status", default)

    if "status" in changes:
        _assert_known_status(db, _status_key(changes["status"]))

    # The drawer sends its whole draft, so most of what arrives is an echo of what
    # is already stored. Narrowing to what genuinely moved, once, is what keeps the
    # trail honest: pressing Save on an untouched order used to name whoever
    # pressed it in the dashboard's Modified column for a change nobody made.
    changed = {field: value for field, value in changes.items() if _differs(po, field, value)}

    if "material" in changed:
        board_service.assert_known_material(db, changed.get("material"))
    if "inspection" in changed:
        board_service.assert_known_inspection(db, changed.get("inspection"))
        if isinstance(changed.get("inspection"), str):
            changed["inspection"] = changed["inspection"].strip().casefold()
    if "priority" in changed:
        board_service.assert_known_priority(db, changed.get("priority"))
        if isinstance(changed.get("priority"), str):
            changed["priority"] = changed["priority"].strip().casefold()
    if "custom_fields" in changed:
        board_service.assert_known_custom_selects(db, changed.get("custom_fields"))

    # Below editor floor, only a real status (or stage→status) move is allowed.
    # No-op echoes of other fields are already gone from `changed`, so a User
    # saving the drawer's whole draft after flipping status alone still passes.
    if not has_rank(actor.role, EDITOR_FLOOR):
        forbidden = sorted(field for field in changed if field not in _STATUS_ONLY)
        if forbidden:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Users may only change status or stage. "
                f"Requires {role_label(EDITOR_FLOOR).lower()} or above to edit other fields.",
            )

    if "status" in changed:
        before = _status_key(po.status)
        after = _status_key(changed["status"])
        _log(db, actor, "Status changed", po, f"{before} -> {after}")
        parts = _as_parts_list(po)
        if len(parts) > 1:
            idx = getattr(po, "display_part_index", 0) or 0
            _set_part_status(po, int(idx), after)
            _persist_rollup_status(db, po)
            changed.pop("status", None)
        else:
            _copy_status_to_parts(po, after)
    if "due_date" in changed:
        _log(db, actor, "Due date moved", po, f"{po.due_date} -> {changed['due_date']}")
    if "locked" in changed:
        was, now = ("locked", "unlocked") if po.locked else ("unlocked", "locked")
        _log(db, actor, f"PO {now}", po, f"{po.job_no}: {was} -> {now}")
    # `exclude_unset` above is what keeps "leave the owner alone" apart from
    # "clear the owner": an absent field never reaches here, an explicit null does.
    if "owner_id" in changed:
        handed_to = _resolve_owner(db, changed["owner_id"])
        _log(db, actor, "Owner changed", po,
             f"{po.job_no}: {_owner_name(po.owner)} -> {_owner_name(handed_to)}")

    # Only the moved fields are assigned, which is also what leaves `updated_at`
    # alone on a save that changed nothing: SQLAlchemy issues no UPDATE for a row
    # it finds unmodified, so the stamp cannot claim an edit the trail denies.
    for field, value in changed.items():
        setattr(po, field, value)

    # Fields with a line of their own above are kept out of the catch-all, or a
    # reassignment would be reported twice.
    other = sorted(field for field in changed if field not in _OWN_LINE)
    if other:
        _log(db, actor, "PO updated", po, ", ".join(other))

    db.commit()
    db.refresh(po)
    _enrich(db, [po])
    return po


@router.delete("/{po_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_po(
    po_id: str, db: Session = Depends(get_db), actor: User = Depends(require_editor)
) -> None:
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    _guard_locked(po, actor)
    _log(db, actor, "PO deleted", po, f"{po.job_no} · {po.po_number}")
    db.delete(po)
    db.commit()


@router.get("/{po_id}/activity", response_model=list[ActivityOut])
def po_activity(
    po_id: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)
) -> list[Activity]:
    stmt = (
        select(Activity)
        .options(selectinload(Activity.actor))
        .where(Activity.entity_type == "purchase_order", Activity.entity_id == po_id)
        .order_by(Activity.created_at.desc())
        .limit(50)
    )
    return list(db.scalars(stmt))


def _require_po(db: Session, po_id: str) -> PurchaseOrder:
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    return po


@router.get("/{po_id}/comments", response_model=list[CommentOut])
def list_comments(
    po_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
    part: int | None = Query(None, ge=1),
    all_threads: bool = Query(False, alias="all"),
) -> list[POComment]:
    """Oldest first — chat order. Any signed-in rank; lock does not apply.

    Omit ``part`` for the project-wide thread. ``part=1`` is the first part.
    ``all=1`` returns every thread on the order for the dashboard overview.
    """
    _require_po(db, po_id)
    cond = [POComment.purchase_order_id == po_id]
    if all_threads:
        pass
    elif part is None:
        cond.append(POComment.part_index.is_(None))
    else:
        cond.append(POComment.part_index == part - 1)
    stmt = (
        select(POComment)
        .options(selectinload(POComment.actor))
        .where(*cond)
        .order_by(POComment.created_at.asc(), POComment.id.asc())
    )
    return list(db.scalars(stmt))


@router.post("/{po_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
def add_comment(
    po_id: str,
    payload: CommentCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> POComment:
    """Any signed-in user may leave a note — Viewer included, locked orders included.

    Notes are not order edits: no editor floor, no lock guard, no activity row, and
    `updated_at` / Modified stay where they were.
    """
    po = _require_po(db, po_id)
    body = payload.body.strip()
    if not body:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Comment cannot be empty")
    if len(body) > COMMENT_MAX_LEN:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Comment is too long (max {COMMENT_MAX_LEN} characters)",
        )
    part_index = payload.part_index
    if part_index is not None and part_index < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "part_index out of range")
    comment = POComment(
        purchase_order_id=po.id,
        actor_id=actor.id,
        body=body,
        part_index=part_index,
    )
    db.add(comment)
    db.commit()
    loaded = db.scalars(
        select(POComment)
        .options(selectinload(POComment.actor))
        .where(POComment.id == comment.id)
    ).one()
    return loaded


@router.delete(
    "/{po_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_comment(
    po_id: str,
    comment_id: str,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> None:
    """Author or Manager+ (people floor) may remove a note. Lock does not block it."""
    _require_po(db, po_id)
    comment = db.get(POComment, comment_id)
    if comment is None or comment.purchase_order_id != po_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if comment.actor_id != actor.id and not has_rank(actor.role, PEOPLE_FLOOR):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the author or a manager can delete this comment",
        )
    db.delete(comment)
    db.commit()


# ---------- traveler packet ----------

_TRAVELER_FORMATS = frozenset({"pdf", "docx", "xlsx", "excel", "zip"})


def _load_po_for_traveler(db: Session, po_id: str) -> PurchaseOrder:
    po = db.scalars(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.owner))
        .where(PurchaseOrder.id == po_id)
    ).first()
    if po is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PO not found")
    board_service.apply_po_overlays(db, [po])
    return po


def _merged_traveler_fields(
    db: Session,
    po: PurchaseOrder,
    actor: User,
    overrides: dict[str, Any] | None = None,
    selected_part_index: int | None = None,
) -> dict[str, Any]:
    base = traveler_svc.draft_from_po(db, po, actor=actor, selected_part_index=selected_part_index)
    return traveler_svc.apply_draft_overrides(base, overrides)


def _content_disposition(filename: str, *, inline: bool = False) -> str:
    """RFC 6266 disposition with both the plain and UTF-8 encoded filename."""
    disposition = "inline" if inline else "attachment"
    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "'")
    return (
        f'{disposition}; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def _traveler_file_response(
    fmt: str,
    fields: dict[str, Any],
    *,
    job_no: str,
    po_id: str | None = None,
    inline: bool = False,
) -> Response:
    try:
        data, media, filename = traveler_svc.content_for_format(
            fmt, fields, job_no=job_no, po_id=po_id
        )
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": _content_disposition(filename, inline=inline)},
    )


@router.get("/{po_id}/traveler", response_model=TravelerDraftOut)
def get_traveler(
    po_id: str,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    part: int | None = Query(None, ge=1),
) -> TravelerDraftOut:
    """Merged editable traveler fields for one part. Any authenticated user."""
    po = _load_po_for_traveler(db, po_id)
    selected_idx = _traveler_part_index(po, part)
    fields = traveler_svc.draft_from_po(db, po, actor=actor, selected_part_index=selected_idx)
    saved = traveler_svc.part_draft(po, selected_idx) or None
    return TravelerDraftOut(fields=fields, saved=saved)


@router.put("/{po_id}/traveler", response_model=TravelerDraftOut)
def put_traveler(
    po_id: str,
    payload: TravelerDraftUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_editor),
    part: int | None = Query(None, ge=1),
) -> TravelerDraftOut:
    """Persist traveler field overrides for one part. Does not write activity."""
    po = _load_po_for_traveler(db, po_id)
    _guard_locked(po, actor)
    selected_idx = _traveler_part_index(po, part)
    normalised = traveler_svc.normalize_draft(payload.fields)
    traveler_svc.set_part_draft(po, selected_idx, normalised or None)
    db.commit()
    db.refresh(po)
    fields = traveler_svc.draft_from_po(db, po, actor=actor, selected_part_index=selected_idx)
    return TravelerDraftOut(fields=fields, saved=traveler_svc.part_draft(po, selected_idx) or None)


@router.get("/{po_id}/traveler/{fmt}")
def preview_traveler(
    po_id: str,
    fmt: str,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    part: int | None = Query(None, ge=1),
) -> Response:
    """Preview / silent file fetch — no activity row (use POST to record generate).

    PDF preview and download share the same cached template-background overlay.
    """
    if fmt.lower() not in _TRAVELER_FORMATS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown format {fmt!r}")
    po = _load_po_for_traveler(db, po_id)
    selected_idx = _traveler_part_index(po, part)
    fields = _merged_traveler_fields(db, po, actor, None, selected_part_index=selected_idx)
    if fmt.lower() == "pdf":
        t0 = time.perf_counter()
        try:
            data, source = traveler_svc.build_preview_pdf(fields, po_id=po.id)
        except FileNotFoundError as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        filename = traveler_svc.traveler_filename(fields, "pdf", job_no=po.job_no)
        return Response(
            content=data,
            media_type="application/pdf",
            headers={
                "Content-Disposition": _content_disposition(filename, inline=True),
                "X-Traveler-Preview-Source": source,
                "X-Traveler-Preview-Ms": str(elapsed_ms),
            },
        )
    return _traveler_file_response(
        fmt, fields, job_no=po.job_no, po_id=po.id, inline=True
    )


@router.post("/{po_id}/traveler/{fmt}")
def generate_traveler(
    po_id: str,
    fmt: str,
    payload: TravelerGenerateBody | None = None,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    part: int | None = Query(None, ge=1),
) -> Response:
    """Download a filled traveler packet and record ``Traveler generated``.

    Activity is excluded from Modified. Optional body may override fields and
    persist them onto ``traveler_draft`` (editor floor + unlocked).
    """
    if fmt.lower() not in _TRAVELER_FORMATS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown format {fmt!r}")
    po = _load_po_for_traveler(db, po_id)
    body = payload or TravelerGenerateBody()
    selected_idx = _traveler_part_index(po, part)
    if body.persist:
        if not has_rank(actor.role, EDITOR_FLOOR):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Requires {role_label(EDITOR_FLOOR).lower()} or above to save traveler draft",
            )
        _guard_locked(po, actor)
        traveler_svc.set_part_draft(
            po, selected_idx, traveler_svc.normalize_draft(body.fields) or None
        )
    fields = _merged_traveler_fields(db, po, actor, body.fields, selected_part_index=selected_idx)
    _log(
        db,
        actor,
        "Traveler generated",
        po,
        f"{po.job_no} · {fmt.lower()} · by {actor.name}",
    )
    db.commit()
    return _traveler_file_response(fmt, fields, job_no=po.job_no, po_id=po.id)
