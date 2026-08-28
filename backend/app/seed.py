"""Bootstrap accounts, the Firmus GB300 campus, and demo workloads."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .models import DataHall, InventoryNode, Rack, Role, User, Workload
from .security import hash_password


def seed(db: Session) -> None:
    _seed_users(db)
    _seed_firmus(db)
    _seed_workloads(db)


def _seed_users(db: Session) -> None:
    if db.scalar(select(User).limit(1)) is not None:
        return
    user = User(
        name=settings.bootstrap_admin_name,
        email=settings.bootstrap_admin_email.lower().strip(),
        org="Firmus",
        role=Role.ADMIN,
        password_hash=hash_password(settings.bootstrap_admin_password),
        is_pending=False,
        last_login_at=datetime.now(timezone.utc),
    )
    db.add(user)
    db.commit()


def _seed_firmus(db: Session) -> None:
    halls = list(db.scalars(select(DataHall)).all())
    hall_count = len(halls)
    rack_count = db.scalar(select(func.count()).select_from(Rack)) or 0
    # 16×4 row layout uses a shallow plate (depth ≤ 12). The older 8×8 seed was 18×18.
    if hall_count == 4 and rack_count == 256 and halls and max(h.depth_tiles for h in halls) <= 12:
        return

    for node in list(db.scalars(select(InventoryNode)).all()):
        db.delete(node)
    for hall in halls:
        db.delete(hall)
    db.flush()

    demo_states = [
        ("on", "running"),
        ("on", "ready"),
        ("on", "idle"),
        ("on", "running"),
        ("off", "idle"),
        ("on", "ready"),
        ("on", "running"),
        ("on", "ready"),
    ]
    names = [
        ("DH-01", "Firmus data hall 1 — GB300"),
        ("DH-02", "Firmus data hall 2 — GB300"),
        ("DH-03", "Firmus data hall 3 — GB300"),
        ("DH-04", "Firmus data hall 4 — GB300"),
    ]
    # Firmus: 16 racks × 4 rows, cold aisle between rows, on an 18×10 plate.
    for hall_i, (name, desc) in enumerate(names):
        hall = DataHall(name=name, description=desc, width_tiles=18, depth_tiles=10)
        db.add(hall)
        db.flush()
        n = 0
        for row in range(4):
            for col in range(16):
                power, run = demo_states[(hall_i * 3 + row + col) % len(demo_states)]
                rack = Rack(
                    hall_id=hall.id,
                    name=f"{name}-R{row + 1:02d}C{col + 1:02d}",
                    x=1 + col,
                    y=1 + row * 2,
                    rotation=180 if row % 2 == 0 else 0,
                    height_u=48,
                    notes="GB300",
                    power_state=power,
                    run_status=run,
                )
                db.add(rack)
                n += 1
        assert n == 64
    db.commit()


def _seed_workloads(db: Session) -> None:
    if db.scalar(select(Workload).limit(1)) is not None:
        return
    now = datetime.now(timezone.utc)
    rows = [
        ("mlperf-gpt3-175b", "mlperf", "failed", 8, 8, 640, 0, now - timedelta(days=12, hours=18), now - timedelta(days=12, hours=6)),
        ("mlperf-llama2-70b", "mlperf", "running", 16, 16, 1280, 1280, now - timedelta(hours=6), None),
        ("mlperf-resnet50", "mlperf", "completed", 4, 4, 320, 320, now - timedelta(days=2), now - timedelta(days=1, hours=20)),
        ("gpt-oss", "inference", "failed", 1, 1, 80, 0, now - timedelta(days=12), now - timedelta(days=12, hours=1)),
        ("gpt-oss-2", "inference", "failed", 4, 0, 320, 0, now - timedelta(days=12), now - timedelta(days=12)),
        ("inference-test", "inference", "running", 2, 2, 160, 160, now - timedelta(hours=3), None),
        ("mistral-chat3", "workspace", "stopped", 1, 0, 80, 0, now - timedelta(days=168), now - timedelta(days=168)),
        ("qwen3-5", "inference", "failed", 1, 0, 80, 0, now - timedelta(days=12), now - timedelta(days=12)),
        ("qwen3-52b", "inference", "running", 4, 4, 320, 320, now - timedelta(hours=1), None),
        ("mlperf-dlrm-dcnv2", "mlperf", "pending", 8, 0, 640, 0, None, None),
    ]
    for name, kind, status, gpu_req, gpu_alloc, mem_req, mem_alloc, started, finished in rows:
        running = status == "running"
        db.add(
            Workload(
                name=name,
                kind=kind,
                status=status,
                project="firmus",
                department="default",
                node_pool="gb300",
                pods_running=1 if running else 0,
                pods_requested=1 if gpu_req <= 8 else 2,
                gpu_request=gpu_req,
                gpu_allocation=gpu_alloc,
                gpu_mem_gb_request=mem_req,
                gpu_mem_gb_alloc=mem_alloc,
                started_at=started,
                finished_at=finished,
                created_at=started or now,
                detail="Firmus GB300 pool",
            )
        )
    db.commit()
