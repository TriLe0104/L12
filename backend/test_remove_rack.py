from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import HiddenRack, InventoryNode, MaxLpsRack
from app import maxlps_inventory as inv
from app import provision_argus


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_remove_unassigned_deletes_nodes_only():
    db = _session()
    db.add(
        InventoryNode(
            serial="IP-10-1-1-1",
            name="slot",
            kind="compute",
            source="manual",
            hall_name="Unassigned",
            bmc_ip="10.1.1.1",
        )
    )
    db.commit()
    out = inv.remove_operator_rack(db, "Unassigned")
    assert out is not None
    assert out["hidden"] is False
    assert out["nodes"] == 1
    assert db.scalar(select(InventoryNode).limit(1)) is None
    assert db.scalar(select(HiddenRack).limit(1)) is None


def test_sync_brings_a_removed_rack_back():
    db = _session()
    rack = inv.create_rack(db, label="GB300-Temp", serial="S-TEMP-1", origin="argus")
    db.add(
        InventoryNode(
            serial="OA1",
            name="n04",
            kind="compute",
            source="argus",
            hall_name="GB300-Temp",
            rack_id=(rack.serial or "")[:36],
            bmc_ip="10.10.17.177",
        )
    )
    db.commit()
    out = inv.remove_operator_rack(db, "GB300-Temp")
    assert out is not None
    assert out["hidden"] is True
    assert out["nodes"] == 1
    assert db.scalar(select(MaxLpsRack).limit(1)) is None
    assert db.scalar(select(InventoryNode).limit(1)) is None
    assert db.scalar(select(HiddenRack).limit(1)) is not None

    argus_rack = {
        "serial_number": "S-TEMP-1",
        "name": "GB300-Temp",
        "type": "GB300",
        "status": "idle",
        "nodes": [
            {
                "location_index": 3,
                "serial_number": "OA1",
                "hostname": "n04",
                "bmc_ip": "10.10.17.177",
            }
        ],
    }
    bundle = {"racks": [argus_rack], "ok_pxes": {"10.1.1.1"}, "errors": []}
    provision_argus._last_sync = 0.0
    out_sync = inv.sync_from_controller(db, bundle)
    assert out_sync["count"] == 1
    provision_argus.sync_from_argus(db, force=True, bundle=bundle)
    assert db.scalar(select(InventoryNode).where(InventoryNode.serial == "OA1")) is not None
    assert db.scalar(select(MaxLpsRack).where(MaxLpsRack.serial == "S-TEMP-1")) is not None
    assert db.scalar(select(HiddenRack).limit(1)) is None


def test_upsert_restores_hidden_serial():
    db = _session()
    inv.remember_hidden(db, serial="S-TEMP-1", label="GB300-Temp")
    db.commit()
    kind = inv.upsert_controller_rack(
        db,
        {"serial_number": "S-TEMP-1", "name": "GB300-Temp", "type": "GB300", "nodes": []},
    )
    assert kind == "created"
    assert db.scalar(select(MaxLpsRack).limit(1)) is not None
    assert db.scalar(select(HiddenRack).limit(1)) is None


def test_remove_all_bucket_does_not_hide():
    db = _session()
    db.add(
        InventoryNode(
            serial="SN-DEMO",
            name="DH-01-R01C01",
            kind="compute",
            source="demo",
            hall_name="DH-01",
        )
    )
    db.commit()
    out = inv.remove_operator_rack(db, "all")
    assert out is not None
    assert out["hidden"] is False
    assert db.scalar(select(HiddenRack).limit(1)) is None
    assert db.scalar(select(InventoryNode).limit(1)) is not None


def test_load_nodes_drops_demo_when_a_pxe_is_saved():
    from app.models import PxeServer
    from app.provision import load_nodes

    db = _session()
    db.add(
        InventoryNode(
            serial="SN-DEMO",
            name="DH-01-R01C01",
            kind="compute",
            source="demo",
            hall_name="DH-01",
        )
    )
    db.add(PxeServer(id="pxe", name="Lab", host="10.1.1.1", username="root"))
    db.commit()
    assert load_nodes(db, sync=False) == []
    assert db.scalar(select(InventoryNode.id).where(InventoryNode.source == "demo")) is None


def _seed_hall(db, name: str, racks: int = 2):
    from app.models import DataHall, Rack

    hall = DataHall(name=name, description="Firmus data hall", width_tiles=18, depth_tiles=10)
    db.add(hall)
    db.flush()
    for i in range(racks):
        db.add(
            Rack(
                hall_id=hall.id,
                name=f"{name}-R01C{i + 1:02d}",
                x=1 + i,
                y=1,
                notes="GB300",
                power_state="on",
                run_status="ready",
            )
        )
    db.commit()
    return hall


def test_remove_seeded_campus_from_provision():
    from app.models import DataHall, PxeServer, Rack
    from app.seed import _seed_firmus

    db = _session()
    db.add(PxeServer(id="pxe", name="Lab", host="10.9.9.9", username="root"))
    live = DataHall(name="Live", description="operator hall", width_tiles=8, depth_tiles=8)
    db.add(live)
    db.flush()
    db.add(Rack(hall_id=live.id, name="Live-1", x=1, y=1, notes="real", power_state="on", run_status="ready"))
    db.commit()
    _seed_hall(db, "DH-01")
    _seed_hall(db, "DH-02", racks=1)
    out = inv.remove_operator_rack(db, "demo-campus")
    assert out is not None
    assert out["hidden"] is False
    assert out["nodes"] == 3
    assert db.scalar(select(DataHall).where(DataHall.name == "DH-01")) is None
    assert db.scalar(select(DataHall).where(DataHall.name == "DH-02")) is None
    assert db.scalar(select(DataHall).where(DataHall.name == "Live")) is not None
    assert db.scalar(select(Rack).where(Rack.name == "Live-1")) is not None
    _seed_firmus(db)
    assert db.scalar(select(DataHall).where(DataHall.name == "DH-01")) is None
    assert func_count_racks(db) == 1


def func_count_racks(db):
    from sqlalchemy import func

    from app.models import Rack

    return db.scalar(select(func.count()).select_from(Rack))


def test_remove_one_seed_hall_leaves_the_others():
    from app.models import DataHall

    db = _session()
    _seed_hall(db, "DH-01")
    _seed_hall(db, "DH-02", racks=1)
    out = inv.remove_operator_rack(db, "DH-01")
    assert out is not None and out["nodes"] == 2
    assert db.scalar(select(DataHall).where(DataHall.name == "DH-01")) is None
    assert db.scalar(select(DataHall).where(DataHall.name == "DH-02")) is not None


def test_sync_names_hidden_racks():
    db = _session()
    inv.remember_hidden(db, serial="S-TEMP-1", label="GB300-Temp")
    db.commit()
    rack = {"serial_number": "S-TEMP-1", "name": "GB300-Temp", "type": "GB300", "nodes": []}
    out = inv.sync_from_controller(
        db,
        {"racks": [rack], "ok_pxes": {"10.1.1.1"}, "errors": []},
    )
    assert out["skipped_hidden"] == []
    assert out["count"] == 1
    assert out["ok_pxes"] == ["10.1.1.1"]
    assert db.scalar(select(HiddenRack).limit(1)) is None
