from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import InventoryNode
from app.provision import add_or_update_node, normalize_mac, _is_placeholder_serial, _placeholder_serial


def test_normalize_mac():
    assert normalize_mac("3C-6D-66-AA-BB-CC") == "3c:6d:66:aa:bb:cc"
    assert normalize_mac("3c6d66aabbcc") == "3c:6d:66:aa:bb:cc"
    assert normalize_mac("3c:6d:66:aa:bb:cc") == "3c:6d:66:aa:bb:cc"
    assert normalize_mac("nope") is None
    assert normalize_mac("") is None


def test_node_gaps_only_when_missing():
    from app.provision import fill_node_gaps, node_gaps

    demo = InventoryNode(
        id="d",
        serial="SN-DEMO",
        name="demo",
        kind="compute",
        source="demo",
        bmc_mac="aa:bb:cc:dd:ee:01",
        bmc_password="x",
    )
    assert node_gaps(demo) == []
    ready = InventoryNode(
        id="r",
        serial="S123",
        name="node-a",
        kind="compute",
        source="manual",
        bmc_mac="aa:bb:cc:dd:ee:02",
        bmc_ip="10.0.0.8",
        bmc_password="x",
        sol_log="=== Redfish ===\nRedfishVersion 1.0\n",
    )
    assert node_gaps(ready) == []
    missing_ip = InventoryNode(
        id="m",
        serial="MAC-AABBCCDDEE03",
        name="MAC-AABBCCDDEE03",
        kind="compute",
        source="manual",
        bmc_mac="aa:bb:cc:dd:ee:03",
        bmc_password="x",
    )
    assert node_gaps(missing_ip) == ["ip"]
    missing_sol = InventoryNode(
        id="s",
        serial="S999",
        name="vera",
        kind="compute",
        source="argus",
        bmc_ip="10.10.17.177",
        bmc_mac="aa:bb:cc:dd:ee:04",
        bmc_password="x",
        sol_log="",
    )
    assert node_gaps(missing_sol) == ["sol"]
    has_console = InventoryNode(
        id="k",
        serial="S1000",
        name="vera",
        kind="compute",
        source="manual",
        bmc_ip="10.10.17.177",
        bmc_mac="aa:bb:cc:dd:ee:09",
        bmc_password="x",
        sol_log="link/ether 5c:6b:6e:5c:e7:ca brd ff:ff:ff:ff:ff:ff\ninet 10.10.3.50/16 metric 100\n",
    )
    assert node_gaps(has_console) == []

    db = _session()
    row = InventoryNode(
        id="fill",
        serial="MAC-AABBCCDDEE05",
        name="MAC-AABBCCDDEE05",
        kind="compute",
        source="manual",
        bmc_ip="10.10.1.5",
        bmc_password="secret",
        provision_status="registered",
    )
    db.add(row)
    db.commit()

    def _enrich(node, arp=True, redfish=True):
        assert redfish is True
        assert node.serial.startswith("MAC-")
        node.bmc_mac = node.bmc_mac or "aa:bb:cc:dd:ee:05"
        node.serial = "SN-FROM-BMC"
        node.name = "vera"
        return {"serial": "SN-FROM-BMC", "notes": []}

    def _sol(node):
        node.sol_log = "=== Redfish ===\nRedfishVersion 1.0\n"
        return node

    with patch("app.provision.pxe_hop.status", return_value={"connected": True}), patch(
        "app.provision.enrich_node", side_effect=_enrich
    ), patch("app.provision._capture_live_sol", side_effect=_sol):
        still = fill_node_gaps(db, row)
    assert still == []
    assert row.serial == "SN-FROM-BMC"
    assert row.bmc_mac == "aa:bb:cc:dd:ee:05"
    assert "RedfishVersion" in (row.sol_log or "")


def test_pick_rack_by_node_name():
    from types import SimpleNamespace
    from unittest.mock import patch

    from app.sanity import pick_rack

    qs = SimpleNamespace(
        id="qs",
        label="SR-GB200-QS-Rack1",
        serial="QS",
        origin="argus",
        nodes=[SimpleNamespace(hostname="hostname", serial="S1", bmc_ip="10.0.0.1")],
    )
    vr = SimpleNamespace(
        id="vr",
        label="VR",
        serial="",
        origin="manual",
        nodes=[SimpleNamespace(hostname="Vera Rubin", serial="SNVR", bmc_ip="10.10.17.177")],
    )
    with patch("app.sanity.maxlps_inventory.load_racks", return_value=[qs, vr]):
        assert pick_rack(None, "vera rubon", "vera rubon").id == "vr"
        assert pick_rack(None, "VR", "VR").id == "vr"
        assert pick_rack(None, None, None).id == "qs"
        assert pick_rack(None, "no such rack", "no such rack") is None


def test_node_has_serial_skips_empty_slots():
    from app.sanity import node_has_serial

    assert node_has_serial("0A265S015410")
    assert not node_has_serial("")
    assert not node_has_serial(None)
    assert not node_has_serial("—")
    assert not node_has_serial("MAC-AABBCCDDEE")


