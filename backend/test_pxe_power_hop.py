"""Dynamic Power hops each rack through the PXE stored on that rack."""

from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.gpu_power import group_by_pxe
from app.maxlps_inventory import live_overview_counts
from app.models import InventoryNode, MaxLpsNode, MaxLpsRack
from app.pxe_servers import pxe_for_address
import app.pxe_hop as pxe_hop
import app.pxe_servers as pxe_servers
import app.sanity as sanity


class _IO:
    def __init__(self, text: str = "") -> None:
        self.channel = self
        self._text = text.encode()

    def read(self) -> bytes:
        return self._text

    def write(self, data: str) -> None:
        return None

    def shutdown_write(self) -> None:
        return None

    def settimeout(self, timeout: float) -> None:
        return None

    def recv_exit_status(self) -> int:
        return 0


class _Transport:
    def __init__(self) -> None:
        self.active = True

    def is_active(self) -> bool:
        return self.active

    def set_keepalive(self, seconds: int) -> None:
        return None


class _Client:
    def __init__(self) -> None:
        self.transport = _Transport()
        self.host = ""

    def set_missing_host_key_policy(self, policy: object) -> None:
        return None

    def connect(self, hostname: str | None = None, **kwargs: object) -> None:
        self.host = hostname or ""

    def get_transport(self) -> _Transport:
        return self.transport

    def close(self) -> None:
        self.transport.active = False

    def exec_command(self, command: str, timeout: float | None = None):
        text = "hop-ok\n" if "hop-ok" in command else f"ran-{self.host}\n"
        return _IO(), _IO(text), _IO()


def _reset_hops() -> None:
    pxe_hop.close()
    pxe_hop._fail_until.clear()
    pxe_servers._ADDR_PXE.clear()


def test_connect_keeps_every_pxe_and_run_uses_the_requested_one():
    _reset_hops()
    with patch("app.gpu_power.force_live_gpu_poll"), patch.object(pxe_hop.paramiko, "SSHClient", _Client), patch.object(
        pxe_hop.paramiko, "AutoAddPolicy", lambda: None
    ):
        pxe_hop.connect("tril", "secret", "10.0.0.1")
        pxe_hop.connect("tril", "secret", "10.0.0.2")
        assert set(pxe_hop.status()["hosts"]) == {"10.0.0.1", "10.0.0.2"}
        with pxe_hop.on_host("10.0.0.1"):
            code, out, _err = pxe_hop.run("echo")
        assert code == 0
        assert "10.0.0.1" in out
        pxe_hop.close("10.0.0.2")
        assert pxe_hop.status()["hosts"] == ["10.0.0.1"]
    _reset_hops()


def test_tunnel_uses_the_rack_pxe_not_the_active_hop():
    _reset_hops()
    try:
        with patch("app.gpu_power.force_live_gpu_poll"), patch.object(pxe_hop.paramiko, "SSHClient", _Client), patch.object(
            pxe_hop.paramiko, "AutoAddPolicy", lambda: None
        ):
            pxe_hop.connect("tril", "x", "10.0.0.1")
            pxe_hop.connect("tril", "x", "10.0.0.2")
            assert pxe_hop.status()["host"] == "10.0.0.2"
            with patch("app.pxe_servers.pxe_for_address", return_value="10.0.0.1"):
                pxe_hop.open_https_tunnel("rack-a", "10.10.1.5", 443)
            assert pxe_hop._pool["10.0.0.1"].tunnels["rack-a"]["bmc_ip"] == "10.10.1.5"
            assert "rack-a" not in pxe_hop._pool["10.0.0.2"].tunnels
            real_ensure = pxe_hop.ensure_host

            def _ensure(host: str) -> bool:
                if host == "10.9.9.9":
                    return False
                return real_ensure(host)

            with patch("app.pxe_servers.pxe_for_address", return_value="10.9.9.9"), patch.object(
                pxe_hop, "ensure_host", side_effect=_ensure
            ):
                try:
                    pxe_hop.open_https_tunnel("other", "10.10.9.9", 443)
                except pxe_hop.NeedsHop as exc:
                    assert "10.9.9.9" in str(exc)
                else:
                    raise AssertionError("tunnel opened without the rack PXE")
            assert "other" not in pxe_hop._pool["10.0.0.1"].tunnels
            assert "other" not in pxe_hop._pool["10.0.0.2"].tunnels
    finally:
        _reset_hops()


