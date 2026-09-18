from __future__ import annotations

import hashlib
import json
import math
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from pydantic import BaseModel, Field

from ..db import get_db
from ..fabric import live_traffic, build_fabric
from ..models import DataHall, Device, Rack, Role, User, Workload, has_rank
from .. import gpu_power, power_limit
from ..schemas import (
    CampusOut,
    ClusterOverview,
    DeviceCreate,
    DeviceOut,
    DeviceUpdate,
    HallCampus,
    HallCreate,
    HallDetail,
    HallOut,
    HallUpdate,
    RackBulkCreate,
    RackBulkPatch,
    RackCreate,
    RackOut,
    RackUpdate,
    TelemetryOut,
)
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/cluster", tags=["cluster"])


def _hall_out(hall: DataHall, rack_count: int | None = None) -> HallOut:
    return HallOut(
        id=hall.id,
        name=hall.name,
        description=hall.description,
        width_tiles=hall.width_tiles,
        depth_tiles=hall.depth_tiles,
        created_at=hall.created_at,
        updated_at=hall.updated_at,
        rack_count=rack_count if rack_count is not None else len(hall.racks),
    )


def _require_hall(db: Session, hall_id: str) -> DataHall:
    hall = db.get(DataHall, hall_id)
    if hall is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Data hall not found")
    return hall


def _require_rack(db: Session, rack_id: str) -> Rack:
    rack = db.get(Rack, rack_id)
    if rack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rack not found")
    return rack


def _occupied(db: Session, hall_id: str, x: int, y: int, ignore_id: str | None = None) -> bool:
    q = select(Rack.id).where(Rack.hall_id == hall_id, Rack.x == x, Rack.y == y)
    if ignore_id:
        q = q.where(Rack.id != ignore_id)
    return db.scalar(q) is not None


RACK_TDP_KW = 120.0  # GB300 liquid-cooled rack, demo nameplate
GPUS_PER_RACK = gpu_power.GPUS_PER_RACK
NODES_PER_RACK = gpu_power.NODES_PER_RACK
CLUSTER_NAME = "Firmus"


def _usage(rack: Rack) -> tuple[float, float, float, float]:
    """Stable fake telemetry: cpu, gpu, mem, power %."""
    if getattr(rack, "power_state", "on") == "off":
        return 0.0, 0.0, 0.0, 0.0
    seed = int(hashlib.md5(rack.id.encode()).hexdigest()[:8], 16)
    span = (seed % 1000) / 1000.0
    status = getattr(rack, "run_status", "ready") or "ready"
    if status == "idle":
        return (
            round(2 + span * 7, 1),
            round(span * 3, 1),
            round(8 + span * 10, 1),
            round(12 + span * 10, 1),
        )
    if status == "running":
        return (
            round(58 + span * 36, 1),
            round(62 + span * 37, 1),
            round(55 + span * 35, 1),
            round(72 + span * 24, 1),
        )
    return (
        round(10 + span * 18, 1),
        round(6 + span * 16, 1),
        round(18 + span * 22, 1),
        round(32 + span * 16, 1),
    )


def serialize_rack(rack: Rack, *, include_devices: bool = True) -> RackOut:
    cpu, gpu, mem, power = _usage(rack)
    devices = []
    if include_devices:
        devices = sorted(getattr(rack, "devices", []) or [], key=lambda d: (-d.u_start, d.name))
    return RackOut(
        id=rack.id,
        hall_id=rack.hall_id,
        name=rack.name,
        x=rack.x,
        y=rack.y,
        rotation=rack.rotation,
        height_u=rack.height_u,
        notes=rack.notes,
        power_state=getattr(rack, "power_state", None) or "on",
        run_status=getattr(rack, "run_status", None) or "ready",
        cpu_pct=cpu,
        gpu_pct=gpu,
        mem_pct=mem,
        power_pct=power,
        power_kw=round(power / 100.0 * RACK_TDP_KW, 2) if power else 0.0,
        created_at=rack.created_at,
        updated_at=rack.updated_at,
        devices=[DeviceOut.model_validate(d) for d in devices],
    )


