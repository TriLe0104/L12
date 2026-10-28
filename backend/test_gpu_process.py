"""GPU inspector process rows come from the node nvidia-smi dump."""

from app import gpu_power

SAMPLE = """0, GPU-aaa
1, GPU-bbb

--APPS--
GPU-aaa, 43210, /usr/bin/python3, 1000
GPU-aaa, 43211, nccl-tests, 4000
GPU-bbb, 7, python, 10

--CMD--
43210 python3 pretrain_gb300.py --n 4
43211 /opt/nccl/all_reduce_perf -b 8
7 python serve.py
"""


def test_smi_dump_picks_the_busiest_process() -> None:
    rows, ok = gpu_power._procs_from_smi(SAMPLE)
    assert ok
    top = rows[0]
    assert top["pid"] == 43211
    assert top["process"] == "nccl-tests"
    assert "all_reduce_perf" in top["workload"]
    assert top["workload"].endswith("+1")
    other = gpu_power._proc_row(rows, ok=True, gpu_n=2)
    assert other["pid"] == 7
    assert other["process"] == "python"
    assert other["workload"] == "python serve.py"


def test_empty_app_list_is_idle() -> None:
    raw = "0, GPU-aaa\n\n--APPS--\n\n--CMD--\n"
    rows, ok = gpu_power._procs_from_smi(raw)
    assert ok
    assert rows == {}
    assert gpu_power._proc_row(rows, ok=True, gpu_n=1)["process"] == "idle"
    assert gpu_power._proc_row(rows, ok=True, gpu_n=1)["pid"] == 0


def test_failed_read_stays_blank() -> None:
    rows, ok = gpu_power._procs_from_smi("nvidia-smi: not found\n")
    assert not ok
    blank = gpu_power._proc_row(rows, ok=False, gpu_n=1)
    assert blank["process"] == "—"
    assert blank["pid"] == 0


def test_gid_parse_and_script_markers() -> None:
    assert gpu_power._parse_gid("1653-n06-g2") == ("1653", 6, 2)
    assert gpu_power._parse_gid("custom-gb300-n12-g4") == ("custom-gb300", 12, 4)
    assert gpu_power._parse_gid("nope") is None
    assert "printf '\\n--APPS--\\n'" in gpu_power._OS_PROC_SH
    assert "tr '\\0'" in gpu_power._OS_PROC_SH
    assert "password" not in gpu_power._OS_PROC_SH


if __name__ == "__main__":
    test_smi_dump_picks_the_busiest_process()
    test_empty_app_list_is_idle()
    test_failed_read_stays_blank()
    test_gid_parse_and_script_markers()
    print("ok")
