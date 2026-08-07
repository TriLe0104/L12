"""Restore demo PO J-55 / J06A41CC, which was hard-deleted by a cleanup script at
2026-08-05 00:18:44 and took the demo set from 28 POs down to 27.

    python tools/restore_j55.py

Why the values below are hard-coded rather than regenerated: `app/seed.py` builds the
demo set from `random.Random(42)`, and it is genuinely deterministic — seeding two
fresh databases in two separate processes yields byte-identical rows. It is *not*,
however, able to reproduce *this* database. Replaying it against the 27 survivors
mismatches 226 of 420 seeded fields, and it never produces po_number J06A41CC at all.
Suppressing the `priority` draw (that column was added to the seed after this database
was created, and it consumes a number the original stream never spent) fixes only part
of the drift. So the seed is a reproducible generator but no longer a faithful record
of what is stored here, and regenerating J-55 from it would have inserted wrong data.

The values below instead come from the field-by-field evidence for the row as it
existed: po_number and job_no from the deletion entry in the activity log, and the
rest from a screenshot taken while the card was still on the board. They are also
internally consistent with the generator's vocabulary — the material/finish pair, the
note and the customer are all drawn from `seed.py`'s lists, po_number and part_number
fit its formats, and mat_dim is dims + (0.35, 0.4, 0.15) as the seed computes it.

`priority` was never part of the seed; it was backfilled later by
`tools/backfill_priorities.py`. The screenshot shows J-55 as HIGH. Note that this
schema stores enum member *names* (see the comment at the top of `app/migrations.py`),
so the stored value is "HIGH", not "high"; passing the `Priority` member handles that.

The script refuses to do anything if a J-55 already exists, so it cannot double-insert.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Activity, Inspection, POStatus, Priority, PurchaseOrder, User  # noqa: E402

OWNER_EMAIL = "trile0104@gmail.com"

FIELDS: dict[str, object] = {
    "job_no": "J-55",
    "po_number": "J06A41CC",
    "part_number": "0A30DD9",
    "qty": 8,
    "due_date": date(2026, 8, 5),
    "dims": "3.68 x 2.474 x 0.27in",
    "mat_dim": "4.03 x 2.87 x 0.42",
    "material": "AL 6061-T6, Bar",
    "finish": "CHEM FILM CLEAR",
    "inspection": Inspection.FORMAL.value,
    "hardware": False,
    "status": POStatus.WAITING_SETUP.value,
    "priority": Priority.HIGH.value,
    "customer": "Nebula-7",
    "note": "expedite: line-down support",
    "thumbnail_url": None,
}


def describe(po: PurchaseOrder) -> str:
    lines = [f"  {'id':<14} {po.id}"]
    for name in FIELDS:
        value = getattr(po, name)
        lines.append(f"  {name:<14} {getattr(value, 'name', value)!r}")
    lines.append(f"  {'owner_id':<14} {po.owner_id}")
    lines.append(f"  {'stage':<14} {po.stage} ({po.status_label} / {po.priority_label})")
    return "\n".join(lines)


def main() -> None:
    with SessionLocal() as db:
        existing = db.scalar(select(PurchaseOrder).where(PurchaseOrder.job_no == FIELDS["job_no"]))
        if existing is not None:
            print(f"REFUSING: {FIELDS['job_no']} already exists — nothing inserted.")
            print(describe(existing))
            drift = [
                f"    {name}: db={getattr(existing, name)!r} expected={value!r}"
                for name, value in FIELDS.items()
                if getattr(existing, name) != value
            ]
            print(f"\n  fields differing from the expected restore: {len(drift)}")
            for line in drift:
                print(line)
            raise SystemExit(1)

        owner = db.scalar(select(User).where(User.email == OWNER_EMAIL))
        if owner is None:
            users = list(db.scalars(select(User)))
            if len(users) != 1:
                raise SystemExit(f"No user {OWNER_EMAIL} and {len(users)} users to fall back on")
            owner = users[0]
            print(f"note: {OWNER_EMAIL} not found, using sole user {owner.email}")

        po = PurchaseOrder(owner_id=owner.id, **FIELDS)
        db.add(po)
        db.flush()
        db.add(
            Activity(
                actor_id=owner.id,
                action="PO restored",
                entity_type="purchase_order",
                entity_id=po.id,
                detail=f"{po.job_no} · {po.po_number} (deleted 2026-08-05 00:18:44)",
            )
        )
        db.commit()
        db.refresh(po)

        print(f"restored {po.job_no} · {po.po_number} for {owner.email}")
        print(describe(po))
        total = len(list(db.scalars(select(PurchaseOrder))))
        print(f"\npurchase orders now: {total}")


if __name__ == "__main__":
    main()