def test_group_by_pxe_keeps_unassigned_racks_out_of_another_pxe():
    rows = [("rack-a", "1", "10.10.1.1"), ("rack-b", "1", "10.10.2.1"), ("rack-c", "1", "10.10.3.1")]
    grouped, bare = group_by_pxe(rows, {"rack-a": "10.40.141.1", "rack-b": "172.25.231.244"}, lambda row: row[0])
    assert [row[0] for row in grouped["10.40.141.1"]] == ["rack-a"]
    assert [row[0] for row in grouped["172.25.231.244"]] == ["rack-b"]
    assert [row[0] for row in bare] == ["rack-c"]


class _Rack:
    def __init__(self, rack_id: str) -> None:
        self.id = rack_id


def test_overview_counts_live_telemetry_not_power_state():
    racks = [_Rack("a"), _Rack("b"), _Rack("c")]
    counts = live_overview_counts(
        racks,
        {
            "a": {"nodes_live": 1, "gpu_live": 4, "metered": False},
            "b": {"nodes_live": 0, "gpu_live": 0, "metered": True},
            "c": {"nodes_live": 0, "gpu_live": 0, "metered": False},
        },
    )
    assert counts == {"racks_on": 2, "nodes_on": 1, "gpus_live": 4}


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_pxe_for_address_uses_the_rack_then_the_inventory_node():
    pxe_servers._ADDR_PXE.clear()
    db = _session()
    db.add(MaxLpsRack(id="rack-1", label="POC", serial="SR1", model="GB300-NVL72", pxe_server="10.40.141.1"))
    db.add(
        MaxLpsNode(
            id="node-1",
            rack_id="rack-1",
            index=1,
            bmc_ip="10.10.13.31",
            os_ip="10.20.1.31",
            bmc_user="ADMIN",
            bmc_password="slot-secret",
        )
    )
    db.add(
        InventoryNode(
            id="inv-1",
            serial="OS-ONLY",
            name="os-only",
            kind="compute",
            source="manual",
            os_ip="10.20.9.9",
            pxe_server="172.25.231.244",
        )
    )
    db.commit()
    assert pxe_for_address("10.10.13.31", db) == "10.40.141.1"
    assert pxe_for_address("10.20.1.31", db) == "10.40.141.1"
    assert pxe_for_address("10.20.9.9", db) == "172.25.231.244"
    pxe_servers._ADDR_PXE.clear()


def test_sanity_redfish_uses_the_assigned_pxe():
    with patch("app.pxe_servers.pxe_for_address", return_value="10.40.141.1"), patch(
        "app.pxe_hop.ensure_host", return_value=True
    ) as ensure, patch("app.pxe_hop._redfish_json", return_value={"SerialNumber": "S"}) as rf, patch(
        "app.bmc_health.redfish_get"
    ) as direct:
        body = sanity._rf("10.10.13.31", "/redfish/v1/Systems", "ADMIN", "secret")
    ensure.assert_called_once_with("10.40.141.1")
    assert rf.call_args.kwargs["host"] == "10.40.141.1"
    direct.assert_not_called()
    assert body.get("_via") == "hop"


def test_sanity_does_not_call_the_bmc_directly_when_its_pxe_is_down():
    with patch("app.pxe_servers.pxe_for_address", return_value="10.40.141.1"), patch(
        "app.pxe_hop.ensure_host", return_value=False
    ), patch("app.bmc_health.redfish_get") as direct:
        body = sanity._rf("10.10.13.31", "/redfish/v1/Systems", "ADMIN", "secret")
    direct.assert_not_called()
    assert body["_error"] == "PXE 10.40.141.1 is not connected"


def _health_system() -> dict:
    return {"PowerState": "On", "Status": {"Health": "OK", "State": "Enabled"}}


