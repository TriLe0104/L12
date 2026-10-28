"""Argus sync reads every PXE and stamps that host on the rack."""

from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.maxlps_inventory import sync_live_infra
from app.models import InventoryNode, MaxLpsNode, MaxLpsRack, PxeServer
from app.pxe_servers import ControllerSource, controller_sources


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _rack(serial: str, name: str, nodes: list[dict]) -> dict:
    return {
        "serial_number": serial,
        "name": name,
        "type": "GB300",
        "status": "idle",
        "nodes": nodes,
        "switches": [],
        "powershelves": [],
    }


def test_sync_assigns_the_pxe_that_returned_the_rack_and_keeps_a_down_one():
    db = _session()
    old = MaxLpsRack(id="old-rack", label="Old", serial="OLD-1", origin="argus", model="GB300-NVL72", pxe_server="10.0.0.9")
    gone = MaxLpsRack(id="gone-rack", label="Gone", serial="GONE-1", origin="argus", model="GB300-NVL72")
    db.add_all([old, gone])
    db.add_all(
        [
            InventoryNode(
                id="old-node",
                serial="OLD-N",
                name="old-n",
                kind="compute",
                source="argus",
                hall_name="Old",
                pxe_server="10.0.0.9",
                bmc_mac="aa:bb:cc:00:00:09",
            ),
            InventoryNode(
                id="gone-node",
                serial="GONE-N",
                name="gone-n",
                kind="compute",
                source="argus",
                hall_name="Gone",
            ),
            InventoryNode(
                id="manual-node",
                serial="MAN-1",
                name="kept",
                kind="compute",
                source="manual",
                hall_name="RackA",
                pxe_server="9.9.9.9",
                bmc_mac="aa:bb:cc:00:00:01",
                bmc_user="ADMIN",
                bmc_password="secret",
            ),
            InventoryNode(
                id="shelf-a",
                serial="SHELF-A",
                name="RackA-PS2",
                kind="power",
                source="argus",
                hall_name="RackA",
            ),
        ]
    )
    db.commit()

    rack_a = _rack(
        "SER-A",
        "RackA",
        [
            {"location_index": 0, "hostname": "n1", "bmc_mac": "aa:bb:cc:00:00:01", "bmc_ip": "10.1.1.1", "serial_number": "SN-A"},
            {"location_index": 1, "hostname": "n2", "bmc_mac": "aa:bb:cc:00:00:0a", "bmc_ip": "10.1.1.2", "serial_number": "SN-A2"},
        ],
    )
    thin = _rack("SER-B", "RackB", [{"location_index": 0, "hostname": "hostname"}])
    rich = _rack(
        "SER-B",
        "RackB",
        [{"location_index": 0, "hostname": "n2", "bmc_mac": "aa:bb:cc:00:00:02", "bmc_ip": "10.2.2.2", "serial_number": "SN-B"}],
    )
    sources = [
        ControllerSource(base="http://10.0.0.1:8000", pxe_host="10.0.0.1"),
        ControllerSource(base="http://10.0.0.2:8000", pxe_host="10.0.0.2"),
        ControllerSource(base="http://10.0.0.9:8000", pxe_host="10.0.0.9"),
    ]

    def list_racks(base=None):
        base = base or ""
        if "10.0.0.9" in base:
            raise RuntimeError("controller unreachable 10.0.0.9: timed out")
        if "10.0.0.1" in base:
            return [rack_a]
        if "10.0.0.2" in base:
            return [thin]
        return []

    def get_rack(serial, name, base=None):
        base = base or ""
        if "10.0.0.2" in base:
            return rich
        if "10.0.0.1" in base:
            return rack_a
        return {}

    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", side_effect=list_racks
    ), patch("app.cluster_controller.get_rack", side_effect=get_rack):
        out = sync_live_infra(db, force=True)

    assert "10.0.0.1" in (out or {}).get("ok_pxes", [])
    assert "10.0.0.2" in (out or {}).get("ok_pxes", [])
    assert any("10.0.0.9" in item for item in (out or {}).get("errors", []))

    racks = {row.serial: row for row in db.scalars(select(MaxLpsRack)).all()}
    assert racks["SER-A"].pxe_server == "10.0.0.1"
    assert racks["SER-B"].pxe_server == "10.0.0.2"
    assert racks["OLD-1"].pxe_server == "10.0.0.9"
    assert "GONE-1" in racks

    nodes = {row.serial: row for row in db.scalars(select(InventoryNode)).all()}
    assert nodes["SN-A2"].pxe_server == "10.0.0.1"
    assert nodes["SHELF-A"].pxe_server == "10.0.0.1"
    assert nodes["MAN-1"].pxe_server == "9.9.9.9"
    assert nodes["MAN-1"].source == "manual"
    assert nodes["MAN-1"].bmc_password == "secret"
    assert nodes["SN-B"].pxe_server == "10.0.0.2"
    assert nodes["OLD-N"].pxe_server == "10.0.0.9"
    assert "GONE-N" in nodes


