"""Keep a single account and hand everything it owns over to them.

    python tools/prune_users.py tri@supermicro.com

Purchase orders and activity rows are reassigned to the kept user first, so no
history is lost and no foreign key is left dangling.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, update  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Activity, PurchaseOrder, Role, User  # noqa: E402


def main(keep_email: str) -> None:
    keep_email = keep_email.lower().strip()
    with SessionLocal() as db:
        keeper = db.scalar(select(User).where(User.email == keep_email))
        if keeper is None:
            raise SystemExit(f"No user with email {keep_email}")

        doomed = list(db.scalars(select(User).where(User.id != keeper.id)))
        if not doomed:
            print("Nothing to remove.")
            return

        pos = db.execute(
            update(PurchaseOrder)
            .where(PurchaseOrder.owner_id != keeper.id)
            .values(owner_id=keeper.id)
        ).rowcount
        acts = db.execute(
            update(Activity).where(Activity.actor_id != keeper.id).values(actor_id=keeper.id)
        ).rowcount

        for user in doomed:
            db.delete(user)

        if keeper.role is not Role.ADMIN:
            keeper.role = Role.ADMIN

        db.commit()

        print(f"reassigned {pos} purchase orders and {acts} activity rows to {keeper.name}")
        print(f"removed {len(doomed)} users: " + ", ".join(u.email for u in doomed))
        print(f"remaining: {db.scalar(select(User).where(User.id == keeper.id)).email}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tri@supermicro.com")