def test_health_poll_uses_each_rack_pxe():
    import app.bmc_health as bmc_health

    targets = [
        {"rack_id": "a", "node_index": "1", "bmc_ip": "10.10.1.1", "user": "ADMIN", "password": "pw"},
        {"rack_id": "b", "node_index": "1", "bmc_ip": "10.10.2.2", "user": "ADMIN", "password": "pw"},
        {"rack_id": "bare", "node_index": "1", "bmc_ip": "10.10.9.9", "user": "ADMIN", "password": "pw"},
    ]
    calls: list[tuple[str | None, list[str]]] = []

    def fake_fetch(tgts, paths, timeout=40, host=None):
        ips = [t["bmc_ip"] for t in tgts]
        calls.append((host, ips))
        out = {}
        for ip in ips:
            own = (host == "10.40.141.1" and ip == "10.10.1.1") or (
                host == "172.25.231.244" and ip in {"10.10.2.2", "10.10.9.9"}
            )
            out[ip] = {"system": _health_system()} if own else {"system": {"_error": "HTTP 404"}}
        return out

    saved = dict(bmc_health._SNAP)
    try:
        with patch.object(bmc_health, "_targets", return_value=targets), patch(
            "app.gpu_power._rack_pxe_map", return_value={"a": "10.40.141.1", "b": "172.25.231.244"}
        ), patch("app.pxe_hop.ensure_saved", return_value=["10.40.141.1", "172.25.231.244"]), patch(
            "app.pxe_hop.ensure_host", return_value=True
        ), patch(
            "app.pxe_hop.status",
            return_value={"hosts": ["10.40.141.1", "172.25.231.244"], "connected": True},
        ), patch("app.pxe_hop.fetch_bmc_health", side_effect=fake_fetch), patch(
            "app.bmc_health.redfish_get"
        ) as direct:
            bmc_health._poll_once()
        assert ("10.40.141.1", ["10.10.1.1"]) in calls
        assert ("172.25.231.244", ["10.10.2.2"]) in calls
        assert ("10.40.141.1", ["10.10.9.9"]) in calls
        assert ("172.25.231.244", ["10.10.9.9"]) in calls
        assert all("10.10.9.9" not in ips or ips == ["10.10.9.9"] for _host, ips in calls)
        direct.assert_not_called()
        with bmc_health._LOCK:
            nodes = list(bmc_health._SNAP["nodes"])
        assert {n["bmc_ip"] for n in nodes} == {"10.10.1.1", "10.10.2.2", "10.10.9.9"}
        assert all(n.get("via") == "hop" and not n.get("error") for n in nodes)
    finally:
        with bmc_health._LOCK:
            bmc_health._SNAP.clear()
            bmc_health._SNAP.update(saved)
        bmc_health._FAIL_UNTIL.clear()


def test_health_poll_skips_direct_redfish_when_the_rack_pxe_is_down():
    import app.bmc_health as bmc_health

    targets = [
        {"rack_id": "a", "node_index": "1", "bmc_ip": "10.10.1.1", "user": "ADMIN", "password": "pw"},
    ]
    saved = dict(bmc_health._SNAP)
    try:
        with patch.object(bmc_health, "_targets", return_value=targets), patch(
            "app.gpu_power._rack_pxe_map", return_value={"a": "10.40.141.1"}
        ), patch("app.pxe_hop.ensure_saved", return_value=[]), patch(
            "app.pxe_hop.ensure_host", return_value=False
        ), patch("app.pxe_hop.status", return_value={"hosts": [], "connected": False}), patch(
            "app.pxe_hop.fetch_bmc_health"
        ) as fetch, patch("app.bmc_health.redfish_get") as direct:
            bmc_health._poll_once()
        fetch.assert_not_called()
        direct.assert_not_called()
        with bmc_health._LOCK:
            nodes = list(bmc_health._SNAP["nodes"])
        assert nodes and nodes[0]["error"] == "pxe-down"
        assert nodes[0]["via"] == "hop"
    finally:
        with bmc_health._LOCK:
            bmc_health._SNAP.clear()
            bmc_health._SNAP.update(saved)
        bmc_health._FAIL_UNTIL.clear()


def test_shelf_miss_zeros_the_last_reading():
    """A PowerShelf that does not answer this poll is 0 kW, not its previous total_power_out."""
    import app.gpu_power as gp

    nodes = [
        {"id": "ps1", "rack_id": "rack", "index": 1, "bmc_ip": "10.1.1.1", "user": "root", "password": "x"},
        {"id": "ps2", "rack_id": "rack", "index": 2, "bmc_ip": "10.1.1.2", "user": "root", "password": "x"},
    ]
    index = gp._shelf_index(nodes)
    gp._LIVE_SHELF.clear()
    try:
        gp._ingest_shelf(index, {"bmc_ip": "10.1.1.1", "total_w": 1600, "sensor_name": "total_power_out"})
        gp._ingest_shelf(index, {"bmc_ip": "10.1.1.2", "total_w": 4100, "sensor_name": "total_power_out"})
        rows, total, live, src = gp._merge_shelf_rows("rack", gp._read_shelf_cache().get("rack") or [])
        assert live and src == "redfish"
        assert abs(total - 5.7) < 0.001

        with patch("app.pxe_hop.ensure_host", return_value=True), patch(
            "app.pxe_hop.fetch_psu_power",
            return_value={
                "10.1.1.1": {"bmc_ip": "10.1.1.1", "total_w": None, "error": "no-watt-reading"},
                "10.1.1.2": {"bmc_ip": "10.1.1.2", "total_w": 3900, "sensor_name": "total_power_out"},
            },
        ):
            assert gp._poll_shelf_group("10.40.141.1", nodes, index) is True
        rows, total, live, src = gp._merge_shelf_rows("rack", gp._read_shelf_cache().get("rack") or [])
        by_index = {row["index"]: row for row in rows}
        assert live and src == "redfish"
        assert by_index[1]["down"] is True and by_index[1]["kw"] == 0
        assert by_index[2]["down"] is False and abs(by_index[2]["kw"] - 3.9) < 0.001
        assert abs(total - 3.9) < 0.001

        with patch("app.pxe_hop.ensure_host", return_value=False):
            assert gp._poll_shelf_group("10.40.141.1", nodes, index) is False
        rows, total, live, src = gp._merge_shelf_rows("rack", gp._read_shelf_cache().get("rack") or [])
        assert src == "down" and live is False and total == 0
        assert rows and all(row["down"] and row["kw"] == 0 for row in rows)

        gp._ingest_shelf(index, {"bmc_ip": "10.1.1.1", "total_w": 2000, "sensor_name": "total_power_out"})
        with gp._LIVE_GPU_LOCK:
            for row in gp._LIVE_SHELF["rack"]:
                if int(row["index"]) == 1:
                    row["t"] = 0
        rows, _total, _live, _src = gp._merge_shelf_rows("rack", gp._read_shelf_cache().get("rack") or [])
        stale = next(row for row in rows if row["index"] == 1)
        assert stale["down"] is True and stale["kw"] == 0
    finally:
        gp._LIVE_SHELF.clear()


