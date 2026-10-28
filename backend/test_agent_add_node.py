from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.agent import (
    _find_compute,
    _inventory_ips,
    _pasted_add_node,
    parse_node_creds,
    tool_add_node,
    tool_list_nodes,
    tool_patch_node,
)
from app.db import Base
from app.models import Role


PHRASE = "add this node OS:  10.10.3.50 nvidia / nvidia BMC 10.10.17.177: root / 0penBmc"


def test_parse_pasted_node_line():
    got = parse_node_creds(PHRASE)
    assert got["os_ip"] == "10.10.3.50"
    assert got["os_username"] == "nvidia"
    assert got["os_password"] == "nvidia"
    assert got["bmc_ip"] == "10.10.17.177"
    assert got["bmc_user"] == "root"
    assert got["bmc_password"] == "0penBmc"
    assert _pasted_add_node(PHRASE) == got
    assert _pasted_add_node("the BMC 10.10.17.177: root / 0penBmc is down") is None


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _editor():
    return SimpleNamespace(id="u", role=Role.ADMIN)


def test_add_node_from_pasted_fields():
    db = _session()
    user = _editor()
    with patch("app.provision.enrich_node", return_value={"notes": ["Connect the PXE hop"]}):
        out = tool_add_node(db, user, **parse_node_creds(PHRASE))
    assert out["ok"] is True
    assert out["created"] is True
    assert out["bmc_ip"] == "10.10.17.177"
    assert out["os_ip"] == "10.10.3.50"
    assert out["bmc_user"] == "root"
    assert out["os_user"] == "nvidia"
    assert out["bmc_login"] is True
    assert out["os_login"] is True
    assert "bmc_password" not in out
    assert "os_password" not in out
    ui = out["ui"]
    assert any(c.get("kind") == "navigate" and c.get("path") == "/provision" for c in ui)
    assert "10.10.17.177" in _inventory_ips(db)
    assert "10.10.3.50" in _inventory_ips(db)
    found = _find_compute(db, "10.10.17.177")
    assert found is not None
    assert found["bmc_user"] == "root"
    listed = tool_list_nodes(db)
    assert any(n.get("bmc_ip") == "10.10.17.177" for n in listed["nodes"])


def test_add_node_raw_line():
    db = _session()
    with patch("app.provision.enrich_node", return_value={"notes": []}):
        out = tool_add_node(db, _editor(), raw=PHRASE)
    assert out["ok"]
    assert out["bmc_ip"] == "10.10.17.177"
    assert out["os_ip"] == "10.10.3.50"


def test_patch_node_name_on_provision_row():
    db = _session()
    user = _editor()
    with patch("app.provision.enrich_node", return_value={"notes": []}):
        added = tool_add_node(db, user, bmc_ip="10.10.1.9", bmc_user="ADMIN", bmc_password="x")
        out = tool_patch_node(db, user, node=added["id"], hostname="slot-9")
    assert out["ok"]
    assert out["name"] == "slot-9"
    assert out["created"] is False
