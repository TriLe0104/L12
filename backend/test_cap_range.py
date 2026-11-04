"""GPU caps hold inside the operation range, rise on a log curve, and fall on an inverse sigmoid."""

from app import gpu_power


def _reset() -> None:
    gpu_power.LOOP.cap_ramp.clear()
    gpu_power.LOOP.last_cap_by_id.clear()
    gpu_power.LOOP.ramp_up = 1.0
    gpu_power.LOOP.ramp_down = 1.0


def test_band_is_gpu_load_plus_or_minus_the_operation_range() -> None:
    assert gpu_power._op_band(0.50, 0.15) == (0.35, 0.65)
    assert gpu_power._op_band(0.80, 0.15) == (0.65, 0.95)


def test_a_tight_cap_rises_toward_draw_over_gpu_load() -> None:
    _reset()
    # 400 W on a 500 W cap is 80%, above a 50% load. The cap climbs toward 800 W.
    first = gpu_power._shape_gpu_cap("g1", 400.0, 500.0, 0.50, 0.05, 50.0, 1400.0, 10.0)
    second = gpu_power._shape_gpu_cap("g1", 400.0, first, 0.50, 0.05, 50.0, 1400.0, 10.7)
    assert 500.0 < first < second < 800.0
    assert first - 500.0 > second - first


def test_an_oversized_cap_falls_toward_draw_over_gpu_load() -> None:
    _reset()
    # 188 W on a 1230 W cap is about 15%, under a 50% ± 5% band.
    held = gpu_power._shape_gpu_cap("g1", 188.0, 1230.0, 0.50, 0.05, 200.0, 1400.0, 10.0)
    assert abs(held - 1230.0) < 1.0
    dest = 188.0 / 0.50
    mid = gpu_power._shape_gpu_cap(
        "g1", 188.0, held, 0.50, 0.05, 200.0, 1400.0, 10.0 + gpu_power._SIGMOID_TAU_S
    )
    assert abs(mid - (1230.0 + (dest - 1230.0) * 0.5)) < 12.0
    assert dest < mid < 900.0


def test_lower_ramp_up_takes_a_smaller_step_toward_gpu_load() -> None:
    _reset()
    gpu_power.LOOP.ramp_up = 0.5
    slow = gpu_power._shape_gpu_cap("g1", 400.0, 500.0, 0.50, 0.05, 50.0, 1400.0, 10.0)
    _reset()
    gpu_power.LOOP.ramp_up = 2.0
    fast = gpu_power._shape_gpu_cap("g1", 400.0, 500.0, 0.50, 0.05, 50.0, 1400.0, 10.0)
    assert 500.0 < slow < fast <= 800.0


def test_ramp_scale_speeds_the_rise_and_the_fall() -> None:
    slow = gpu_power._log_rise(400.0, 1400.0, 0.5)
    base = gpu_power._log_rise(400.0, 1400.0, 1.0)
    fast = gpu_power._log_rise(400.0, 1400.0, 2.0)
    assert 400.0 < slow < base < fast <= 1400.0
    origin, dest = 1000.0, 400.0
    half = gpu_power._inverse_sigmoid_fall(origin, dest, gpu_power._SIGMOID_TAU_S, 1.0)
    twice = gpu_power._inverse_sigmoid_fall(origin, dest, gpu_power._SIGMOID_TAU_S / 2, 2.0)
    assert abs(half - twice) < 1e-6
    assert gpu_power._ramp_scale(100) == 1.0
    assert gpu_power._ramp_scale(0.1) == gpu_power.RAMP_SCALE_MIN


def test_rise_is_logarithmic_and_the_first_step_is_the_largest() -> None:
    first = gpu_power._log_rise(400.0, 1400.0)
    second = gpu_power._log_rise(first, 1400.0)
    assert first < 1400.0
    assert second < 1400.0
    assert first - 400.0 > second - first
    assert first - 400.0 > 200.0


def test_fall_is_an_inverse_sigmoid_and_starts_soft() -> None:
    origin, dest = 1000.0, 400.0
    assert abs(gpu_power._inverse_sigmoid_fall(origin, dest, 0.0) - origin) < 1e-6
    soft = gpu_power._inverse_sigmoid_fall(origin, dest, 0.7)
    assert origin - soft < 2.0
    mid = gpu_power._inverse_sigmoid_fall(origin, dest, gpu_power._SIGMOID_TAU_S)
    assert abs(mid - 700.0) < 5.0
    late = gpu_power._inverse_sigmoid_fall(origin, dest, gpu_power._SIGMOID_TAU_S * 3)
    assert late < 410.0
    assert late >= dest


def test_a_drop_in_draw_follows_the_sigmoid() -> None:
    _reset()
    bounds = (50.0, 1400.0)
    gpu_power._shape_gpu_cap("g1", 800.0, 1000.0, 0.50, 0.15, *bounds, 100.0)
    held = gpu_power._shape_gpu_cap("g1", 200.0, 1000.0, 0.50, 0.15, *bounds, 101.0)
    assert abs(held - 1000.0) < 1.0
    soft = gpu_power._shape_gpu_cap("g1", 200.0, held, 0.50, 0.15, *bounds, 101.7)
    assert 1000.0 - soft < 2.0
    mid = gpu_power._shape_gpu_cap("g1", 200.0, soft, 0.50, 0.15, *bounds, 101.0 + gpu_power._SIGMOID_TAU_S)
    dest = 200.0 / 0.50
    assert abs(mid - (1000.0 + (dest - 1000.0) * 0.5)) < 8.0


def test_budget_still_cuts_on_this_pass() -> None:
    _reset()
    caps, _p = gpu_power._range_caps(
        ["a", "b"],
        [500.0, 500.0],
        [1000.0, 1000.0],
        [(50.0, 1400.0), (50.0, 1400.0)],
        0.50,
        0.15,
        600.0,
        1.0,
    )
    assert abs(sum(caps) - 600.0) < 1e-6
    assert "a" not in gpu_power.LOOP.cap_ramp


def test_spare_budget_does_not_lift_an_oversized_cap() -> None:
    _reset()
    gpu_power._range_caps(
        ["a"],
        [188.0],
        [1230.0],
        [(200.0, 1400.0)],
        0.50,
        0.05,
        500_000.0,
        10.0,
    )
    caps, _p = gpu_power._range_caps(
        ["a"],
        [188.0],
        [1230.0],
        [(200.0, 1400.0)],
        0.50,
        0.05,
        500_000.0,
        10.0 + gpu_power._SIGMOID_TAU_S,
    )
    assert 188.0 / 0.50 < caps[0] < 900.0


def test_a_tight_cap_rises_toward_gpu_load_not_the_budget() -> None:
    _reset()
    caps, _p = gpu_power._range_caps(
        ["a", "b"],
        [200.0, 200.0],
        [200.0, 200.0],
        [(50.0, 1400.0), (50.0, 1400.0)],
        0.50,
        0.05,
        2000.0,
        1.0,
    )
    assert 200.0 < min(caps) < 400.0
    assert sum(caps) < 900.0
