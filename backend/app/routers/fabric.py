from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..fabric import build_fabric, live_traffic
from ..models import DataHall, User
from ..security import get_current_user

router = APIRouter(prefix="/api/fabric", tags=["fabric"])


def _load_fabric(db: Session) -> dict:
    halls = list(
        db.scalars(select(DataHall).options(selectinload(DataHall.racks)).order_by(DataHall.name)).all()
    )
    return build_fabric(halls)


@router.get("")
def get_fabric(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    fabric = _load_fabric(db)
    fabric.pop("ports", None)
    return fabric


@router.get("/ports")
def get_ports(
    hall: str | None = Query(default=None),
    role: str | None = Query(default=None),
    state: str | None = Query(default=None),
    q: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    fabric = _load_fabric(db)
    ports = fabric["ports"]
    if hall:
        ports = [p for p in ports if (p.get("hall_name") or "") == hall]
    if role:
        ports = [p for p in ports if p.get("role") == role]
    if state:
        ports = [p for p in ports if p.get("state") == state]
    if q:
        needle = q.lower()
        ports = [
            p
            for p in ports
            if needle in p["local_system"].lower()
            or needle in p["peer_system"].lower()
            or needle in str(p["local_port"])
        ]
    return {"count": len(ports), "ports": ports[:2000], "summary": fabric["summary"]}


@router.get("/live")
def get_live(
    node: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    fabric = _load_fabric(db)
    traffic = live_traffic(fabric)
    all_links = traffic.pop("all_links", None) or traffic.get("links") or []
    if node:
        traffic["links"] = [
            l
            for l in all_links
            if node in (l.get("from_id"), l.get("to_id"), l.get("from_name"), l.get("to_name"))
        ]
    traffic["summary"] = fabric["summary"]
    return traffic
