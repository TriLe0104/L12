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


def _fill(node: InventoryNode, field: str, value: Any) -> None:
    """Write Argus identity only when the operator has not set the field."""
    incoming = _blank(value) if not isinstance(value, bool) else value
    if incoming is None or incoming == "":
        return
    cur = getattr(node, field, None)
    if cur is None or (isinstance(cur, str) and not str(cur).strip()):
        setattr(node, field, incoming)


def _is_local(node: InventoryNode) -> bool:
    return (node.source or "") in ("manual", "provision")


def _same_rack(node: InventoryNode, rack_key: str, rack_name: str) -> bool:
    """True when this inventory row already belongs to the Argus rack.

    Operator rows keep the MaxLPS id in rack_id, so a matching hall is enough.
    """
    if not node.rack_id or node.rack_id == rack_key:
        return True
    if _is_local(node):
        hall = _blank(node.hall_name)
        if hall and hall.lower() == (rack_name or "").strip().lower():
            return True
    return False


def _fill_from_entry(node: InventoryNode, entry: dict[str, Any]) -> None:
    _fill(node, "bmc_mac", entry.get("bmc_mac"))
    _fill(node, "bmc_ip", entry.get("bmc_ip"))
    _fill(node, "bmc_user", entry.get("bmc_username") or entry.get("bmc_user"))
    _fill(node, "bmc_password", entry.get("bmc_password"))
    _fill(node, "os_mac", entry.get("os_mac"))
    _fill(node, "os_ip", entry.get("os_ip"))
    _fill(node, "os_username", entry.get("os_username") or entry.get("os_user"))
    _fill(node, "os_password", entry.get("os_password"))
    if not node.pxe_mac:
        node.pxe_mac = node.os_mac or node.bmc_mac


def _copy_mgmt_to_os(node: InventoryNode) -> None:
    """Power shelves have no BMC. Argus stores the SSH login in the BMC columns."""
    _fill(node, "os_ip", node.bmc_ip)
    _fill(node, "os_username", node.bmc_user)
    _fill(node, "os_password", node.bmc_password)


def promote_power_shelf_ssh(db: Session) -> None:
    """Copy a shelf's management login into the OS fields when those are blank."""
    changed = False
    for node in db.scalars(select(InventoryNode).where(InventoryNode.kind == "power")).all():
        before = (node.os_ip, node.os_username, node.os_password)
        _copy_mgmt_to_os(node)
        if (node.os_ip, node.os_username, node.os_password) != before:
            changed = True
    if changed:
        db.commit()


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


def _meta_for(rid: str, name: str) -> dict:
    found = RACK_META.get(rid) or RACK_META.get(name)
    if found:
        return found
    needle = (name or "").strip().lower()
    for item in RACK_META.values():
        if str(item.get("name") or "").strip().lower() == needle:
            return item
    return {}


