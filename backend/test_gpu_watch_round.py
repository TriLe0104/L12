"""An empty GPU poll must not keep a stale no-bmc-targets label."""

from app import gpu_power
from app import pxe_hop


def _round(**kwargs: object) -> None:
    gpu_power._finish_gpu_round(
        nodes_n=int(kwargs.get("nodes_n", 0)),
        hopped=bool(kwargs.get("hopped", False)),
        missing_pw=int(kwargs.get("missing_pw", 0)),
        bare_n=int(kwargs.get("bare_n", 0)),
        last_err=str(kwargs.get("last_err", "")),
        node_err=str(kwargs.get("node_err", "")),
        hosts_up=bool(kwargs.get("hosts_up", True)),
        direct_n=int(kwargs.get("direct_n", 0)),
        query_err=str(kwargs.get("query_err", "")),
    )


def test_empty_inventory_query_is_not_labeled_as_missing_targets() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU_ERR = "no-bmc-targets"
    gpu_power._LIVE_GPU_T = 0.0
    _round(nodes_n=0, query_err="database is locked")
    assert gpu_power._LIVE_GPU_ERR == "database is locked"
    assert gpu_power._LIVE_GPU_T > 0


def test_targets_with_empty_power_replace_the_stale_label() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU_ERR = "no-bmc-targets"
    gpu_power._LIVE_GPU_T = 10.0
    _round(nodes_n=18, hosts_up=True, node_err="power-reading-empty")
    assert gpu_power._LIVE_GPU_ERR == "power-reading-empty"
    assert gpu_power._LIVE_GPU_T > 10


def test_answered_bmcs_clear_the_error() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU_ERR = "no-bmc-targets"
    _round(nodes_n=18, hopped=True)
    assert gpu_power._LIVE_GPU_ERR == ""


def test_held_readings_stay_when_the_next_round_is_empty() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU["g1"] = {"watts": 350.0}
    gpu_power._LIVE_GPU_ERR = ""
    gpu_power._LIVE_GPU_T = 40.0
    _round(nodes_n=18, hosts_up=True, node_err="power-reading-empty")
    assert gpu_power._LIVE_GPU["g1"]["watts"] == 350.0
    assert gpu_power._LIVE_GPU_ERR == "power-reading-empty"
    assert gpu_power._LIVE_GPU_T == 40.0
    gpu_power._LIVE_GPU.clear()


def test_no_bmc_addresses_keeps_that_label() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU_ERR = ""
    _round(nodes_n=0)
    assert gpu_power._LIVE_GPU_ERR == "no-bmc-targets"


def test_password_and_hop_misses() -> None:
    gpu_power._LIVE_GPU.clear()
    _round(nodes_n=4, missing_pw=4, bare_n=0, hosts_up=True)
    assert gpu_power._LIVE_GPU_ERR == "bmc-password-missing"
    gpu_power._LIVE_GPU.clear()
    _round(nodes_n=4, hosts_up=False, direct_n=0)
    assert gpu_power._LIVE_GPU_ERR == "pxe-hop-down"


def test_hop_script_reads_the_sensor_when_the_metric_is_empty() -> None:
    src = pxe_hop._HOP_GPU_POWER
    assert "DataSourceUri" in src
    assert 'row["ms"]' in src
    assert "time.time()" in src
    assert "power-reading-empty" in src
    assert "fetch_and_emit" in src
    assert '"done": True' in src
    assert "_BMCConn" in src
    assert "keep-alive" in src
    assert "persist" in src
    compile(src, "l12-gpu-power.py", "exec")


def test_live_ranking_orders_highest_watts_first() -> None:
    gpu_power._LIVE_GPU.clear()
    gpu_power._LIVE_GPU["a"] = {"watts": 10.0}
    gpu_power._LIVE_GPU["b"] = {"watts": 30.2}
    gpu_power._LIVE_GPU["c"] = {"watts": 20.0}
    rows = gpu_power.live_ranking()["gpus"]
    assert [r["id"] for r in rows] == ["b", "c", "a"]
    assert [r["rank"] for r in rows] == [1, 2, 3]
    assert rows[0]["watts"] == 30.2
    gpu_power._LIVE_GPU.clear()


def test_frequency_paces_the_live_read() -> None:
    prev = gpu_power.LOOP.interval_s
    try:
        gpu_power.LOOP.interval_s = 0.5
        assert abs(gpu_power._poll_wait_s(0.1) - 0.4) < 1e-9
        gpu_power.LOOP.interval_s = 0.001
        assert abs(gpu_power._poll_wait_s(0.0) - 0.001) < 1e-9
        assert "interval_ms" not in gpu_power.live_ranking()
    finally:
        gpu_power.LOOP.interval_s = prev


