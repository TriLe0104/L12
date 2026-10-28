from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import InventoryNode, User
from .. import pxe_hop
from ..provision import (
    add_or_update_node,
    apply_node_fields,
    arp_table,
    commit_enriched,
    dhcp_table,
    discover,
    kick_background_fill,
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


class PxeServerIn(BaseModel):
    id: str | None = Field(default=None, max_length=36)
    name: str = Field(default="", max_length=120)
    host: str = Field(max_length=120)
    username: str = Field(default="root", max_length=80)
    password: str | None = Field(default=None, max_length=200)


class PxeServersIn(BaseModel):
    servers: list[PxeServerIn] = Field(default_factory=list)


class NodeIn(BaseModel):
    bmc_mac: str | None = Field(default=None, max_length=24)
    bmc_user: str | None = Field(default=None, max_length=80)
    bmc_password: str | None = Field(default=None, max_length=200)
    bmc_ip: str | None = Field(default=None, max_length=48)
    os_ip: str | None = Field(default=None, max_length=48)
    os_username: str | None = Field(default=None, max_length=80)
    os_password: str | None = Field(default=None, max_length=200)
    pxe_server: str | None = Field(default=None, max_length=120)
    os_mac: str | None = Field(default=None, max_length=24)
    serial: str | None = Field(default=None, max_length=80)
    name: str | None = Field(default=None, max_length=160)
    kind: str | None = Field(default="compute", max_length=24)
    hall_name: str | None = Field(default=None, max_length=80)


def _payload(db: Session, nodes: list[InventoryNode] | None = None, *, sync: bool = True) -> dict:
    if nodes is None:
        nodes = load_nodes(db, sync=sync)
    hop = pxe_hop.status()
    for n in nodes:
        if (getattr(n, "source", None) or "demo") == "demo":
            refresh_sol(n)
    db.commit()
    kick_background_fill()
    dhcp = dhcp_table(nodes)
    arp = arp_table(nodes)
    counts: dict[str, int] = {}
    for n in nodes:
        counts[n.provision_status] = counts.get(n.provision_status, 0) + 1
    kinds = {getattr(n, "source", None) for n in nodes}
    if "argus" in kinds:
        source = "argus"
    elif "manual" in kinds or "provision" in kinds:
        source = "manual"
    else:
        source = "demo" if nodes else "none"
    from .. import maxlps_inventory as inv
    from .. import provision_argus

    provision_argus.promote_power_shelf_ssh(db)
    trees = provision_argus.rack_tree(nodes) if source != "demo" else []
    seeded = inv.seeded_provision_rack(db)
    if seeded and all(str(tree.get("id")) != seeded["id"] for tree in trees):
        trees.append(seeded)
    return {
        "source": source,
        "hop": hop,
        "racks": trees,
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
def get_inventory(
    sync: bool = True,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return _payload(db, sync=sync)


@router.post("/register")
def register(body: RegisterIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    register_serials(db, body.serials)
    discover(db)
    return _payload(db)


@router.post("/nodes")
def add_node(body: NodeIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    try:
        node, filled, created = add_or_update_node(db, **body.model_dump())
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    out = _payload(db, sync=False)
    out["added"] = serialize(node)
    out["created"] = created
    out["filled"] = filled
    return out


@router.patch("/nodes/{node_id}")
def patch_node(node_id: str, body: NodeIn, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    data = body.model_dump(exclude_unset=True)
    apply_node_fields(db, node, **data)
    if "hall_name" in data:
        try:
            from .. import maxlps_inventory as inv

            inv.ensure_rack_for_node(db, node)
        except Exception:
            pass
    touch = {"bmc_ip", "bmc_mac", "bmc_user", "bmc_password"}
    if touch & set(data):
        filled = commit_enriched(db, node)
    else:
        db.commit()
        db.refresh(node)
        filled = {}
    out = _payload(db, sync=False)
    out["added"] = serialize(node)
    out["filled"] = filled
    return out


@router.post("/nodes/{node_id}/enrich")
def enrich(node_id: str, _user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    filled = commit_enriched(db, node)
    out = _payload(db, sync=False)
    out["added"] = serialize(node)
    out["filled"] = filled
    return out


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
        hop = pxe_hop.connect(body.username, body.password, body.host)
        kick_background_fill()
        return hop
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.get("/pxe-servers")
def list_pxe_servers(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    from .. import pxe_servers

    return {"servers": [pxe_servers.dump_server(row) for row in pxe_servers.list_servers(db)]}


@router.put("/pxe-servers")
def save_pxe_servers(
    body: PxeServersIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    from .. import pxe_servers

    rows = pxe_servers.replace_servers(db, [item.model_dump() for item in body.servers])
    return {"servers": [pxe_servers.dump_server(row) for row in rows]}


@router.post("/hop/check")
def hop_check(body: HopIn, _user: User = Depends(require_editor)) -> dict:
    if not body.host or not body.host.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "PXE host IP is required")
    return pxe_hop.check_reachable(body.host, body.username, body.password)


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
    if not node.bmc_mac and not node.bmc_ip:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Node has no BMC MAC or BMC IP")
    try:
        via = pxe_hop.bind_target(node.bmc_ip or "", node.pxe_server)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    try:
        if node.bmc_mac:
            found = pxe_hop.find_ip_for_mac(node.bmc_mac, via)
            ip = found.get("ip")
            if ip and ip != node.bmc_ip:
                node.bmc_ip = ip
                db.commit()
            return {"id": node.id, "bmc_mac": node.bmc_mac, "bmc_ip": node.bmc_ip, **found}
        found = pxe_hop.find_mac_for_ip(node.bmc_ip or "", via)
        mac = found.get("mac")
        if mac and mac != node.bmc_mac:
            node.bmc_mac = mac
            node.pxe_mac = node.pxe_mac or mac
            db.commit()
        return {"id": node.id, "bmc_mac": node.bmc_mac, "bmc_ip": node.bmc_ip, **found}
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.post("/nodes/{node_id}/kvm")
def open_kvm(
    node_id: str,
    view: str = "kvm",
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    node = db.get(InventoryNode, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    if getattr(node, "kind", "compute") != "compute":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "KVM is only available on compute node BMCs")
    if not node.bmc_ip:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Node has no BMC IP")
    try:
        via = pxe_hop.bind_target(node.bmc_ip, node.pxe_server)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    try:
        from .. import kvm_proxy

        launched = kvm_proxy.start_kvm(node.id, node.bmc_ip, node.bmc_password or "", node.bmc_user, view=view)
    except pxe_hop.NeedsHop as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    path = launched["path"]
    hashes = {"sol": "#/console/serial-over-lan-console", "bmc": "#/", "kvm": "#/console/kvm"}
    dest = hashes.get((view or "kvm").lower(), hashes["kvm"])
    return {
        "id": node.id,
        "name": node.name,
        "bmc_ip": node.bmc_ip,
        "path": path,
        "view": launched.get("view") or view,
        "url": path + dest,
        "sol_url": path + hashes["sol"],
        "bmc_url": path + hashes["bmc"],
        "user": launched.get("user") or "ADMIN",
        "via": via,
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


@router.delete("/racks/{rack_id}")
def delete_rack(
    rack_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict:
    from .. import maxlps_inventory as inv

    removed = inv.remove_operator_rack(db, rack_id)
    if removed is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rack not found")
    out = _payload(db, sync=False)
    out["removed"] = removed
    return out


@router.post("/sync")
def sync_argus(_user: User = Depends(require_editor), db: Session = Depends(get_db)) -> dict:
    from .. import maxlps_inventory

    result = maxlps_inventory.sync_live_infra(db, force=True) or {}
    errors = [str(item) for item in (result.get("errors") or [])]
    ok = list(result.get("ok_pxes") or [])
    if errors and not ok:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "; ".join(errors))
    out = _payload(db, sync=False)
    if errors:
        out["sync_errors"] = errors
    out["synced_pxes"] = ok
    return out
