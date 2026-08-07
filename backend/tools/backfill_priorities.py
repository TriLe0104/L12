"""Spread priorities across seeded demo POs that are still at the default.

Only touches rows whose priority is 'normal', so anything you have already
triaged by hand is left alone.

    python tools/backfill_priorities.py
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collections import Counter  # noqa: E402

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Priority, PurchaseOrder  # noqa: E402


def main() -> None:
    rng = random.Random(7)
    with SessionLocal() as db:
        rows = list(db.scalars(select(PurchaseOrder).where(PurchaseOrder.priority == "normal")))
        for po in rows:
            po.priority = rng.choices(
                [Priority.HOT.value, Priority.HIGH.value, Priority.NORMAL.value, Priority.LOW.value],
                weights=[1, 3, 5, 2],
            )[0]
        db.commit()

        counts = Counter(p.priority for p in db.scalars(select(PurchaseOrder)))
        print(f"updated {len(rows)} POs")
        for value in ("hot", "high", "normal", "low"):
            print(f"  {value:<7} {counts.get(value, 0)}")


if __name__ == "__main__":
    main()