def test_answered_pxes_drop_racks_they_no_longer_list():
    db = _session()
    db.add(MaxLpsRack(id="gone-rack", label="Gone", serial="GONE-1", origin="argus", model="GB300-NVL72"))
    db.add(
        InventoryNode(
            id="gone-node",
            serial="GONE-N",
            name="gone-n",
            kind="compute",
            source="argus",
            hall_name="Gone",
        )
    )
    db.commit()
    sources = [ControllerSource(base="http://10.0.0.1:8000", pxe_host="10.0.0.1")]
    rack = _rack(
        "SER-A",
        "RackA",
        [{"location_index": 0, "hostname": "n1", "bmc_mac": "aa:bb:cc:00:00:11", "serial_number": "SN-A"}],
    )
    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", return_value=[rack]
    ), patch("app.cluster_controller.get_rack", return_value=rack):
        sync_live_infra(db, force=True)
    serials = {row.serial for row in db.scalars(select(MaxLpsRack)).all()}
    assert "GONE-1" not in serials
    assert "SER-A" in serials
    node = db.scalar(select(InventoryNode).where(InventoryNode.serial == "SN-A"))
    assert node is not None
    assert node.pxe_server == "10.0.0.1"
    assert db.get(InventoryNode, "gone-node") is None


def test_serialless_manual_rack_adopts_argus_serial_and_pxe():
    db = _session()
    db.add(MaxLpsRack(id="lab", label="RackA", serial=None, origin="manual", model="GB300-NVL72"))
    db.commit()
    rack = _rack(
        "SER-A",
        "RackA",
        [{"location_index": 0, "hostname": "n1", "bmc_mac": "aa:bb:cc:00:00:21", "serial_number": "SN-A"}],
    )
    sources = [ControllerSource(base="http://10.0.0.1:8000", pxe_host="10.0.0.1")]
    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", return_value=[rack]
    ), patch("app.cluster_controller.get_rack", return_value=rack):
        sync_live_infra(db, force=True)
    rows = list(db.scalars(select(MaxLpsRack)).all())
    assert len(rows) == 1
    assert rows[0].id == "lab"
    assert rows[0].serial == "SER-A"
    assert rows[0].origin == "manual"
    assert rows[0].pxe_server == "10.0.0.1"


def test_suffix_duplicate_folds_into_the_serialless_rack():
    from app.maxlps_inventory import create_rack

    db = _session()
    manual = create_rack(db, label="GB300-POC3", origin="manual")
    slot = db.scalar(select(MaxLpsNode).where(MaxLpsNode.rack_id == manual.id, MaxLpsNode.index == 1))
    assert slot is not None
    slot.serial = "S964512X5913263"
    slot.hostname = "POC3"
    slot.bmc_mac = "7c:c2:55:90:2c:17"
    slot.bmc_password = "slot-secret"
    suffix = create_rack(db, label="GB300-POC3-00POC3", serial="SR000GB300POC3", origin="argus")
    suffix.pxe_server = "10.40.141.1"
    db.add_all(
        [
            InventoryNode(
                id="poc-manual",
                serial="S964512X5913263",
                name="GB300-POC3",
                kind="compute",
                source="manual",
                hall_name="GB300-POC3",
                rack_id=manual.id,
                pxe_server="10.40.141.1",
                bmc_mac="7c:c2:55:90:2c:17",
                bmc_password="secret",
            ),
            InventoryNode(
                id="poc-dup",
                serial="S964512X5913263-SR000GB3",
                name="custom-gb300-slot17",
                kind="compute",
                source="argus",
                hall_name="GB300-POC3",
                rack_id="SR000GB300POC3",
                pxe_server="10.40.141.1",
                bmc_mac="7c:c2:55:90:2c:17",
                bmc_ip="10.10.13.31",
            ),
        ]
    )
    db.commit()
    detail = _rack(
        "SR000GB300POC3",
        "GB300-POC3",
        [
            {
                "location_index": 17,
                "hostname": "custom-gb300-slot17",
                "bmc_mac": "7c:c2:55:90:2c:17",
                "bmc_ip": "10.10.13.31",
                "serial_number": "S964512X5913263",
            }
        ],
    )
    sources = [ControllerSource(base="http://10.40.141.1:8000", pxe_host="10.40.141.1")]
    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", return_value=[detail]
    ), patch("app.cluster_controller.get_rack", return_value=detail):
        sync_live_infra(db, force=True)
    rows = list(db.scalars(select(MaxLpsRack)).all())
    assert len(rows) == 1
    assert rows[0].id == manual.id
    assert rows[0].label == "GB300-POC3"
    assert rows[0].serial == "SR000GB300POC3"
    assert rows[0].origin == "manual"
    assert rows[0].pxe_server == "10.40.141.1"
    slots = {
        node.index: node
        for node in db.scalars(select(MaxLpsNode).where(MaxLpsNode.rack_id == manual.id)).all()
    }
    assert not (slots[1].bmc_mac or slots[1].serial)
    assert slots[18].bmc_mac == "7c:c2:55:90:2c:17"
    assert slots[18].bmc_ip == "10.10.13.31"
    assert slots[18].bmc_password == "slot-secret"
    from app.provision_argus import rack_tree

    trees = {item["name"]: item for item in rack_tree(list(db.scalars(select(InventoryNode)).all()))}
    assert trees["GB300-POC3"]["serial"] == "SR000GB300POC3"
    kept = db.get(InventoryNode, "poc-manual")
    assert kept is not None
    assert kept.source == "manual"
    assert kept.name == "GB300-POC3"
    assert kept.bmc_password == "secret"
    assert kept.pxe_server == "10.40.141.1"
    assert kept.bmc_ip == "10.10.13.31"
    assert db.get(InventoryNode, "poc-dup") is None


