"""SPM lookup, DHCP/ARP discovery, PXE provision, and SOL console — demo fabric.

SPM is not on this host. Serials are resolved into BMC MAC + password from a
stable hash, then DHCP/ARP/Redfish are simulated the same way so the UI can
run the full register → discover → PXE → SOL path.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import DataHall, InventoryNode, Rack
from . import provision_argus
from . import pxe_hop

STATUSES = ("registered", "dhcp", "pxe", "imaging", "sol", "ready", "failed")


def _hid(text: str, n: int = 12) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:n]


def mac_from(seed: str, tag: int) -> str:
    h = hashlib.md5(f"{seed}:{tag}".encode()).hexdigest()
    parts = [h[i : i + 2] for i in range(0, 12, 2)]
    oui = ["3c", "6d", "66"] if tag == 0 else ["0c", "42", "a1"] if tag == 1 else ["7c", "c2", "55"]
    return ":".join(oui + parts[:3])


def serial_for_rack(rack: Rack) -> str:
    return f"SN-{rack.name}"


def serial_for_switch(name: str) -> str:
    return f"SN-{name}"


def spm_lookup(serial: str) -> dict:
    h = _hid(serial, 8)
    return {
        "serial": serial.strip().upper() if serial.startswith("SN-") is False and serial.isupper() else serial.strip(),
        "bmc_mac": mac_from(serial, 0),
        "os_mac": mac_from(serial, 1),
        "pxe_mac": mac_from(serial, 1),
        "switch_mac": mac_from(serial, 2),
        "bmc_password": f"Supermicro!{h[:4].upper()}",
        "model": "GB300-NVL72" if "SP-" not in serial and "-LF-" not in serial else "QM9700",
    }


def _octet(seed: str, lo: int = 2, hi: int = 250) -> int:
    return lo + (int(_hid(seed, 6), 16) % (hi - lo))


def assign_ips(serial: str, hall_i: int, idx: int, kind: str) -> tuple[str | None, str | None]:
    if kind == "spine":
        return f"172.16.0.{10 + idx}", None
    if kind == "leaf":
        return f"172.16.{hall_i + 1}.{20 + idx}", None
    bmc = f"172.31.{hall_i + 1}.{10 + (idx % 240)}"
    os_ip = f"10.20.{hall_i + 1}.{10 + (idx % 240)}"
    return bmc, os_ip


def ensure_inventory(db: Session) -> list[InventoryNode]:
    existing = list(db.scalars(select(InventoryNode)).all())
    by_serial = {n.serial: n for n in existing}
    halls = list(db.scalars(select(DataHall)).all())
    hall_i = {h.id: i for i, h in enumerate(sorted(halls, key=lambda h: h.name))}
    created = False

    racks = list(db.scalars(select(Rack)).all())
    for i, rack in enumerate(racks):
        serial = serial_for_rack(rack)
        if serial in by_serial:
            continue
        hall_name = next((h.name for h in halls if h.id == rack.hall_id), None)
        spm = spm_lookup(serial)
        hi = hall_i.get(rack.hall_id, 0)
        bmc_ip, os_ip = assign_ips(serial, hi, i, "compute")
        node = InventoryNode(
            kind="compute",
            serial=serial,
            name=rack.name,
            hall_name=hall_name,
            rack_id=rack.id,
            bmc_mac=spm["bmc_mac"],
            os_mac=spm["os_mac"],
            pxe_mac=spm["pxe_mac"],
            bmc_password=spm["bmc_password"],
            bmc_ip=bmc_ip,
            os_ip=os_ip if rack.power_state != "off" else None,
            provision_status="ready" if rack.power_state != "off" else "registered",
            last_seen_at=datetime.now(timezone.utc),
        )
        db.add(node)
        by_serial[serial] = node
        created = True

    for hi, hall in enumerate(sorted(halls, key=lambda h: h.name)):
        rows = sorted({r.y for r in hall.racks})
        for ri, _y in enumerate(rows):
            name = f"{hall.name}-LF-R{ri + 1:02d}"
            serial = serial_for_switch(name)
            if serial in by_serial:
                continue
            spm = spm_lookup(serial)
            bmc_ip, _ = assign_ips(serial, hi, ri, "leaf")
            db.add(
                InventoryNode(
                    kind="leaf",
                    serial=serial,
                    name=name,
                    hall_name=hall.name,
                    switch_mac=spm["switch_mac"],
                    bmc_mac=spm["bmc_mac"],
                    bmc_password=spm["bmc_password"],
                    bmc_ip=bmc_ip,
                    provision_status="ready",
                    last_seen_at=datetime.now(timezone.utc),
                )
            )
            created = True

    for i in range(8):
        name = f"SP-{i + 1:02d}"
        serial = serial_for_switch(name)
        if serial in by_serial:
            continue
        spm = spm_lookup(serial)
        bmc_ip, _ = assign_ips(serial, 0, i, "spine")
        db.add(
            InventoryNode(
                kind="spine",
                serial=serial,
                name=name,
                hall_name=None,
                switch_mac=spm["switch_mac"],
                bmc_mac=spm["bmc_mac"],
                bmc_password=spm["bmc_password"],
                bmc_ip=bmc_ip,
                provision_status="ready",
                last_seen_at=datetime.now(timezone.utc),
            )
        )
        created = True

    if created:
        db.commit()
    return list(db.scalars(select(InventoryNode).order_by(InventoryNode.kind, InventoryNode.name)).all())


def register_serials(db: Session, serials: list[str]) -> list[InventoryNode]:
    ensure_inventory(db)
    racks = {serial_for_rack(r): r for r in db.scalars(select(Rack)).all()}
    halls = {h.id: h.name for h in db.scalars(select(DataHall)).all()}
    out: list[InventoryNode] = []
    for raw in serials:
        serial = raw.strip()
        if not serial:
            continue
        node = db.scalar(select(InventoryNode).where(InventoryNode.serial == serial))
        spm = spm_lookup(serial)
        rack = racks.get(serial)
        if node is None:
            node = InventoryNode(serial=serial, name=serial, kind="compute")
            db.add(node)
        node.bmc_mac = spm["bmc_mac"]
        node.os_mac = spm["os_mac"]
        node.pxe_mac = spm["pxe_mac"]
        node.bmc_password = spm["bmc_password"]
        node.provision_status = node.provision_status or "registered"
        if rack:
            node.kind = "compute"
            node.name = rack.name
            node.rack_id = rack.id
            node.hall_name = halls.get(rack.hall_id)
        elif "-LF-" in serial:
            node.kind = "leaf"
            node.name = serial.replace("SN-", "")
            node.switch_mac = spm["switch_mac"]
        elif "SP-" in serial:
            node.kind = "spine"
            node.name = serial.replace("SN-", "")
            node.switch_mac = spm["switch_mac"]
        out.append(node)
    db.commit()
    for n in out:
        db.refresh(n)
    return out


def discover(db: Session) -> None:
    nodes = ensure_inventory(db)
    halls = list(db.scalars(select(DataHall)).all())
    hall_i = {h.name: i for i, h in enumerate(sorted(halls, key=lambda h: h.name))}
    for i, node in enumerate(nodes):
        hi = hall_i.get(node.hall_name or "", 0)
        bmc_ip, os_ip = assign_ips(node.serial, hi, i, node.kind)
        node.bmc_ip = bmc_ip
        if node.kind == "compute" and node.provision_status in ("ready", "dhcp", "registered"):
            if node.provision_status == "registered":
                node.provision_status = "dhcp"
            if node.provision_status == "ready":
                node.os_ip = os_ip
        node.last_seen_at = datetime.now(timezone.utc)
    db.commit()


def redfish_probe(db: Session, ids: list[str]) -> list[InventoryNode]:
    nodes = list(db.scalars(select(InventoryNode).where(InventoryNode.id.in_(ids))).all())
    halls = {h.name: i for i, h in enumerate(db.scalars(select(DataHall)).all())}
    for i, node in enumerate(nodes):
        if node.kind != "compute":
            continue
        hi = halls.get(node.hall_name or "", 0)
        _, os_ip = assign_ips(node.serial, hi, i, "compute")
        node.os_ip = os_ip
        if node.provision_status in ("registered", "dhcp"):
            node.provision_status = "dhcp"
        node.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return nodes


def start_pxe(db: Session, ids: list[str]) -> list[InventoryNode]:
    nodes = list(db.scalars(select(InventoryNode).where(InventoryNode.id.in_(ids))).all())
    now = datetime.now(timezone.utc)
    for node in nodes:
        node.provision_status = "pxe"
        node.provision_started_at = now
        node.sol_log = _sol_header(node)
    db.commit()
    return nodes


def _sol_header(node: InventoryNode) -> str:
    return (
        f"SOL session {node.name} ({node.serial})\n"
        f"BMC {node.bmc_ip}  MAC {node.bmc_mac}\n"
        f"{'=' * 52}\n"
    )


_PXE_LINES = [
    (4, "pxe", ">> Start PXE over IPv4."),
    (8, "pxe", "  Station IP {bmc}  Server 10.0.0.2"),
    (12, "pxe", "  NBP: snponly.efi  OK"),
    (16, "imaging", "iPXE> chain http://boot.firmus/gb300.ipxe"),
    (22, "imaging", "Fetching gb300-ubuntu-24.04-nv.squashfs …"),
    (30, "imaging", "Writing RAID1 /dev/md0  14%"),
    (40, "imaging", "Writing RAID1 /dev/md0  61%"),
    (50, "imaging", "cloud-init: datasource ConfigDrive"),
    (58, "sol", "cloud-init: networking up  OS IP {os}"),
    (66, "sol", "kernel: mlx5_core 0000:03:00.0 mlx5_0"),
    (72, "sol", "nvidia-persistenced: started"),
    (80, "ready", "login: ubuntu  (provision complete)"),
]

_SW_LINES = [
    (5, "pxe", "ONIE: starting discovery"),
    (12, "imaging", "ONIE: NOS installer cumulus-linux-5.11.bin"),
    (24, "imaging", "Installing to ONIE-BOOT …"),
    (40, "sol", "onie: switching to NOS"),
    (52, "sol", "switchd: ports 1-64 link scan"),
    (64, "ready", "login: admin  (switch ready)"),
]


def refresh_sol(node: InventoryNode) -> InventoryNode:
    if getattr(node, "source", None) == "argus":
        hop = pxe_hop.status()
        header = _sol_header(node)
        if not hop.get("connected"):
            node.sol_log = (
                header
                + f"BMC {node.bmc_ip or 'unknown'} is on the PXE network.\n"
                + f"Connect SSH to {hop.get('host')} as {hop.get('user')} to pull live SOL / open KVM.\n"
            )
            return node
        if not node.bmc_ip:
            node.sol_log = header + "No BMC IP on this node yet.\n"
            return node
        try:
            burst = pxe_hop.sol_capture(
                node.bmc_ip,
                getattr(node, "bmc_user", None) or "ADMIN",
                node.bmc_password or "",
            )
            node.sol_log = header + burst
        except pxe_hop.NeedsHop:
            node.sol_log = header + "PXE hop dropped. Re-enter jump-host credentials.\n"
        except Exception as exc:
            node.sol_log = header + f"SOL capture failed: {exc}\n"
        return node
    if node.provision_status in ("registered", "dhcp", "ready", "failed"):
        if node.provision_status == "ready" and not node.sol_log:
            node.sol_log = _sol_header(node) + "login: ubuntu  (provision complete)\n"
        return node
    started = node.provision_started_at
    if not started:
        return node
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    lines = _SW_LINES if node.kind != "compute" else _PXE_LINES
    log = [_sol_header(node)]
    status = "pxe"
    for t, st, tmpl in lines:
        if elapsed < t:
            break
        status = st
        log.append(tmpl.format(bmc=node.bmc_ip or "0.0.0.0", os=node.os_ip or "pending"))
    node.sol_log = "\n".join(log) + "\n"
    node.provision_status = status
    if status == "ready" and node.kind == "compute" and not node.os_ip:
        hi = 0
        _, os_ip = assign_ips(node.serial, hi, 0, "compute")
        node.os_ip = os_ip
    return node


def dhcp_table(nodes: list[InventoryNode]) -> list[dict]:
    rows = []
    for n in nodes:
        if n.bmc_ip and n.bmc_mac:
            rows.append(
                {
                    "ip": n.bmc_ip,
                    "mac": n.bmc_mac,
                    "hostname": f"{n.name}-bmc",
                    "lease": "12h",
                    "mapped": n.name,
                    "kind": n.kind,
                    "iface": "bmc0",
                }
            )
        if n.os_ip and n.os_mac:
            rows.append(
                {
                    "ip": n.os_ip,
                    "mac": n.os_mac,
                    "hostname": n.name.lower().replace(" ", "-"),
                    "lease": "12h",
                    "mapped": n.name,
                    "kind": n.kind,
                    "iface": "pxe0",
                }
            )
        if n.bmc_ip and n.switch_mac and n.kind != "compute":
            rows.append(
                {
                    "ip": n.bmc_ip,
                    "mac": n.switch_mac,
                    "hostname": f"{n.name}-mgmt",
                    "lease": "12h",
                    "mapped": n.name,
                    "kind": n.kind,
                    "iface": "eth0",
                }
            )
    rows.sort(key=lambda r: r["ip"])
    return rows


def arp_table(nodes: list[InventoryNode]) -> list[dict]:
    rows = []
    seen = set()
    for n in nodes:
        entries = [
            (n.bmc_ip, n.bmc_mac, "Supermicro BMC" if n.kind == "compute" else "NVIDIA QM9700"),
            (n.os_ip, n.os_mac, "Mellanox ConnectX-8"),
            (n.bmc_ip if n.kind != "compute" else None, n.switch_mac, "NVIDIA Quantum-2"),
        ]
        for ip, mac, vendor in entries:
            if not ip or not mac or (ip, mac) in seen:
                continue
            seen.add((ip, mac))
            rows.append(
                {
                    "ip": ip,
                    "mac": mac,
                    "vendor": vendor,
                    "mapped": n.name,
                    "kind": n.kind,
                    "state": "REACHABLE",
                }
            )
    rows.sort(key=lambda r: r["ip"])
    return rows


def serialize(node: InventoryNode) -> dict:
    hop = pxe_hop.status()
    tun = hop.get("tunnels") or {}
    kvm = tun.get(node.id)
    kvm_url = None
    if kvm:
        kvm_url = f"https://127.0.0.1:{kvm['port']}/#/console"
    return {
        "id": node.id,
        "kind": node.kind,
        "serial": node.serial,
        "name": node.name,
        "hall_name": node.hall_name,
        "rack_id": node.rack_id,
        "bmc_mac": node.bmc_mac,
        "os_mac": node.os_mac,
        "pxe_mac": node.pxe_mac,
        "switch_mac": node.switch_mac,
        "bmc_user": getattr(node, "bmc_user", None),
        "bmc_password": node.bmc_password,
        "bmc_ip": node.bmc_ip,
        "os_ip": node.os_ip,
        "os_username": getattr(node, "os_username", None),
        "os_password": getattr(node, "os_password", None),
        "source": getattr(node, "source", None) or "demo",
        "provision_status": node.provision_status,
        "sol_log": node.sol_log,
        "kvm_url": kvm_url,
        "gpus": provision_argus.node_gpus(node.bmc_mac),
        "last_seen_at": node.last_seen_at.isoformat() if node.last_seen_at else None,
        "provision_started_at": node.provision_started_at.isoformat() if node.provision_started_at else None,
    }


def load_nodes(db: Session) -> list[InventoryNode]:
    try:
        argus = provision_argus.sync_from_argus(db)
        if argus:
            return argus
    except Exception:
        db.rollback()
        existing = list(
            db.scalars(select(InventoryNode).where(InventoryNode.source == "argus").order_by(InventoryNode.name)).all()
        )
        if existing:
            return existing
    return ensure_inventory(db)
