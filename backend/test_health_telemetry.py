"""Temperature and PSU history, and the hold that keeps an empty BMC read from blanking the last values."""

import app.bmc_health as health


def _rich_node():
    return {
        "bmc_ip": "10.1.1.1",
        "via": "hop",
        "status": "ok",
        "thermal": {"status": "ok", "hottest_c": 46.5, "temps": [{"name": "GPU 0", "celsius": 46.5}], "gpu_temps": []},
        "power": {"status": "ok", "watts": 1800.0, "psus": [{"id": "PSU1", "watts": 1800.0}], "psu_count": 1},
        "fans": {"status": "ok", "rpm_avg": 3000, "items": [{"name": "FAN 1"}]},
        "leak": {"status": "ok", "detectors": [{"label": "Leak 1", "status": "ok"}]},
        "held": {"thermal": 1_000.0, "power": 1_000.0, "fans": 1_000.0, "leak": 1_000.0},
    }


def _thin_node():
    return {
        "bmc_ip": "10.1.1.1",
        "via": "hop",
        "status": "ok",
        "thermal": {"status": "unknown", "hottest_c": None, "temps": [], "gpu_temps": []},
        "power": {"status": "unknown", "watts": None, "psus": [], "psu_count": 0},
        "fans": {"status": "unknown", "items": []},
        "leak": {"status": "unknown", "detectors": []},
    }


def test_empty_read_keeps_temperature_and_psu_inside_the_hold():
    kept = health._keep_attrs(_thin_node(), _rich_node(), now=1_050.0)
    assert kept["thermal"]["hottest_c"] == 46.5
    assert kept["power"]["watts"] == 1800.0
    assert kept["power"]["psu_count"] == 1
    assert kept["fans"]["rpm_avg"] == 3000
    assert kept["leak"]["status"] == "ok"
    assert kept["held"]["thermal"] == 1_000.0


def test_empty_read_clears_attributes_after_the_hold():
    kept = health._keep_attrs(_thin_node(), _rich_node(), now=1_000.0 + health._ATTR_HOLD_S + 1)
    assert kept["thermal"]["hottest_c"] is None
    assert kept["power"]["watts"] is None
    assert kept["fans"].get("items") == []


def test_fresh_reading_replaces_the_held_value():
    fresh = _thin_node()
    fresh["thermal"] = {"status": "ok", "hottest_c": 51.0, "temps": [{"name": "GPU 0", "celsius": 51.0}]}
    fresh["power"] = {"status": "ok", "watts": 2100.0, "psus": [{"id": "PSU1"}], "psu_count": 1}
    kept = health._keep_attrs(fresh, _rich_node(), now=1_050.0)
    assert kept["thermal"]["hottest_c"] == 51.0
    assert kept["power"]["watts"] == 2100.0
    assert kept["held"]["thermal"] == 1_050.0
    assert kept["held"]["power"] == 1_050.0


def test_partial_store_does_not_drop_the_other_node():
    saved = dict(health._SNAP)
    hist = list(health._HIST)
    hist_nodes = list(health._NODE_HIST)
    loaded = health._HIST_LOADED
    last = health._last_sample
    last_node = health._last_node_sample
    write = health._write_sample
    health._write_sample = lambda *a, **k: None
    try:
        health._SNAP["nodes"] = [
            {"bmc_ip": "10.1.1.1", "status": "ok", "error": None, "thermal": {"hottest_c": 40, "temps": [{"celsius": 40}]}},
            {"bmc_ip": "10.1.1.2", "status": "ok", "error": None, "thermal": {"hottest_c": 42, "temps": [{"celsius": 42}]}},
        ]
        health._store(
            [{"bmc_ip": "10.1.1.1", "status": "ok", "thermal": {"hottest_c": 41, "temps": [{"celsius": 41}]}}],
            "hop",
            [],
        )
        ips = {n["bmc_ip"] for n in health._SNAP["nodes"]}
        assert ips == {"10.1.1.1", "10.1.1.2"}
        health._store(
            [{"bmc_ip": "10.1.1.1", "status": "ok", "thermal": {"hottest_c": 41, "temps": [{"celsius": 41}]}}],
            "hop",
            [],
            final=True,
        )
        ips = {n["bmc_ip"] for n in health._SNAP["nodes"]}
        assert ips == {"10.1.1.1"}
    finally:
        health._write_sample = write
        health._SNAP.clear()
        health._SNAP.update(saved)
        health._HIST[:] = hist
        health._NODE_HIST[:] = hist_nodes
        health._HIST_LOADED = loaded
        health._last_sample = last
        health._last_node_sample = last_node


