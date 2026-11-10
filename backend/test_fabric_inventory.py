"""TOR switches from provision inventory when the floor has no cabinets."""

from types import SimpleNamespace

from app.fabric import build_fabric


def _node(kind, name, hall="GB300-POC3", os_ip="10.0.0.1"):
    return SimpleNamespace(id=name, kind=kind, name=name, hall_name=hall, os_ip=os_ip, bmc_ip=None)


def test_inventory_tors_link_each_pair_of_nodes():
    leaves = [_node("leaf", f"GB300-POC3-sw{i}", os_ip=f"10.0.0.{i}") for i in range(9)]
    hosts = [_node("compute", f"custom-gb300-slot{i}", os_ip=f"10.1.0.{i}") for i in range(18)]
    fabric = build_fabric([], leaves[::-1] + hosts[::-1] + [_node("power", "shelf0")])
    assert fabric["summary"]["spines"] == 8
    assert fabric["summary"]["leaves"] == 9
    assert fabric["summary"]["racks"] == 18
    downs = [link for link in fabric["links"] if link["role"] == "downlink"]
    assert len(downs) == 18
    sw0 = sorted(link["to_name"] for link in downs if link["from_id"] == "GB300-POC3-sw0")
    assert sw0 == ["custom-gb300-slot0", "custom-gb300-slot1"]
    ups = [link for link in fabric["links"] if link["role"] == "uplink" and link["from_id"] == "GB300-POC3-sw0"]
    assert len(ups) == 8
    assert {link["to_id"] for link in ups} == {f"SP-{i:02d}" for i in range(1, 9)}
    host = next(node for node in fabric["nodes"] if node["label"] == "custom-gb300-slot0")
    assert host["name"] == "slot0"
    assert host["role"] == "rack"


def test_floor_racks_ignore_provision_inventory():
    rack = SimpleNamespace(id="r1", name="R1", x=0, y=0, power_state="on")
    hall = SimpleNamespace(id="h1", name="DH-01", racks=[rack])
    fabric = build_fabric([hall], [_node("compute", "custom-gb300-slot0")])
    assert fabric["summary"]["leaves"] == 1
    assert fabric["summary"]["racks"] == 1
    assert all(node["name"] != "slot0" for node in fabric["nodes"])
    assert any(node["id"] == "rack:r1" for node in fabric["nodes"])


def test_empty_floor_stays_spines_only():
    fabric = build_fabric([])
    assert fabric["summary"]["spines"] == 8
    assert fabric["summary"]["leaves"] == 0
    assert fabric["summary"]["racks"] == 0
    assert fabric["links"] == []
