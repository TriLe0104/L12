"""Dynamic Power frequency accepts milliseconds, stored as fractional seconds."""

from pydantic import ValidationError

from app import gpu_power
from app.routers.cluster import PowerPatch


def test_interval_accepts_milliseconds() -> None:
    prev = gpu_power.LOOP.interval_s
    try:
        gpu_power.apply_loop(interval_s=0.05)
        assert abs(gpu_power.LOOP.interval_s - 0.05) < 1e-9
        gpu_power.apply_loop(interval_s=0.001)
        assert abs(gpu_power.LOOP.interval_s - 0.001) < 1e-12
        gpu_power.apply_loop(interval_s=0.0001)
        assert abs(gpu_power.LOOP.interval_s - gpu_power.MIN_INTERVAL_S) < 1e-12
        gpu_power.apply_loop(interval_s=1)
        assert abs(gpu_power.LOOP.interval_s - 1) < 1e-9
        gpu_power.apply_loop(interval_s=10)
        assert abs(gpu_power.LOOP.interval_s - 10) < 1e-9
        gpu_power.apply_loop(interval_s=999)
        assert abs(gpu_power.LOOP.interval_s - 300) < 1e-9
    finally:
        gpu_power.LOOP.interval_s = prev


def test_power_patch_accepts_subsecond() -> None:
    assert PowerPatch(interval_s=0.001).interval_s == 0.001
    assert PowerPatch(interval_s=0.05).interval_s == 0.05
    assert PowerPatch(interval_s=1).interval_s == 1
    assert PowerPatch(interval_s=300).interval_s == 300
    try:
        PowerPatch(interval_s=0.0005)
    except ValidationError:
        return
    raise AssertionError("interval under 1 ms must be rejected")


def test_redfish_poll_waits_out_the_frequency() -> None:
    assert gpu_power._poll_wait_s(2.0, 10.0) == 8.0
    assert gpu_power._poll_wait_s(3.0, 0.05) == 0.0
    assert abs(gpu_power._poll_wait_s(0.0, 0.001) - 0.001) < 1e-9
    assert gpu_power._poll_wait_s(0.0, 0.05) == 0.05


def test_continuous_starts_the_next_power_read_immediately() -> None:
    prev_flag = gpu_power.LOOP.continuous
    prev_interval = gpu_power.LOOP.interval_s
    prev_force = gpu_power.LOOP.force
    try:
        gpu_power.LOOP.continuous = False
        gpu_power.LOOP.force = False
        gpu_power.LOOP.interval_s = 10.0
        assert gpu_power._gpu_round_wait_s(0.7, had_targets=True) == 9.3
        assert gpu_power._cap_check_open(due=False, busy=False) is False
        assert gpu_power._cap_check_open(due=True, busy=True) is False
        assert gpu_power._cap_check_open(due=True, busy=False) is True
        gpu_power.apply_loop(continuous=True)
        assert gpu_power.LOOP.continuous is True
        assert gpu_power.LOOP.force is True
        assert gpu_power.LOOP.interval_s == 10.0
        assert gpu_power._gpu_round_wait_s(0.7, had_targets=True) == 0.0
        assert abs(gpu_power._gpu_round_wait_s(0.01, had_targets=True) - 0.04) < 1e-9
        assert gpu_power._gpu_round_wait_s(0.0, had_targets=False) == 10.0
        assert gpu_power._cap_check_open(due=False, busy=False) is True
        assert gpu_power._cap_check_open(due=True, busy=True) is False
        gpu_power.LOOP.force = False
        gpu_power.apply_loop(continuous=True)
        assert gpu_power.LOOP.force is False
        gpu_power.apply_loop(continuous=False)
        assert gpu_power.LOOP.continuous is False
        assert gpu_power.LOOP.interval_s == 10.0
        assert gpu_power._gpu_round_wait_s(0.7, had_targets=True) == 9.3
    finally:
        gpu_power.LOOP.continuous = prev_flag
        gpu_power.LOOP.interval_s = prev_interval
        gpu_power.LOOP.force = prev_force


def test_power_patch_accepts_continuous() -> None:
    assert PowerPatch(continuous=True).continuous is True
    assert PowerPatch(continuous=False).continuous is False
    assert PowerPatch().continuous is None


def test_gpu_cap_is_a_percent_of_power_left_after_the_rack() -> None:
    # 140 kW envelope, rack already drawing 28 kW, GPU power 100% -> 112 kW, not 140.
    assert gpu_power._gpu_allowable_w(140_000, 28_000, 1.0) == 112_000
    assert gpu_power._gpu_allowable_w(140_000, 28_000, 0.5) == 56_000
    assert gpu_power._gpu_allowable_w(140_000, 200_000, 1.0) == 0.0
    assert gpu_power._gpu_allowable_w(140_000, 0, 0.75) == 105_000


def test_shown_rack_draw_skips_a_rack_past_the_envelope() -> None:
    def fake(rid: str):
        kw = {"a": 100.0, "b": 50.0, "c": 10.0}[rid]
        return [], kw, True, "redfish"

    orig = gpu_power._merge_shelves
    gpu_power._merge_shelves = fake
    try:
        draw = gpu_power._shown_rack_draw_w(
            [("a", False, "a"), ("b", False, "b"), ("c", False, "c")],
            140_000,
        )
        assert abs(draw - 110_000) < 1
    finally:
        gpu_power._merge_shelves = orig


def test_continuous_leaves_shelves_on_frequency() -> None:
    import inspect

    shelf = inspect.getsource(gpu_power._shelf_watch_forever)
    gpu = inspect.getsource(gpu_power._gpu_watch_forever)
    assert "_sleep_poll_interval" in shelf
    assert "_gpu_round_wait_s" not in shelf
    assert "_gpu_round_wait_s" in gpu
    assert "LOOP.continuous" in gpu


if __name__ == "__main__":
    test_redfish_poll_waits_out_the_frequency()
    test_interval_accepts_milliseconds()
    test_power_patch_accepts_subsecond()
    test_continuous_starts_the_next_power_read_immediately()
    test_power_patch_accepts_continuous()
    test_gpu_cap_is_a_percent_of_power_left_after_the_rack()
    test_shown_rack_draw_skips_a_rack_past_the_envelope()
    test_continuous_leaves_shelves_on_frequency()
    print("ok")
