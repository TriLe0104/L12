"""SPM lookup, DHCP/ARP discovery, PXE provision, and SOL console — demo fabric.

SPM is not on this host. Serials are resolved into BMC MAC + password from a
stable hash, then DHCP/ARP/Redfish are simulated the same way so the UI can
run the full register → discover → PXE → SOL path.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import DataHall, HiddenRack, InventoryNode, PxeServer, Rack, _uuid
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


def normalize_mac(raw: str | None) -> str | None:
    hex_only = re.sub(r"[^0-9a-fA-F]", "", raw or "")
    if len(hex_only) != 12:
        return None
    return ":".join(hex_only[i : i + 2] for i in range(0, 12, 2)).lower()


def _placeholder_serial(mac: str | None, ip: str | None) -> str:
    if mac:
        return f"MAC-{mac.replace(':', '')[-12:].upper()}"
    if ip:
        return f"IP-{ip.replace('.', '-')}"
    return f"UNK-{_uuid()[:8].upper()}"


def _is_placeholder_serial(serial: str | None) -> bool:
    s = (serial or "").strip().upper()
    return s.startswith("MAC-") or s.startswith("IP-") or s.startswith("UNK-")


def _unique_serial(db: Session, serial: str, skip_id: str | None = None) -> str:
    base = (serial or "").strip() or _placeholder_serial(None, None)
    candidate = base
    n = 2
    while True:
        row = db.scalar(select(InventoryNode).where(InventoryNode.serial == candidate))
        if row is None or (skip_id and row.id == skip_id):
            return candidate
        candidate = f"{base}-{n}"
        n += 1
        if n > 40:
            return f"{base}-{_uuid()[:6]}"


def _find_by_mac_or_ip(db: Session, mac: str | None, ip: str | None) -> InventoryNode | None:
    if mac:
        for n in db.scalars(select(InventoryNode)).all():
            if normalize_mac(n.bmc_mac) == mac:
                return n
    if ip:
        row = db.scalar(select(InventoryNode).where(InventoryNode.bmc_ip == ip))
        if row is not None:
            return row
    return None


def enrich_node(node: InventoryNode, *, arp: bool = True, redfish: bool = True) -> dict[str, Any]:
    """ARP the PXE hop for BMC IP, then Redfish for serial / hostname / MACs."""
    notes: list[str] = []
    filled: dict[str, Any] = {}
    connect_hint = f"Connect to PXE server {node.pxe_server}" if node.pxe_server else "Connect the PXE hop"

    def _ready(addr: str = "") -> bool:
        try:
            pxe_hop.bind_target(addr or node.bmc_ip or node.os_ip or "", node.pxe_server)
            return True
        except pxe_hop.NeedsHop:
            return False

    if arp and not node.bmc_ip and node.bmc_mac:
        if not _ready():
            notes.append(f"{connect_hint} to ARP-scan this MAC")
        else:
            try:
                found = pxe_hop.find_ip_for_mac(node.bmc_mac, node.pxe_server)
                ip = found.get("ip")
                if ip:
                    node.bmc_ip = ip
                    filled["bmc_ip"] = ip
                    notes.append(f"ARP {ip}")
                else:
                    notes.append("No neighbor or DHCP lease for that MAC yet")
            except pxe_hop.NeedsHop:
                notes.append(f"{connect_hint} to ARP-scan this MAC")
            except Exception as exc:
                notes.append(f"ARP failed: {exc}")
    if arp and node.bmc_ip and not node.bmc_mac:
        if not _ready(node.bmc_ip):
            notes.append(f"{connect_hint} to fill BMC MAC from this IP")
        else:
            try:
                found = pxe_hop.find_mac_for_ip(node.bmc_ip, node.pxe_server)
                mac = normalize_mac(found.get("mac"))
                if mac:
                    node.bmc_mac = mac
                    node.pxe_mac = node.pxe_mac or mac
                    filled["bmc_mac"] = mac
                    notes.append(f"ARP MAC {mac}")
                else:
                    notes.append("No neighbor MAC for that IP yet")
            except pxe_hop.NeedsHop:
                notes.append(f"{connect_hint} to fill BMC MAC from this IP")
            except Exception as exc:
                notes.append(f"ARP MAC failed: {exc}")
    if redfish and node.bmc_ip and (node.bmc_password or node.bmc_user):
        if not _ready(node.bmc_ip):
            notes.append(f"{connect_hint} to read serial from the BMC")
        else:
            try:
                ident = pxe_hop.redfish_identity(node.bmc_ip, node.bmc_user or "ADMIN", node.bmc_password or "")
            except pxe_hop.NeedsHop:
                notes.append(f"{connect_hint} to read serial from the BMC")
                ident = {}
            except Exception as exc:
                ident = {"error": str(exc)}
            if ident.get("error") and not ident.get("serial"):
                notes.append(f"Redfish: {ident['error']}")
            serial = (ident.get("serial") or "").strip()
            if serial and (_is_placeholder_serial(node.serial) or not node.serial):
                filled["serial"] = serial
            host = (ident.get("hostname") or "").strip()
            if host and (_is_placeholder_serial(node.name) or not node.name or node.name == node.serial):
                filled["name"] = host
            mac = normalize_mac(ident.get("bmc_mac"))
            if mac and not node.bmc_mac:
                filled["bmc_mac"] = mac
                notes.append(f"BMC MAC {mac}")
            os_mac = normalize_mac(ident.get("os_mac"))
            if os_mac and not node.os_mac:
                filled["os_mac"] = os_mac
            if ident.get("model"):
                filled["model"] = ident["model"]
            for key, val in filled.items():
                if key == "model":
                    continue
                setattr(node, key, val)
            if serial and filled.get("serial"):
                notes.append(f"SN {serial}")
            elif serial:
                notes.append(f"BMC SN {serial} (kept {node.serial})")
    node.last_seen_at = datetime.now(timezone.utc)
    if node.bmc_ip and node.provision_status in ("registered",):
        node.provision_status = "dhcp"
    filled["notes"] = notes
    return filled


def apply_node_fields(
    db: Session,
    node: InventoryNode,
    *,
    bmc_mac: str | None = None,
    bmc_user: str | None = None,
    bmc_password: str | None = None,
    bmc_ip: str | None = None,
    os_ip: str | None = None,
    os_username: str | None = None,
    os_password: str | None = None,
    pxe_server: str | None = None,
    os_mac: str | None = None,
    serial: str | None = None,
    name: str | None = None,
    kind: str | None = None,
    hall_name: str | None = None,
) -> None:
    if bmc_mac is not None:
        mac = normalize_mac(bmc_mac)
        node.bmc_mac = mac
        if mac:
            node.pxe_mac = node.pxe_mac or mac
    if bmc_ip is not None:
        node.bmc_ip = (bmc_ip or "").strip() or None
    if bmc_user is not None and str(bmc_user).strip():
        node.bmc_user = str(bmc_user).strip()
    elif not node.bmc_user:
        node.bmc_user = "ADMIN"
    if bmc_password is not None and str(bmc_password):
        node.bmc_password = str(bmc_password)
    if os_ip is not None:
        node.os_ip = str(os_ip).strip() or None
    if os_username is not None:
        node.os_username = str(os_username).strip() or None
    if os_password is not None:
        node.os_password = str(os_password) or None
    if pxe_server is not None:
        node.pxe_server = str(pxe_server).strip() or None
    if os_mac:
        node.os_mac = normalize_mac(os_mac) or node.os_mac
    if serial and str(serial).strip():
        node.serial = _unique_serial(db, str(serial).strip(), skip_id=node.id)
    if name and str(name).strip():
        node.name = str(name).strip()
    if kind and str(kind).strip():
        node.kind = str(kind).strip()
    if hall_name is not None:
        rack = str(hall_name).strip()
        node.hall_name = rack or (node.name or node.serial)
    if node.source == "demo":
        node.source = "manual"
    if not node.hall_name:
        node.hall_name = node.name or node.serial or "Unassigned"


def commit_enriched(db: Session, node: InventoryNode) -> dict[str, Any]:
    filled = enrich_node(node)
    if filled.get("serial"):
        node.serial = _unique_serial(db, filled["serial"], skip_id=node.id)
        filled["serial"] = node.serial
    if filled.get("name"):
        node.name = filled["name"]
    elif _is_placeholder_serial(node.name):
        node.name = node.serial
    db.commit()
    db.refresh(node)
    return filled


def add_or_update_node(
    db: Session,
    *,
    bmc_mac: str | None = None,
    bmc_user: str | None = None,
    bmc_password: str | None = None,
    bmc_ip: str | None = None,
    os_ip: str | None = None,
    os_username: str | None = None,
    os_password: str | None = None,
    pxe_server: str | None = None,
    os_mac: str | None = None,
    serial: str | None = None,
    name: str | None = None,
    kind: str | None = None,
    hall_name: str | None = None,
) -> tuple[InventoryNode, dict[str, Any], bool]:
    mac = normalize_mac(bmc_mac)
    ip = (bmc_ip or "").strip() or None
    if not mac and not ip:
        raise ValueError("Need a BMC MAC or BMC IP")
    node = _find_by_mac_or_ip(db, mac, ip)
    created = node is None
    if node is None:
        sn = _unique_serial(db, (serial or "").strip() or _placeholder_serial(mac, ip))
        node_name = (name or "").strip() or sn
        rack = (hall_name or "").strip() or node_name
        node = InventoryNode(
            id=_uuid(),
            serial=sn,
            name=node_name,
            kind=(kind or "compute").strip() or "compute",
            source="manual",
            hall_name=rack,
            provision_status="registered",
        )
        db.add(node)
    apply_node_fields(
        db,
        node,
        bmc_mac=bmc_mac,
        bmc_user=bmc_user,
        bmc_password=bmc_password,
        bmc_ip=bmc_ip,
        os_ip=os_ip,
        os_username=os_username,
        os_password=os_password,
        pxe_server=pxe_server,
        os_mac=os_mac,
        serial=serial if created else (serial if serial and _is_placeholder_serial(node.serial) else None),
        name=name,
        kind=kind,
        hall_name=hall_name if hall_name is not None or created else None,
    )
    try:
        from . import maxlps_inventory as inv

        inv.ensure_rack_for_node(db, node)
    except Exception:
        pass
    filled = commit_enriched(db, node)
    return node, filled, created


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


_SOL_STUBS = (
    "No BMC IP on this node yet.",
    "Connect SSH to",
    "PXE hop dropped",
    "SOL capture failed",
    "SOL idle",
)


def _sol_is_stub(log: str | None) -> bool:
    """True only for an empty log or one of our own placeholders. A real console dump counts."""
    text = (log or "").strip()
    if not text:
        return True
    if "RedfishVersion" in text or "=== Redfish" in text:
        return False
    if "login: ubuntu" in text or "provision complete" in text:
        return False
    if any(marker in text for marker in _SOL_STUBS):
        return True
    return len(text) < 40


def node_gaps(node: InventoryNode) -> list[str]:
    """Fields the hop can fill. Demo rows stay on the scripted path."""
    if (getattr(node, "source", None) or "demo") == "demo":
        return []
    gaps: list[str] = []
    mac = (node.bmc_mac or "").strip()
    ip = (node.bmc_ip or "").strip()
    if mac and not ip:
        gaps.append("ip")
    if ip and not mac:
        gaps.append("mac")
    creds = bool((node.bmc_password or "").strip())
    if ip and creds and (_is_placeholder_serial(node.serial) or not (node.serial or "").strip()):
        gaps.append("identity")
    if node.kind == "compute" and ip and creds and _sol_is_stub(node.sol_log):
        gaps.append("sol")
    return gaps


def fill_node_gaps(db: Session, node: InventoryNode) -> list[str]:
    """Fill only what is missing. Returns the gaps that were still open after the attempt."""
    if not pxe_hop.status().get("connected"):
        return node_gaps(node)
    want = set(node_gaps(node))
    if not want:
        return []
    worked = False
    if want & {"ip", "mac", "identity"}:
        enrich_node(node, arp=bool(want & {"ip", "mac"}), redfish="identity" in want)
        worked = True
        if "identity" not in want and "identity" in node_gaps(node):
            enrich_node(node, arp=False, redfish=True)
    if "sol" in node_gaps(node):
        _capture_live_sol(node)
        worked = True
    if worked:
        db.commit()
        db.refresh(node)
    return node_gaps(node)


_FILL_LOCK = threading.Lock()
_FILL_THREAD: threading.Thread | None = None
_FILL_NEXT: dict[str, float] = {}
_FILL_WAIT = 90.0


def kick_background_fill() -> None:
    """One pass over nodes that are missing BMC IP, MAC, serial, or SOL. No-op until the hop is up."""
    global _FILL_THREAD
    if not pxe_hop.status().get("connected"):
        return
    with _FILL_LOCK:
        if _FILL_THREAD is not None and _FILL_THREAD.is_alive():
            return
        _FILL_THREAD = threading.Thread(target=_fill_loop, name="provision-fill", daemon=True)
        _FILL_THREAD.start()


def _fill_loop() -> None:
    from .db import SessionLocal

    while pxe_hop.status().get("connected"):
        db = SessionLocal()
        target_id = ""
        try:
            now = time.time()
            target = None
            for node in db.scalars(select(InventoryNode)).all():
                if not node_gaps(node):
                    _FILL_NEXT.pop(node.id, None)
                    continue
                if _FILL_NEXT.get(node.id, 0) > now:
                    continue
                target = node
                break
            if target is None:
                upcoming = [t for t in _FILL_NEXT.values() if t > now]
                if not upcoming:
                    return
                time.sleep(min(30.0, max(2.0, min(upcoming) - now)))
                continue
            target_id = target.id
            still = fill_node_gaps(db, target)
            if still:
                _FILL_NEXT[target_id] = time.time() + _FILL_WAIT
            else:
                _FILL_NEXT.pop(target_id, None)
        except Exception:
            db.rollback()
            if target_id:
                _FILL_NEXT[target_id] = time.time() + _FILL_WAIT
        finally:
            db.close()


def _capture_live_sol(node: InventoryNode) -> InventoryNode:
    header = _sol_header(node)
    try:
        pxe_hop.bind_target(node.bmc_ip or "", node.pxe_server)
    except pxe_hop.NeedsHop:
        which = node.pxe_server or "the PXE hop"
        node.sol_log = header + f"BMC {node.bmc_ip or 'unknown'} is on the PXE network.\nPXE {which} is not connected.\n"
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
    except pxe_hop.NeedsHop as exc:
        node.sol_log = header + f"{exc}\n"
    except Exception as exc:
        node.sol_log = header + f"SOL capture failed: {exc}\n"
    return node


def refresh_sol(node: InventoryNode) -> InventoryNode:
    if (getattr(node, "source", None) or "demo") != "demo":
        return _capture_live_sol(node)
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
        "pxe_server": getattr(node, "pxe_server", None),
        "source": getattr(node, "source", None) or "demo",
        "provision_status": node.provision_status,
        "sol_log": node.sol_log,
        "kvm_url": kvm_url,
        "gpus": provision_argus.node_gpus(node.bmc_mac),
        "last_seen_at": node.last_seen_at.isoformat() if node.last_seen_at else None,
        "provision_started_at": node.provision_started_at.isoformat() if node.provision_started_at else None,
    }


def _operator_inventory(db: Session) -> bool:
    """True once a PXE is saved or a rack was removed. Demo campus rows are not inventory."""
    if db.scalar(select(PxeServer.id).limit(1)) is not None:
        return True
    return db.scalar(select(HiddenRack.id).limit(1)) is not None


def _drop_demo_inventory(db: Session) -> None:
    from . import maxlps_inventory

    dirty = False
    for row in list(db.scalars(select(InventoryNode).where(InventoryNode.source == "demo")).all()):
        db.delete(row)
        dirty = True
    if dirty:
        db.commit()
    maxlps_inventory.forget_bucket_hides(db)


def _live_nodes(db: Session) -> list[InventoryNode]:
    return list(
        db.scalars(
            select(InventoryNode)
            .where(InventoryNode.source.in_(("argus", "manual", "provision")))
            .order_by(InventoryNode.hall_name, InventoryNode.name)
        ).all()
    )


def load_nodes(db: Session, *, sync: bool = True) -> list[InventoryNode]:
    try:
        if sync:
            from . import maxlps_inventory

            maxlps_inventory.sync_live_infra(db)
        if _operator_inventory(db):
            _drop_demo_inventory(db)
        live = _live_nodes(db)
        if live:
            return live
    except Exception:
        db.rollback()
        existing = _live_nodes(db)
        if existing:
            return existing
    if _operator_inventory(db):
        try:
            _drop_demo_inventory(db)
        except Exception:
            db.rollback()
        return []
    return ensure_inventory(db)
