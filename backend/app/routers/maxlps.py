"""MaxLPS hardware inventory and wattage history."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import maxlps_inventory as inv
from ..db import get_db
from ..models import MaxLpsGpu, MaxLpsNode, MaxLpsRack, MaxLpsShelf, User
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/maxlps", tags=["maxlps"])


class RackCreateIn(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    serial: str | None = Field(default=None, max_length=80)
    hall: str | None = Field(default=None, max_length=80)
    notes: str | None = None
    model: str | None = Field(default="GB300-NVL72", max_length=80)


class RackPatchIn(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    serial: str | None = None
    hall: str | None = None
    notes: str | None = None
    model: str | None = None
    enabled: bool | None = None
    power_state: str | None = None


class NodePatchIn(BaseModel):
    serial: str | None = None
    hostname: str | None = None
    bmc_mac: str | None = None
    bmc_ip: str | None = None
    bmc_user: str | None = None
    bmc_password: str | None = None
    os_mac: str | None = None
    os_ip: str | None = None


class ShelfPatchIn(BaseModel):
    serial: str | None = None
    ip: str | None = None
    mac: str | None = None
    user: str | None = None
    password: str | None = None
    model: str | None = None


class GpuPatchIn(BaseModel):
    serial: str | None = None
    uuid: str | None = None
    pci_addr: str | None = None
    model: str | None = None
    tdp_w: float | None = Field(default=None, ge=50, le=2000)


@router.get("/schema")
def inventory_schema(_user: User = Depends(get_current_user)) -> dict:
    return inv.schema_guide()


@router.post("/sync")
def sync_inventory(_user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    try:
        result = inv.sync_from_controller(db)
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    racks = [inv.dump_rack(r, secrets=True) for r in inv.load_racks(db)]
    return {"ok": True, **result, "racks": racks, "count": len(racks), "source": "inventory" if racks else "floor"}


@router.get("/inventory")
def list_inventory(
    sync: bool = Query(default=False),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if sync:
        inv.maybe_sync(db)
    racks = [inv.dump_rack(r, secrets=True) for r in inv.load_racks(db)]
    return {
        "source": "inventory" if racks else "floor",
        "count": len(racks),
        "racks": racks,
        "layout": {
            "nodes_per_rack": inv.NODES,
            "gpus_per_node": inv.GPUS,
            "shelves_per_rack": inv.SHELVES,
            "gpus_per_rack": inv.NODES * inv.GPUS,
            "model": "GB300-NVL72",
        },
    }


@router.post("/racks", status_code=status.HTTP_201_CREATED)
def create_rack(
    body: RackCreateIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    try:
        rack = inv.create_rack(
            db,
            label=body.label,
            serial=body.serial,
            hall=body.hall,
            notes=body.notes,
            model=body.model,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return inv.dump_rack(rack, secrets=True)


@router.patch("/racks/{rack_id}")
def patch_rack(
    rack_id: str,
    body: RackPatchIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    rack = inv.get_rack(db, rack_id)
    if rack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MaxLPS rack not found")
    try:
        rack = inv.patch_rack(db, rack, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return inv.dump_rack(rack, secrets=True)


@router.delete("/racks/{rack_id}")
def delete_rack(
    rack_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    if not inv.delete_rack(db, rack_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MaxLPS rack not found")
    return {"ok": True, "id": rack_id}


@router.patch("/nodes/{node_id}")
def patch_node(
    node_id: str,
    body: NodePatchIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    node = db.get(MaxLpsNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    node = inv.patch_node(db, node, body.model_dump(exclude_unset=True))
    return inv.dump_node(node, secrets=True)


@router.patch("/shelves/{shelf_id}")
def patch_shelf(
    shelf_id: str,
    body: ShelfPatchIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    shelf = db.get(MaxLpsShelf, shelf_id)
    if shelf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Power shelf not found")
    shelf = inv.patch_shelf(db, shelf, body.model_dump(exclude_unset=True))
    return inv.dump_shelf(shelf, secrets=True)


@router.patch("/gpus/{gpu_id}")
def patch_gpu(
    gpu_id: str,
    body: GpuPatchIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    gpu = db.get(MaxLpsGpu, gpu_id)
    if gpu is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "GPU not found")
    gpu = inv.patch_gpu(db, gpu, body.model_dump(exclude_unset=True))
    return inv.dump_gpu(gpu)


@router.get("/watts")
def list_cluster_watts(
    since: datetime | None = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=20000),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return {"samples": inv.cluster_watts(db, since=since, limit=limit)}


@router.get("/watts/racks/{rack_id}")
def list_rack_watts(
    rack_id: str,
    since: datetime | None = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=20000),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if db.get(MaxLpsRack, rack_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MaxLPS rack not found")
    return {"rack_id": rack_id, "samples": inv.rack_watts(db, rack_id, since=since, limit=limit)}
