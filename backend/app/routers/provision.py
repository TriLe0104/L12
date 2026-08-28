from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import InventoryNode, User
from ..provision import (
    arp_table,
    dhcp_table,
    discover,
    ensure_inventory,
    redfish_probe,
    refresh_sol,
    register_serials,
    serialize,
    start_pxe,
)
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/provision", tags=["provision"])


class RegisterIn(BaseModel):
    serials: list[str]


class IdsIn(BaseModel):
    ids: list[str]


def _payload(db: Session, nodes: list[InventoryNode] | None = None) -> dict:
    if nodes is None:
        nodes = ensure_inventory(db)
    for n in nodes:
        refresh_sol(n)
    db.commit()
    nodes = ensure_inventory(db)
    dhcp = dhcp_table(nodes)
    arp = arp_table(nodes)
    counts: dict[str, int] = {}
    for n in nodes:
        counts[n.provision_status] = counts.get(n.provision_status, 0) + 1
    return {
        "nodes": [serialize(n) for n in nodes],
        "dhcp": dhcp,
        "arp": arp,
        "summary": {
            "nodes": len(nodes),
            "compute": sum(1 for n in nodes if n.kind == "compute"),
            "switches": sum(1 for n in nodes if n.kind != "compute"),
            "mapped_macs": len(arp),
            "leases": len(dhcp),
            "status": counts,
        },
    }


@router.get("")
def get_inventory(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    return _payload(db)


@router.post("/register")
def register(body: RegisterIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    register_serials(db, body.serials)
    discover(db)
    return _payload(db)


@router.post("/discover")
def run_discover(_user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    discover(db)
    return _payload(db)


@router.post("/redfish")
def run_redfish(body: IdsIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    if not body.ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ids required")
    redfish_probe(db, body.ids)
    return _payload(db)


@router.post("/pxe")
def run_pxe(body: IdsIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    if not body.ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "ids required")
    start_pxe(db, body.ids)
    return _payload(db)


@router.get("/nodes/{node_id}/console")
def console(node_id: str, _user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    refresh_sol(node)
    db.commit()
    return {"id": node.id, "name": node.name, "status": node.provision_status, "log": node.sol_log or ""}
