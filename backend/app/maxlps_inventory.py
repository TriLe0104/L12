"""MaxLPS hardware inventory and wattage samples.

GB300 NVL72 layout is fixed: 18 nodes × 4 GPUs, 8 power shelves.
Identity fields (serials, BMC, shelf IPs) are filled in by operators.
BMC / shelf passwords are stored for Redfish later; they are never logged.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from . import cluster_controller, gpu_power
from .models import (
    DataHall,
    HiddenRack,
    InventoryNode,
    MaxLpsClusterWatt,
    MaxLpsGpu,
    MaxLpsNode,
    MaxLpsRack,
    MaxLpsRackWatt,
    MaxLpsShelf,
    Rack,
    _now,
    _uuid,
)

NODES = gpu_power.NODES_PER_RACK
GPUS = gpu_power.GPUS_PER_NODE
SHELVES = gpu_power.SHELVES_PER_RACK
WATT_KEEP = timedelta(hours=24)
_last_prune = 0.0
_last_write = 0.0
_last_sync = 0.0


_BUCKETS = {"unassigned", "rack", "inventory", "all"}


def _blank(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _norm(v: str | None) -> str:
    return (v or "").strip().lower()


def hidden_tokens(db: Session) -> set[str]:
    out: set[str] = set()
    for row in db.scalars(select(HiddenRack)).all():
        for raw in (row.serial, row.label, (row.serial or "")[:36]):
            token = _norm(raw)
            if token and token not in _BUCKETS:
                out.add(token)
    return out


def is_hidden(db: Session, *values: str | None) -> bool:
    tokens = hidden_tokens(db)
    if not tokens:
        return False
    for value in values:
        token = _norm(value)
        if token and (token in tokens or token[:36] in tokens):
            return True
    return False


def remember_hidden(db: Session, *, serial: str | None, label: str | None) -> None:
    serial = _blank(serial)
    label = _blank(label)
    if serial and _norm(serial) in _BUCKETS:
        serial = None
    if label and _norm(label) in _BUCKETS:
        label = None
    if not serial and not label:
        return
    existing = None
    if serial:
        existing = db.scalars(select(HiddenRack).where(HiddenRack.serial == serial)).first()
    if existing is None and label:
        existing = db.scalars(select(HiddenRack).where(HiddenRack.label == label)).first()
    if existing is not None:
        if serial and not existing.serial:
            existing.serial = serial
        if label and not existing.label:
            existing.label = label
        return
    db.add(HiddenRack(id=_uuid(), serial=serial, label=label))


def forget_bucket_hides(db: Session) -> None:
    """Drop hide rows created by removing the synthetic Inventory / all bucket."""
    changed = False
    for row in list(db.scalars(select(HiddenRack)).all()):
        serial = _norm(row.serial)
        label = _norm(row.label)
        if (not serial or serial in _BUCKETS) and (not label or label in _BUCKETS) and (serial or label):
            db.delete(row)
            changed = True
    if changed:
        db.commit()


def reveal_hidden(db: Session, *, serial: str | None = None, label: str | None = None) -> None:
    serial_n = _norm(serial)
    label_n = _norm(label)
    if not serial_n and not label_n:
        return
    for row in list(db.scalars(select(HiddenRack)).all()):
        row_serial = _norm(row.serial)
        row_label = _norm(row.label)
        if serial_n and row_serial and (row_serial == serial_n or row_serial[:36] == serial_n[:36]):
            db.delete(row)
        elif label_n and row_label == label_n:
            db.delete(row)


def inventory_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(MaxLpsRack)) or 0)


def _node_populated(node: MaxLpsNode) -> bool:
    return bool(
        (node.bmc_ip or "").strip()
        or (node.hostname or "").strip()
        or (node.serial or "").strip()
        or (node.os_ip or "").strip()
        or (node.bmc_mac or "").strip()
        or (node.os_mac or "").strip()
    )


def rack_populated_nodes(rack: MaxLpsRack, live_gpus: int = 0, live_nodes: int = 0) -> int:
    """Compute trays that actually exist: inventory identity or live Redfish, not empty NVL72 slots."""
    named = sum(1 for n in rack.nodes if _node_populated(n))
    from_live = int(live_nodes or 0)
    if not from_live and live_gpus:
        from_live = (int(live_gpus) + GPUS - 1) // GPUS
    return max(named, from_live)


def live_overview_counts(racks: list[MaxLpsRack], live_by_rack: dict[str, dict] | None = None) -> dict[str, int]:
    """Racks, nodes, and GPUs that returned watts. Inventory power_state is not alive."""
    live_by_rack = live_by_rack or {}
    racks_on = 0
    nodes_on = 0
    gpus_live = 0
    for rack in racks:
        live = live_by_rack.get(rack.id) or {}
        nodes = int(live.get("nodes_live") or 0)
        gpus = int(live.get("gpu_live") or 0)
        nodes_on += nodes
        gpus_live += gpus
        if live.get("metered") or nodes or gpus:
            racks_on += 1
    return {"racks_on": racks_on, "nodes_on": nodes_on, "gpus_live": gpus_live}


def populated_counts(
    racks: list[MaxLpsRack],
    live_by_rack: dict[str, dict] | None = None,
) -> dict[str, int]:
    """Cluster compute/GPU totals: 4 GPUs per populated node."""
    live_by_rack = live_by_rack or {}
    n_nodes = 0
    n_nodes_on = 0
    for rack in racks:
        live = live_by_rack.get(rack.id) or {}
        nodes = rack_populated_nodes(rack, int(live.get("gpu_live") or 0), int(live.get("nodes_live") or 0))
        n_nodes += nodes
        if rack.enabled and (rack.power_state or "on") != "off":
            n_nodes_on += nodes
    return {
        "nodes": n_nodes,
        "nodes_on": n_nodes_on,
        "gpus": n_nodes * GPUS,
        "gpus_per_node": GPUS,
    }


def load_racks(db: Session) -> list[MaxLpsRack]:
    q = (
        select(MaxLpsRack)
        .options(
            selectinload(MaxLpsRack.nodes).selectinload(MaxLpsNode.gpus),
            selectinload(MaxLpsRack.shelves),
            selectinload(MaxLpsRack.gpus),
        )
        .order_by(MaxLpsRack.label, MaxLpsRack.serial)
    )
    return list(db.scalars(q).unique().all())


def get_rack(db: Session, rack_id: str) -> MaxLpsRack | None:
    q = (
        select(MaxLpsRack)
        .where(MaxLpsRack.id == rack_id)
        .options(
            selectinload(MaxLpsRack.nodes).selectinload(MaxLpsNode.gpus),
            selectinload(MaxLpsRack.shelves),
            selectinload(MaxLpsRack.gpus),
        )
    )
    return db.scalars(q).unique().first()


def dump_node(n: MaxLpsNode, *, secrets: bool) -> dict[str, Any]:
    out = {
        "id": n.id,
        "rack_id": n.rack_id,
        "index": n.index,
        "serial": n.serial,
        "hostname": n.hostname,
        "bmc_mac": n.bmc_mac,
        "bmc_ip": n.bmc_ip,
        "bmc_user": n.bmc_user or "ADMIN",
        "os_mac": n.os_mac,
        "os_ip": n.os_ip,
        "os_username": n.os_username or "root",
        "gpu_count": GPUS,
        "loop_on": bool(getattr(n, "loop_on", True)),
    }
    if secrets:
        out["bmc_password"] = n.bmc_password
        out["os_password"] = n.os_password
    else:
        out["bmc_password_set"] = bool(n.bmc_password)
        out["os_password_set"] = bool(n.os_password)
    return out


def dump_shelf(s: MaxLpsShelf, *, secrets: bool) -> dict[str, Any]:
    out = {
        "id": s.id,
        "rack_id": s.rack_id,
        "index": s.index,
        "serial": s.serial,
        "ip": s.ip,
        "mac": s.mac,
        "user": s.user,
        "model": s.model,
    }
    if secrets:
        out["password"] = s.password
    else:
        out["password_set"] = bool(s.password)
    return out


def dump_gpu(g: MaxLpsGpu) -> dict[str, Any]:
    return {
        "id": g.id,
        "rack_id": g.rack_id,
        "node_id": g.node_id,
        "node_index": g.node_index,
        "gpu_index": g.gpu_index,
        "serial": g.serial,
        "uuid": g.uuid,
        "pci_addr": g.pci_addr,
        "model": g.model,
        "tdp_w": g.tdp_w,
    }


def dump_rack(rack: MaxLpsRack, *, secrets: bool = True) -> dict[str, Any]:
    nodes = sorted(rack.nodes, key=lambda n: n.index)
    shelves = sorted(rack.shelves, key=lambda s: s.index)
    gpus = sorted(rack.gpus, key=lambda g: (g.node_index, g.gpu_index))
    return {
        "id": rack.id,
        "label": rack.label,
        "serial": rack.serial,
        "hall": rack.hall,
        "model": rack.model,
        "notes": rack.notes,
        "origin": rack.origin or "manual",
        "pxe_server": getattr(rack, "pxe_server", None),
        "enabled": rack.enabled,
        "power_state": rack.power_state,
        "created_at": rack.created_at.isoformat() if rack.created_at else None,
        "updated_at": rack.updated_at.isoformat() if rack.updated_at else None,
        "node_count": len(nodes),
        "shelf_count": len(shelves),
        "gpu_count": len(gpus),
        "nodes": [dump_node(n, secrets=secrets) for n in nodes],
        "shelves": [dump_shelf(s, secrets=secrets) for s in shelves],
        "gpus": [dump_gpu(g) for g in gpus],
    }


def _fill_topology(rack: MaxLpsRack) -> None:
    for i in range(1, NODES + 1):
        nid = f"{rack.id}-n{i:02d}"
        node = MaxLpsNode(id=nid, rack_id=rack.id, index=i, bmc_user="ADMIN")
        rack.nodes.append(node)
        for g in range(1, GPUS + 1):
            gid = f"{rack.id}-n{i:02d}-g{g}"
            rack.gpus.append(
                MaxLpsGpu(
                    id=gid,
                    rack_id=rack.id,
                    node_id=nid,
                    node_index=i,
                    gpu_index=g,
                    model="GB300",
                    tdp_w=gpu_power.GPU_TDP_W,
                )
            )
    for i in range(1, SHELVES + 1):
        rack.shelves.append(MaxLpsShelf(id=f"{rack.id}-ps{i}", rack_id=rack.id, index=i, model="PSU-50V"))


def create_rack(
    db: Session,
    *,
    label: str,
    serial: str | None = None,
    hall: str | None = None,
    notes: str | None = None,
    model: str | None = None,
    origin: str = "manual",
    node: dict[str, Any] | None = None,
) -> MaxLpsRack:
    label = (label or "").strip()
    if not label:
        raise ValueError("label is required")
    serial = _blank(serial)
    reveal_hidden(db, serial=serial, label=label)
    if serial:
        exists = db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.serial == serial))
        if exists:
            raise ValueError(f"rack serial {serial} already exists")
    clash = db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.label == label))
    if clash:
        raise ValueError(f"rack label {label} already exists")
    src = (origin or "manual").strip().lower()
    if src not in ("manual", "argus"):
        src = "manual"
    rack = MaxLpsRack(
        id=_uuid(),
        label=label,
        serial=serial,
        hall=_blank(hall),
        notes=_blank(notes),
        model=(model or "GB300-NVL72").strip() or "GB300-NVL72",
        origin=src,
        enabled=True,
        power_state="on",
    )
    _fill_topology(rack)
    db.add(rack)
    gpu_power.LOOP.cached_out = None
    gpu_power.LOOP.force = True
    db.commit()
    db.refresh(rack)
    loaded = get_rack(db, rack.id) or rack
    if node:
        assign_node(db, loaded, node)
        loaded = get_rack(db, rack.id) or loaded
    try:
        from .routers.cluster import _invalidate_power_cache

        _invalidate_power_cache()
    except Exception:
        pass
    return loaded


def _identity_payload(node: InventoryNode) -> dict[str, Any]:
    serial = (node.serial or "").strip()
    if serial.upper().startswith(("MAC-", "IP-", "UNK-")):
        serial = ""
    return {
        "bmc_ip": node.bmc_ip,
        "bmc_mac": node.bmc_mac,
        "bmc_user": node.bmc_user,
        "bmc_password": node.bmc_password,
        "os_ip": node.os_ip,
        "os_mac": node.os_mac,
        "os_username": node.os_username,
        "os_password": node.os_password,
        "hostname": node.name,
        "serial": serial or None,
    }


def _slot_matches(slot: MaxLpsNode, node: InventoryNode) -> bool:
    ip = (node.bmc_ip or "").strip()
    mac = (node.bmc_mac or "").strip().lower()
    if ip and (slot.bmc_ip or "").strip() == ip:
        return True
    if mac and (slot.bmc_mac or "").strip().lower() == mac:
        return True
    return False


def _detach_identity(db: Session, node: InventoryNode, keep_id: str | None) -> None:
    ip = (node.bmc_ip or "").strip()
    mac = (node.bmc_mac or "").strip().lower()
    if not ip and not mac:
        return
    for rack in load_racks(db):
        if keep_id and rack.id == keep_id:
            continue
        changed = False
        for slot in rack.nodes:
            if not _slot_matches(slot, node):
                continue
            slot.bmc_ip = None
            slot.bmc_mac = None
            slot.hostname = None
            changed = True
        if changed:
            rack.updated_at = _now()


def ensure_rack_for_node(db: Session, node: InventoryNode) -> MaxLpsRack | None:
    """Keep MaxLPS / Cluster on the same rack name as Provision."""
    label = (node.hall_name or node.name or "").strip()
    if not label or _norm(label) in _BUCKETS:
        return None
    reveal_hidden(db, label=label)
    racks = load_racks(db)
    rack = next((r for r in racks if _norm(r.label) == _norm(label)), None)
    if rack is None and node.rack_id:
        current = next((r for r in racks if r.id == node.rack_id), None)
        if current is not None and (current.origin or "manual") == "manual":
            others = [
                n
                for n in db.scalars(select(InventoryNode)).all()
                if n.id != node.id
                and (n.rack_id == current.id or _norm(n.hall_name) == _norm(current.label))
            ]
            if not others:
                current.label = label
                current.updated_at = _now()
                rack = current
    payload = _identity_payload(node)
    if rack is None:
        try:
            rack = create_rack(db, label=label, origin="manual", node=payload if (node.bmc_ip or node.bmc_mac) else None)
        except ValueError:
            rack = next((r for r in load_racks(db) if _norm(r.label) == _norm(label)), None)
            if rack is None:
                return None
    else:
        match = next((s for s in rack.nodes if _slot_matches(s, node)), None)
        if match is not None:
            patch_node(db, match, payload)
        elif node.bmc_ip or node.bmc_mac:
            try:
                assign_node(db, rack, payload)
            except ValueError:
                pass
    _detach_identity(db, node, rack.id)
    node.rack_id = rack.id
    return rack


def assign_node(db: Session, rack: MaxLpsRack, body: dict[str, Any]) -> MaxLpsNode:
    """Fill a topology slot with BMC identity. Next empty slot if index omitted."""
    nodes = sorted(rack.nodes, key=lambda n: int(n.index))
    raw_idx = body.get("index")
    if raw_idx is None or raw_idx == "":
        target = next((n for n in nodes if not (n.bmc_ip or "").strip()), None)
        if target is None:
            raise ValueError("rack has no free node slots")
    else:
        idx = int(raw_idx)
        target = next((n for n in nodes if int(n.index) == idx), None)
        if target is None:
            raise ValueError(f"node slot {idx} not found")
    return patch_node(db, target, body)


def _match_maxlps(db: Session, key: str) -> MaxLpsRack | None:
    rack = get_rack(db, key)
    if rack is not None:
        return rack
    needle = _norm(key)
    if not needle:
        return None
    for row in load_racks(db):
        serial = _norm(row.serial)
        if (
            _norm(row.label) == needle
            or serial == needle
            or serial[:36] == needle
            or row.id.lower() == needle
        ):
            return row
    return None


def _inventory_for_rack(db: Session, *, rack: MaxLpsRack | None, key: str, name: str | None) -> list[InventoryNode]:
    keys = {_norm(key)}
    if name:
        keys.add(_norm(name))
    if rack:
        keys.update({_norm(rack.id), _norm(rack.label), _norm(rack.serial), _norm(rack.serial)[:36]})
    keys.discard("")
    out: list[InventoryNode] = []
    for node in db.scalars(select(InventoryNode)).all():
        if _norm(node.rack_id) in keys or _norm(node.hall_name) in keys:
            out.append(node)
    return out


_SEED_KEYS = {"demo-campus", "seeded", "seeded campus"}


def _is_seed_rack(rack: Rack, hall_name: str) -> bool:
    return (rack.notes or "") == "GB300" and (rack.name or "").startswith(f"{hall_name}-R")


def seeded_halls(db: Session) -> list[DataHall]:
    """Firmus placeholder halls (DH-01..DH-04). Operator halls are left alone."""
    halls = list(db.scalars(select(DataHall).options(selectinload(DataHall.racks))).all())
    out: list[DataHall] = []
    for hall in halls:
        name = (hall.name or "").strip()
        racks = list(hall.racks)
        if name.startswith("DH-") and racks and all(_is_seed_rack(rack, name) for rack in racks):
            out.append(hall)
    return out


def seeded_provision_rack(db: Session) -> dict[str, Any] | None:
    halls = seeded_halls(db)
    if not halls:
        return None
    names = ", ".join(sorted(hall.name for hall in halls))
    count = sum(len(list(hall.racks)) for hall in halls)
    return {
        "id": "demo-campus",
        "serial": names,
        "name": "Seeded campus",
        "type": "placeholder",
        "status": "placeholder",
        "counts": {"nodes": count, "switches": 0, "shelves": 0},
    }


def _delete_seed_halls(db: Session, halls: list[DataHall]) -> int:
    if not halls:
        return 0
    ids = [hall.id for hall in halls]
    names = [hall.name for hall in halls]
    count = int(
        db.scalar(select(func.count()).select_from(Rack).where(Rack.hall_id.in_(ids))) or 0
    )
    db.execute(delete(InventoryNode).where(InventoryNode.hall_name.in_(names), InventoryNode.source == "demo"))
    db.execute(delete(Rack).where(Rack.hall_id.in_(ids)))
    db.execute(delete(DataHall).where(DataHall.id.in_(ids)))
    db.expire_all()
    return count


def remove_seeded_campus(db: Session, key: str) -> dict[str, Any] | None:
    """Delete seeded floor halls. Does not hide a name and does not touch Argus."""
    needle = _norm(key)
    halls = seeded_halls(db)
    if not halls:
        return None
    if needle in _SEED_KEYS or needle in {"all", "inventory"}:
        targets = halls
    else:
        targets = [hall for hall in halls if _norm(hall.name) == needle or hall.id.lower() == needle]
        if not targets:
            for hall in halls:
                for rack in list(hall.racks):
                    if rack.id.lower() == needle or _norm(rack.name) == needle:
                        label = rack.name
                        hall_id = hall.id
                        db.execute(delete(Rack).where(Rack.id == rack.id))
                        left = int(
                            db.scalar(select(func.count()).select_from(Rack).where(Rack.hall_id == hall_id)) or 0
                        )
                        if left == 0:
                            db.execute(delete(DataHall).where(DataHall.id == hall_id))
                        db.commit()
                        return {"ok": True, "id": key, "label": label, "nodes": 1, "hidden": False}
            return None
    labels = [hall.name for hall in targets]
    count = _delete_seed_halls(db, targets)
    db.commit()
    return {"ok": True, "id": key, "label": ", ".join(labels), "nodes": count, "hidden": False}


def remove_operator_rack(db: Session, key: str) -> dict[str, Any] | None:
    """Delete a rack from MaxLPS + provision and keep Argus from putting it back."""
    key = (key or "").strip()
    if not key:
        return None
    seeded = remove_seeded_campus(db, key)
    if seeded is not None:
        return seeded
    rack = _match_maxlps(db, key)
    name = (rack.label if rack else key).strip() or key
    serial = _blank(rack.serial if rack else None) or (None if _norm(key) in _BUCKETS else key)
    hide = _norm(name) not in _BUCKETS
    nodes = _inventory_for_rack(db, rack=rack, key=key, name=name)
    for node in nodes:
        db.delete(node)
    if hide:
        remember_hidden(db, serial=serial, label=name)
        try:
            from . import provision_argus

            for tok in (serial, name, key, (serial or "")[:36], rack.id if rack else None):
                if tok:
                    provision_argus.RACK_META.pop(str(tok), None)
                    provision_argus.RACK_META.pop(str(tok)[:36], None)
        except Exception:
            pass
    rid = rack.id if rack else key
    if rack is not None:
        db.delete(rack)
        gpu_power.LOOP.cached_out = None
        gpu_power.LOOP.force = True
        try:
            from .routers.cluster import _invalidate_power_cache

            _invalidate_power_cache()
        except Exception:
            pass
    db.commit()
    return {"ok": True, "id": rid, "label": name, "nodes": len(nodes), "hidden": hide}


def delete_rack(db: Session, rack_id: str) -> bool:
    return remove_operator_rack(db, rack_id) is not None


def patch_rack(db: Session, rack: MaxLpsRack, body: dict[str, Any]) -> MaxLpsRack:
    if "label" in body and body["label"] is not None:
        label = str(body["label"]).strip()
        if not label:
            raise ValueError("label is required")
        rack.label = label
    if "serial" in body:
        serial = _blank(body.get("serial"))
        if serial:
            other = db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.serial == serial, MaxLpsRack.id != rack.id))
            if other:
                raise ValueError(f"rack serial {serial} already exists")
        rack.serial = serial
    if "hall" in body:
        rack.hall = _blank(body.get("hall"))
    if "notes" in body:
        rack.notes = _blank(body.get("notes"))
    if "model" in body and body["model"]:
        rack.model = str(body["model"]).strip()
    if "enabled" in body and body["enabled"] is not None:
        rack.enabled = bool(body["enabled"])
    if "power_state" in body and body["power_state"] in ("on", "off"):
        rack.power_state = body["power_state"]
    rack.updated_at = _now()
    db.commit()
    return get_rack(db, rack.id) or rack


def patch_node(db: Session, node: MaxLpsNode, body: dict[str, Any]) -> MaxLpsNode:
    for key in (
        "serial",
        "hostname",
        "bmc_mac",
        "bmc_ip",
        "bmc_user",
        "bmc_password",
        "os_mac",
        "os_ip",
        "os_username",
        "os_password",
    ):
        if key in body:
            if key == "bmc_user":
                setattr(node, key, _blank(body.get(key)) or "ADMIN")
            elif key == "os_username":
                setattr(node, key, _blank(body.get(key)) or "root")
            else:
                setattr(node, key, _blank(body.get(key)))
    node.updated_at = _now()
    db.commit()
    db.refresh(node)
    return node


def patch_shelf(db: Session, shelf: MaxLpsShelf, body: dict[str, Any]) -> MaxLpsShelf:
    for key in ("serial", "ip", "mac", "user", "password", "model"):
        if key in body:
            setattr(shelf, key, _blank(body.get(key)))
    shelf.updated_at = _now()
    db.commit()
    db.refresh(shelf)
    return shelf


def patch_gpu(db: Session, gpu: MaxLpsGpu, body: dict[str, Any]) -> MaxLpsGpu:
    for key in ("serial", "uuid", "pci_addr", "model"):
        if key in body:
            setattr(gpu, key, _blank(body.get(key)) or (gpu.model if key == "model" else None))
    if "tdp_w" in body and body["tdp_w"] is not None:
        gpu.tdp_w = max(50.0, min(2000.0, float(body["tdp_w"])))
    gpu.updated_at = _now()
    db.commit()
    db.refresh(gpu)
    return gpu


def power_samples(db: Session, demand_kw: float = 0.0) -> list[dict[str, Any]]:
    """Limiter input rows from MaxLPS inventory (replaces floor-plan racks)."""
    rows = []
    for rack in db.scalars(select(MaxLpsRack).order_by(MaxLpsRack.label)).all():
        on = bool(rack.enabled) and (rack.power_state or "on") != "off"
        _shelves, live_sum, live, _src = gpu_power._merge_shelves(rack.id)
        demand = float(live_sum) if live else 0.0
        if demand <= 0 and demand_kw and not live:
            demand = 0.0
        rows.append(
            {
                "id": rack.id,
                "name": rack.label,
                "hall_id": rack.hall or "live",
                "power_state": "on" if on else "off",
                "run_status": "ready",
                "demand_kw": demand if on else 0.0,
                "saturating": False,
            }
        )
    return rows


def _watt_ts(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def watt_series(db: Session, start_ts: float, end_ts: float, points: int = 48) -> list[dict[str, Any]]:
    """Downsampled PowerShelf / GPU kW history for the cluster overview."""
    rows = list(db.scalars(select(MaxLpsClusterWatt).order_by(MaxLpsClusterWatt.ts.asc())).all())
    if not rows:
        return []
    picked: list[MaxLpsClusterWatt] = []
    for row in rows:
        t = _watt_ts(row.ts)
        if t < start_ts - 2 or t > end_ts + 2:
            continue
        picked.append(row)
    if not picked:
        picked = rows[-min(len(rows), points) :]
    if len(picked) > points:
        out_rows = []
        last = len(picked) - 1
        for i in range(points):
            out_rows.append(picked[int(round(i * last / max(1, points - 1)))])
        picked = out_rows
    return [
        {
            "t": _watt_ts(r.ts),
            "power_kw": round(float(r.used_kw or 0.0), 2),
            "gpu_kw": round(float(r.gpu_kw or 0.0), 2),
        }
        for r in picked
    ]


def last_watt_by_rack(db: Session) -> dict[str, dict[str, float]]:
    """Newest stored shelf/GPU kW per registered rack."""
    rows = list(db.scalars(select(MaxLpsRackWatt).order_by(MaxLpsRackWatt.ts.desc()).limit(400)).all())
    out: dict[str, dict[str, float]] = {}
    for row in rows:
        if row.rack_id in out:
            continue
        out[row.rack_id] = {
            "shelf_kw": float(row.shelf_kw or 0.0),
            "gpu_kw": float(row.gpu_kw or 0.0),
        }
    return out


def record_from_view(db: Session, view: dict[str, Any]) -> None:
    """Persist cluster + per-rack watt samples. GPU/shelf traces ride as JSON on the rack row."""
    global _last_prune, _last_write
    now = time.time()
    if now - _last_write < 0.85:
        return
    _last_write = now
    if not inventory_count(db):
        return
    ts = datetime.now(timezone.utc)
    totals = view.get("totals") or {}
    db.add(
        MaxLpsClusterWatt(
            ts=ts,
            used_kw=float(totals.get("used_kw") or totals.get("shelf_kw") or 0.0),
            gpu_kw=float(totals.get("gpu_kw") or 0.0),
            overhead_kw=float(totals.get("overhead_kw") or 0.0),
            available_kw=float(totals.get("available_kw") or 0.0),
            total_kw=float(totals.get("total_kw") or 0.0),
            rack_count=len(view.get("racks") or []),
            gpu_count=int(totals.get("gpus_total") or 0),
        )
    )
    by_rack: dict[str, list[dict[str, Any]]] = {}
    for g in view.get("gpus") or []:
        rid = g.get("rack_id")
        if rid:
            by_rack.setdefault(rid, []).append(g)
    known = set(db.scalars(select(MaxLpsRack.id)).all())
    for r in view.get("racks") or []:
        rid = r.get("id")
        if rid not in known:
            continue
        gpus = sorted(by_rack.get(rid, []), key=lambda x: (int(x.get("node") or 0), int(x.get("gpu") or 0)))
        shelves = r.get("shelves") or []
        db.add(
            MaxLpsRackWatt(
                ts=ts,
                rack_id=rid,
                shelf_kw=float(r.get("shelf_kw") or 0.0),
                gpu_kw=float(r.get("gpu_kw") or 0.0),
                overhead_kw=float(r.get("overhead_kw") or 0.0),
                allocated_kw=float(r.get("allocated_kw") or 0.0),
                gpu_watts=[float(g.get("watts") or 0.0) for g in gpus],
                shelf_watts=[float(s.get("kw") or 0.0) for s in shelves],
            )
        )
    if now - _last_prune > 60:
        cutoff = ts - WATT_KEEP
        db.execute(delete(MaxLpsClusterWatt).where(MaxLpsClusterWatt.ts < cutoff))
        db.execute(delete(MaxLpsRackWatt).where(MaxLpsRackWatt.ts < cutoff))
        _last_prune = now
    db.commit()


def cluster_watts(db: Session, since: datetime | None = None, limit: int = 2000) -> list[dict[str, Any]]:
    q = select(MaxLpsClusterWatt).order_by(MaxLpsClusterWatt.ts.desc()).limit(max(1, min(limit, 20000)))
    if since is not None:
        q = q.where(MaxLpsClusterWatt.ts >= since)
    rows = list(db.scalars(q).all())
    rows.reverse()
    return [
        {
            "ts": r.ts.isoformat(),
            "used_kw": r.used_kw,
            "gpu_kw": r.gpu_kw,
            "overhead_kw": r.overhead_kw,
            "available_kw": r.available_kw,
            "total_kw": r.total_kw,
            "rack_count": r.rack_count,
            "gpu_count": r.gpu_count,
        }
        for r in rows
    ]


def rack_watts(db: Session, rack_id: str, since: datetime | None = None, limit: int = 2000) -> list[dict[str, Any]]:
    q = (
        select(MaxLpsRackWatt)
        .where(MaxLpsRackWatt.rack_id == rack_id)
        .order_by(MaxLpsRackWatt.ts.desc())
        .limit(max(1, min(limit, 20000)))
    )
    if since is not None:
        q = q.where(MaxLpsRackWatt.ts >= since)
    rows = list(db.scalars(q).all())
    rows.reverse()
    return [
        {
            "ts": r.ts.isoformat(),
            "rack_id": r.rack_id,
            "shelf_kw": r.shelf_kw,
            "gpu_kw": r.gpu_kw,
            "overhead_kw": r.overhead_kw,
            "allocated_kw": r.allocated_kw,
            "gpu_watts": r.gpu_watts,
            "shelf_watts": r.shelf_watts,
        }
        for r in rows
    ]


def _slot(raw: Any, nmax: int) -> int | None:
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if 0 <= n < nmax:
        return n + 1
    return None


def _gpu_slot(g: dict[str, Any]) -> int | None:
    for key in ("name", "Id", "id"):
        v = str(g.get(key) or "")
        if v.upper().startswith("GPU_"):
            try:
                return int(v.rsplit("_", 1)[-1]) + 1
            except ValueError:
                continue
    return None


def _set_if(obj: Any, field: str, value: Any) -> None:
    v = _blank(value) if isinstance(value, str) or value is None else value
    if v is None or v == "":
        return
    setattr(obj, field, v)


def _apply_node(node: MaxLpsNode, src: dict[str, Any], rack: MaxLpsRack) -> None:
    _set_if(node, "serial", src.get("serial_number") or src.get("serial"))
    _set_if(node, "hostname", src.get("hostname"))
    _set_if(node, "bmc_mac", src.get("bmc_mac"))
    _set_if(node, "bmc_ip", src.get("bmc_ip"))
    _set_if(node, "bmc_user", src.get("bmc_username") or src.get("bmc_user"))
    _set_if(node, "bmc_password", src.get("bmc_password"))
    _set_if(node, "os_mac", src.get("os_mac"))
    _set_if(node, "os_ip", src.get("os_ip"))
    _set_if(node, "os_username", src.get("os_username") or src.get("os_user"))
    _set_if(node, "os_password", src.get("os_password"))
    hw = src.get("hardware_data") if isinstance(src.get("hardware_data"), dict) else {}
    gpus_src = hw.get("gpus") if isinstance(hw, dict) else None
    if not isinstance(gpus_src, list):
        return
    by_i = {g.gpu_index: g for g in node.gpus}
    if not by_i:
        by_i = {g.gpu_index: g for g in rack.gpus if g.node_index == node.index}
    for gsrc in gpus_src:
        if not isinstance(gsrc, dict):
            continue
        gi = _gpu_slot(gsrc)
        if gi is None or gi not in by_i:
            continue
        gpu = by_i[gi]
        _set_if(gpu, "serial", gsrc.get("SerialNumber") or gsrc.get("sn") or gsrc.get("serial"))
        _set_if(gpu, "uuid", gsrc.get("UUID") or gsrc.get("uuid"))
        _set_if(gpu, "model", gsrc.get("Model") or gsrc.get("model"))
        _set_if(gpu, "pci_addr", gsrc.get("pci_addr") or gsrc.get("PCI"))


_SLOT_FIELDS = (
    "serial",
    "hostname",
    "bmc_mac",
    "bmc_ip",
    "bmc_user",
    "bmc_password",
    "os_mac",
    "os_ip",
    "os_username",
    "os_password",
)
_CRED_FIELDS = ("bmc_user", "bmc_password", "os_username", "os_password", "os_ip", "os_mac")


def _clash_label(name: str, serial: str) -> str:
    return f"{name}-{serial[-6:]}"


def _release_duplicate_slot(nodes_by_i: dict[int, MaxLpsNode], src: dict[str, Any], idx: int) -> None:
    """Move a machine off the wrong slot before Argus writes its real location."""
    mac = (_blank(src.get("bmc_mac")) or "").lower()
    ip = _blank(src.get("bmc_ip"))
    serial = _blank(src.get("serial_number") or src.get("serial"))
    if not mac and not ip and not serial:
        return
    target = nodes_by_i.get(idx)
    for other_i, other in list(nodes_by_i.items()):
        if other_i == idx:
            continue
        if not (
            (mac and (_blank(other.bmc_mac) or "").lower() == mac)
            or (serial and _blank(other.serial) == serial)
            or (ip and _blank(other.bmc_ip) == ip)
        ):
            continue
        if target is not None:
            for field in _CRED_FIELDS:
                incoming = _blank(getattr(other, field, None))
                if incoming and not _blank(getattr(target, field, None)):
                    setattr(target, field, incoming)
        for field in _SLOT_FIELDS:
            setattr(other, field, None)


def _apply_shelf(shelf: MaxLpsShelf, src: dict[str, Any]) -> None:
    _set_if(shelf, "serial", src.get("serial_number") or src.get("serial"))
    _set_if(shelf, "ip", src.get("bmc_ip") or src.get("ip"))
    _set_if(shelf, "mac", src.get("bmc_mac") or src.get("mac"))
    _set_if(shelf, "user", src.get("bmc_username") or src.get("user"))
    _set_if(shelf, "password", src.get("bmc_password") or src.get("password"))
    _set_if(shelf, "model", src.get("model"))


def _richness(detail: dict[str, Any]) -> int:
    score = 0
    for key in ("nodes", "switches", "powershelves", "cdus"):
        for entry in detail.get(key) or []:
            if not isinstance(entry, dict):
                continue
            score += 1
            if _blank(entry.get("bmc_ip")) or _blank(entry.get("serial_number") or entry.get("serial")):
                score += 5
    return score


def collect_controller_racks(db: Session) -> dict[str, Any]:
    """Read every PXE's Argus. One down host does not blank the others.

    The same serial on two servers keeps the copy with more identity filled in,
    and that server is the rack's PXE.
    """
    from . import cluster_controller, pxe_servers

    best: dict[str, tuple[int, dict[str, Any]]] = {}
    ok_pxes: set[str] = set()
    errors: list[str] = []
    sources = pxe_servers.controller_sources(db)
    if not sources:
        return {"racks": [], "ok_pxes": ok_pxes, "errors": ["cluster controller URL is not set"]}
    for src in sources:
        try:
            rows = cluster_controller.list_racks(base=src.base)
        except Exception as exc:
            errors.append(f"{src.pxe_host}: {exc}")
            continue
        ok_pxes.add(src.pxe_host.lower())
        for row in rows:
            if not isinstance(row, dict):
                continue
            sn = _blank(row.get("serial_number") or row.get("serial"))
            name = _blank(row.get("name"))
            if not sn or not name:
                continue
            try:
                detail = cluster_controller.get_rack(sn, name, base=src.base) or row
            except Exception:
                detail = row
            if not isinstance(detail, dict):
                detail = row
            detail = dict(detail)
            detail["pxe_server"] = src.pxe_host
            score = _richness(detail)
            prev = best.get(sn)
            if prev is None or score > prev[0]:
                best[sn] = (score, detail)
    return {"racks": [item[1] for item in best.values()], "ok_pxes": ok_pxes, "errors": errors}


def upsert_controller_rack(db: Session, detail: dict[str, Any]) -> str:
    serial = _blank(detail.get("serial_number") or detail.get("serial"))
    name = _blank(detail.get("name")) or serial or "rack"
    if not serial:
        raise ValueError("controller rack missing serial_number")
    # A remove only clears L12. The next Argus sync puts the rack back.
    if is_hidden(db, serial, name):
        reveal_hidden(db, serial=serial, label=name)
    pxe = _blank(detail.get("pxe_server"))
    rack = db.scalars(select(MaxLpsRack).where(MaxLpsRack.serial == serial)).first()
    created = "updated"
    if rack is None:
        same_label = db.scalars(select(MaxLpsRack).where(MaxLpsRack.label == name)).first()
        # A serial-less operator rack with this label is the same rack.
        if same_label is not None and not _blank(same_label.serial):
            same_label.serial = serial
            rack = same_label
    elif rack.label == _clash_label(name, serial):
        # An earlier sync renamed around a serial-less rack. Fold that copy back.
        same_label = db.scalars(select(MaxLpsRack).where(MaxLpsRack.label == name)).first()
        if same_label is not None and same_label.id != rack.id and not _blank(same_label.serial):
            db.execute(delete(MaxLpsRackWatt).where(MaxLpsRackWatt.rack_id == rack.id))
            db.delete(rack)
            db.flush()
            same_label.serial = serial
            rack = same_label
    if rack is None:
        label = name
        if db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.label == label)):
            label = _clash_label(name, serial)
        rack_type = _blank(detail.get("type")) or "GB300-NVL72"
        model = "GB300-NVL72" if str(rack_type).lower().startswith("gb300") else str(rack_type)
        rack = create_rack(
            db,
            label=label,
            serial=serial,
            hall=None,
            notes=_blank(detail.get("status")),
            model=model,
            origin="argus",
        )
        created = "created"
        if pxe:
            rack.pxe_server = pxe
    else:
        if name and rack.label != name and not db.scalar(
            select(MaxLpsRack.id).where(MaxLpsRack.label == name, MaxLpsRack.id != rack.id)
        ):
            rack.label = name
        if detail.get("status"):
            rack.notes = _blank(detail.get("status"))
        rtype = _blank(detail.get("type"))
        if rtype:
            rack.model = "GB300-NVL72" if rtype.lower().startswith("gb300") else rtype
        if (rack.origin or "manual").strip().lower() != "manual":
            rack.origin = "argus"
        if pxe:
            rack.pxe_server = pxe
        rack.updated_at = _now()
        db.commit()
        loaded = get_rack(db, rack.id)
        rack = loaded or rack
    nodes_by_i = {n.index: n for n in rack.nodes}
    for src in detail.get("nodes") or []:
        if not isinstance(src, dict):
            continue
        idx = _slot(src.get("location_index"), NODES)
        if idx is None or idx not in nodes_by_i:
            continue
        _release_duplicate_slot(nodes_by_i, src, idx)
        _apply_node(nodes_by_i[idx], src, rack)
    shelves_by_i = {s.index: s for s in rack.shelves}
    for src in detail.get("powershelves") or []:
        if not isinstance(src, dict):
            continue
        idx = _slot(src.get("location_index"), SHELVES)
        if idx is None or idx not in shelves_by_i:
            continue
        _apply_shelf(shelves_by_i[idx], src)
    db.commit()
    return created


def prune_controller_racks(
    db: Session,
    keep_serials: set[str],
    *,
    confirmed_pxes: set[str] | None = None,
    drop_unassigned: bool = True,
) -> list[str]:
    """Remove MaxLPS racks whose serial is gone from Argus. Serial-less local racks stay.

    A rack assigned to a PXE that did not answer this round stays. Unassigned
    Argus racks are removed only when every configured PXE answered.
    """
    keep = {str(s).strip() for s in keep_serials if str(s).strip()}
    confirmed = {str(p).strip().lower() for p in (confirmed_pxes or set()) if str(p).strip()}
    removed: list[str] = []
    for rack in list(db.scalars(select(MaxLpsRack)).all()):
        sn = (rack.serial or "").strip()
        origin = (getattr(rack, "origin", None) or "manual").strip().lower()
        if origin != "argus" or not sn or sn in keep:
            continue
        if confirmed_pxes is not None:
            assigned = (getattr(rack, "pxe_server", None) or "").strip().lower()
            if assigned:
                if assigned not in confirmed:
                    continue
            elif not drop_unassigned:
                continue
        removed.append(rack.label or sn)
        db.delete(rack)
    if removed:
        db.commit()
        gpu_power.LOOP.cached_out = None
        gpu_power.LOOP.force = True
        try:
            from .routers.cluster import _invalidate_power_cache

            _invalidate_power_cache()
        except Exception:
            pass
    return removed


def sync_from_controller(db: Session, bundle: dict[str, Any] | None = None) -> dict[str, Any]:
    bundle = bundle or collect_controller_racks(db)
    ok_pxes = {str(p).lower() for p in (bundle.get("ok_pxes") or set())}
    errors = [str(item) for item in (bundle.get("errors") or [])]
    if not ok_pxes:
        raise RuntimeError("; ".join(errors) or "cluster controller URL is not set")
    created = updated = 0
    racks: list[str] = []
    skipped: list[str] = []
    keep: set[str] = set()
    for detail in bundle.get("racks") or []:
        if not isinstance(detail, dict):
            continue
        sn = detail.get("serial_number") or detail.get("serial")
        name = detail.get("name")
        if not sn or not name:
            continue
        kind = upsert_controller_rack(db, detail)
        if kind == "skipped":
            skipped.append(str(name))
            continue
        if kind == "created":
            created += 1
        else:
            updated += 1
        racks.append(str(sn))
        keep.add(str(sn).strip())
    removed = prune_controller_racks(
        db,
        keep,
        confirmed_pxes=ok_pxes,
        drop_unassigned=not errors,
    )
    gpu_power.LOOP.cached_out = None
    gpu_power.LOOP.force = True
    try:
        from .routers.cluster import _invalidate_power_cache

        _invalidate_power_cache()
    except Exception:
        pass
    return {
        "created": created,
        "updated": updated,
        "removed": len(removed),
        "removed_labels": removed,
        "count": created + updated,
        "serials": racks,
        "skipped_hidden": skipped,
        "ok_pxes": sorted(ok_pxes),
        "errors": errors,
    }


def sync_live_infra(db: Session, force: bool = False) -> dict[str, Any] | None:
    """Argus is the live source: MaxLPS racks, provision nodes, cluster floor."""
    out: dict[str, Any] | None = None
    bundle: dict[str, Any] | None = None
    try:
        if force:
            bundle = collect_controller_racks(db)
            out = sync_from_controller(db, bundle)
        else:
            out = maybe_sync(db)
    except Exception as exc:
        db.rollback()
        out = {
            "created": 0,
            "updated": 0,
            "removed": 0,
            "serials": [],
            "ok_pxes": [],
            "errors": [str(exc)],
        }
    try:
        from . import provision_argus

        ran = bool(out and out.get("ok_pxes"))
        provision_argus.sync_from_argus(db, force=force or ran, bundle=bundle if force else None)
    except Exception as exc:
        db.rollback()
        if out is None:
            out = {"created": 0, "updated": 0, "removed": 0, "serials": [], "ok_pxes": [], "errors": []}
        out.setdefault("errors", []).append(str(exc))
    return out


def maybe_sync(db: Session) -> dict[str, Any] | None:
    global _last_sync
    from . import pxe_servers

    if not pxe_servers.controller_sources(db):
        return None
    now = time.time()
    from .config import settings

    gap = max(15.0, float(settings.cluster_controller_sync_s or 60.0))
    if _last_sync and now - _last_sync < gap:
        return None
    try:
        out = sync_from_controller(db)
        _last_sync = now
        return out
    except Exception:
        db.rollback()
        _last_sync = now
        return None


def schema_guide() -> dict[str, Any]:
    return {
        "layout": "GB300 NVL72 — 18 nodes × 4 GPU, 8 power shelves",
        "tables": {
            "maxlps_racks": {
                "purpose": "One physical rack. Add/remove these from the MaxLPS page.",
                "columns": [
                    "id",
                    "label",
                    "serial (rack SN, unique)",
                    "hall",
                    "model",
                    "notes",
                    "enabled",
                    "power_state",
                    "created_at",
                    "updated_at",
                ],
            },
            "maxlps_nodes": {
                "purpose": "Compute node / BMC. 18 per rack.",
                "columns": [
                    "id",
                    "rack_id",
                    "index (1–18)",
                    "serial (node SN)",
                    "hostname",
                    "bmc_mac",
                    "bmc_ip",
                    "bmc_user",
                    "bmc_password",
                    "os_mac",
                    "os_ip",
                ],
            },
            "maxlps_gpus": {
                "purpose": "GPU identity under a node. 4 per node, 72 per rack.",
                "columns": [
                    "id",
                    "rack_id",
                    "node_id",
                    "node_index",
                    "gpu_index (1–4)",
                    "serial",
                    "uuid",
                    "pci_addr",
                    "model",
                    "tdp_w",
                ],
            },
            "maxlps_shelves": {
                "purpose": "Power shelf / PDU. 8 per rack.",
                "columns": ["id", "rack_id", "index (1–8)", "serial", "ip", "mac", "user", "password", "model"],
            },
            "maxlps_cluster_watts": {
                "purpose": "Cluster mix samples ~1 Hz. Kept 24 h.",
                "columns": ["id", "ts", "used_kw", "gpu_kw", "overhead_kw", "available_kw", "total_kw", "rack_count", "gpu_count"],
            },
            "maxlps_rack_watts": {
                "purpose": "Per-rack samples ~1 Hz. GPU and shelf traces stored as JSON arrays. Kept 24 h.",
                "columns": [
                    "id",
                    "ts",
                    "rack_id",
                    "shelf_kw",
                    "gpu_kw",
                    "overhead_kw",
                    "allocated_kw",
                    "gpu_watts (JSON, 72 W)",
                    "shelf_watts (JSON, 8 kW)",
                ],
            },
        },
    }