def test_unselected_gpus_consume_cap_left() -> None:
    rows = [
        {"id": "r1-n01-g1", "rack_id": "r1", "node": 1, "watts": 400.0},
        {"id": "r1-n02-g1", "rack_id": "r1", "node": 2, "watts": 800.0},
    ]
    selected_keys = {("r1", 2)}
    outside = gpu_power._unselected_draw_w(rows, selected_keys)
    assert outside == 400.0
    used = sum(float(r["watts"]) for r in rows)
    assert used == 1200.0
    share = 1000.0
    left = max(0.0, share - outside)
    caps, _p = gpu_power._post_caps([800.0], left, 0.5, [(50.0, 1400.0)])
    caps_ignoring, _ = gpu_power._post_caps([800.0], share, 0.5, [(50.0, 1400.0)])
    assert caps[0] < caps_ignoring[0]
    assert caps[0] <= left + 1e-6
    assert gpu_power._unselected_draw_w(rows, None) == 0.0
    assert gpu_power._unselected_draw_w(rows, set()) == 1200.0
    assert max(0.0, share - 1200.0) == 0.0
    # Static has no SetPoint fit. Cap left is still the share minus every live watt
    # while every node is selected. An uncapped node is held at its BMC max.
    assert share - used == share - 1200.0
    uncapped = [
        {"rack_id": "r1", "node": 1, "watts": 180.0, "hw_max": 1400.0},
        {"rack_id": "r1", "node": 1, "watts": 180.0, "hw_max": 1400.0},
        {"rack_id": "r1", "node": 2, "watts": 190.0, "hw_max": 1400.0},
    ]
    hold = gpu_power._unselected_hold_w(uncapped, {("r1", 2)})
    assert hold == 2800.0
    draw_left = 10_000.0 - (180.0 + 180.0 + 190.0)
    held_left = 10_000.0 - 190.0 - hold
    assert held_left == 10_000.0 - 190.0 - 2800.0
    assert held_left < draw_left


def test_live_power_response_follows_the_latest_read() -> None:
    gpu_power._LIVE_GPU.clear()
    index = {"10.0.0.8": ("r1", "1")}
    try:
        gpu_power._ingest_bmc(
            index,
            {"bmc_ip": "10.0.0.8", "gpus": [{"index": 1, "watts": 180, "ms": 120.5, "path": "/p"}]},
        )
        gid = "r1-n01-g1"
        assert gpu_power.live_read_ms(gid) == 120.5
        gpu_power._ingest_bmc(
            index,
            {"bmc_ip": "10.0.0.8", "gpus": [{"index": 1, "watts": 190, "ms": 88.2, "path": "/p"}]},
        )
        assert gpu_power._LIVE_GPU[gid]["watts"] == 190.0
        assert gpu_power.live_read_ms(gid) == 88.2
        gpu_power._ingest_bmc(
            index,
            {"bmc_ip": "10.0.0.8", "gpus": [{"index": 1, "watts": 191, "path": "/p"}]},
        )
        assert gpu_power.live_read_ms(gid) == 88.2
    finally:
        gpu_power._LIVE_GPU.clear()


def test_loop_membership_is_rack_and_node() -> None:
    keys = {("r1", 2)}
    assert gpu_power._row_in_loop({"rack_id": "r1", "node": 2}, keys)
    assert not gpu_power._row_in_loop({"rack_id": "r1", "node": 3}, keys)
    assert not gpu_power._row_in_loop({"rack_id": "r2", "node": 2}, keys)
    assert gpu_power._row_in_loop({"rack_id": "other", "node": 1}, None)
    assert not gpu_power._row_in_loop({"rack_id": "r1", "node": "nope"}, keys)
    assert gpu_power.node_gpu_ids("r1", 2) == [
        "r1-n02-g1",
        "r1-n02-g2",
        "r1-n02-g3",
        "r1-n02-g4",
    ]


def test_gpu_lines_apply_as_each_bmc_finishes() -> None:
    seen: list[str] = []

    def on_node(node: dict) -> None:
        seen.append(node["bmc_ip"])

    n, errs, stop = pxe_hop._take_gpu_line(
        {"bmc_ip": "10.0.0.2", "gpus": [{"index": 1, "watts": 200}]},
        on_node,
    )
    assert (n, errs, stop, seen) == (1, [], False, ["10.0.0.2"])
    n, errs, stop = pxe_hop._take_gpu_line({"ok": True, "done": True}, on_node)
    assert (n, errs, stop) == (0, [], True)
    seen.clear()
    n, _errs, stop = pxe_hop._take_gpu_line(
        {"ok": True, "nodes": [{"bmc_ip": "10.0.0.3", "gpus": [{"watts": 11}]}]},
        on_node,
    )
    assert n == 1 and stop and seen == ["10.0.0.3"]