def test_blank_golden_is_not_a_failure():
    from app.sanity import compare_bom

    empty = {"system": {"os_version": "N/A"}, "firmware": {"bios_version": "N/A"}, "memory": {"modules": []}}
    live = {"system": {"os_version": "Ubuntu 26.04.1 LTS"}, "firmware": {"bios_version": "06.05.01.03"}, "memory": {"modules": [{"part_number": "X"}]}}
    assert compare_bom(empty, live) == []
    dated = {"firmware": {"bios_version": "(Date: )"}}
    assert compare_bom(dated, {"firmware": {"bios_version": "06.05.01.03"}}) == []
    real = {"firmware": {"bios_version": "1.0"}}
    diffs = compare_bom(real, {"firmware": {"bios_version": "2.0"}})
    assert any(row["label"] == "BIOS Version" and row["status"] == "DIFF" for row in diffs)


def test_placeholder_serial():
    assert _placeholder_serial("3c:6d:66:aa:bb:cc", None) == "MAC-3C6D66AABBCC"
    assert _is_placeholder_serial("MAC-3C6D66AABBCC")
    assert not _is_placeholder_serial("S12345678")


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_add_node_by_mac_without_hop():
    db = _session()
    with patch("app.provision.enrich_node", return_value={"notes": ["Connect the PXE hop to ARP-scan this MAC"]}):
        node, filled, created = add_or_update_node(
            db,
            bmc_mac="3c6d66aabbcc",
            bmc_user="ADMIN",
            bmc_password="secret",
        )
    assert created
    assert node.bmc_mac == "3c:6d:66:aa:bb:cc"
    assert node.bmc_user == "ADMIN"
    assert node.bmc_password == "secret"
    assert node.source == "manual"
    assert node.serial.startswith("MAC-")
    assert node.hall_name == node.name == node.serial
    same, _, created2 = add_or_update_node(db, bmc_mac="3C:6D:66:AA:BB:CC", bmc_ip="10.10.1.9")
    assert not created2
    assert same.id == node.id
    assert same.bmc_ip == "10.10.1.9"


def test_add_requires_mac_or_ip():
    db = _session()
    try:
        add_or_update_node(db, bmc_user="ADMIN", bmc_password="x")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "MAC" in str(exc) or "IP" in str(exc)


def test_patch_name_without_touching_bmc():
    db = _session()
    with patch("app.provision.enrich_node", return_value={"notes": []}):
        node, _, _ = add_or_update_node(db, bmc_mac="3c6d66aabbcc", bmc_user="ADMIN", bmc_password="secret")
    from app.provision import apply_node_fields

    apply_node_fields(db, node, name="rack-slot3")
    db.commit()
    db.refresh(node)
    assert node.name == "rack-slot3"
    assert node.bmc_mac == "3c:6d:66:aa:bb:cc"


def test_add_by_ip_fills_mac():
    db = _session()
    with patch("app.provision.pxe_hop.status", return_value={"connected": True}), patch(
        "app.provision.pxe_hop.find_mac_for_ip",
        return_value={"mac": "aa:bb:cc:dd:ee:ff", "matches": [{"mac": "aa:bb:cc:dd:ee:ff", "source": "neighbor"}]},
    ), patch(
        "app.provision.pxe_hop.redfish_identity",
        return_value={"serial": "SN123", "hostname": "node-1", "bmc_mac": "aa:bb:cc:dd:ee:ff"},
    ):
        node, filled, created = add_or_update_node(
            db,
            bmc_ip="10.10.1.20",
            bmc_user="ADMIN",
            bmc_password="secret",
        )
    assert created
    assert node.bmc_ip == "10.10.1.20"
    assert node.bmc_mac == "aa:bb:cc:dd:ee:ff"
    assert filled.get("bmc_mac") == "aa:bb:cc:dd:ee:ff"
    assert node.serial == "SN123"


def test_argus_sync_keeps_operator_edits_and_manual_nodes():
    from app.models import InventoryNode
    from app import provision_argus

    db = _session()
    argus = InventoryNode(
        serial="OA265S015410",
        name="my-n04",
        kind="compute",
        source="argus",
        hall_name="my-rack",
        bmc_ip="10.10.17.177",
        bmc_user="root",
        bmc_password="0penBmc",
        os_ip="10.10.3.50",
        os_username="nvidia",
        os_password="nvidia",
    )
    manual = InventoryNode(
        serial="IP-10-10-1-20",
        name="slot-x",
        kind="compute",
        source="manual",
        hall_name="Unassigned",
        bmc_ip="10.10.1.20",
        bmc_user="ADMIN",
        bmc_password="secret",
    )
    db.add_all([argus, manual])
    db.commit()
    rack = {
        "serial_number": "RACK1",
        "name": "GB300-Temp",
        "type": "GB300",
        "status": "idle",
        "nodes": [
            {
                "location_index": 3,
                "serial_number": "OA265S015410",
                "hostname": "n04",
                "bmc_ip": "10.10.17.177",
                "bmc_username": "ADMIN",
                "bmc_password": "argus-pw",
                "os_ip": "10.0.0.9",
            }
        ],
    }
    provision_argus._last_sync = 0.0
    with patch("app.provision_argus.cluster_controller.list_racks", return_value=[rack]), patch(
        "app.provision_argus.cluster_controller.get_rack",
        return_value=rack,
    ):
        provision_argus.sync_from_argus(db, force=True)
    db.refresh(argus)
    db.refresh(manual)
    assert argus.bmc_user == "root"
    assert argus.bmc_password == "0penBmc"
    assert argus.os_ip == "10.10.3.50"
    assert argus.os_username == "nvidia"
    assert argus.name == "my-n04"
    assert argus.hall_name == "my-rack"
    assert manual.source == "manual"
    assert manual.bmc_ip == "10.10.1.20"
    assert manual.name == "slot-x"
    assert db.get(InventoryNode, manual.id) is not None