def test_bucket_uses_the_hottest_temp_and_skips_empty_gaps():
    start = 0.0
    end = 100.0
    rows = [
        (10.0, 40.0, 1000.0),
        (20.0, 70.0, 3000.0),
        (80.0, 50.0, 2000.0),
        (250.0, 99.0, 9.0),
    ]
    out = health.bucket_telemetry(rows, start, end, points=2)
    assert len(out) == 2
    assert out[0]["temp_c"] == 70.0
    assert out[0]["psu_w"] == 2000.0
    assert out[1]["temp_c"] == 50.0
    assert all(p["t"] <= end for p in out)


def test_node_bucket_keeps_the_hottest_temp_and_average_watts():
    rows = [
        (
            10.0,
            [
                ["10.1.1.2", 2, "rack-a", 30.0, 500.0],
                ["10.1.1.1", 1, "rack-a", 40.0, 1000.0],
            ],
        ),
        (20.0, [["10.1.1.1", 1, "rack-a", 70.0, 3000.0]]),
        (80.0, [["10.1.1.1", 1, "rack-a", 50.0, 2000.0]]),
        (250.0, [["10.1.1.1", 1, "rack-a", 99.0, 9.0]]),
        (40.0, []),
    ]
    out = health.bucket_node_telemetry(rows, 0.0, 100.0, points=2)
    assert [row["bmc_ip"] for row in out] == ["10.1.1.1", "10.1.1.2"]
    assert out[0]["points"][0]["temp_c"] == 70.0
    assert out[0]["points"][0]["psu_w"] == 2000.0
    assert out[0]["points"][1]["temp_c"] == 50.0
    assert out[0]["points"][1]["psu_w"] == 2000.0
    assert len(out[1]["points"]) == 1
    assert out[1]["points"][0]["temp_c"] == 30.0
    assert out[1]["points"][0]["psu_w"] == 500.0
    assert all(point["t"] <= 100.0 for row in out for point in row["points"])


def test_telemetry_window_is_one_day_three_days_and_one_week():
    start, end, key, points = health.telemetry_window("1d", now=1_000_000.0)
    assert key == "1d" and end - start == 86400 and points == health.TELEM_POINTS["1d"]
    start, end, key, _points = health.telemetry_window("3d", now=1_000_000.0)
    assert key == "3d" and end - start == 3 * 86400
    start, end, key, _points = health.telemetry_window("1w", now=1_000_000.0)
    assert key == "1w" and end - start == 7 * 86400
    _start, _end, key, _points = health.telemetry_window("nope", now=1_000_000.0)
    assert key == "1d"


def test_series_stays_inside_the_requested_window():
    saved = list(health._HIST)
    loaded = health._HIST_LOADED
    snap = dict(health._SNAP)
    now = 2_000_000.0
    try:
        health._HIST_LOADED = True
        health._HIST[:] = [
            (now - 2 * 86400, 30.0, 100.0),
            (now - 3600, 44.0, 1500.0),
            (now - 8 * 86400, 90.0, 9.0),
        ]
        health._SNAP["summary"] = {}
        health._SNAP["t"] = 0
        start, end, _key, points = health.telemetry_window("1d", now=now)
        series = health.telemetry_series(start, end, points=points)
        assert series
        assert all(start <= p["t"] <= end for p in series)
        assert max(p["temp_c"] for p in series if p["temp_c"] is not None) == 44.0
        week_start, week_end, _key, week_points = health.telemetry_window("1w", now=now)
        week = health.telemetry_series(week_start, week_end, points=week_points)
        temps = [p["temp_c"] for p in week if p["temp_c"] is not None]
        assert 44.0 in temps and 30.0 in temps
        assert 90.0 not in temps
    finally:
        health._HIST[:] = saved
        health._HIST_LOADED = loaded
        health._SNAP.clear()
        health._SNAP.update(snap)


def test_health_script_waits_and_retries_empty_attributes():
    import app.pxe_hop as hop

    src = hop._HOP_HEALTH
    assert "ATTR_WAIT = 2.0" in src
    assert "temps_ready" in src
    assert "watts_ready" in src
    compile(src, "l12-bmc-health.py", "exec")
