from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import InventoryNode, User
from .. import pxe_hop
from ..provision import (
    arp_table,
    dhcp_table,
    discover,
    load_nodes,
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


class HopIn(BaseModel):
    host: str | None = Field(default=None, max_length=120)
    username: str | None = Field(default=None, max_length=80)
    password: str | None = Field(default=None, max_length=200)


def _payload(db: Session, nodes: list[InventoryNode] | None = None) -> dict:
    if nodes is None:
        nodes = load_nodes(db)
    hop = pxe_hop.status()
    for n in nodes:
        if n.source != "argus":
            refresh_sol(n)
    db.commit()
    dhcp = dhcp_table(nodes)
    arp = arp_table(nodes)
    counts: dict[str, int] = {}
    for n in nodes:
        counts[n.provision_status] = counts.get(n.provision_status, 0) + 1
    source = "argus" if any(getattr(n, "source", None) == "argus" for n in nodes) else "demo"
    from .. import provision_argus

    return {
        "source": source,
        "hop": hop,
        "racks": provision_argus.rack_tree(nodes) if source == "argus" else [],
        "nodes": [serialize(n) for n in nodes],
        "dhcp": dhcp,
        "arp": arp,
        "summary": {
            "nodes": len(nodes),
            "compute": sum(1 for n in nodes if n.kind == "compute"),
            "switches": sum(1 for n in nodes if n.kind in ("leaf", "spine")),
            "shelves": sum(1 for n in nodes if n.kind == "power"),
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


@router.get("/hop")
def hop_status(_user: User = Depends(get_current_user)) -> dict:
    return pxe_hop.status()


@router.post("/hop")
def hop_connect(body: HopIn, _user: User = Depends(require_editor)) -> dict:
    try:
        return pxe_hop.connect(body.username, body.password, body.host)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.delete("/hop")
def hop_close(_user: User = Depends(require_editor)) -> dict:
    pxe_hop.close()
    return pxe_hop.status()


@router.get("/nodes/{node_id}/console")
def console(node_id: str, _user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    refresh_sol(node)
    db.commit()
    hop = pxe_hop.status()
    return {
        "id": node.id,
        "name": node.name,
        "status": node.provision_status,
        "log": node.sol_log or "",
        "needs_hop": not hop.get("connected"),
        "hop": hop,
        "bmc_ip": node.bmc_ip,
    }


@router.post("/nodes/{node_id}/find-ip")
def find_ip(node_id: str, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    if not node.bmc_mac:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Node has no BMC MAC")
    hop = pxe_hop.status()
    if not hop.get("connected"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connect to the PXE jump host first")
    try:
        found = pxe_hop.find_ip_for_mac(node.bmc_mac)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    ip = found.get("ip")
    if ip and ip != node.bmc_ip:
        node.bmc_ip = ip
        db.commit()
    return {"id": node.id, "bmc_mac": node.bmc_mac, "bmc_ip": node.bmc_ip, **found}


@router.post("/nodes/{node_id}/kvm")
def open_kvm(node_id: str, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    if getattr(node, "kind", "compute") != "compute":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "KVM is only available on compute node BMCs")
    if not node.bmc_ip:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Node has no BMC IP")
    hop = pxe_hop.status()
    if not hop.get("connected"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connect to the PXE jump host first")
    try:
        from .. import kvm_proxy

        launched = kvm_proxy.start_kvm(node.id, node.bmc_ip, node.bmc_password or "", node.bmc_user)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    path = launched["path"]
    return {
        "id": node.id,
        "name": node.name,
        "bmc_ip": node.bmc_ip,
        "path": path,
        "url": path + "#/console",
        "sol_url": path + "#/console/serial-over-lan",
        "user": launched.get("user") or "ADMIN",
        "via": hop.get("host"),
    }


_KVM_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


@router.api_route("/kvm/{token}", methods=_KVM_METHODS, include_in_schema=False)
@router.api_route("/kvm/{token}/{path:path}", methods=_KVM_METHODS, include_in_schema=False)
async def kvm_http(token: str, request: Request, path: str = "") -> object:
    from .. import kvm_proxy

    body = await request.body()
    headers = {k: v for k, v in request.headers.items()}
    return await asyncio.to_thread(
        kvm_proxy.http_proxy,
        token,
        path,
        request.method,
        request.url.query,
        headers,
        body,
    )


@router.websocket("/kvm/{token}")
@router.websocket("/kvm/{token}/{path:path}")
async def kvm_ws(websocket: WebSocket, token: str, path: str = "") -> None:
    from .. import kvm_proxy

    await kvm_proxy.ws_proxy(websocket, token, path)


@router.post("/sync")
def sync_argus(_user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    from .. import provision_argus

    try:
        provision_argus.sync_from_argus(db, force=True)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return _payload(db)
