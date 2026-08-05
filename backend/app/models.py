from __future__ import annotations

import enum
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    """Access hierarchy: Admin > Manager > User > Viewer.

    Never compare roles by identity to decide what someone may do -- compare
    ranks. `ROLE_RANK` below is the only place the ordering is written down.
    """

    ADMIN = "admin"
    MANAGER = "manager"   # runs the shop day to day: edits orders, administers people
    USER = "user"         # signed-in staff; read-only on orders for now
    VIEWER = "viewer"


class POStatus(str, enum.Enum):
    NEW = "new"
    RFQ_FINISHING = "rfq_finishing"
    IN_MACHINING = "in_machining"
    FINISHING = "finishing"
    UNDER_INSPECTION = "under_inspection"
    WAIT_VQC = "wait_vqc"
    READY_TO_SHIP = "ready_to_ship"
    SHIPPED = "shipped"
    ON_HOLD = "on_hold"


class Stage(str, enum.Enum):
    """Kanban column. Derived from status so the calendar and the board never disagree."""

    PENDING = "pending"
    ON_HOLD = "on_hold"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class Priority(str, enum.Enum):
    HOT = "hot"
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class Inspection(str, enum.Enum):
    FORMAL = "formal"
    STANDARD = "standard"
    SOURCE = "source"
    NONE = "none"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160))
    org: Mapped[str | None] = mapped_column(String(120), nullable=True)
    role: Mapped[Role] = mapped_column(Enum(Role, native_enum=False), default=Role.VIEWER)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_pending: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    last_login_at: Mapped[datetime | None] = mapped_column(nullable=True)

    purchase_orders: Mapped[list[PurchaseOrder]] = relationship(back_populates="owner")
    activity: Mapped[list[Activity]] = relationship(
        back_populates="actor", cascade="all, delete-orphan"
    )

    @property
    def initials(self) -> str:
        parts = [p for p in self.name.replace("(", " ").split() if p[:1].isalpha()]
        return "".join(p[0] for p in parts[:2]).upper() or self.email[:2].upper()


class PurchaseOrder(Base):
    """One job card: a PO line with its material + finishing detail, due on a date."""

    __tablename__ = "purchase_orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)

    # header
    job_no: Mapped[str] = mapped_column(String(32), index=True)          # J-42
    po_number: Mapped[str] = mapped_column(String(64), index=True)       # J03CE6AA
    part_number: Mapped[str] = mapped_column(String(64))                 # 0A44DD1
    qty: Mapped[int] = mapped_column(Integer, default=1)
    due_date: Mapped[date] = mapped_column(Date, index=True)

    # material + geometry
    dims: Mapped[str | None] = mapped_column(String(120), nullable=True)      # 0.905 x 0.870 x 0.345in
    mat_dim: Mapped[str | None] = mapped_column(String(120), nullable=True)   # 1.25 x 1.7 x .500
    material: Mapped[str | None] = mapped_column(String(160), nullable=True)  # AL 6061-T651, Plate
    finish: Mapped[str | None] = mapped_column(String(200), nullable=True)    # CLEAR ANODIZE; CHEM FILM GOLD

    # process
    inspection: Mapped[Inspection] = mapped_column(
        Enum(Inspection, native_enum=False), default=Inspection.STANDARD
    )
    hardware: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[POStatus] = mapped_column(
        Enum(POStatus, native_enum=False), default=POStatus.NEW, index=True
    )
    priority: Mapped[Priority] = mapped_column(
        Enum(Priority, native_enum=False), default=Priority.NORMAL, index=True
    )
    # while set, only an admin may change the row -- including clearing it
    locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # context
    customer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # "no dim change, just censoring"
    thumbnail_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # 3D model slot: one per order, sitting beside the photo. The URL points at the
    # file exactly as uploaded -- no server-side conversion; the browser translates
    # CAD formats itself. Name and size ride along so the card can label the slot
    # without fetching the model.
    model_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model_size: Mapped[int | None] = mapped_column(Integer, nullable=True)

    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    owner: Mapped[User | None] = relationship(back_populates="purchase_orders")

    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    @property
    def status_label(self) -> str:
        return STATUS_META[self.status]["label"]

    @property
    def stage(self) -> Stage:
        return STAGE_BY_STATUS[self.status]

    @property
    def priority_label(self) -> str:
        return PRIORITY_META[self.priority]["label"]


