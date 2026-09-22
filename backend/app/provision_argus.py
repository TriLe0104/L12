"""Load provision inventory from Cluster Backend Controller (Argus)."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import cluster_controller
from .models import InventoryNode, _now, _uuid

_PLACEHOLDER_HOST = {"hostname", "host", ""}
_last_sync = 0.0
GPU_BY_MAC: dict[str, list[dict]] = {}
RACK_META: dict[str, dict] = {}


def _blank(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _kind(entry: dict[str, Any]) -> str:
    t = (entry.get("type") or "").lower()
    if t in ("switch", "nvswitch", "leaf"):
        return "leaf"
    if t in ("spine",):
        return "spine"
    if t in ("powershelf", "power", "psu", "pmc"):
        return "power"
    return "compute"


def _status(entry: dict[str, Any]) -> str:
    ts = entry.get("test_status") or ""
    if ts and ts not in ("idle", "none", "None"):
        return "sol"
    alive = entry.get("last_alive")
    if alive:
        return "ready"
    if entry.get("bmc_ip"):
        return "dhcp"
    return "registered"


def _name(entry: dict[str, Any], rack_name: str) -> str:
    host = _blank(entry.get("hostname"))
    if host and host.lower() not in _PLACEHOLDER_HOST:
        return host
    loc = entry.get("location_index")
    kind = _kind(entry)
    if kind == "power":
        try:
            n = int(str(loc)) + 1
        except (TypeError, ValueError):
            n = loc
        return f"{rack_name}-PS{n}"
    prefix = "slot" if kind == "compute" else "sw"
    return f"{rack_name}-{prefix}{loc}"


def _serial(entry: dict[str, Any]) -> str:
    sn = _blank(entry.get("serial_number") or entry.get("serial"))
    mac = (_blank(entry.get("bmc_mac")) or "").replace(":", "")
    if sn:
        return sn
    if mac:
        return f"MAC-{mac[-12:]}"
    return f"UNK-{_uuid()[:8]}"


def _gpus(entry: dict) -> list[dict]:
    hw = entry.get("hardware_data") if isinstance(entry.get("hardware_data"), dict) else {}
    rows = hw.get("gpus") if isinstance(hw, dict) else None
    if not isinstance(rows, list):
        return []
    out = []
    for i, g in enumerate(rows):
        if not isinstance(g, dict):
            continue
        out.append(
            {
                "id": str(g.get("Id") or g.get("name") or f"GPU_{i}"),
                "name": str(g.get("name") or g.get("Name") or f"GPU_{i}"),
                "serial": g.get("SerialNumber") or g.get("sn"),
                "uuid": g.get("UUID") or g.get("uuid"),
                "model": g.get("Model") or g.get("model"),
                "pn": g.get("PartNumber") or g.get("pn"),
            }
        )
    return out


def node_gpus(mac: str | None) -> list[dict]:
    if not mac:
        return []
    return GPU_BY_MAC.get(mac.lower()) or []


def rack_tree(nodes: list[InventoryNode]) -> list[dict]:
    groups: dict[str, list[InventoryNode]] = {}
    for n in nodes:
        key = n.rack_id or n.hall_name or "rack"
        groups.setdefault(key, []).append(n)
    trees = []
    for rid, kids in groups.items():
        meta = RACK_META.get(rid) or {}
        name = meta.get("name") or kids[0].hall_name or rid
        compute = [k for k in kids if k.kind == "compute"]
        switches = [k for k in kids if k.kind in ("leaf", "spine")]
        shelves = [k for k in kids if k.kind == "power"]
        trees.append(
            {
                "id": rid,
                "serial": meta.get("serial") or rid,
                "name": name,
                "type": meta.get("type") or "gb300",
                "status": meta.get("status") or "idle",
                "counts": {
                    "nodes": len(compute),
                    "switches": len(switches),
                    "shelves": len(shelves),
                },
            }
        )
    have = {str(t.get("id") or t.get("serial")) for t in trees}
    for rid, meta in RACK_META.items():
        key = str(rid)[:36]
        if key in have or rid in have:
            continue
        trees.append(
            {
                "id": key,
                "serial": meta.get("serial") or rid,
                "name": meta.get("name") or rid,
                "type": meta.get("type") or "",
                "status": meta.get("status") or "idle",
                "counts": {"nodes": 0, "switches": 0, "shelves": 0},
            }
        )
        have.add(key)
    trees.sort(key=lambda r: str(r.get("name") or ""))
    return trees


def sync_from_argus(db: Session, force: bool = False) -> list[InventoryNode]:
    global _last_sync
    now = time.time()
    existing = list(
        db.scalars(select(InventoryNode).where(InventoryNode.source == "argus").order_by(InventoryNode.hall_name, InventoryNode.name)).all()
    )
    if existing and not force and _last_sync and now - _last_sync < 45:
        return existing
    summaries = cluster_controller.list_racks()
    seen: set[str] = set()
    out: list[InventoryNode] = []
    by_mac = {n.bmc_mac.lower(): n for n in db.scalars(select(InventoryNode)).all() if n.bmc_mac}
    by_serial = {n.serial: n for n in db.scalars(select(InventoryNode)).all()}

    for row in summaries:
        sn = row.get("serial_number") or row.get("serial")
        name = row.get("name")
        if not sn or not name:
            continue
        detail = cluster_controller.get_rack(str(sn), str(name)) or row
        rack_name = str(detail.get("name") or name)
        rack_serial = str(detail.get("serial_number") or sn)
        RACK_META[rack_serial] = {
            "serial": rack_serial,
            "name": rack_name,
            "type": str(detail.get("type") or ""),
            "status": str(detail.get("status") or "idle"),
        }
        groups = [
            ("compute", detail.get("nodes") or []),
            ("leaf", detail.get("switches") or []),
            ("power", detail.get("powershelves") or []),
        ]
        for default_kind, entries in groups:
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                mac = _blank(entry.get("bmc_mac"))
                serial = _serial(entry)
                rack_key = rack_serial[:36]
                node = None
                if mac:
                    found = by_mac.get(mac.lower())
                    if found is not None and (not found.rack_id or found.rack_id == rack_key):
                        node = found
                if node is None:
                    clash = by_serial.get(serial)
                    if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                        serial = f"{serial}-{rack_serial[:8]}"
                        clash = by_serial.get(serial)
                    if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                        clash = None
                    if clash is not None and mac and clash.bmc_mac and clash.bmc_mac.lower() != mac.lower():
                        serial = f"{serial}-{mac.replace(':', '')[-6:]}"
                        clash = by_serial.get(serial)
                    node = clash
                if node is None:
                    node = InventoryNode(id=_uuid(), serial=serial, name=_name(entry, rack_name), kind=default_kind)
                    db.add(node)
                    by_serial[serial] = node
                else:
                    if node.serial != serial and serial not in by_serial:
                        node.serial = serial
                        by_serial[serial] = node
                if mac:
                    by_mac[mac.lower()] = node
                node.source = "argus"
                node.kind = _kind(entry) if entry.get("type") else default_kind
                node.name = _name(entry, rack_name)
                node.hall_name = rack_name
                node.rack_id = rack_serial[:36]
                node.bmc_mac = mac
                node.bmc_ip = _blank(entry.get("bmc_ip"))
                node.bmc_user = _blank(entry.get("bmc_username") or entry.get("bmc_user")) or "ADMIN"
                pw = _blank(entry.get("bmc_password"))
                if pw:
                    node.bmc_password = pw
                node.os_mac = _blank(entry.get("os_mac"))
                node.os_ip = _blank(entry.get("os_ip"))
                node.os_username = _blank(entry.get("os_username") or entry.get("os_user")) or node.os_username
                os_pw = _blank(entry.get("os_password"))
                if os_pw:
                    node.os_password = os_pw
                node.pxe_mac = node.os_mac or node.bmc_mac
                node.provision_status = _status(entry)
                alive = _blank(entry.get("last_alive"))
                if alive:
                    try:
                        node.last_seen_at = datetime.fromisoformat(alive.replace("Z", "+00:00"))
                    except ValueError:
                        node.last_seen_at = _now()
                else:
                    node.last_seen_at = _now()
                node.updated_at = _now()
                if mac:
                    GPU_BY_MAC[mac.lower()] = _gpus(entry)
                seen.add(node.id)
                out.append(node)
    _merge_maxlps_racks(db, by_mac, by_serial, seen)
    db.commit()
    _last_sync = now
    return list(db.scalars(select(InventoryNode).where(InventoryNode.source == "argus").order_by(InventoryNode.hall_name, InventoryNode.name)).all())


def _merge_maxlps_racks(db: Session, by_mac: dict, by_serial: dict, seen: set[str]) -> None:
    """Keep every MaxLPS / Argus rack in the tree, even when Argus detail is thin."""
    from sqlalchemy.orm import selectinload

    from .models import MaxLpsRack

    racks = list(db.scalars(select(MaxLpsRack).options(selectinload(MaxLpsRack.nodes), selectinload(MaxLpsRack.shelves))).all())
    for rack in racks:
        rack_serial = _blank(rack.serial) or rack.id
        rack_name = rack.label or rack_serial
        RACK_META.setdefault(
            rack_serial,
            {"serial": rack_serial, "name": rack_name, "type": rack.model or "", "status": "idle"},
        )
        RACK_META[rack_serial]["name"] = rack_name
        for n in rack.nodes:
            if not (_blank(n.serial) or _blank(n.bmc_mac) or _blank(n.bmc_ip)):
                continue
            mac = _blank(n.bmc_mac)
            serial = _blank(n.serial) or (f"MAC-{mac.replace(':','')[-12:]}" if mac else f"{rack_serial}-{n.index}")
            rack_key = rack_serial[:36]
            node = None
            if mac:
                found = by_mac.get(mac.lower())
                if found is not None and (not found.rack_id or found.rack_id == rack_key):
                    node = found
            if node is None:
                clash = by_serial.get(serial)
                if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                    serial = f"{serial}-{rack_serial[:8]}"
                    clash = by_serial.get(serial)
                if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                    clash = None
                node = clash
            if node is None:
                node = InventoryNode(id=_uuid(), serial=serial, name=n.hostname or f"{rack_name}-slot{n.index}", kind="compute")
                db.add(node)
                by_serial[serial] = node
            if mac:
                by_mac[mac.lower()] = node
            node.source = "argus"
            node.kind = "compute"
            host = _blank(n.hostname)
            if host and host.lower() not in _PLACEHOLDER_HOST:
                node.name = host
            elif not node.name or node.name.lower() in _PLACEHOLDER_HOST:
                node.name = f"{rack_name}-slot{n.index}"
            node.hall_name = rack_name
            node.rack_id = rack_serial[:36]
            if mac:
                node.bmc_mac = mac
            if n.bmc_ip:
                node.bmc_ip = n.bmc_ip
            node.bmc_user = n.bmc_user or node.bmc_user or "ADMIN"
            if n.bmc_password:
                node.bmc_password = n.bmc_password
            if n.os_mac:
                node.os_mac = n.os_mac
            if n.os_ip:
                node.os_ip = n.os_ip
            if not node.provision_status:
                node.provision_status = "dhcp" if node.bmc_ip else "registered"
            node.updated_at = _now()
            seen.add(node.id)
        for s in rack.shelves:
            serial = _blank(s.serial) or f"{rack_serial}-PS{s.index}"
            node = by_serial.get(serial)
            if node is None:
                node = InventoryNode(id=_uuid(), serial=serial, name=f"{rack_name}-PS{s.index + 1}", kind="power")
                db.add(node)
                by_serial[serial] = node
            node.source = "argus"
            node.kind = "power"
            node.hall_name = rack_name
            node.rack_id = rack_serial[:36]
            if s.mac:
                node.bmc_mac = s.mac
            if s.ip:
                node.bmc_ip = s.ip
            node.bmc_user = s.user or node.bmc_user
            if s.password:
                node.bmc_password = s.password
            node.provision_status = node.provision_status or "registered"
            node.updated_at = _now()
            seen.add(node.id)
