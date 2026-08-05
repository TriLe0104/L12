"""Point the primary admin account at a different email (and optionally rename it
or reset its password), keeping every PO and activity row attached to it.

    python tools/set_primary_account.py --from tri@supermicro.com --to me@gmail.com \
        --name "Tri Le" --password "temp-pass"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Activity, PurchaseOrder, Role, User  # noqa: E402
from app.security import hash_password  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    ap.add_argument("--name")
    ap.add_argument("--password")
    args = ap.parse_args()

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == args.src.lower().strip()))
        if user is None:
            raise SystemExit(f"No user with email {args.src}")

        dst = args.dst.lower().strip()
        if db.scalar(select(User).where(User.email == dst, User.id != user.id)):
            raise SystemExit(f"{dst} is already taken by another account")

        user.email = dst
        if args.name:
            user.name = args.name
        if args.password:
            user.password_hash = hash_password(args.password)
        user.role = Role.ADMIN
        user.is_active = True
        user.is_pending = False

        db.add(
            Activity(
                actor_id=user.id,
                action="Account email changed",
                entity_type="user",
                entity_id=user.id,
                detail=f"{args.src} -> {dst}",
            )
        )
        db.commit()

        pos = db.scalar(
            select(PurchaseOrder).where(PurchaseOrder.owner_id == user.id).limit(1)
        )
        owned = len(list(db.scalars(select(PurchaseOrder).where(PurchaseOrder.owner_id == user.id))))
        print(f"account   {user.name} <{user.email}> role={user.role.value}")
        print(f"kept      {owned} purchase orders (sample: {pos.job_no if pos else 'none'})")
        print(f"users now {len(list(db.scalars(select(User))))}")


if __name__ == "__main__":
    main()
