"""Saved PXE hosts. Argus on each host is http://host:8000."""

from __future__ import annotations

import threading
import time
import urllib.parse
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .config import settings
from .models import InventoryNode, MaxLpsNode, MaxLpsRack, MaxLpsShelf, PxeServer, _now, _uuid


@dataclass(frozen=True)
class ControllerSource:
    base: str
    pxe_host: str


def normalize_host(raw: str | None) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = "http://" + text
    return (urllib.parse.urlparse(text).hostname or "").strip()


def list_servers(db: Session) -> list[PxeServer]:
    return list(db.scalars(select(PxeServer).order_by(PxeServer.name, PxeServer.host)).all())


def dump_server(row: PxeServer) -> dict[str, str | None]:
    return {
        "id": row.id,
        "name": row.name,
        "host": row.host,
        "username": row.username,
        "password": row.password,
    }


def replace_servers(db: Session, servers: list[dict]) -> list[PxeServer]:
    existing = {row.host.lower(): row for row in list_servers(db)}
    keep: set[str] = set()
    for item in servers:
        host = normalize_host(str(item.get("host") or ""))
        if not host:
            continue
        key = host.lower()
        if key in keep:
            continue
        keep.add(key)
        name = (str(item.get("name") or "").strip() or host)[:120]
        username = (str(item.get("username") or "").strip() or "root")[:80]
        password = str(item.get("password") or "").strip() or None
        row = existing.get(key)
        if row is None:
            row = PxeServer(
                id=(str(item.get("id") or "").strip() or _uuid())[:36],
                name=name,
                host=host,
                username=username,
                password=password,
            )
            db.add(row)
            existing[key] = row
        else:
            row.name = name
            row.username = username
            if password:
                row.password = password
            row.updated_at = _now()
    for key, row in existing.items():
        if key not in keep:
            db.delete(row)
    db.commit()
    return list_servers(db)


def controller_sources(db: Session) -> list[ControllerSource]:
    """Every PXE whose Argus should be read, plus the configured controller."""
    sources: list[ControllerSource] = []
    seen: set[str] = set()

    def add(host: str, base: str) -> None:
        host = normalize_host(host) or normalize_host(base)
        base = (base or "").strip().rstrip("/")
        if not host or not base:
            return
        key = host.lower()
        if key in seen:
            return
        seen.add(key)
        sources.append(ControllerSource(base=base, pxe_host=host))

    for row in list_servers(db):
        host = normalize_host(row.host)
        add(host, f"http://{host}:8000")
    # Hosts already assigned to a rack or node stay in the sync set.
    known = list(db.scalars(select(PxeServer.host)).all())
    known += list(db.scalars(select(InventoryNode.pxe_server)).all())
    known += list(db.scalars(select(MaxLpsRack.pxe_server)).all())
    for raw in known:
        host = normalize_host(raw)
        if host:
            add(host, f"http://{host}:8000")

    configured = (settings.cluster_controller_url or "").strip().rstrip("/")
    if configured:
        host = normalize_host(configured) or normalize_host(settings.cluster_pxe_host)
        key = host.lower()
        if key in seen:
            sources[:] = [
                ControllerSource(base=configured, pxe_host=item.pxe_host) if item.pxe_host.lower() == key else item
                for item in sources
            ]
        else:
            add(host, configured)

    try:
        from . import pxe_hop

        hop = pxe_hop.status()
        hosts = list(hop.get("hosts") or [])
        if not hosts and hop.get("connected") and hop.get("host"):
            hosts = [str(hop.get("host"))]
        for raw in hosts:
            host = normalize_host(str(raw))
            add(host, f"http://{host}:8000")
    except Exception:
        pass
    return sources


_ADDR_PXE: dict[str, tuple[float, str]] = {}
_ADDR_LOCK = threading.Lock()


def pxe_for_address(addr: str, db: Session | None = None) -> str:
    """PXE host that owns this BMC or OS address. Rack assignment wins over the inventory row."""
    ip = (addr or "").strip()
    if not ip:
        return ""
    now = time.monotonic()
    with _ADDR_LOCK:
        hit = _ADDR_PXE.get(ip)
        if hit and now - hit[0] < 30:
            return hit[1]
    own = db is None
    if own:
        from .db import SessionLocal

        db = SessionLocal()
    assert db is not None
    try:
        pxe = ""
        node = db.scalars(
            select(MaxLpsNode).where(or_(MaxLpsNode.bmc_ip == ip, MaxLpsNode.os_ip == ip)).limit(1)
        ).first()
        if node is not None and node.rack is not None:
            pxe = normalize_host(node.rack.pxe_server)
        if not pxe:
            shelf = db.scalars(select(MaxLpsShelf).where(MaxLpsShelf.ip == ip).limit(1)).first()
            if shelf is not None and shelf.rack is not None:
                pxe = normalize_host(shelf.rack.pxe_server)
        if not pxe:
            inv = db.scalars(
                select(InventoryNode).where(or_(InventoryNode.bmc_ip == ip, InventoryNode.os_ip == ip)).limit(1)
            ).first()
            if inv is not None:
                pxe = normalize_host(inv.pxe_server)
    finally:
        if own:
            db.close()
    with _ADDR_LOCK:
        _ADDR_PXE[ip] = (now, pxe)
    return pxe