def rack_tree(nodes: list[InventoryNode]) -> list[dict]:
    groups: dict[str, list[InventoryNode]] = {}
    titles: dict[str, str] = {}
    for n in nodes:
        raw = (n.hall_name or n.name or n.serial or "rack").strip() or "rack"
        key = raw.lower()
        groups.setdefault(key, []).append(n)
        if key not in titles:
            titles[key] = (n.hall_name or raw).strip() or raw
    trees = []
    have_names: set[str] = set()
    have_ids: set[str] = set()
    for key, kids in groups.items():
        name = titles[key]
        rid = next((k.rack_id for k in kids if k.rack_id), name)
        meta = _meta_for(str(rid), name)
        compute = [k for k in kids if k.kind == "compute"]
        switches = [k for k in kids if k.kind in ("leaf", "spine")]
        shelves = [k for k in kids if k.kind == "power"]
        trees.append(
            {
                "id": name,
                "serial": meta.get("serial") or (kids[0].rack_id if kids else "") or "",
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
        have_names.add(name.lower())
        have_ids.add(str(rid))
        have_ids.add(name)
    for rid, meta in RACK_META.items():
        nm = str(meta.get("name") or rid)
        key = str(rid)[:36]
        if nm.lower() in have_names or key in have_ids or str(rid) in have_ids:
            continue
        trees.append(
            {
                "id": nm,
                "serial": meta.get("serial") or rid,
                "name": nm,
                "type": meta.get("type") or "",
                "status": meta.get("status") or "idle",
                "counts": {"nodes": 0, "switches": 0, "shelves": 0},
            }
        )
        have_names.add(nm.lower())
    trees.sort(key=lambda r: str(r.get("name") or ""))
    return trees


def _assign_pxe(node: InventoryNode, pxe_host: str | None, *, force: bool) -> None:
    host = _blank(pxe_host)
    if not host:
        return
    if not force and (node.pxe_server or "").strip():
        return
    node.pxe_server = host


def sync_from_argus(db: Session, force: bool = False, bundle: dict[str, Any] | None = None) -> list[InventoryNode]:
    global _last_sync
    now = time.time()
    existing = list(
        db.scalars(select(InventoryNode).where(InventoryNode.source == "argus").order_by(InventoryNode.hall_name, InventoryNode.name)).all()
    )
    if existing and not force and _last_sync and now - _last_sync < 45:
        return existing
    from . import maxlps_inventory as _inv

    bundle = bundle or _inv.collect_controller_racks(db)
    ok_pxes = {str(p).strip().lower() for p in (bundle.get("ok_pxes") or set()) if str(p).strip()}
    errors = [str(item) for item in (bundle.get("errors") or [])]
    if not ok_pxes:
        return existing
    seen: set[str] = set()
    live_serials: set[str] = set()
    out: list[InventoryNode] = []
    rows = list(db.scalars(select(InventoryNode)).all())
    by_mac: dict[str, InventoryNode] = {}
    for row in rows:
        mac = _blank(row.bmc_mac)
        if not mac:
            continue
        key = mac.lower()
        prev = by_mac.get(key)
        # Prefer the operator row when Argus already cloned the same MAC.
        if prev is None or (_is_local(row) and not _is_local(prev)):
            by_mac[key] = row
    by_serial = {row.serial: row for row in rows}

    for detail in bundle.get("racks") or []:
        if not isinstance(detail, dict):
            continue
        sn = detail.get("serial_number") or detail.get("serial")
        name = detail.get("name")
        if not sn or not name:
            continue
        rack_name = str(detail.get("name") or name)
        rack_serial = str(detail.get("serial_number") or sn)
        _inv.reveal_hidden(db, serial=rack_serial, label=rack_name)
        pxe_host = _blank(detail.get("pxe_server"))
        meta = {
            "serial": rack_serial,
            "name": rack_name,
            "type": str(detail.get("type") or ""),
            "status": str(detail.get("status") or "idle"),
            "pxe_server": pxe_host or "",
        }
        RACK_META[rack_serial] = meta
        live_serials.add(rack_serial)
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
                    if found is not None and _same_rack(found, rack_key, rack_name):
                        node = found
                if node is None:
                    clash = by_serial.get(serial)
                    if clash is not None and not _same_rack(clash, rack_key, rack_name):
                        serial = f"{serial}-{rack_serial[:8]}"
                        clash = by_serial.get(serial)
                    if clash is not None and not _same_rack(clash, rack_key, rack_name):
                        clash = None
                    if clash is not None and mac and clash.bmc_mac and clash.bmc_mac.lower() != mac.lower():
                        serial = f"{serial}-{mac.replace(':', '')[-6:]}"
                        clash = by_serial.get(serial)
                    node = clash
                if node is not None and _is_local(node):
                    _fill_from_entry(node, entry)
                    _fill(node, "name", _name(entry, rack_name))
                    _assign_pxe(node, pxe_host, force=False)
                    if mac:
                        by_mac[mac.lower()] = node
                        GPU_BY_MAC[mac.lower()] = _gpus(entry)
                    continue
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
                _assign_pxe(node, pxe_host, force=True)
                _fill(node, "name", _name(entry, rack_name))
                _fill(node, "hall_name", rack_name)
                if not node.rack_id:
                    node.rack_id = rack_serial[:36]
                _fill_from_entry(node, entry)
                if not node.bmc_user:
                    node.bmc_user = "ADMIN"
                if node.kind == "power":
                    _copy_mgmt_to_os(node)
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
    for stale_key in [k for k in RACK_META if k not in live_serials]:
        RACK_META.pop(stale_key, None)
    _merge_maxlps_racks(db, by_mac, by_serial, seen, live_serials)
    drop_unassigned = not errors
    for n in existing:
        if n.id in seen:
            continue
        assigned = (n.pxe_server or "").strip().lower()
        if assigned:
            if assigned not in ok_pxes:
                continue
        elif not drop_unassigned:
            continue
        db.delete(n)
    try:
        from . import maxlps_inventory

        maxlps_inventory.prune_controller_racks(
            db,
            live_serials,
            confirmed_pxes=ok_pxes,
            drop_unassigned=drop_unassigned,
        )
    except Exception:
        pass
    pxe_by_hall: dict[str, str] = {}
    for meta in RACK_META.values():
        host = _blank(meta.get("pxe_server"))
        name = _blank(meta.get("name"))
        if host and name:
            pxe_by_hall[name.lower()] = host
    if pxe_by_hall:
        for node in db.scalars(select(InventoryNode)).all():
            host = pxe_by_hall.get((node.hall_name or "").strip().lower())
            if host:
                _assign_pxe(node, host, force=not _is_local(node))
    db.commit()
    _last_sync = now
    return list(db.scalars(select(InventoryNode).where(InventoryNode.source == "argus").order_by(InventoryNode.hall_name, InventoryNode.name)).all())


def _merge_maxlps_racks(
    db: Session, by_mac: dict, by_serial: dict, seen: set[str], live_serials: set[str] | None = None
) -> None:
    """Fill identity on Argus racks from MaxLPS when controller detail is thin.

    Only racks still present in Argus are merged. Local / retired MaxLPS racks stay out.
    """
    from sqlalchemy.orm import selectinload

    from .models import MaxLpsRack

    racks = list(db.scalars(select(MaxLpsRack).options(selectinload(MaxLpsRack.nodes), selectinload(MaxLpsRack.shelves))).all())
    keep = {str(s).strip() for s in (live_serials or ()) if str(s).strip()} if live_serials is not None else None

    for rack in racks:
        rack_serial = _blank(rack.serial) or rack.id
        origin = (getattr(rack, "origin", None) or "manual").strip().lower()
        if keep is not None and origin == "argus" and rack_serial not in keep and rack.id not in keep:
            continue
        rack_name = rack.label or rack_serial
        RACK_META.setdefault(
            rack_serial,
            {"serial": rack_serial, "name": rack_name, "type": rack.model or "", "status": "idle"},
        )
        RACK_META[rack_serial]["name"] = rack_name
        by_ip = {(_blank(n.bmc_ip) or ""): n for n in list(by_serial.values()) + list(by_mac.values()) if _blank(n.bmc_ip)}
        for n in rack.nodes:
            if not (_blank(n.serial) or _blank(n.bmc_mac) or _blank(n.bmc_ip)):
                continue
            mac = _blank(n.bmc_mac)
            ip = _blank(n.bmc_ip)
            serial = _blank(n.serial) or (f"MAC-{mac.replace(':','')[-12:]}" if mac else f"{rack_serial}-{n.index}")
            rack_key = rack_serial[:36]
            node = None
            if mac:
                found = by_mac.get(mac.lower())
                if found is not None and (not found.rack_id or found.rack_id == rack_key or origin == "manual"):
                    node = found
            if node is None and ip:
                found = by_ip.get(ip)
                if found is not None and (not found.rack_id or found.rack_id == rack_key or origin == "manual"):
                    node = found
            if node is None:
                clash = by_serial.get(serial)
                if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                    serial = f"{serial}-{rack_serial[:8]}"
                    clash = by_serial.get(serial)
                if clash is not None and clash.rack_id and clash.rack_id != rack_key:
                    clash = None
                node = clash
            if node is not None and _is_local(node):
                _fill(node, "bmc_mac", mac)
                _fill(node, "bmc_ip", n.bmc_ip)
                _fill(node, "bmc_user", n.bmc_user)
                _fill(node, "bmc_password", n.bmc_password)
                _fill(node, "os_mac", n.os_mac)
                _fill(node, "os_ip", n.os_ip)
                _fill(node, "os_username", n.os_username)
                _fill(node, "os_password", n.os_password)
                _assign_pxe(node, getattr(rack, "pxe_server", None), force=False)
                if mac:
                    by_mac[mac.lower()] = node
                if ip:
                    by_ip[ip] = node
                continue
            if node is None:
                if origin == "manual":
                    continue
                node = InventoryNode(id=_uuid(), serial=serial, name=n.hostname or f"{rack_name}-slot{n.index}", kind="compute")
                db.add(node)
                by_serial[serial] = node
            if mac:
                by_mac[mac.lower()] = node
            node.source = "argus"
            node.kind = "compute"
            host = _blank(n.hostname)
            if host and host.lower() not in _PLACEHOLDER_HOST:
                _fill(node, "name", host)
            elif not node.name or node.name.lower() in _PLACEHOLDER_HOST:
                _fill(node, "name", f"{rack_name}-slot{n.index}")
            _fill(node, "hall_name", rack_name)
            if not node.rack_id:
                node.rack_id = rack_serial[:36]
            _fill(node, "bmc_mac", mac)
            _fill(node, "bmc_ip", n.bmc_ip)
            _fill(node, "bmc_user", n.bmc_user or "ADMIN")
            _fill(node, "bmc_password", n.bmc_password)
            _fill(node, "os_mac", n.os_mac)
            _fill(node, "os_ip", n.os_ip)
            _fill(node, "os_username", n.os_username)
            _fill(node, "os_password", n.os_password)
            _assign_pxe(node, getattr(rack, "pxe_server", None), force=True)
            if not node.provision_status:
                node.provision_status = "dhcp" if node.bmc_ip else "registered"
            node.updated_at = _now()
            seen.add(node.id)
        for s in rack.shelves:
            mac = _blank(s.mac)
            serial = _blank(s.serial) or (f"MAC-{mac.replace(':', '')[-12:]}" if mac else f"{rack_serial}-PS{s.index}")
            node = None
            if mac:
                found = by_mac.get(mac.lower())
                if found is not None and _same_rack(found, rack_serial[:36], rack_name):
                    node = found
            if node is None:
                node = by_serial.get(serial)
            if node is not None and _is_local(node):
                _fill(node, "bmc_mac", s.mac)
                _fill(node, "bmc_ip", s.ip)
                _fill(node, "bmc_user", s.user)
                _fill(node, "bmc_password", s.password)
                _copy_mgmt_to_os(node)
                _assign_pxe(node, getattr(rack, "pxe_server", None), force=False)
                continue
            if node is None:
                if origin == "manual" or not (_blank(s.serial) or mac or _blank(s.ip)):
                    continue
                node = InventoryNode(id=_uuid(), serial=serial, name=f"{rack_name}-PS{s.index + 1}", kind="power")
                db.add(node)
                by_serial[serial] = node
            node.source = "argus"
            node.kind = "power"
            _fill(node, "hall_name", rack_name)
            if not node.rack_id:
                node.rack_id = rack_serial[:36]
            _fill(node, "bmc_mac", s.mac)
            _fill(node, "bmc_ip", s.ip)
            _fill(node, "bmc_user", s.user)
            _fill(node, "bmc_password", s.password)
            _copy_mgmt_to_os(node)
            _assign_pxe(node, getattr(rack, "pxe_server", None), force=not _is_local(node))
            node.provision_status = node.provision_status or "registered"
            node.updated_at = _now()
            seen.add(node.id)
            if mac:
                by_mac[mac.lower()] = node