def test_cap_post_counts_http_failures_and_a_down_pxe():
    import app.gpu_power as gp

    gp.LOOP.cap_result.clear()
    gp.LOOP.last_posted.pop("g-ok", None)
    gp.LOOP.last_posted.pop("g-fail", None)
    gp.LOOP.last_posted.pop("g-down", None)
    try:
        gp._remember_caps(
            [
                {"gid": "g-ok", "bmc_ip": "10.0.0.5", "path": "/a", "setpoint": 400},
                {"gid": "g-fail", "bmc_ip": "10.0.0.5", "path": "/b", "setpoint": 500},
            ],
            [
                {"bmc_ip": "10.0.0.5", "path": "/a", "status": 200, "ms": 182.4},
                {"bmc_ip": "10.0.0.5", "path": "/b", "status": 500, "error": "no", "ms": 40},
            ],
        )
        gp._remember_caps(
            [{"gid": "g-fail", "bmc_ip": "10.0.0.5", "path": "/b", "setpoint": 500}],
            [{"bmc_ip": "10.0.0.5", "path": "/b", "status": 0, "error": "down"}],
        )
        ok = gp.cap_post_stats("g-ok")
        fail = gp.cap_post_stats("g-fail")
        assert ok == {"cap_posts": 1, "cap_fails": 0, "cap_fail_pct": 0.0, "cap_ms": 182.4}
        gp._remember_caps(
            [{"gid": "g-ok", "bmc_ip": "10.0.0.5", "path": "/a", "setpoint": 410}],
            [{"bmc_ip": "10.0.0.5", "path": "/a", "status": 200, "ms": 510.2}],
        )
        assert gp.cap_post_stats("g-ok")["cap_ms"] == 510.2
        assert gp.cap_post_stats("g-ok")["cap_posts"] == 2
        assert fail["cap_posts"] == 2 and fail["cap_fails"] == 2 and fail["cap_fail_pct"] == 100.0
        assert fail["cap_ms"] == 40.0
        assert gp.LOOP.last_posted.get("g-ok") == 410
        assert "g-fail" not in gp.LOOP.last_posted

        with patch("app.pxe_servers.pxe_for_address", return_value="10.9.9.9"), patch(
            "app.pxe_hop.ensure_saved", return_value=[]
        ), patch("app.pxe_hop.ensure_host", return_value=False), patch(
            "app.pxe_hop.apply_gpu_setpoints"
        ) as apply:
            gp._apply_gpu_caps(
                [{"gid": "g-down", "bmc_ip": "10.10.1.9", "path": "/p", "setpoint": 300}]
            )
        apply.assert_not_called()
        down = gp.cap_post_stats("g-down")
        assert down["cap_posts"] == 1 and down["cap_fails"] == 1 and down["cap_fail_pct"] == 100.0
        assert down["cap_ms"] is None
        assert gp.cap_post_stats("missing")["cap_posts"] == 0
        assert gp.cap_post_stats("missing")["cap_ms"] is None
        assert "time.time()" in pxe_hop._HOP_GPU_CAP and '"ms"' in pxe_hop._HOP_GPU_CAP
        compile(pxe_hop._HOP_GPU_CAP, "l12-gpu-cap.py", "exec")
    finally:
        gp.LOOP.cap_result.pop("g-ok", None)
        gp.LOOP.cap_result.pop("g-fail", None)
        gp.LOOP.cap_result.pop("g-down", None)
        gp.LOOP.last_posted.pop("g-ok", None)