def test_matching_rack_name_groups_nodes():
    from app.provision import apply_node_fields
    from app.provision_argus import rack_tree

    db = _session()
    with patch("app.provision.enrich_node", return_value={"notes": []}):
        a, _, _ = add_or_update_node(
            db, bmc_ip="10.10.1.1", bmc_user="ADMIN", bmc_password="x", hall_name="lab-a", name="n1"
        )
        b, _, _ = add_or_update_node(
            db, bmc_ip="10.10.1.2", bmc_user="ADMIN", bmc_password="x", hall_name="Lab-A", name="n2"
        )
        c, _, _ = add_or_update_node(
            db, bmc_ip="10.10.1.3", bmc_user="ADMIN", bmc_password="x", name="solo"
        )
    trees = {t["name"].lower(): t["counts"]["nodes"] for t in rack_tree([a, b, c])}
    assert trees["lab-a"] == 2
    assert trees["solo"] == 1
    apply_node_fields(db, c, hall_name="lab-a")
    db.commit()
    trees = {t["name"].lower(): t["counts"]["nodes"] for t in rack_tree([a, b, c])}
    assert trees["lab-a"] == 3
    assert "solo" not in trees


def test_manual_node_persists_pxe_server_assignment():
    from app.provision import apply_node_fields, serialize

    db = _session()
    with patch("app.provision.enrich_node", return_value={"notes": []}):
        node, _, created = add_or_update_node(
            db,
            bmc_ip="10.10.1.40",
            bmc_user="ADMIN",
            bmc_password="secret",
            pxe_server="172.25.231.245",
        )
    assert created
    assert node.pxe_server == "172.25.231.245"
    assert serialize(node)["pxe_server"] == "172.25.231.245"

    apply_node_fields(db, node, pxe_server="")
    db.commit()
    assert node.pxe_server is None


def test_pxe_server_reachability_checks_ssh_without_replacing_active_hop():
    import paramiko

    from app import pxe_hop

    ssh_client = MagicMock()
    with patch("app.pxe_hop.socket.create_connection"), patch(
        "app.pxe_hop.paramiko.SSHClient", return_value=ssh_client
    ):
        assert pxe_hop.check_reachable("172.25.231.245", "root", "secret")["authenticated"] is True
        ssh_client.connect.assert_called_once()
        ssh_client.close.assert_called_once()

        ssh_client.reset_mock()
        ssh_client.connect.side_effect = paramiko.AuthenticationException()
        result = pxe_hop.check_reachable("172.25.231.245", "root", "wrong")
        assert result == {
            "reachable": True,
            "authenticated": False,
            "detail": "SSH login rejected",
        }
        ssh_client.close.assert_called_once()


def test_sqlite_url_pins_backend_file():
    from pathlib import Path

    from app.config import Settings, _BACKEND_DIR

    s = Settings(database_url="sqlite:///./po_calendar.db")
    raw = s.database_url.split("sqlite:///", 1)[-1]
    path = Path(raw)
    assert path.is_absolute()
    assert path == (_BACKEND_DIR / "po_calendar.db").resolve()


def test_kvm_inject_keeps_login_under_prefix():
    from app.kvm_proxy import _inject_js

    js = _inject_js("/api/provision/kvm/tok", {"view": "kvm", "bmc_user": "ADMIN", "password": "x"})
    assert "stayUnderPrefix" in js
    assert "#/console/kvm" in js
    assert "PREFIX+'/#/login'" in js
    assert "AUTH||'1'" not in js
    assert "SessionService/Sessions" in js
    assert "userInfo.username" in js
    assert "loginFired" in js
    assert "atDest" in js
    assert "landed" in js
    assert "requestAnimationFrame" not in js
    assert "box.clientWidth" not in js
    assert "data-l12-key" in js
    assert "--l12-zoom" in js
    assert "image-rendering:pixelated" not in js
    assert "setInterval(fitConsole" not in js
    assert "location.reload" not in js
    sol = _inject_js("/api/provision/kvm/tok", {"view": "sol", "bmc_user": "ADMIN", "password": "x"})
    assert "serial-over-lan-console" in sol
    bmc = _inject_js("/api/provision/kvm/tok", {"view": "bmc", "bmc_user": "ADMIN", "password": "x"})
    assert "VIEW==='bmc'" in bmc