class Activity(Base):
    __tablename__ = "activity"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor: Mapped[User | None] = relationship(back_populates="activity")
    action: Mapped[str] = mapped_column(String(120))                 # "status changed"
    entity_type: Mapped[str] = mapped_column(String(40))             # "purchase_order" | "user"
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)  # "wait_vqc -> shipped"
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


# The role hierarchy, written down exactly once. Higher number = more authority.
# Every permission check in the app is derived from this table, so adding or
# reordering a rung is a one-line change here plus its label below.
ROLE_RANK: dict[Role, int] = {
    Role.VIEWER: 0,
    Role.USER: 1,
    Role.MANAGER: 2,
    Role.ADMIN: 3,
}

ROLE_META: dict[Role, dict[str, str]] = {
    Role.ADMIN: {"label": "Admin"},
    Role.MANAGER: {"label": "Manager"},
    Role.USER: {"label": "User"},
    Role.VIEWER: {"label": "Viewer"},
}


def role_label(role: Role) -> str:
    return ROLE_META[role]["label"]


def has_rank(role: Role, floor: Role) -> bool:
    """`role` is `floor` or above -- the "manager and above" test."""
    return ROLE_RANK[role] >= ROLE_RANK[floor]


def outranks(actor: Role, target: Role) -> bool:
    """`actor` sits strictly above `target`."""
    return ROLE_RANK[actor] > ROLE_RANK[target]


def roles_high_to_low() -> list[Role]:
    """Every role, most authority first -- the order pickers should show."""
    return sorted(ROLE_RANK, key=lambda r: ROLE_RANK[r], reverse=True)


PRIORITY_META: dict[Priority, dict[str, str]] = {
    Priority.HOT: {"label": "HOT", "tone": "red"},
    Priority.HIGH: {"label": "HIGH", "tone": "orange"},
    Priority.NORMAL: {"label": "NORMAL", "tone": "slate"},
    Priority.LOW: {"label": "LOW", "tone": "graphite"},
}

# highest first
PRIORITY_RANK: dict[Priority, int] = {
    Priority.HOT: 0,
    Priority.HIGH: 1,
    Priority.NORMAL: 2,
    Priority.LOW: 3,
}

STAGE_BY_STATUS: dict[POStatus, Stage] = {
    POStatus.NEW: Stage.PENDING,
    POStatus.RFQ_FINISHING: Stage.PENDING,
    POStatus.ON_HOLD: Stage.ON_HOLD,
    POStatus.IN_MACHINING: Stage.IN_PROGRESS,
    POStatus.FINISHING: Stage.IN_PROGRESS,
    POStatus.UNDER_INSPECTION: Stage.IN_PROGRESS,
    POStatus.WAIT_VQC: Stage.IN_PROGRESS,
    POStatus.READY_TO_SHIP: Stage.COMPLETED,
    POStatus.SHIPPED: Stage.COMPLETED,
}

# Where a card lands when it is dragged into a column, if its current status
# doesn't already belong to that column.
STAGE_DEFAULT_STATUS: dict[Stage, POStatus] = {
    Stage.PENDING: POStatus.NEW,
    Stage.ON_HOLD: POStatus.ON_HOLD,
    Stage.IN_PROGRESS: POStatus.IN_MACHINING,
    Stage.COMPLETED: POStatus.READY_TO_SHIP,
}

STAGE_META: dict[Stage, dict[str, str]] = {
    Stage.PENDING: {"label": "PENDING", "tone": "slate"},
    Stage.ON_HOLD: {"label": "ON HOLD", "tone": "orange"},
    Stage.IN_PROGRESS: {"label": "IN PROGRESS", "tone": "blue"},
    Stage.COMPLETED: {"label": "COMPLETED", "tone": "green"},
}

STATUS_META: dict[POStatus, dict[str, str]] = {
    POStatus.NEW: {"label": "NEW", "tone": "slate"},
    POStatus.RFQ_FINISHING: {"label": "RFQ FINISHING", "tone": "cyan"},
    POStatus.IN_MACHINING: {"label": "IN MACHINING", "tone": "blue"},
    POStatus.FINISHING: {"label": "FINISHING", "tone": "teal"},
    POStatus.UNDER_INSPECTION: {"label": "UNDER INSPECTION", "tone": "amber"},
    POStatus.WAIT_VQC: {"label": "WAIT VQC", "tone": "red"},
    POStatus.READY_TO_SHIP: {"label": "READY TO SHIP", "tone": "green"},
    POStatus.SHIPPED: {"label": "SHIPPED", "tone": "graphite"},
    POStatus.ON_HOLD: {"label": "ON HOLD", "tone": "orange"},
}
