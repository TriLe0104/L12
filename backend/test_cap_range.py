"""GPU caps hold inside the operation range, rise on a log curve, and fall on an inverse sigmoid."""

from app import gpu_power


def _reset() -> None:
    gpu_power.LOOP.cap_ramp.clear()


def test_band_is_gpu_load_plus_or_minus_the_operation_range() -> None:
    assert gpu_power._op_band(0.50, 0.15) == (0.35, 0.65)
    assert gpu_power._op_band(0.80, 0.15) == (0.65, 0.95)


def test_draw_inside_the_range_does_not_move_the_cap() -> None:
    _reset()
    cap = gpu_power._shape_gpu_cap("g1", 500.0, 1000.0, 0.50, 0.15, 50.0, 1400.0, 10.0)
    assert cap == 1000.0
    assert "g1" not in gpu_power.LOOP.cap_ramp
    edge = gpu_power._shape_gpu_cap("g1", 650.0, 1000.0, 0.50, 0.15, 50.0, 1400.0, 11.0)
    assert edge == 1000.0


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


def test_a_dip_holds_then_softens_toward_gpu_load() -> None:
    _reset()
    bounds = (50.0, 1400.0)
    held = gpu_power._shape_gpu_cap("g1", 200.0, 1000.0, 0.50, 0.15, *bounds, 100.0)
    assert held == 1000.0
    soft = gpu_power._shape_gpu_cap("g1", 200.0, held, 0.50, 0.15, *bounds, 100.7)
    assert 1000.0 - soft < 2.0
    mid = gpu_power._shape_gpu_cap("g1", 200.0, soft, 0.50, 0.15, *bounds, 106.0)
    assert abs(mid - 700.0) < 5.0


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
