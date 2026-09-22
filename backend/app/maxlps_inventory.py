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
from .models import MaxLpsClusterWatt, MaxLpsGpu, MaxLpsNode, MaxLpsRack, MaxLpsRackWatt, MaxLpsShelf, _now, _uuid

NODES = gpu_power.NODES_PER_RACK
GPUS = gpu_power.GPUS_PER_NODE
SHELVES = gpu_power.SHELVES_PER_RACK
WATT_KEEP = timedelta(hours=24)
_last_prune = 0.0
_last_write = 0.0
_last_sync = 0.0


def _blank(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def inventory_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(MaxLpsRack)) or 0)


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
        "gpu_count": GPUS,
    }
    if secrets:
        out["bmc_password"] = n.bmc_password
    else:
        out["bmc_password_set"] = bool(n.bmc_password)
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
) -> MaxLpsRack:
    label = (label or "").strip()
    if not label:
        raise ValueError("label is required")
    serial = _blank(serial)
    if serial:
        exists = db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.serial == serial))
        if exists:
            raise ValueError(f"rack serial {serial} already exists")
    clash = db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.label == label))
    if clash:
        raise ValueError(f"rack label {label} already exists")
    rack = MaxLpsRack(
        id=_uuid(),
        label=label,
        serial=serial,
        hall=_blank(hall),
        notes=_blank(notes),
        model=(model or "GB300-NVL72").strip() or "GB300-NVL72",
        enabled=True,
        power_state="on",
    )
    _fill_topology(rack)
    db.add(rack)
    gpu_power.LOOP.cached_out = None
    gpu_power.LOOP.force = True
    db.commit()
    db.refresh(rack)
    return get_rack(db, rack.id) or rack


def delete_rack(db: Session, rack_id: str) -> bool:
    rack = db.get(MaxLpsRack, rack_id)
    if rack is None:
        return False
    db.delete(rack)
    gpu_power.LOOP.cached_out = None
    gpu_power.LOOP.force = True
    db.commit()
    return True


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
    for key in ("serial", "hostname", "bmc_mac", "bmc_ip", "bmc_user", "bmc_password", "os_mac", "os_ip"):
        if key in body:
            setattr(node, key, _blank(body.get(key)) if key != "bmc_user" else (_blank(body.get(key)) or "ADMIN"))
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
        rows.append(
            {
                "id": rack.id,
                "name": rack.label,
                "hall_id": rack.hall or "",
                "power_state": "on" if on else "off",
                "run_status": "ready",
                "demand_kw": float(demand_kw) if on else 0.0,
                "saturating": False,
            }
        )
    return rows


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


def _apply_shelf(shelf: MaxLpsShelf, src: dict[str, Any]) -> None:
    _set_if(shelf, "serial", src.get("serial_number") or src.get("serial"))
    _set_if(shelf, "ip", src.get("bmc_ip") or src.get("ip"))
    _set_if(shelf, "mac", src.get("bmc_mac") or src.get("mac"))
    _set_if(shelf, "user", src.get("bmc_username") or src.get("user"))
    _set_if(shelf, "password", src.get("bmc_password") or src.get("password"))
    _set_if(shelf, "model", src.get("model"))


def upsert_controller_rack(db: Session, detail: dict[str, Any]) -> str:
    serial = _blank(detail.get("serial_number") or detail.get("serial"))
    name = _blank(detail.get("name")) or serial or "rack"
    if not serial:
        raise ValueError("controller rack missing serial_number")
    rack = db.scalars(select(MaxLpsRack).where(MaxLpsRack.serial == serial)).first()
    created = "updated"
    if rack is None:
        label = name
        if db.scalar(select(MaxLpsRack.id).where(MaxLpsRack.label == label)):
            label = f"{name}-{serial[-6:]}"
        rack_type = _blank(detail.get("type")) or "GB300-NVL72"
        model = "GB300-NVL72" if str(rack_type).lower().startswith("gb300") else str(rack_type)
        rack = create_rack(db, label=label, serial=serial, hall=None, notes=_blank(detail.get("status")), model=model)
        created = "created"
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


def sync_from_controller(db: Session) -> dict[str, Any]:
    if not cluster_controller.enabled():
        raise RuntimeError("cluster controller URL is not set")
    summaries = cluster_controller.list_racks()
    created = updated = 0
    racks: list[str] = []
    for row in summaries:
        sn = row.get("serial_number") or row.get("serial")
        name = row.get("name")
        if not sn or not name:
            continue
        detail = cluster_controller.get_rack(str(sn), str(name))
        if not detail:
            detail = row
        kind = upsert_controller_rack(db, detail)
        if kind == "created":
            created += 1
        else:
            updated += 1
        racks.append(str(sn))
    gpu_power.LOOP.cached_out = None
    gpu_power.LOOP.force = True
    try:
        from .routers.cluster import _invalidate_power_cache

        _invalidate_power_cache()
    except Exception:
        pass
    return {"created": created, "updated": updated, "count": created + updated, "serials": racks}


def maybe_sync(db: Session) -> dict[str, Any] | None:
    global _last_sync
    if not cluster_controller.enabled():
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
