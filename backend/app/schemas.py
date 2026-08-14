from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .models import Role


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
    password: str = Field(min_length=8)


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
    certificates: str | None = None
    inspection: str = "standard"
    hardware: bool = False
    # Status key from the published board catalog (day-one: POStatus values).
    status: str = "need_material_size"
    priority: str = "normal"
    customer: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None
    owner_id: str | None = None
    # Optional list of parts/components for multipart orders. Each part is an
    # arbitrary small object; clients may include part_number, part_name, qty,
    # and thumbnail_url.
    parts: list[dict[str, Any]] | None = None
    # Admin-defined attributes; keys match board settings customFields.
    custom_fields: dict[str, str | int | float | None] | None = None


class POCreate(POBase):
    pass


class PartCreate(BaseModel):
    part_number: str
    part_name: str | None = None
    qty: int | None = 1
    dims: str | None = None
    mat_dim: str | None = None
    material: str | None = None
    finish: str | None = None
    inspection: str | None = "standard"
    hardware: bool | None = False
    priority: str | None = "normal"
    certificates: str | None = None
    custom_fields: dict[str, Any] | None = None
    status: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None


class PartUpdate(BaseModel):
    part_number: str | None = None
    part_name: str | None = None
    qty: int | None = None
    dims: str | None = None
    mat_dim: str | None = None
    material: str | None = None
    finish: str | None = None
    inspection: str | None = None
    hardware: bool | None = None
    priority: str | None = None
    certificates: str | None = None
    custom_fields: dict[str, Any] | None = None
    status: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None


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
    certificates: str | None = None
    inspection: str | None = None
    hardware: bool | None = None
    status: str | None = None
    priority: str | None = None
    locked: bool | None = None
    # Setting a stage moves the card between kanban columns; it resolves to that
    # column's default status unless the current status already sits in the column.
    # Stage is now a kanban column key from board settings.
    stage: str | None = None
    customer: str | None = None
    note: str | None = None
    thumbnail_url: str | None = None
    model_url: str | None = None
    model_filename: str | None = None
    model_size: int | None = None
    owner_id: str | None = None
    custom_fields: dict[str, str | int | float | None] | None = None


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
    certificates: str | None = None
    inspection: str
    hardware: bool
    status: str
    status_label: str
    stage: str
    priority: str
    priority_label: str
    locked: bool
    customer: str | None
    note: str | None
    thumbnail_url: str | None
    model_url: str | None
    model_filename: str | None
    model_size: int | None
    owner: OwnerBrief | None
    custom_fields: dict[str, str | int | float | None] | None = None
    # Optional list of parts/components for multipart orders. Kept optional to
    # preserve single-part PO compatibility.
    parts: list[dict[str, Any]] | None = None
    display_part_index: int = 0
    # Editable traveler packet overrides. Legacy rows are a flat field map;
    # multi-part orders store `{ "0": {...}, "1": {...} }` keyed by part index.
    traveler_draft: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
    # Absent unless the route bothered to derive it; the list and every write
    # response do, so the dashboard never has to guess after a save.
    last_modified: LastModified | None = None
    # How many notes sit on this order. Derived in one GROUP BY for the list so
    # the dashboard badge never N+1s. Comments are not activity and never move
    # `last_modified`.
    comment_count: int = 0
    # Per-part note counts, keyed by 0-based part index as a string.
    part_comment_counts: dict[str, int] = Field(default_factory=dict)
    # Multi-part rollup; null on single-part orders.
    parts_completed: int | None = None
    parts_total: int | None = None


class TravelerDraftOut(BaseModel):
    """Merged traveler field map ready for the editor / packet fill."""

    fields: dict[str, str | int | float | None]
    saved: dict[str, str | int | float | None] | None = None


class DisplayPartUpdate(BaseModel):
    """Pick which part the board cards show for everyone."""

    index: int


class TravelerDraftUpdate(BaseModel):
    """Persist editable traveler overrides onto the PO (`traveler_draft` JSON)."""

    fields: dict[str, str | int | float | None]


class TravelerGenerateBody(BaseModel):
    """Optional field overrides when downloading a packet; may also persist."""

    fields: dict[str, str | int | float | None] | None = None
    persist: bool = False


class POWithPartUpdate(BaseModel):
    """Combined update for PO and optionally a selected part.

    `fields` follows POUpdate (only present keys are applied). `part_index` is
    zero-based. `part` follows PartUpdate and is applied only when provided.
    """

    fields: POUpdate | None = None
    part_index: int | None = None
    part: PartUpdate | None = None


# ---------- comments ----------
COMMENT_MAX_LEN = 2000


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=COMMENT_MAX_LEN)
    # 0-based part index; omit / null for the project-wide thread.
    part_index: int | None = None


class CommentOut(ORMModel):
    id: str
    body: str
    created_at: datetime
    part_index: int | None = None
    actor: OwnerBrief | None


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


# ---------- board settings ----------
class BoardSettingsOut(BaseModel):
    version: int
    updated_at: datetime | None = None
    updated_by_id: str | None = None
    document: dict


class BoardSettingsUpdate(BaseModel):
    """Full document replace. Sections: cardFields, customFields, statuses,
    dashboardColumns, kanbanColumns."""

    document: dict