def test_power_shelf_mac_is_not_duplicated_without_a_serial():
    db = _session()
    db.add(
        InventoryNode(
            id="blank-shelf",
            serial="SER-QS-PS1",
            name="QS-PS1",
            kind="power",
            source="argus",
            hall_name="QS",
            rack_id="SER-QS",
            pxe_server=None,
        )
    )
    db.commit()
    detail = _rack("SER-QS", "QS", [])
    detail["powershelves"] = [
        {"location_index": 0, "bmc_mac": "24:5b:f0:80:42:5a", "serial_number": None, "type": "powershelf"}
    ]
    sources = [ControllerSource(base="http://172.25.231.244:8000", pxe_host="172.25.231.244")]
    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", return_value=[detail]
    ), patch("app.cluster_controller.get_rack", return_value=detail):
        sync_live_infra(db, force=True)
    power = list(db.scalars(select(InventoryNode).where(InventoryNode.kind == "power")).all())
    assert [row.serial for row in power] == ["MAC-245bf080425a"]
    assert power[0].pxe_server == "172.25.231.244"
    assert power[0].hall_name == "QS"
    assert db.get(InventoryNode, "blank-shelf") is None


def test_power_shelf_management_login_is_the_os_ssh_login():
    db = _session()
    detail = _rack("SER-QS", "QS", [])
    detail["powershelves"] = [
        {
            "location_index": 0,
            "type": "powershelf",
            "serial_number": "PS-SN",
            "bmc_mac": "24:5b:f0:80:42:5a",
            "bmc_ip": "10.5.5.5",
            "bmc_username": "root",
            "bmc_password": "shelf-secret",
        }
    ]
    sources = [ControllerSource(base="http://172.25.231.244:8000", pxe_host="172.25.231.244")]
    with patch("app.pxe_servers.controller_sources", return_value=sources), patch(
        "app.cluster_controller.list_racks", return_value=[detail]
    ), patch("app.cluster_controller.get_rack", return_value=detail):
        sync_live_infra(db, force=True)
    row = db.scalar(select(InventoryNode).where(InventoryNode.kind == "power"))
    assert row is not None
    assert row.os_ip == "10.5.5.5"
    assert row.os_username == "root"
    assert row.os_password == "shelf-secret"
    row.os_ip = "10.8.8.8"
    db.commit()
    from app.provision_argus import promote_power_shelf_ssh

    promote_power_shelf_ssh(db)
    assert db.get(InventoryNode, row.id).os_ip == "10.8.8.8"


def test_pxe_already_assigned_to_a_node_is_synced():
    db = _session()
    db.add(
        InventoryNode(
            id="poc",
            serial="POC-1",
            name="poc",
            kind="compute",
            source="manual",
            pxe_server="10.40.141.1",
        )
    )
    db.commit()
    with patch("app.pxe_servers.settings.cluster_controller_url", ""), patch(
        "app.pxe_hop.status", return_value={"connected": False, "host": ""}
    ):
        sources = controller_sources(db)
    assert [(item.pxe_host, item.base) for item in sources] == [("10.40.141.1", "http://10.40.141.1:8000")]


def test_controller_sources_include_every_saved_pxe_once():
    db = _session()
    db.add_all(
        [
            PxeServer(id="1", name="Lab", host="10.1.1.1", username="root"),
            PxeServer(id="2", name="Argus", host="172.25.231.244", username="root"),
        ]
    )
    db.commit()
    with patch("app.pxe_servers.settings.cluster_controller_url", "http://172.25.231.244:8000"), patch(
        "app.pxe_hop.status", return_value={"connected": True, "host": "10.2.2.2"}
    ):
        sources = controller_sources(db)
    by_host = {item.pxe_host: item.base for item in sources}
    assert by_host == {
        "10.1.1.1": "http://10.1.1.1:8000",
        "172.25.231.244": "http://172.25.231.244:8000",
        "10.2.2.2": "http://10.2.2.2:8000",
    }
