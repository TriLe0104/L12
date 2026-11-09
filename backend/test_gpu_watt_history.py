"""Per-GPU watt history from 1 hour through 7 days."""

import time
from datetime import datetime, timezone

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import GpuWattSample
from app import gpu_power
from app import maxlps_inventory as inv


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _raises(fn):
    try:
        fn()
    except ValueError as exc:
        return str(exc)
    raise AssertionError("expected ValueError")


def test_gpu_history_bounds_rejects_short_long_and_old_windows():
    now = 1_000_000.0
    assert "at least 1 hour" in _raises(lambda: inv.gpu_history_bounds(now - 60, now, now=now))
    assert "at most 7 days" in _raises(lambda: inv.gpu_history_bounds(now - 8 * 86400, now, now=now))
    assert "7 days ago" in _raises(
        lambda: inv.gpu_history_bounds(now - 8 * 86400, now - 8 * 86400 + 7200, now=now)
    )
    assert "start before" in _raises(lambda: inv.gpu_history_bounds(now, now, now=now))
    start, end = inv.gpu_history_bounds(now - 3600, now + 100, now=now)
    assert start == now - 3600
    assert end == now
    start, end = inv.gpu_history_bounds(now - 7 * 86400, now, now=now)
    assert end - start == 7 * 86400


def test_bucket_watt_samples_averages_and_skips_gaps():
    out = inv.bucket_watt_samples(
        [(10.0, 100.0), (20.0, 300.0), (80.0, 200.0), (250.0, 9.0)],
        0.0,
        100.0,
        points=2,
    )
    assert len(out) == 2
    assert out[0]["w"] == 200.0
    assert out[1]["w"] == 200.0
    assert out[0]["t"] < 50 < out[1]["t"]
    sparse = inv.bucket_watt_samples([(1.0, 10.0), (90.0, 40.0)], 0.0, 100.0, points=4)
    assert len(sparse) == 2
    assert [row["w"] for row in sparse] == [10.0, 40.0]


def test_gpu_watt_history_keeps_one_gpu_inside_the_window():
    now = time.time()
    start = now - 3600
    db = _session()
    saved = gpu_power.live_gpu_watts
    try:
        gpu_power.live_gpu_watts = lambda _gpu_id: (None, 0.0)
        for stamp, watts in ((start + 10, 100.0), (start + 20, 300.0), (start + 3500, 200.0)):
            db.add(GpuWattSample(ts=datetime.fromtimestamp(stamp, timezone.utc), gpu_id="r-n1-g1", watts=watts))
        db.add(GpuWattSample(ts=datetime.fromtimestamp(start + 10, timezone.utc), gpu_id="other", watts=999.0))
        db.add(GpuWattSample(ts=datetime.fromtimestamp(start - 7200, timezone.utc), gpu_id="r-n1-g1", watts=50.0))
        db.commit()
        out = inv.gpu_watt_history(db, "r-n1-g1", start, now, points=2)
        assert out["id"] == "r-n1-g1"
        assert out["from_ts"] == start
        assert abs(out["to_ts"] - now) < 1
        assert [point["w"] for point in out["points"]] == [200.0, 200.0]
        assert all(start <= point["t"] <= now + 1 for point in out["points"])
    finally:
        gpu_power.live_gpu_watts = saved
        db.close()


def test_remember_gpu_samples_writes_each_live_gpu_and_ignores_a_quiet_round():
    import app.db as dbmod

    session = _session()
    factory = sessionmaker(bind=session.get_bind())
    saved_factory = dbmod.SessionLocal
    saved_live = dict(gpu_power._LIVE_GPU)
    saved_sample = inv._last_gpu_sample
    saved_prune = inv._last_gpu_prune
    dbmod.SessionLocal = factory
    try:
        inv._last_gpu_sample = 0.0
        inv._last_gpu_prune = time.time()
        gpu_power._LIVE_GPU.clear()
        gpu_power._LIVE_GPU["r1-n1-g1"] = {"watts": 180.0}
        gpu_power._LIVE_GPU["r1-n1-g2"] = {"watts": 220.5}
        inv.remember_gpu_samples()
        with factory() as db:
            rows = list(db.scalars(select(GpuWattSample).order_by(GpuWattSample.gpu_id)).all())
        assert [(row.gpu_id, row.watts) for row in rows] == [("r1-n1-g1", 180.0), ("r1-n1-g2", 220.5)]
        inv.remember_gpu_samples()
        with factory() as db:
            assert db.scalar(select(func.count()).select_from(GpuWattSample)) == 2
        stamped = inv._last_gpu_sample
        gpu_power._LIVE_GPU.clear()
        inv._last_gpu_sample = 0.0
        inv.remember_gpu_samples()
        assert inv._last_gpu_sample == 0.0
        with factory() as db:
            assert db.scalar(select(func.count()).select_from(GpuWattSample)) == 2
        assert stamped > 0
    finally:
        dbmod.SessionLocal = saved_factory
        inv._last_gpu_sample = saved_sample
        inv._last_gpu_prune = saved_prune
        gpu_power._LIVE_GPU.clear()
        gpu_power._LIVE_GPU.update(saved_live)
        session.close()
