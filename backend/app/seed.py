"""Demo data so the calendar is populated on first run. Safe to re-run: it no-ops
if the users table already has rows."""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import Activity, Inspection, POStatus, Priority, PurchaseOrder, Role, User
from .security import hash_password

MATERIALS = [
    ("AL 6061-T651, Plate", "CLEAR ANODIZE; CHEM FILM GOLD"),
    ("AL 6061-T6, Bar", "CHEM FILM CLEAR"),
    ("SS 304, Sheet", "PASSIVATE"),
    ("SS 316L, Plate", "BEAD BLAST + PASSIVATE"),
    ("AL 7075-T7351, Plate", "HARD ANODIZE, BLACK"),
    ("Copper C110, Plate", "ELECTROLESS NICKEL"),
    ("Brass 360, Bar", "NONE"),
    ("AL 5052-H32, Sheet", "POWDER COAT, BLACK TEXTURE"),
]

NOTES = [
    "no dim change, just censoring",
    "customer supplied print rev C",
    "second article - match first article dims",
    None,
    None,
    "expedite: line-down support",
]

CUSTOMERS = ["Tri-Test", "GB300 Rack", "Nebula-7", "Orion DC", "Falcon Bay"]


def seed(db: Session) -> None:
    if db.scalar(select(User).limit(1)) is not None:
        return

    rng = random.Random(42)
    users: list[User] = []
    bootstrap_users = [
        (settings.bootstrap_admin_name, settings.bootstrap_admin_email, Role.ADMIN),
    ]
    for name, email, role in bootstrap_users:
        user = User(
            name=name,
            email=email.lower().strip(),
            org="IT",
            role=role,
            password_hash=hash_password(settings.bootstrap_admin_password),
            is_pending=False,
            last_login_at=datetime.now(timezone.utc) - timedelta(days=rng.randint(0, 9)),
        )
        users.append(user)
        db.add(user)
    db.flush()

    today = date.today()
    month_start = today.replace(day=1)
    statuses = list(POStatus)

    for i in range(28):
        material, finish = rng.choice(MATERIALS)
        due = month_start + timedelta(days=rng.randint(0, 55))
        w = round(rng.uniform(0.4, 6.5), 3)
        h = round(rng.uniform(0.4, 4.5), 3)
        t = round(rng.uniform(0.12, 1.25), 3)
        po = PurchaseOrder(
            job_no=f"J-{40 + i}",
            po_number=f"J0{rng.randint(1, 9)}{rng.choice('ABCDEF')}{rng.randint(10, 99)}"
            f"{rng.choice('ABCDEF')}{rng.choice('ABCDEF')}",
            part_number=f"0A{rng.randint(10, 99)}{rng.choice('ABCDEF')}D{rng.randint(1, 9)}",
            qty=rng.choice([1, 2, 4, 6, 8, 12, 24, 50]),
            due_date=due,
            dims=f"{w} x {h} x {t}in",
            mat_dim=f"{round(w + 0.35, 2)} x {round(h + 0.4, 2)} x {round(t + 0.15, 3)}",
            material=material,
            finish=finish,
            inspection=rng.choice(
                [Inspection.FORMAL, Inspection.STANDARD, Inspection.SOURCE, Inspection.NONE]
            ),
            hardware=rng.random() < 0.35,
            status=rng.choice(statuses).value,
            priority=rng.choices(
                [Priority.HOT, Priority.HIGH, Priority.NORMAL, Priority.LOW],
                weights=[1, 3, 5, 2],
            )[0],
            customer=rng.choice(CUSTOMERS),
            note=rng.choice(NOTES),
            owner_id=rng.choice(users).id,
        )
        db.add(po)
        db.flush()
        db.add(
            Activity(
                actor_id=po.owner_id,
                action="PO created",
                entity_type="purchase_order",
                entity_id=po.id,
                detail=f"{po.job_no} · {po.po_number}",
            )
        )

    db.commit()