def telemetry_for(racks: list[Rack]) -> TelemetryOut:
    if not racks:
        return TelemetryOut(cpu_pct=0, gpu_pct=0, mem_pct=0, power_kw=0, racks_on=0, racks_total=0)
    on = [r for r in racks if (getattr(r, "power_state", None) or "on") != "off"]
    power_kw = 0.0
    cpu = gpu = mem = 0.0
    for r in racks:
        c, g, m, p = _usage(r)
        power_kw += p / 100.0 * RACK_TDP_KW
        cpu += c
        gpu += g
        mem += m
    denom = len(on) or 1
    return TelemetryOut(
        cpu_pct=round(cpu / denom, 1),
        gpu_pct=round(gpu / denom, 1),
        mem_pct=round(mem / denom, 1),
        power_kw=round(power_kw, 1),
        racks_on=len(on),
        racks_total=len(racks),
    )


@router.get("/overview", response_model=ClusterOverview)
def overview(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ClusterOverview:
    halls = db.scalar(select(func.count()).select_from(DataHall)) or 0
    racks = db.scalar(select(func.count()).select_from(Rack)) or 0
    devices = list(db.scalars(select(Device)).all())
    rack_rows = list(db.scalars(select(Rack)).all())
    total_u = sum(r.height_u for r in rack_rows)
    occupied_u = sum(d.u_height for d in devices if d.kind != "empty")
    status_counts = {"healthy": 0, "warning": 0, "critical": 0, "offline": 0, "empty": 0}
    resources = {"compute": 0, "switch": 0, "power": 0, "empty": 0}
    rack_power = {"on": 0, "off": 0}
    rack_run = {"idle": 0, "running": 0, "ready": 0}
    for r in rack_rows:
        ps = getattr(r, "power_state", None) or "on"
        rs = getattr(r, "run_status", None) or "ready"
        rack_power[ps] = rack_power.get(ps, 0) + 1
        if ps == "off":
            rack_run["idle"] = rack_run.get("idle", 0) + 1
        else:
            rack_run[rs] = rack_run.get(rs, 0) + 1
    checks: list[dict] = []
    for d in devices:
        status_counts[d.status] = status_counts.get(d.status, 0) + 1
        resources[d.kind] = resources.get(d.kind, 0) + 1
        if d.check_value:
            checks.append(
                {
                    "entity": d.name,
                    "name": d.kind,
                    "value": d.check_value,
                    "last_check": d.last_check_at.isoformat() if d.last_check_at else None,
                    "status": d.status,
                }
            )
    checks.sort(key=lambda c: c["entity"])
    pct = round((occupied_u / total_u) * 100, 1) if total_u else 0.0
    tel = telemetry_for(rack_rows)
    return ClusterOverview(
        name=CLUSTER_NAME,
        halls=halls,
        racks=racks,
        devices=len(devices),
        occupied_u=occupied_u,
        total_u=total_u,
        utilization_pct=pct,
        cpu_pct=tel.cpu_pct,
        gpu_pct=tel.gpu_pct,
        mem_pct=tel.mem_pct,
        power_kw=tel.power_kw,
        device_status=status_counts,
        resources=resources,
        rack_power=rack_power,
        rack_run=rack_run,
        health_checks=checks[:40],
    )


METRIC_SPANS = {
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 3600,
    "6h": 6 * 3600,
    "24h": 86400,
    "7d": 7 * 86400,
}


@router.get("/metrics")
def metrics(
    span: str = Query(default="5m", alias="range"),
    from_ts: float | None = Query(default=None),
    to_ts: float | None = Query(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    rack_rows = list(db.scalars(select(Rack)).all())
    tel = telemetry_for(rack_rows)
    nameplate = max(1.0, len(rack_rows) * RACK_TDP_KW)
    def _on(r: Rack) -> bool:
        return (getattr(r, "power_state", "on") or "on") != "off"

    running = [r for r in rack_rows if _on(r) and (getattr(r, "run_status", None) or "ready") == "running"]
    ready = [r for r in rack_rows if _on(r) and (getattr(r, "run_status", None) or "ready") == "ready"]
    idle = [r for r in rack_rows if _on(r) and (getattr(r, "run_status", None) or "ready") == "idle"]
    off = [r for r in rack_rows if not _on(r)]
    works = list(db.scalars(select(Workload).where(Workload.status == "running").order_by(Workload.started_at.desc())).all())
    work = works[0] if works else None
    halls = list(db.scalars(select(DataHall).options(selectinload(DataHall.racks)).order_by(DataHall.name)).all())
    fabric = build_fabric(halls)
    traffic = live_traffic(fabric)

    now = time.time()
    if from_ts is not None and to_ts is not None and to_ts > from_ts:
        start, end = float(from_ts), float(to_ts)
        span_key = "custom"
    else:
        window = METRIC_SPANS.get(span, METRIC_SPANS["5m"])
        end = now
        start = now - window
        span_key = span if span in METRIC_SPANS else "5m"
    points = 48
    step = max(1.0, (end - start) / (points - 1))
    series = []
    for i in range(points):
        t = start + i * step
        wobble = 0.04 * math.sin(t / 18.0) + 0.025 * math.sin(t / 7.3)
        cpu = max(0.4, min(99.0, tel.cpu_pct * (1 + wobble)))
        gpu = max(0.4, min(99.0, tel.gpu_pct * (1 + wobble * 1.15)))
        mem = max(1.0, min(99.0, tel.mem_pct * (1 + wobble * 0.6)))
        power = max(0.0, tel.power_kw * (1 + wobble * 0.35))
        tx = traffic["total_tx_gbps"] * (0.92 + 0.08 * math.sin(t / 11.0 + i * 0.1))
        rx = traffic["total_rx_gbps"] * (0.90 + 0.10 * math.sin(t / 13.0 + i * 0.13))
        disk = max(8.0, min(92.0, 36.5 + 6.0 * math.sin(t / 22.0) + 2.2 * math.sin(t / 9.4)))
        disk_r = 1.8 + 0.7 * (1 + math.sin(t / 8.0 + i * 0.2))
        disk_w = 1.1 + 0.55 * (1 + math.sin(t / 10.5 + i * 0.17))
        series.append(
            {
                "t": t,
                "cpu": round(cpu, 2),
                "gpu": round(gpu, 2),
                "mem": round(mem, 2),
                "power_kw": round(power, 1),
                "tx_gbps": round(tx, 1),
                "rx_gbps": round(rx, 1),
                "disk_pct": round(disk, 2),
                "disk_read_gbs": round(disk_r, 2),
                "disk_write_gbs": round(disk_w, 2),
            }
        )
    last = series[-1]
    gpus = len(rack_rows) * GPUS_PER_RACK
    disk_tb = round(len(rack_rows) * 30.72, 1)
    on_racks = len(running) + len(ready) + len(idle)
    leaves = sum(1 for n in fabric["nodes"] if n["role"] == "leaf")
    spines = sum(1 for n in fabric["nodes"] if n["role"] == "spine")
    fab_sum = fabric.get("summary") or {}
    return {
        "name": CLUSTER_NAME,
        "now": {
            "cpu_pct": last["cpu"],
            "gpu_pct": last["gpu"],
            "mem_pct": last["mem"],
            "power_kw": last["power_kw"],
            "power_pct": round(last["power_kw"] / nameplate * 100, 1),
            "tx_gbps": last["tx_gbps"],
            "rx_gbps": last["rx_gbps"],
            "disk_pct": last["disk_pct"],
            "disk_read_gbs": last["disk_read_gbs"],
            "disk_write_gbs": last["disk_write_gbs"],
        },
        "series": series,
        "size": {
            "halls": len(halls),
            "racks": len(rack_rows),
            "gpus": gpus,
            "nameplate_kw": nameplate,
            "cols": 16,
            "rows": 4,
            "racks_on": on_racks,
            "compute_nodes": len(rack_rows) * NODES_PER_RACK,
            "compute_on": on_racks * NODES_PER_RACK,
            "spines": spines,
            "leaves": leaves,
            "switches": spines + leaves,
            "active_links": traffic.get("active_links", 0),
            "active_ports": fab_sum.get("active_ports", 0),
            "total_ports": fab_sum.get("total_ports", 0),
            "speed": fab_sum.get("speed", "800 Gbps"),
        },
        "nodes": {
            "total": len(rack_rows),
            "active": len(running),
            "ready": len(ready),
            "idle": len(idle),
            "off": len(off),
            "compute_total": len(rack_rows) * NODES_PER_RACK,
            "compute_on": on_racks * NODES_PER_RACK,
        },
        "workload": None
        if work is None
        else {
            "id": work.id,
            "name": work.name,
            "kind": work.kind,
            "status": work.status,
            "gpu_allocation": work.gpu_allocation,
            "pods_running": work.pods_running,
            "gpu_request": work.gpu_request,
        },
        "workloads_running": [
            {"name": w.name, "kind": w.kind, "gpu_allocation": w.gpu_allocation}
            for w in works[:4]
        ],
        "gpu_used": round(gpus * last["gpu"] / 100.0),
        "cpu_cores": len(rack_rows) * 144,
        "mem_tb": round(len(rack_rows) * 2.3, 1),
        "disk_tb": disk_tb,
        "disk_used_tb": round(disk_tb * last["disk_pct"] / 100.0, 1),
        "range": span_key,
        "from_ts": start,
        "to_ts": end,
    }


class PowerPatch(BaseModel):
    mode: str | None = None
    budget_kw: float | None = Field(default=None, ge=0)
    auto_budget: bool | None = None
    reset: bool = False
    max_rack_kw: float | None = Field(default=None, ge=20, le=2000)
    max_hall_kw: float | None = Field(default=None, ge=1000, le=135000)
    max_pod_kw: float | None = Field(default=None, ge=5, le=500)
    stay_under_pct: float | None = Field(default=None, ge=10, le=100)
    total_budget_kw: float | None = Field(default=None, ge=100, le=10_000_000)
    rack_count: int | None = Field(default=None, ge=1, le=2000)
    min_rack_kw: float | None = Field(default=None, ge=8, le=2000)
    interval_s: float | None = Field(default=None, ge=1, le=300)
    gpu_power_percent: float | None = Field(default=None, ge=10, le=100)
    desired_cap_percent: float | None = Field(default=None, ge=10, le=100)
    gpu_min_w: float | None = Field(default=None, ge=50, le=2000)
    gpu_max_w: float | None = Field(default=None, ge=50, le=2000)


def _power_samples(rack_rows: list[Rack], workloads: list[Workload] | None = None) -> list[dict]:
    hot = power_limit.pick_hot_ids(rack_rows, workloads or [])
    share = power_limit.rack_policy_kw()
    rows = []
    for r in rack_rows:
        _cpu, _gpu, _mem, power = _usage(r)
        rows.append(
            {
                "id": r.id,
                "name": r.name,
                "hall_id": r.hall_id,
                "power_state": getattr(r, "power_state", None) or "on",
                "run_status": getattr(r, "run_status", None) or "ready",
                "demand_kw": round(power / 100.0 * share, 2) if power else 0.0,
                "saturating": r.id in hot,
            }
        )
    return rows


def _running_workloads(db: Session) -> list[Workload]:
    return list(db.scalars(select(Workload).where(Workload.status == "running")).all())


_POWER_CACHE: tuple[float, dict, list] | None = None


def _invalidate_power_cache() -> None:
    global _POWER_CACHE
    _POWER_CACHE = None


def _maxlps_inputs(db: Session) -> tuple[dict, list]:
    """Reuse the limiter snapshot for ~1s so MaxLPS polls skip SQLite."""
    global _POWER_CACHE
    now = time.time()
    if _POWER_CACHE and now - _POWER_CACHE[0] < 1.0:
        return _POWER_CACHE[1], _POWER_CACHE[2]
    rack_rows = list(db.scalars(select(Rack).order_by(Rack.name)).all())
    works = _running_workloads(db)
    snap = power_limit.snapshot(_power_samples(rack_rows, works))
    jobs = [
        {"id": w.id, "name": w.name, "kind": w.kind, "status": w.status, "gpu_allocation": w.gpu_allocation}
        for w in works
    ]
    _POWER_CACHE = (now, snap, jobs)
    return snap, jobs


def _json(data: dict) -> Response:
    return Response(content=json.dumps(data, separators=(",", ":")), media_type="application/json")


@router.get("/power")
def power_limiter(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    rack_rows = list(db.scalars(select(Rack).order_by(Rack.name)).all())
    return power_limit.snapshot(_power_samples(rack_rows, _running_workloads(db)))


@router.get("/maxlps")
def maxlps_view(
    top: int = Query(default=0, ge=0, le=30000),
    rack_id: str | None = Query(default=None),
    gpu_id: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    snap, jobs = _maxlps_inputs(db)
    return _json(gpu_power.snapshot(snap, top=top, rack_id=rack_id, gpu_id=gpu_id, workloads=jobs))


class GpuBoundPatch(BaseModel):
    min_w: float | None = Field(default=None, ge=50, le=2000)
    max_w: float | None = Field(default=None, ge=50, le=2000)


@router.get("/maxlps/gpus/{gpu_id}/curve")
def maxlps_gpu_curve(gpu_id: str, _user: User = Depends(get_current_user)) -> dict:
    return gpu_power.watch_curve(gpu_id)


@router.patch("/maxlps/gpus/{gpu_id}")
def patch_gpu_bounds(
    gpu_id: str,
    payload: GpuBoundPatch,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if payload.min_w is None and payload.max_w is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "min_w or max_w required")
    gpu_power.set_bounds(gpu_id, min_w=payload.min_w, max_w=payload.max_w)
    _invalidate_power_cache()
    snap, jobs = _maxlps_inputs(db)
    return _json(gpu_power.snapshot(snap, top=0, gpu_id=gpu_id, workloads=jobs))


@router.patch("/power")
def patch_power_limiter(
    payload: PowerPatch,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if payload.mode is not None and payload.mode not in ("static", "dynamic"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "mode must be static or dynamic")
    power_limit.apply_patch(
        mode=payload.mode,
        budget_kw=payload.budget_kw,
        reset=payload.reset,
        auto_budget_flag=bool(payload.auto_budget),
        max_rack_kw=payload.max_rack_kw,
        max_hall_kw=payload.max_hall_kw,
        max_pod_kw=payload.max_pod_kw,
        stay_under_pct=payload.stay_under_pct,
        total_budget_kw=payload.total_budget_kw,
        rack_count=payload.rack_count,
        min_rack_kw=payload.min_rack_kw,
    )
    gpu_power.apply_loop(
        interval_s=payload.interval_s,
        gpu_power_percent=payload.gpu_power_percent,
        desired_cap_percent=payload.desired_cap_percent,
        gpu_min_w=payload.gpu_min_w,
        gpu_max_w=payload.gpu_max_w,
    )
    if (
        payload.total_budget_kw is not None
        or payload.stay_under_pct is not None
        or payload.reset
        or payload.interval_s is not None
        or payload.gpu_power_percent is not None
        or payload.desired_cap_percent is not None
        or payload.gpu_min_w is not None
        or payload.gpu_max_w is not None
    ):
        gpu_power.LOOP.force = True
        gpu_power.LOOP.last_caps = None
    _invalidate_power_cache()
    rack_rows = list(db.scalars(select(Rack).order_by(Rack.name)).all())
    return power_limit.snapshot(_power_samples(rack_rows, _running_workloads(db)))


@router.get("/campus", response_model=CampusOut)
def campus(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> CampusOut:
    halls = list(
        db.scalars(select(DataHall).options(selectinload(DataHall.racks)).order_by(DataHall.name)).all()
    )
    hall_payload: list[HallCampus] = []
    all_racks: list[Rack] = []
    for hall in halls:
        all_racks.extend(hall.racks)
        hall_payload.append(
            HallCampus(
                **_hall_out(hall, len(hall.racks)).model_dump(),
                telemetry=telemetry_for(hall.racks),
                racks=[serialize_rack(r, include_devices=False) for r in hall.racks],
            )
        )
    return CampusOut(name=CLUSTER_NAME, telemetry=telemetry_for(all_racks), halls=hall_payload)


@router.get("/halls", response_model=list[HallOut])
def list_halls(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[HallOut]:
    rows = db.execute(
        select(DataHall, func.count(Rack.id))
        .outerjoin(Rack, Rack.hall_id == DataHall.id)
        .group_by(DataHall.id)
        .order_by(DataHall.name)
    ).all()
    return [_hall_out(hall, count) for hall, count in rows]


@router.post("/halls", response_model=HallDetail, status_code=status.HTTP_201_CREATED)
def create_hall(
    payload: HallCreate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> HallDetail:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
    hall = DataHall(
        name=name,
        description=(payload.description or "").strip() or None,
        width_tiles=max(4, min(payload.width_tiles, 64)),
        depth_tiles=max(4, min(payload.depth_tiles, 64)),
    )
    db.add(hall)
    db.commit()
    db.refresh(hall)
    return HallDetail(**_hall_out(hall, 0).model_dump(), racks=[])


@router.get("/halls/{hall_id}", response_model=HallDetail)
def get_hall(
    hall_id: str,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> HallDetail:
    hall = db.scalar(
        select(DataHall)
        .options(selectinload(DataHall.racks).selectinload(Rack.devices))
        .where(DataHall.id == hall_id)
    )
    if hall is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Data hall not found")
    out_racks = [serialize_rack(r) for r in hall.racks]
    return HallDetail(**_hall_out(hall, len(out_racks)).model_dump(), racks=out_racks)


@router.patch("/halls/{hall_id}", response_model=HallOut)
def update_hall(
    hall_id: str,
    payload: HallUpdate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> HallOut:
    hall = _require_hall(db, hall_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
        hall.name = name
    if "description" in data:
        hall.description = (data["description"] or "").strip() or None
    if "width_tiles" in data and data["width_tiles"] is not None:
        hall.width_tiles = max(4, min(data["width_tiles"], 64))
    if "depth_tiles" in data and data["depth_tiles"] is not None:
        hall.depth_tiles = max(4, min(data["depth_tiles"], 64))
    db.commit()
    db.refresh(hall)
    count = db.scalar(select(func.count()).select_from(Rack).where(Rack.hall_id == hall.id)) or 0
    return _hall_out(hall, count)


@router.delete("/halls/{hall_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_hall(
    hall_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
):
    hall = _require_hall(db, hall_id)
    db.delete(hall)
    db.commit()


@router.post("/halls/{hall_id}/racks", response_model=RackOut, status_code=status.HTTP_201_CREATED)
def create_rack(
    hall_id: str,
    payload: RackCreate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> RackOut:
    hall = _require_hall(db, hall_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
    if not (0 <= payload.x < hall.width_tiles and 0 <= payload.y < hall.depth_tiles):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Position is outside the hall")
    if _occupied(db, hall.id, payload.x, payload.y):
        raise HTTPException(status.HTTP_409_CONFLICT, "A rack already occupies that tile")
    rack = Rack(
        hall_id=hall.id,
        name=name,
        x=payload.x,
        y=payload.y,
        rotation=payload.rotation % 360,
        height_u=max(1, min(payload.height_u, 60)),
        notes=payload.notes,
    )
    db.add(rack)
    db.commit()
    db.refresh(rack)
    return serialize_rack(rack)


@router.post("/halls/{hall_id}/racks/bulk", response_model=list[RackOut], status_code=status.HTTP_201_CREATED)
def bulk_create_racks(
    hall_id: str,
    payload: RackBulkCreate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> list[RackOut]:
    hall = _require_hall(db, hall_id)
    cols = max(1, min(int(payload.cols), 32))
    rows = max(1, min(int(payload.rows), 32))
    want = cols * rows if payload.count is None else int(payload.count)
    want = max(1, min(want, cols * rows))
    prefix = (payload.prefix or hall.name).strip() or hall.name
    step_y = 2 if payload.aisle else 1
    hall.width_tiles = max(hall.width_tiles, cols + 2)
    hall.depth_tiles = max(hall.depth_tiles, 1 + (rows - 1) * step_y + 2)
    taken = {
        (r.x, r.y)
        for r in db.scalars(select(Rack).where(Rack.hall_id == hall.id)).all()
    }
    created: list[Rack] = []
    n = 0
    for row in range(rows):
        for col in range(cols):
            if n >= want:
                break
            x = 1 + col
            y = 1 + row * step_y
            if not (0 <= x < hall.width_tiles and 0 <= y < hall.depth_tiles):
                continue
            if (x, y) in taken:
                continue
            rack = Rack(
                hall_id=hall.id,
                name=f"{prefix}-R{row + 1:02d}C{col + 1:02d}",
                x=x,
                y=y,
                rotation=180 if row % 2 == 0 else 0,
                height_u=48,
                notes="GB300",
            )
            db.add(rack)
            taken.add((x, y))
            created.append(rack)
            n += 1
        if n >= want:
            break
    db.commit()
    for rack in created:
        db.refresh(rack)
    return [serialize_rack(r, include_devices=False) for r in created]


@router.post("/racks/bulk")
def bulk_patch_racks(
    payload: RackBulkPatch,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    ids = list(dict.fromkeys(payload.ids))
    if payload.delete:
        n = 0
        for rid in ids:
            rack = db.get(Rack, rid)
            if rack is None:
                continue
            db.delete(rack)
            n += 1
        db.commit()
        return {"deleted": n}
    out: list[RackOut] = []
    for rid in ids:
        rack = db.get(Rack, rid)
        if rack is None:
            continue
        if payload.power_state in ("on", "off"):
            rack.power_state = payload.power_state
            if payload.power_state == "off":
                rack.run_status = "idle"
        if payload.run_status in ("idle", "running", "ready") and rack.power_state != "off":
            rack.run_status = payload.run_status
        out.append(serialize_rack(rack, include_devices=False))
    db.commit()
    return {"racks": [r.model_dump() for r in out]}


@router.get("/racks/{rack_id}", response_model=RackOut)
def get_rack(
    rack_id: str,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RackOut:
    rack = db.scalar(select(Rack).options(selectinload(Rack.devices)).where(Rack.id == rack_id))
    if rack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rack not found")
    return serialize_rack(rack)


@router.patch("/racks/{rack_id}", response_model=RackOut)
def update_rack(
    rack_id: str,
    payload: RackUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RackOut:
    if not has_rank(user.role, Role.MANAGER):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires Manager or above")
    rack = db.scalar(
        select(Rack).options(selectinload(Rack.devices), selectinload(Rack.hall)).where(Rack.id == rack_id)
    )
    if rack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rack not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
        rack.name = name
    x = data.get("x", rack.x)
    y = data.get("y", rack.y)
    if x != rack.x or y != rack.y:
        hall = rack.hall
        if not (0 <= x < hall.width_tiles and 0 <= y < hall.depth_tiles):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Position is outside the hall")
        if _occupied(db, hall.id, x, y, ignore_id=rack.id):
            raise HTTPException(status.HTTP_409_CONFLICT, "A rack already occupies that tile")
        rack.x = x
        rack.y = y
    if "rotation" in data and data["rotation"] is not None:
        rack.rotation = data["rotation"] % 360
    if "height_u" in data and data["height_u"] is not None:
        rack.height_u = max(1, min(data["height_u"], 60))
    if "notes" in data:
        rack.notes = data["notes"]
    if "power_state" in data and data["power_state"] in ("on", "off"):
        rack.power_state = data["power_state"]
        if rack.power_state == "off":
            rack.run_status = "idle"
        elif rack.run_status == "idle":
            rack.run_status = "ready"
    if "run_status" in data and data["run_status"] in ("idle", "running", "ready"):
        rack.run_status = data["run_status"]
        if rack.run_status != "idle":
            rack.power_state = "on"
    db.commit()
    rack = db.scalar(select(Rack).options(selectinload(Rack.devices)).where(Rack.id == rack_id))
    assert rack is not None
    return serialize_rack(rack)


@router.delete("/racks/{rack_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rack(
    rack_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
):
    rack = _require_rack(db, rack_id)
    db.delete(rack)
    db.commit()


@router.post("/racks/{rack_id}/devices", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
def create_device(
    rack_id: str,
    payload: DeviceCreate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> DeviceOut:
    rack = _require_rack(db, rack_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name is required")
    device = Device(
        rack_id=rack.id,
        name=name,
        kind=payload.kind,
        status=payload.status,
        u_start=payload.u_start,
        u_height=max(1, payload.u_height),
        last_check_at=datetime.now(timezone.utc),
        check_value=payload.check_value,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return DeviceOut.model_validate(device)


@router.patch("/devices/{device_id}", response_model=DeviceOut)
def update_device(
    device_id: str,
    payload: DeviceUpdate,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> DeviceOut:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(device, key, value)
    device.last_check_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(device)
    return DeviceOut.model_validate(device)


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_device(
    device_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    db.delete(device)
    db.commit()
