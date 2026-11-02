"""GPU caps rise in one pass and ease down. A budget overrun still cuts now."""

import math

from app import gpu_power


def _reset() -> None:
    gpu_power.LOOP.held_cap.clear()
    gpu_power.LOOP.held_cap_t.clear()


def test_rise_is_one_pass_and_a_drop_eases_down() -> None:
    _reset()
    bounds = [(50.0, 1400.0)]
    first, _p = gpu_power._shaped_caps(["g1"], [400.0], 0.5, bounds, 100_000.0, 1_000.0)
    assert first == [800.0]

    dropped, _p = gpu_power._shaped_caps(["g1"], [100.0], 0.5, bounds, 100_000.0, 1_000.7)
    raw = 200.0
    expected = raw + (800.0 - raw) * math.exp(-0.7 / gpu_power.CAP_RELEASE_TAU_S)
    assert abs(dropped[0] - expected) < 1e-6
    assert dropped[0] > 700.0

    risen, _p = gpu_power._shaped_caps(["g1"], [500.0], 0.5, bounds, 100_000.0, 1_001.4)
    assert risen == [1_000.0]


def test_budget_cut_is_immediate_and_becomes_the_hold() -> None:
    _reset()
    bounds = [(50.0, 1400.0)]
    opened, _p = gpu_power._shaped_caps(["g1"], [400.0], 0.5, bounds, 100_000.0, 10.0)
    assert opened == [800.0]

    cut, p = gpu_power._shaped_caps(["g1"], [400.0], 0.5, bounds, 300.0, 10.7)
    assert abs(cut[0] - 300.0) < 1e-6
    assert abs(gpu_power.LOOP.held_cap["g1"] - 300.0) < 1e-6
    assert p > 0.5

    still, _p = gpu_power._shaped_caps(["g1"], [400.0], 0.5, bounds, 300.0, 11.7)
    assert abs(still[0] - 300.0) < 1e-6

    eased, _p = gpu_power._shaped_caps(["g1"], [50.0], 0.5, bounds, 100_000.0, 12.4)
    raw = 100.0
    expected = raw + (300.0 - raw) * math.exp(-0.7 / gpu_power.CAP_RELEASE_TAU_S)
    assert abs(eased[0] - expected) < 1e-6
    assert eased[0] > 250.0


def test_budget_fit_scales_held_caps_by_usage_shape() -> None:
    _reset()
    bounds = [(50.0, 1400.0), (50.0, 1400.0)]
    caps, _p = gpu_power._shaped_caps(
        ["a", "b"],
        [100.0, 300.0],
        0.5,
        bounds,
        400.0,
        0.0,
    )
    assert abs(caps[0] - 100.0) < 1e-6
    assert abs(caps[1] - 300.0) < 1e-6
    assert abs(gpu_power.LOOP.held_cap["a"] - 100.0) < 1e-6
    assert abs(gpu_power.LOOP.held_cap["b"] - 300.0) < 1e-6
