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


if __name__ == "__main__":
    test_redfish_poll_waits_out_the_frequency()
    test_interval_accepts_milliseconds()
    test_power_patch_accepts_subsecond()
    print("ok")