def test_power_target_key_hides_the_password() -> None:
    key = pxe_hop._power_targets_key(
        [
            {"bmc_ip": "10.1.1.2", "user": "ADMIN", "password": "s3cret-token"},
            {"bmc_ip": "10.1.1.1", "user": "root", "password": "s3cret-token"},
        ]
    )
    assert [row[0] for row in key] == ["10.1.1.1", "10.1.1.2"]
    assert "s3cret-token" not in str(key)
    assert key[0][2] == key[1][2]
    assert len(key[0][2]) == 12


def test_stop_power_pipe_is_safe_when_missing() -> None:
    hop = pxe_hop._Hop("10.0.0.1", "root", None)
    pxe_hop._stop_power_pipe(hop)
    assert hop.power_pipe is None


def test_power_kicks_reuse_one_process() -> None:
    import inspect
    import threading

    assert "exec_command" not in inspect.getsource(pxe_hop._read_gpu_round)
    pipe = pxe_hop._PowerPipe()
    scripted = _ScriptedPipe()
    pipe.stdin = scripted
    pipe.stdout = scripted
    threading.Thread(target=pxe_hop._power_pipe_reader, args=(pipe,), daemon=True).start()
    seen: list[float] = []

    def on_node(node: dict) -> None:
        seen.append(float(node["gpus"][0]["ms"]))

    err = pxe_hop._kick_power_pipe(pipe, on_node, timeout=2)
    assert err == ""
    err = pxe_hop._kick_power_pipe(pipe, on_node, timeout=2)
    assert err == ""
    assert seen == [400.0, 40.0]
    assert scripted.writes == ["\n", "\n"]
    assert pipe.dead is False


def test_power_kick_timeout_marks_the_pipe_dead() -> None:
    import threading

    pipe = pxe_hop._PowerPipe()
    hung = _HungPipe()
    pipe.stdin = hung
    pipe.stdout = hung
    threading.Thread(target=pxe_hop._power_pipe_reader, args=(pipe,), daemon=True).start()
    err = pxe_hop._kick_power_pipe(pipe, lambda _node: None, timeout=0.3)
    assert err == "power-read-timeout"
    assert pipe.dead is True


class _ScriptedPipe:
    def __init__(self) -> None:
        import threading

        self.channel = self
        self.writes: list[str] = []
        self.pending: list[str] = []
        self.cv = threading.Condition()
        self.n = 0

    def write(self, data: str) -> None:
        with self.cv:
            self.writes.append(data)
            self.n += 1
            ms = 400.0 if self.n == 1 else 40.0
            self.pending.append(
                '{"bmc_ip":"10.0.0.2","gpus":[{"index":1,"watts":10,"ms":%s}]}\n' % ms
            )
            self.pending.append('{"ready":true}\n')
            self.cv.notify_all()

    def flush(self) -> None:
        return None

    def readline(self) -> str:
        with self.cv:
            while not self.pending:
                self.cv.wait(timeout=2)
            return self.pending.pop(0)

    def close(self) -> None:
        return None


class _HungPipe:
    def __init__(self) -> None:
        import threading

        self.channel = self
        self.go = threading.Event()

    def write(self, data: str) -> None:
        return None

    def flush(self) -> None:
        return None

    def readline(self) -> str:
        self.go.wait(3)
        return ""

    def close(self) -> None:
        self.go.set()


if __name__ == "__main__":
    test_empty_inventory_query_is_not_labeled_as_missing_targets()
    test_targets_with_empty_power_replace_the_stale_label()
    test_answered_bmcs_clear_the_error()
    test_held_readings_stay_when_the_next_round_is_empty()
    test_no_bmc_addresses_keeps_that_label()
    test_password_and_hop_misses()
    test_hop_script_reads_the_sensor_when_the_metric_is_empty()
    test_live_ranking_orders_highest_watts_first()
    test_frequency_paces_the_live_read()
    test_unselected_gpus_consume_cap_left()
    test_live_power_response_follows_the_latest_read()
    test_loop_membership_is_rack_and_node()
    test_gpu_lines_apply_as_each_bmc_finishes()
    test_power_target_key_hides_the_password()
    test_stop_power_pipe_is_safe_when_missing()
    test_power_kicks_reuse_one_process()
    test_power_kick_timeout_marks_the_pipe_dead()
    print("ok")
