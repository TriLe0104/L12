from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from .models import Inspection, POStatus, Priority, Role, Stage


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- users ----------
class UserBase(BaseModel):
    email: str
    name: str
    org: str | None = None
    role: Role = Role.VIEWER
    avatar_url: str | None = None


class UserCreate(UserBase):
    password: str | None = Field(default=None, min_length=6)


class UserUpdate(BaseModel):
    name: str | None = None
    org: str | None = None
    role: Role | None = None
    avatar_url: str | None = None
    is_active: bool | None = None
    is_pending: bool | None = None
    password: str | None = Field(default=None, min_length=6)


class UserOut(ORMModel):
    id: str
    email: str
    name: str
    org: str | None
    role: Role
    avatar_url: str | None
    is_active: bool
    is_pending: bool
    initials: str
    created_at: datetime
    last_login_at: datetime | None


# ---------- purchase orders ----------
class POBase(BaseModel):
    job_no: str
    po_number: str
    part_number: str
    qty: int = 1
    due_date: date
    dims: str | None = None
    mat_dim: str | None = None
    material: str | None = None
    finish: str | None = None
    inspection: Inspection = Inspection.STANDARD
    hardware: bool = False
    status: POStatus = POStatus.NEW
    priority: Priority = Priority.NORMAL
    customer: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None
    owner_id: str | None = None


class POCreate(POBase):
    pass


class POUpdate(BaseModel):
    job_no: str | None = None
    po_number: str | None = None
    part_number: str | None = None
    qty: int | None = None
    due_date: date | None = None
    dims: str | None = None
    mat_dim: str | None = None
    material: str | None = None
    finish: str | None = None
    inspection: Inspection | None = None
    hardware: bool | None = None
    status: POStatus | None = None
    priority: Priority | None = None
    locked: bool | None = None
    # Setting a stage moves the card between kanban columns; it resolves to that
    # column's default status unless the current status already sits in the column.
    stage: Stage | None = None
    customer: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None
    owner_id: str | None = None


class OwnerBrief(ORMModel):
    id: str
    name: str
    initials: str
    avatar_url: str | None


class Assignee(OwnerBrief):
    """A person an order may be handed to: exactly what the owner picker draws,
    and nothing else. Deliberately narrower than `UserOut` -- no email and no
    account state, so offering the picker never doubles as a directory dump."""

    role: Role


class LastModified(BaseModel):
    """Who last changed an order and when, read back off the activity trail.

    Not a column on the order: there are too many write paths (drawer save,
    kanban drag, calendar drag, lock toggle, owner picker, uploads) for a
    denormalised field to stay honest. `list_pos` derives this for the whole
    page in one query and hangs it on each row.
    """

    by: OwnerBrief
    at: datetime
    action: str


class POOut(ORMModel):
    id: str
    job_no: str
    po_number: str
    part_number: str
    qty: int
    due_date: date
    dims: str | None
    mat_dim: str | None
    material: str | None
    finish: str | None
    inspection: Inspection
    hardware: bool
    status: POStatus
    status_label: str
    stage: Stage
    priority: Priority
    priority_label: str
    locked: bool
    customer: str | None
    note: str | None
    thumbnail_url: str | None
    model_url: str | None
    model_filename: str | None
    model_size: int | None
    owner: OwnerBrief | None
    created_at: datetime
    updated_at: datetime
    # Absent unless the route bothered to derive it; the list and every write
    # response do, so the dashboard never has to guess after a save.
    last_modified: LastModified | None = None


# ---------- activity ----------
class ActivityOut(ORMModel):
    id: str
    action: str
    entity_type: str
    entity_id: str | None
    detail: str | None
    created_at: datetime
    actor: OwnerBrief | None


# ---------- auth ----------
class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=8, max_length=200)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class StatusMeta(BaseModel):
    value: str
    label: str
    tone: str


class RoleMeta(BaseModel):
    value: str
    label: str
    rank: int


class StageMeta(BaseModel):
    value: str
    label: str
    tone: str
    statuses: list[str]


class UploadOut(BaseModel):
    url: str
    filename: str


class ModelUploadOut(UploadOut):
    """A stored 3D model: same shape as an image upload plus what the card needs
    to label the slot without downloading the geometry."""

    size: int
    format: str
