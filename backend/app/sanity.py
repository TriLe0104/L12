"""L11-style sanity, BOM, golden, and NVIDIA bench catalog for L12.

Ports the nburn-wrapper workflow (FW / SW / BOM / PSU / Voltage / SEL plus
golden compare) onto MaxLPS inventory. BMC work is Redfish; software capture
uses SSH when the OS IP is reachable. Passwords never appear in results.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sqlalchemy.orm import Session

from . import bmc_health, maxlps_inventory
from .models import MaxLpsNode, MaxLpsRack

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "l11"
GOLDEN_DIR = DATA_DIR / "golden"
RUNS_DIR = DATA_DIR / "runs"
SCRIPTS_DIR = ROOT / "scripts" / "l11"

CHECKS: list[dict[str, str]] = [
    {"id": "fw", "label": "Firmware", "blurb": "BIOS / BMC / CPLD / GPU VBIOS vs golden"},
    {"id": "sw", "label": "Software", "blurb": "OS, kernel, NVIDIA driver, CUDA vs golden"},
    {"id": "bom", "label": "BOM", "blurb": "CPU, DIMM, GPU, NIC, storage vs golden"},
    {"id": "psu", "label": "PSU", "blurb": "Power supply present and healthy"},
    {"id": "voltage", "label": "Voltage", "blurb": "Rail health from Redfish sensors"},
    {"id": "sel", "label": "SEL", "blurb": "Critical BMC event-log entries"},
]

CHECK_IDS = [c["id"] for c in CHECKS]

SCRIPTS: list[dict[str, Any]] = [
    {"id": "201stress-ng", "label": "stress-ng", "component": "cpu", "detail": "CPU stress (L11 201)", "entry": "benchmarks/201stress-ng/01-run-stress-ng.sh"},
    {"id": "202stressapptest", "label": "stressapptest", "component": "memory", "detail": "Memory stress (L11 202)", "entry": "benchmarks/202stressapptest/01-run-stressapptest.sh"},
    {"id": "204mprime", "label": "mprime", "component": "cpu", "detail": "Prime95 torture (L11 204)", "entry": "benchmarks/204mprime/01-run-mprime.sh"},
    {"id": "205fio", "label": "fio", "component": "storage", "detail": "NVMe I/O (L11 205)", "entry": "benchmarks/205fio/01-run-fio.sh"},
    {"id": "206ib_write_bw", "label": "ib_write_bw", "component": "network", "detail": "RDMA write bandwidth (L11 206)", "entry": "benchmarks/206ib_write_bw/01-loopback-ib_write_bw.sh"},
    {"id": "208nccl", "label": "NCCL", "component": "interconnect", "detail": "NCCL all_reduce (L11 208)", "entry": "benchmarks/208nccl/01-run-nccl-single.sh"},
    {"id": "209dcgm", "label": "DCGM", "component": "gpu", "detail": "NVIDIA DCGM diagnostics (L11 209)", "entry": "benchmarks/209dcgm/01-run-dcgm.sh"},
    {"id": "211nv_stream", "label": "nv_stream", "component": "memory", "detail": "GPU STREAM (L11 211)", "entry": "benchmarks/211nv_stream/01-run-nv_stream.sh"},
    {"id": "212parallel-dcgm-stress", "label": "parallel DCGM", "component": "gpu", "detail": "Parallel DCGM stress (L11 212)", "entry": "benchmarks/212parallel-dcgm-stress/01-run-parallel-dcgm-stress.sh"},
    {"id": "sanity-fw", "label": "Firmware inventory", "component": "system", "detail": "L11 firmware capture script", "entry": "sanitycheck/01-fw-sw_checks/01-firmwareinventoryinfo.sh"},
    {"id": "sanity-sw", "label": "Software capture", "component": "system", "detail": "L11 software capture script", "entry": "sanitycheck/01-fw-sw_checks/02-software_capture.sh"},
    {"id": "sanity-bom", "label": "BOM check", "component": "system", "detail": "trilsanitychk golden BOM compare", "entry": "sanitycheck/02-bom_checks/01-trilsanitychk.sh"},
    {"id": "sanity-psu", "label": "PSU health", "component": "system", "detail": "Redfish PSU health script", "entry": "sanitycheck/03-health_checks/01-psu_health.sh"},
    {"id": "sanity-voltage", "label": "Voltage health", "component": "system", "detail": "Redfish voltage rails", "entry": "sanitycheck/03-health_checks/02-voltage_health.sh"},
    {"id": "sanity-sel", "label": "SEL errors", "component": "system", "detail": "Critical SEL finder", "entry": "sanitycheck/03-health_checks/03-sel_find_active_errors.sh"},
]

_GOLDEN_FILES = {
    "bom": "bom_golden.json",
    "fw": "fw_golden.json",
    "sw": "sw_golden.json",
    "log": "golden_capture.log",
}

_NA = {"", "n/a", "na", "null", "none", "unknown", "n/a (bmc unreachable)"}

_LOCK = threading.Lock()
_JOB: dict[str, Any] = {
    "running": False,
    "job_id": None,
    "kind": None,
    "started_at": None,
    "rack_serial": None,
    "rack_label": None,
}
_STOP = threading.Event()
_THREAD: threading.Thread | None = None

_SYS_PATHS = (
    "/redfish/v1/Systems/System_0",
    "/redfish/v1/Systems/1",
    "/redfish/v1/Systems/system",
    "/redfish/v1/Systems/System",
    "/redfish/v1/Systems/HGX_Baseboard_0",
)
_MGR_PATHS = (
    "/redfish/v1/Managers/BMC_0",
    "/redfish/v1/Managers/1",
    "/redfish/v1/Managers/bmc",
    "/redfish/v1/Managers/BMC",
    "/redfish/v1/Managers/HGX_BMC_0",
)
_CHASSIS_PATHS = (
    "/redfish/v1/Chassis/Chassis_0",
    "/redfish/v1/Chassis/1",
    "/redfish/v1/Chassis/chassis",
    "/redfish/v1/Chassis/Chassis",
    "/redfish/v1/Chassis/HGX_Chassis_0",
)
_FW_PATHS = (
    "/redfish/v1/UpdateService/FirmwareInventory",
    "/redfish/v1/UpdateService/FirmwareInventory?$expand=.($levels=1)",
)
_POWER_PATHS = (
    "/redfish/v1/Chassis/1/Power",
    "/redfish/v1/Chassis/chassis/Power",
    "/redfish/v1/Chassis/Chassis/Power",
    "/redfish/v1/Chassis/Chassis_0/Power",
    "/redfish/v1/Chassis/Chassis_0/PowerSubsystem",
    "/redfish/v1/Chassis/chassis/PowerSubsystem/PowerSupplies?$expand=.($levels=1)",
    "/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies?$expand=.($levels=1)",
)
_SEL_PATHS = (
    "/redfish/v1/Managers/BMC_0/LogServices/EventLog/Entries?$expand=.($levels=1)",
    "/redfish/v1/Managers/1/LogServices/EventLog/Entries?$expand=.($levels=1)",
    "/redfish/v1/Systems/System_0/LogServices/EventLog/Entries?$expand=.($levels=1)",
    "/redfish/v1/Managers/1/LogServices/SEL/Entries?$expand=.($levels=1)",
)
_SENSOR_PATHS = (
    "/redfish/v1/Chassis/Chassis_0/Sensors?$expand=.($levels=1)",
    "/redfish/v1/Chassis/1/Sensors?$expand=.($levels=1)",
    "/redfish/v1/Chassis/HGX_Chassis_0/Sensors?$expand=.($levels=1)",
)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ensure_dirs() -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _na(value: Any) -> str:
    if value is None:
        return "N/A"
    text = str(value).strip()
    if text.lower() in _NA:
        return "N/A"
    return text


def _same(a: Any, b: Any) -> bool:
    return _na(a).lower() == _na(b).lower()


def _blank_ref(value: Any) -> bool:
    """An empty golden or unreadable field is not a mismatch."""
    text = _na(value)
    if text == "N/A" or text.lower().startswith("n/a"):
        return True
    compact = re.sub(r"[\s():]", "", text).lower()
    return compact in {"", "date"}


def _members(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(body, dict):
        return []
    rows = body.get("Members") or body.get("PowerSupplies") or body.get("Voltages") or []
    return [m for m in rows if isinstance(m, dict)]


_DIRECT_DEAD: dict[str, float] = {}


def _direct_dead(ip: str) -> bool:
    return _DIRECT_DEAD.get(ip, 0) > time.time()


def _mark_direct_dead(ip: str, err: str) -> None:
    low = (err or "").lower()
    if any(bit in low for bit in ("timed out", "timeout", "unreachable", "refused", "reset", "no route")):
        _DIRECT_DEAD[ip] = time.time() + 600


def _rf(ip: str, path: str, user: str, password: str, timeout: float = 10.0) -> dict[str, Any]:
    """Redfish GET through the PXE stored on this node's rack."""
    from . import pxe_hop
    from .pxe_servers import pxe_for_address

    host = pxe_for_address(ip)
    if host:
        if not pxe_hop.ensure_host(host):
            return {"_error": f"PXE {host} is not connected", "_path": path}
        try:
            hopped = pxe_hop._redfish_json(ip, path, user, password, host=host)
            if isinstance(hopped, dict):
                if not hopped.get("_error"):
                    hopped["_via"] = "hop"
                return hopped
        except Exception as exc:
            return {"_error": str(exc)[:180], "_path": path}
    elif pxe_hop.status().get("connected"):
        try:
            hopped = pxe_hop._redfish_json(ip, path, user, password)
            if isinstance(hopped, dict):
                if not hopped.get("_error"):
                    hopped["_via"] = "hop"
                return hopped
        except Exception as exc:
            return {"_error": str(exc)[:180], "_path": path}
    if _direct_dead(ip):
        return {"_error": "Connect the PXE hop first", "_path": path}
    body = bmc_health.redfish_get(ip, path, user, password, timeout=min(timeout, 4))
    if isinstance(body, dict) and not body.get("_error"):
        return body
    _mark_direct_dead(ip, str((body or {}).get("_error") if isinstance(body, dict) else ""))
    return body if isinstance(body, dict) else {"_error": "Connect the PXE hop first", "_path": path}


def _collection_of(path: str) -> str | None:
    for name in ("Systems", "Managers", "Chassis"):
        if f"/{name}/" in path or path.rstrip("/").endswith(f"/{name}"):
            return f"/redfish/v1/{name}"
    return None


def _rf_first(ip: str, user: str, password: str, paths: tuple[str, ...], timeout: float = 10.0) -> dict[str, Any]:
    last: dict[str, Any] = {"_error": "no path"}
    for path in paths:
        body = _rf(ip, path, user, password, timeout=timeout)
        if not body.get("_error"):
            body["_path"] = path
            return body
        last = body
    seen: set[str] = set()
    for path in paths:
        col = _collection_of(path)
        if not col or col in seen:
            continue
        seen.add(col)
        listing = _rf(ip, col, user, password, timeout=timeout)
        for member in _members(listing)[:4]:
            href = str(member.get("@odata.id") or "")
            if not href:
                continue
            body = _rf(ip, href, user, password, timeout=timeout)
            if not body.get("_error"):
                body["_path"] = href
                return body
            last = body
    return last


def _expand(ip: str, user: str, password: str, body: dict[str, Any], limit: int = 64) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for member in _members(body):
        if len(rows) >= limit:
            break
        href = str(member.get("@odata.id") or "")
        if href and len(member) <= 4:
            full = _rf(ip, href, user, password)
            if full.get("_error"):
                rows.append(member)
            else:
                rows.append(full)
        else:
            rows.append(member)
    return rows


def script_catalog() -> dict[str, Any]:
    rows = []
    for spec in SCRIPTS:
        path = SCRIPTS_DIR / spec["entry"]
        rows.append({**spec, "present": path.is_file(), "source": "l11"})
    return {"source": "l11", "scripts": rows, "root": str(SCRIPTS_DIR)}


def read_script(script_id: str) -> tuple[str, str]:
    spec = next((s for s in SCRIPTS if s["id"] == script_id), None)
    if spec is None:
        raise FileNotFoundError(script_id)
    path = SCRIPTS_DIR / spec["entry"]
    if not path.is_file():
        raise FileNotFoundError(spec["entry"])
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) > 200_000:
        text = text[:200_000] + "\n[truncated]"
    return spec["entry"], text


_CAPTURE: dict[str, Any] = {"running": False, "error": None, "finished_at": None, "started_at": None, "node": None, "gen": 0}


def golden_status() -> dict[str, Any]:
    _ensure_dirs()
    out: dict[str, Any] = {"capture": dict(_CAPTURE)}
    for key, name in _GOLDEN_FILES.items():
        path = GOLDEN_DIR / name
        if path.is_file():
            out[key] = {
                "exists": True,
                "filename": name,
                "mtime": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bytes": path.stat().st_size,
            }
        else:
            out[key] = {"exists": False, "filename": name, "mtime": None, "bytes": 0}
    return out


def golden_path(kind: str) -> Path:
    name = _GOLDEN_FILES.get((kind or "").strip().lower())
    if not name:
        raise KeyError("kind must be bom, fw, sw, or log")
    _ensure_dirs()
    return GOLDEN_DIR / name


def load_golden(kind: str) -> Any:
    path = golden_path(kind)
    if not path.is_file():
        return None
    raw = path.read_text(encoding="utf-8", errors="replace")
    if kind == "log":
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def save_golden(kind: str, content: Any) -> dict[str, Any]:
    path = golden_path(kind)
    if kind == "log":
        text = content if isinstance(content, str) else str(content)
        path.write_text(text, encoding="utf-8")
    else:
        if isinstance(content, str):
            json.loads(content)
            path.write_text(content, encoding="utf-8")
        else:
            path.write_text(json.dumps(content, indent=2), encoding="utf-8")
    return golden_status()[kind]


def _load_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _dump_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def latest_result_path(rack_serial: str | None = None) -> Path | None:
    _ensure_dirs()
    files = sorted(RUNS_DIR.glob("sanity_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if rack_serial:
        needle = rack_serial.strip().lower()
        for path in files:
            data = _load_json(path)
            if isinstance(data, dict) and str(data.get("rack_serial") or "").strip().lower() == needle:
                return path
    return files[0] if files else None


def load_status(rack_serial: str | None = None) -> dict[str, Any]:
    with _LOCK:
        job = dict(_JOB)
    path = latest_result_path(rack_serial)
    data = _load_json(path) if path else None
    if not isinstance(data, dict):
        data = {"status": "no_results", "overall": None, "nodes": {}, "checks": CHECKS}
    if str(data.get("status") or "") == "running" and not job.get("running"):
        data["status"] = "interrupted"
        data["overall"] = "STOPPED"
        for row in (data.get("nodes") or {}).values():
            if not isinstance(row, dict) or row.get("overall") != "RUNNING":
                continue
            row["overall"] = "STOPPED"
            row["skip_reason"] = row.get("skip_reason") or "run stopped before it finished"
            for chk in (row.get("checks") or {}).values():
                if isinstance(chk, dict) and chk.get("status") == "RUNNING":
                    chk["status"] = "STOPPED"
                    chk["detail"] = chk.get("detail") or "run stopped before it finished"
    data["job"] = job
    data["golden"] = golden_status()
    data["checks"] = CHECKS
    if path:
        data["result_file"] = path.name
    return data


def _fold(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _token_in(token: str, blob: str) -> bool:
    if token in blob:
        return True
    for word in blob.split():
        if abs(len(word) - len(token)) > 1 or len(token) < 4:
            continue
        if word[:3] == token[:3]:
            return True
    return False


def pick_rack(db: Session, serial: str | None = None, name: str | None = None) -> MaxLpsRack | None:
    """Match a rack label, serial, id, or a node on that rack (hostname, serial, IP).

    A named rack that does not match returns None. An empty name falls back to the live Argus rack.
    """
    racks = maxlps_inventory.load_racks(db)
    raw = (serial or name or "").strip()
    raw_l = raw.lower()
    if raw_l:
        for rack in racks:
            if raw_l in {
                rack.id.lower(),
                (rack.serial or "").strip().lower(),
                (rack.label or "").strip().lower(),
            }:
                return rack
    needle = _fold(serial or name)
    if not needle:
        live = next((r for r in racks if (r.serial or "").strip() and r.origin == "argus"), None)
        return live or (racks[0] if racks else None)
    tokens = [part for part in needle.split() if len(part) >= 4]
    best: MaxLpsRack | None = None
    best_score = 0
    for rack in racks:
        score = 0
        label = _fold(rack.label)
        serial_fold = _fold(rack.serial)
        if needle in {label, serial_fold, rack.id.lower()}:
            score = 100
        elif label and len(label) >= 2 and label in needle.split():
            score = 90
        else:
            blobs = [label, serial_fold]
            for node in rack.nodes:
                blobs.append(_fold(node.hostname))
                blobs.append(_fold(node.serial))
                blobs.append((node.bmc_ip or "").strip().lower())
            for blob in blobs:
                if not blob:
                    continue
                if blob == needle:
                    score = max(score, 95)
                elif len(blob) >= 4 and len(needle) >= 4 and (needle in blob or blob in needle):
                    score = max(score, 85)
                elif tokens and all(_token_in(tok, blob) for tok in tokens):
                    score = max(score, 75)
        if score > best_score:
            best, best_score = rack, score
    return best if best_score >= 75 else None


def node_has_serial(serial: str | None) -> bool:
    text = (serial or "").strip()
    if not text or text in {"—", "-"}:
        return False
    folded = text.upper()
    return not folded.startswith(("MAC-", "IP-", "UNK-"))


def _node_label(node: MaxLpsNode) -> str:
    if node.index is not None:
        return f"N{int(node.index)}"
    return node.hostname or node.serial or node.id[:8]


def _node_selected(node: MaxLpsNode, needle: str) -> bool:
    if not needle:
        return False
    bits = {
        (node.serial or "").strip().lower(),
        (node.hostname or "").strip().lower(),
        (node.bmc_mac or "").strip().lower(),
        (node.bmc_ip or "").strip().lower(),
        (node.os_ip or "").strip().lower(),
        node.id.lower(),
    }
    if node.index is not None:
        bits.add(f"n{int(node.index)}")
        bits.add(str(int(node.index)))
    if needle in bits:
        return True
    host = (node.hostname or "").strip().lower()
    return len(needle) >= 4 and bool(host) and (needle in host or host in needle)


def _pick_nodes(rack: MaxLpsRack, macs: list[str] | None) -> list[MaxLpsNode]:
    want = [m.strip().lower() for m in (macs or []) if m and m.strip()]
    if not want:
        return list(rack.nodes)
    return [node for node in rack.nodes if any(_node_selected(node, needle) for needle in want)]


def _unique_join(rows: list[dict[str, Any]], key: str) -> str:
    seen: list[str] = []
    for row in rows:
        val = _na(row.get(key))
        if val not in seen:
            seen.append(val)
    return ", ".join(seen) if seen else "N/A"


def collect_firmware(ip: str, user: str, password: str) -> dict[str, Any]:
    inv = _rf_first(ip, user, password, _FW_PATHS)
    items = _expand(ip, user, password, inv) if not inv.get("_error") else []
    versions: dict[str, str] = {}
    for item in items:
        name = str(item.get("Id") or item.get("Name") or "").strip()
        ver = _na(item.get("Version"))
        if name:
            versions[name] = ver
    bios = "N/A"
    bmc = "N/A"
    cpld = "N/A"
    vbios = "N/A"
    bkc = "N/A"
    for name, ver in versions.items():
        low = name.lower()
        if "bios" in low and "gpu" not in low and bios == "N/A":
            bios = ver
        elif any(x in low for x in ("bmc", "bmc_0", "manager")) and bmc == "N/A":
            bmc = ver
        elif "cpld" in low and cpld == "N/A":
            cpld = ver
        elif any(x in low for x in ("vbios", "gpubios", "gpu_bios")) and vbios == "N/A":
            vbios = ver
        elif any(x in low for x in ("bkc", "bundle", "hgx_fw")) and bkc == "N/A":
            bkc = ver
    system = _rf_first(ip, user, password, _SYS_PATHS)
    manager = _rf_first(ip, user, password, _MGR_PATHS)
    if bios == "N/A":
        bios = _na(system.get("BiosVersion"))
    if bmc == "N/A":
        bmc = _na(manager.get("FirmwareVersion"))
    return {
        "bios_version": bios,
        "bmc_version": bmc,
        "cpld_version": cpld,
        "bkc_version": bkc,
        "global_vbios": vbios,
        "inventory": versions,
    }


def _open_ssh(host: str, user: str, password: str):
    """SSH to the OS through the PXE hop. These nodes are not reachable from this PC."""
    import paramiko
    from . import pxe_hop

    def connect(target: str, port: int) -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            target,
            port=port,
            username=user,
            password=password,
            timeout=20,
            allow_agent=False,
            look_for_keys=False,
            banner_timeout=20,
            auth_timeout=20,
        )
        return client

    from .pxe_servers import pxe_for_address

    pxe = pxe_for_address(host)
    if pxe:
        if not pxe_hop.ensure_host(pxe):
            raise RuntimeError(f"PXE {pxe} is not connected. This node is reached through that hop.")
        with pxe_hop.on_host(pxe):
            local = pxe_hop.open_https_tunnel(f"ssh-{host}", host, 22)
    elif not pxe_hop.status().get("connected"):
        raise RuntimeError("Connect the PXE hop first. This node is only reachable from there.")
    else:
        local = pxe_hop.open_https_tunnel(f"ssh-{host}", host, 22)
    try:
        return connect("127.0.0.1", local)
    except Exception as exc:
        raise RuntimeError(f"PXE hop tunnel to {host} failed ({exc})") from exc


def _ssh_exec(host: str, port: int, user: str, password: str, cmd: str) -> tuple[str, str, int]:
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            host,
            port=port,
            username=user,
            password=password,
            timeout=8,
            allow_agent=False,
            look_for_keys=False,
            banner_timeout=8,
            auth_timeout=8,
        )
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=20)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return out, err, code
    finally:
        try:
            client.close()
        except Exception:
            pass


def collect_software(node: MaxLpsNode) -> dict[str, Any]:
    host = (node.os_ip or "").strip()
    user = (node.os_username or "root").strip() or "root"
    password = node.os_password or ""
    if not host or not password:
        return {"ok": False, "error": "OS SSH not configured", "os_version": "N/A", "kernel_version": "N/A"}
    cmd = (
        "source /etc/os-release 2>/dev/null || true; "
        "echo OS=${PRETTY_NAME:-unknown}; "
        "echo KERNEL=$(uname -r); "
        "nvidia-smi --query-gpu=driver_version,vbios_version,name --format=csv,noheader 2>/dev/null | head -1 | "
        "awk -F, '{gsub(/ /,\"\"); print \"DRIVER=\"$1; print \"VBIOS=\"$2; print \"GPU=\"$3}'; "
        "echo CUDA=$(nvidia-smi 2>/dev/null | awk -F'CUDA Version: ' '/CUDA Version/{print $2}' | awk '{print $1}'); "
        "echo OFED=$(ofed_info -s 2>/dev/null | head -1); "
        "echo DCGM=$(dcgmi -v 2>/dev/null | head -1)"
    )
    try:
        client = _open_ssh(host, user, password)
        try:
            _stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
        finally:
            try:
                client.close()
            except Exception:
                pass
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:180], "os_version": "N/A", "kernel_version": "N/A"}
    fields: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            key, val = line.split("=", 1)
            fields[key.strip().lower()] = val.strip() or "N/A"
    return {
        "ok": code == 0,
        "error": None if code == 0 else (err[:180] or f"exit {code}"),
        "os_version": fields.get("os") or "N/A",
        "kernel_version": fields.get("kernel") or "N/A",
        "driver": fields.get("driver") or "N/A",
        "cuda": fields.get("cuda") or "N/A",
        "ofed": fields.get("ofed") or "N/A",
        "dcgm": fields.get("dcgm") or "N/A",
        "gpu_name": fields.get("gpu") or "N/A",
        "vbios": fields.get("vbios") or "N/A",
    }


def collect_bom(ip: str, user: str, password: str, node: MaxLpsNode, firmware: dict[str, Any], software: dict[str, Any]) -> dict[str, Any]:
    system = _rf_first(ip, user, password, _SYS_PATHS)
    chassis = _rf_first(ip, user, password, _CHASSIS_PATHS)
    hgx = _rf(ip, "/redfish/v1/Systems/HGX_Baseboard_0", user, password)
    processors = _expand(ip, user, password, _rf(ip, str(system.get("@odata.id") or "/redfish/v1/Systems/System_0") + "/Processors?$expand=.($levels=1)", user, password))
    if not processors:
        processors = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/System_0/Processors", user, password))
    memory = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/System_0/Memory?$expand=.($levels=1)", user, password))
    if not memory:
        memory = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/1/Memory", user, password))
    nics = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/System_0/EthernetInterfaces?$expand=.($levels=1)", user, password))
    storage = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/System_0/Storage?$expand=.($levels=1)", user, password))
    drives: list[dict[str, Any]] = []
    for sto in storage:
        for drv in sto.get("Drives") or []:
            if isinstance(drv, dict):
                href = str(drv.get("@odata.id") or "")
                if href and len(drv) <= 4:
                    full = _rf(ip, href, user, password)
                    drives.append(full if not full.get("_error") else drv)
                else:
                    drives.append(drv)
    gpus = []
    for proc in processors:
        ptype = str(proc.get("ProcessorType") or "").lower()
        name = str(proc.get("Model") or proc.get("Name") or "")
        if ptype == "gpu" or "gpu" in name.lower() or "b200" in name.lower() or "gb300" in name.lower() or "h100" in name.lower():
            gpus.append(proc)
    if not gpus and not hgx.get("_error"):
        gpus = _expand(ip, user, password, _rf(ip, "/redfish/v1/Systems/HGX_Baseboard_0/Processors", user, password))
    cpu_models = [str(p.get("Model") or p.get("Name") or "N/A") for p in processors if str(p.get("ProcessorType") or "CPU").lower() != "gpu"]
    dimms = []
    total_mb = 0
    for dimm in memory:
        size = dimm.get("CapacityMiB") or dimm.get("CapacityMB")
        try:
            total_mb += int(size or 0)
        except (TypeError, ValueError):
            pass
        dimms.append(
            {
                "locator": dimm.get("DeviceLocator") or dimm.get("Name") or dimm.get("Id"),
                "size": f"{int(size) // 1024} GB" if isinstance(size, (int, float)) and size else _na(dimm.get("CapacityMiB")),
                "speed": dimm.get("OperatingSpeedMhz") or dimm.get("MaxSpeedMHz"),
                "part_number": dimm.get("PartNumber"),
                "serial_number": dimm.get("SerialNumber"),
            }
        )
    nic_rows = [
        {
            "name": n.get("Id") or n.get("Name"),
            "mac": n.get("MACAddress"),
            "speed": n.get("SpeedMbps"),
            "firmware": n.get("FirmwarePackageVersion") or n.get("FirmwareVersion"),
            "part_number": n.get("PartNumber") or n.get("Model"),
        }
        for n in nics
    ]
    drive_rows = [
        {
            "model": d.get("Model") or d.get("Name"),
            "firmware": d.get("FirmwareVersion") or d.get("Revision"),
            "capacity": d.get("CapacityBytes"),
            "protocol": d.get("Protocol"),
        }
        for d in drives
    ]
    gpu_rows = [
        {
            "name": g.get("Model") or g.get("Name"),
            "id": g.get("Id"),
            "firmware": g.get("FirmwareVersion"),
        }
        for g in gpus
    ]
    gb = round(total_mb / 1024) if total_mb else 0
    mb = system.get("ProcessorSummary") if isinstance(system.get("ProcessorSummary"), dict) else {}
    board = system.get("PartNumber") or chassis.get("PartNumber")
    capture_bits = []
    if system.get("_error"):
        capture_bits.append(f"Redfish {system.get('_error')}")
    if software.get("error"):
        capture_bits.append(f"SSH {software.get('error')}")
    return {
        "capture_error": "; ".join(capture_bits) or None,
        "system": {
            "hostname": node.hostname or system.get("HostName") or "N/A",
            "os_version": software.get("os_version") or "N/A",
            "kernel_version": software.get("kernel_version") or "N/A",
            "system_pn": system.get("Model") or chassis.get("Model") or hgx.get("Model") or "N/A",
            "system_sn": node.serial or system.get("SerialNumber") or chassis.get("SerialNumber") or "N/A",
            "motherboard": {
                "vendor": system.get("Manufacturer") or chassis.get("Manufacturer") or "N/A",
                "part_number": board or "N/A",
                "serial_number": chassis.get("SerialNumber") or "N/A",
            },
            "chassis_sn": chassis.get("SerialNumber") or "N/A",
        },
        "firmware": {
            "bios_version": firmware.get("bios_version") or "N/A",
            "bmc_version": firmware.get("bmc_version") or "N/A",
            "cpld_version": firmware.get("cpld_version") or "N/A",
            "bkc_version": firmware.get("bkc_version") or "N/A",
        },
        "tpm": {"model": "N/A", "revision": "N/A"},
        "cpu": {
            "info": {
                "model": "; ".join(dict.fromkeys(cpu_models)) if cpu_models else _na((mb or {}).get("Model")),
                "counts": str((mb or {}).get("Count") or len(cpu_models) or "N/A"),
            }
        },
        "memory": {
            "summary": f"{gb} GB Total" if gb else "N/A",
            "modules": dimms,
        },
        "accelerators_gpu": {
            "global_vbios": firmware.get("global_vbios") or software.get("vbios") or "N/A",
            "devices": gpu_rows,
        },
        "network_interfaces": nic_rows,
        "storage": drive_rows,
        "software": {
            "driver": software.get("driver") or "N/A",
            "cuda": software.get("cuda") or "N/A",
            "ofed": software.get("ofed") or "N/A",
            "dcgm": software.get("dcgm") or "N/A",
        },
    }


_BOM_ROWS = (
    ("OS Version", ("system", "os_version")),
    ("Kernel Version", ("system", "kernel_version")),
    ("BIOS Version", ("firmware", "bios_version")),
    ("BMC Version", ("firmware", "bmc_version")),
    ("CPLD Version", ("firmware", "cpld_version")),
    ("Bundle Version", ("firmware", "bkc_version")),
    ("GPU VBIOS (Global)", ("accelerators_gpu", "global_vbios")),
    ("System Model", ("system", "system_pn")),
    ("Motherboard PN", ("system", "motherboard", "part_number")),
    ("TPM Model", ("tpm", "model")),
    ("TPM Revision", ("tpm", "revision")),
    ("CPU Model", ("cpu", "info", "model")),
    ("Total Memory", ("memory", "summary")),
)


def _dig(doc: Any, path: tuple[str, ...]) -> Any:
    cur = doc
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def compare_bom(ref: dict[str, Any], sys_doc: dict[str, Any]) -> list[dict[str, str]]:
    diffs: list[dict[str, str]] = []
    for label, path in _BOM_ROWS:
        raw_left = _dig(ref, path)
        raw_right = _dig(sys_doc, path)
        if _blank_ref(raw_left) or _blank_ref(raw_right):
            continue
        left = _na(raw_left)
        right = _na(raw_right)
        if not _same(left, right):
            diffs.append({"label": label, "ref": left, "sys": right, "status": "DIFF"})
    for label, path in (
        ("DIMM Count", ("memory", "modules")),
        ("GPU Count", ("accelerators_gpu", "devices")),
        ("NIC Count", ("network_interfaces",)),
        ("Drive Count", ("storage",)),
    ):
        left_list = _dig(ref, path)
        right_list = _dig(sys_doc, path)
        if not isinstance(left_list, list) or not left_list:
            continue
        if not isinstance(right_list, list) or not right_list:
            continue
        left_n = len(left_list)
        right_n = len(right_list)
        if left_n != right_n:
            diffs.append({"label": label, "ref": str(left_n), "sys": str(right_n), "status": "DIFF"})
    uniques = (
        ("DIMM Part#", ("memory", "modules"), "part_number"),
        ("GPU Model", ("accelerators_gpu", "devices"), "name"),
        ("NIC Firmware", ("network_interfaces",), "firmware"),
        ("NIC Part#", ("network_interfaces",), "part_number"),
        ("Drive Model(s)", ("storage",), "model"),
        ("Drive Firmware", ("storage",), "firmware"),
    )
    for label, path, key in uniques:
        if not isinstance(_dig(ref, path), list) or not _dig(ref, path):
            continue
        left = _unique_join(list(_dig(ref, path) or []), key)
        right = _unique_join(list(_dig(sys_doc, path) or []), key) if isinstance(_dig(sys_doc, path), list) else "N/A"
        if _blank_ref(left):
            continue
        if not _same(left, right):
            diffs.append({"label": label, "ref": left, "sys": right, "status": "DIFF"})
    return diffs


def _health_ok(value: Any) -> bool:
    text = str(value or "").strip().lower()
    return text in {"ok", "enabled", "on", "healthy", ""}


def _psu_rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    rows = body.get("PowerSupplies")
    if isinstance(rows, list) and rows:
        return [row for row in rows if isinstance(row, dict)]
    return []


def _read_psus(ip: str, user: str, password: str) -> tuple[list[dict[str, Any]], str]:
    last_err = ""
    for path in _POWER_PATHS:
        body = _rf(ip, path, user, password)
        if body.get("_error"):
            last_err = str(body.get("_error"))
            continue
        rows = _psu_rows(body)
        if rows:
            return rows, path
    listing = _rf(ip, "/redfish/v1/Chassis", user, password)
    for member in _members(listing)[:6]:
        href = str(member.get("@odata.id") or "").rstrip("/")
        if not href:
            continue
        body = _rf(ip, href + "/Power", user, password)
        if body.get("_error"):
            last_err = str(body.get("_error"))
            continue
        rows = _psu_rows(body)
        if rows:
            return rows, href + "/Power"
    return [], last_err


def check_psu(ip: str, user: str, password: str) -> dict[str, Any]:
    live = None
    try:
        snap = bmc_health.snapshot()
        for row in snap.get("nodes") or []:
            if (row.get("bmc_ip") or "") == ip:
                live = row.get("power") or {}
                break
    except Exception:
        live = None
    supplies: list[dict[str, Any]] = []
    if live and live.get("psus"):
        for psu in live["psus"]:
            supplies.append({"id": psu.get("id"), "status": psu.get("status"), "watts": psu.get("watts")})
    else:
        rows, err = _read_psus(ip, user, password)
        if not rows and err:
            return {"status": "FAIL", "failures": [f"Redfish power: {err}"], "detail": "BMC power endpoint failed", "items": []}
        for psu in rows:
            st = psu.get("Status") if isinstance(psu.get("Status"), dict) else {}
            supplies.append(
                {
                    "id": psu.get("Id") or psu.get("Name") or psu.get("MemberId"),
                    "status": (st or {}).get("Health") or (st or {}).get("State") or psu.get("status"),
                    "watts": psu.get("PowerOutputWatts") or psu.get("PowerInputWatts") or psu.get("OutputWatts"),
                }
            )
    bad = [s for s in supplies if not _health_ok(s.get("status")) and str(s.get("status") or "").lower() not in {"ok"}]
    if not supplies:
        return {"status": "FAIL", "failures": ["No PSUs reported"], "detail": "empty power inventory", "items": []}
    if bad:
        names = ", ".join(str(s.get("id") or "?") for s in bad)
        return {"status": "FAIL", "failures": [f"Unhealthy PSU: {names}"], "detail": f"{len(supplies)} PSU", "items": supplies}
    return {"status": "PASS", "failures": [], "detail": f"{len(supplies)} PSU OK", "items": supplies}


def check_voltage(ip: str, user: str, password: str) -> dict[str, Any]:
    power = _rf_first(ip, user, password, _POWER_PATHS)
    volts = [v for v in (power.get("Voltages") or []) if isinstance(v, dict)]
    if not volts:
        sensors = _rf_first(ip, user, password, _SENSOR_PATHS)
        for s in _expand(ip, user, password, sensors) if not sensors.get("_error") else []:
            reading_type = str(s.get("ReadingType") or s.get("Name") or "").lower()
            if "volt" in reading_type:
                volts.append(s)
    if not volts:
        return {"status": "SKIP", "failures": [], "detail": "No voltage sensors on this BMC", "items": []}
    bad: list[str] = []
    items = []
    for v in volts:
        st = v.get("Status") if isinstance(v.get("Status"), dict) else {}
        health = (st or {}).get("Health") or v.get("Health")
        reading = v.get("ReadingVolts") or v.get("Reading")
        name = v.get("Name") or v.get("Id")
        lo = v.get("LowerThresholdCritical")
        hi = v.get("UpperThresholdCritical")
        err = None
        if health and not _health_ok(health) and str(health).lower() != "ok":
            err = f"{name}: health {health}"
        elif isinstance(reading, (int, float)) and isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
            if reading < lo or reading > hi:
                err = f"{name}: {reading}V outside {lo}-{hi}"
        items.append({"name": name, "reading": reading, "health": health, "error": err or "OK"})
        if err:
            bad.append(err)
    if bad:
        return {"status": "FAIL", "failures": bad[:12], "detail": f"{len(bad)} rail(s) out of spec", "items": items}
    return {"status": "PASS", "failures": [], "detail": f"{len(items)} rails OK", "items": items}


def check_sel(ip: str, user: str, password: str) -> dict[str, Any]:
    body = _rf_first(ip, user, password, _SEL_PATHS, timeout=12.0)
    if body.get("_error"):
        return {"status": "SKIP", "failures": [], "detail": f"SEL unavailable ({body.get('_error')})", "items": []}
    entries = _expand(ip, user, password, body, limit=80) if _members(body) else [e for e in (body.get("Members") or []) if isinstance(e, dict)]
    crit: list[str] = []
    for entry in entries:
        sev = str(entry.get("Severity") or entry.get("EventSeverity") or "").lower()
        health = ""
        st = entry.get("Status") if isinstance(entry.get("Status"), dict) else {}
        if st:
            health = str(st.get("Health") or "").lower()
        msg = str(entry.get("Message") or entry.get("Description") or "")
        created = str(entry.get("Created") or entry.get("EventTimestamp") or "")
        blob = f"{sev} {health} {msg}".lower()
        if any(x in blob for x in ("critical", "emergency", "unrecoverable")) and "ok" not in sev:
            if any(x in blob for x in ("assert", "error", "fail", "leak", "overtemp", "unrecoverable", "critical")):
                crit.append(f"{created} {msg}".strip()[:180])
    if crit:
        return {"status": "FAIL", "failures": crit[:12], "detail": f"{len(crit)} critical SEL entries", "items": crit[:20]}
    return {"status": "PASS", "failures": [], "detail": f"{len(entries)} entries, no critical", "items": []}


def _check_result(status: str, failures: list[str] | None = None, detail: str = "", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {"status": status, "failures": failures or [], "detail": detail}
    if extra:
        out.update(extra)
    return out


def run_node(
    node: MaxLpsNode,
    checks: list[str],
    goldens: dict[str, Any],
    progress: Any = None,
) -> dict[str, Any]:
    label = _node_label(node)
    ip = (node.bmc_ip or "").strip()
    user = (node.bmc_user or "root").strip() or "root"
    password = node.bmc_password or ""
    result: dict[str, Any] = {
        "label": label,
        "serial": node.serial,
        "hostname": node.hostname,
        "bmc_ip": ip,
        "os_ip": node.os_ip,
        "overall": "RUNNING",
        "timestamp": _now(),
        "skip_reason": None,
        "checks": {},
        "bom": None,
        "log": [],
    }

    def note(text: str) -> None:
        result["log"].append(f"{_now()[11:19]} {text}")
        if progress:
            snap = {k: v for k, v in result.items() if k != "bom"}
            progress(label, snap)
    note(f"{label} {node.hostname or ''} {ip or 'no BMC IP'}".strip())
    if not ip:
        result["skip_reason"] = "no BMC IP"
        result["overall"] = "SKIP"
        note("skip: no BMC IP")
        for cid in checks:
            result["checks"][cid] = _check_result("SKIP", detail="no BMC IP")
        return result
    if not password:
        result["skip_reason"] = "no BMC login stored"
        result["overall"] = "SKIP"
        note("skip: no BMC login stored")
        for cid in checks:
            result["checks"][cid] = _check_result("SKIP", detail="no BMC login stored")
        return result

    firmware: dict[str, Any] = {}
    software: dict[str, Any] = {}
    bom: dict[str, Any] = {}
    script_bom: dict[str, Any] | None = None
    need_script = any(c in checks for c in ("fw", "sw", "bom", "psu")) and (node.os_ip or "").strip() and node.os_password
    if need_script:
        note("reading inventory on the node")
        try:
            script_bom = _capture_with_script(node)
            note("inventory read")
        except Exception as exc:
            note(f"inventory script failed: {exc}")
    need_fw = any(c in checks for c in ("fw", "bom"))
    need_sw = any(c in checks for c in ("sw", "bom"))
    if script_bom:
        fwsec = script_bom.get("firmware") if isinstance(script_bom.get("firmware"), dict) else {}
        system = script_bom.get("system") if isinstance(script_bom.get("system"), dict) else {}
        swsec = script_bom.get("software") if isinstance(script_bom.get("software"), dict) else {}
        gpu = script_bom.get("accelerators_gpu") if isinstance(script_bom.get("accelerators_gpu"), dict) else {}
        firmware = {
            "bios_version": fwsec.get("bios_version"),
            "bmc_version": fwsec.get("bmc_version"),
            "cpld_version": fwsec.get("cpld_version"),
            "bkc_version": fwsec.get("bkc_version"),
            "global_vbios": gpu.get("global_vbios"),
            "inventory": True,
        }
        software = {
            "ok": True,
            "os_version": system.get("os_version"),
            "kernel_version": system.get("kernel_version"),
            "driver": swsec.get("driver"),
            "cuda": swsec.get("cuda"),
            "ofed": swsec.get("ofed"),
            "dcgm": swsec.get("dcgm"),
        }
        bom = script_bom
        result["bom"] = bom
    else:
        if need_fw:
            note("fw: reading BMC")
            firmware = collect_firmware(ip, user, password)
        if need_sw:
            note("sw: reading OS")
            software = collect_software(node)
        if "bom" in checks or "fw" in checks:
            bom = collect_bom(ip, user, password, node, firmware or {}, software or {})
            result["bom"] = bom

    if "fw" in checks:
        ref = goldens.get("fw") if isinstance(goldens.get("fw"), dict) else None
        live = {
            "bios_version": firmware.get("bios_version"),
            "bmc_version": firmware.get("bmc_version"),
            "cpld_version": firmware.get("cpld_version"),
            "bkc_version": firmware.get("bkc_version"),
            "global_vbios": firmware.get("global_vbios"),
        }
        if firmware.get("inventory") is None and firmware.get("bios_version") == "N/A" and firmware.get("bmc_version") == "N/A":
            result["checks"]["fw"] = _check_result("FAIL", ["Firmware inventory unreachable"], "BMC firmware read failed")
            note("fw: FAIL BMC firmware read failed")
        elif not ref:
            result["checks"]["fw"] = _check_result("SKIP", detail="no firmware golden — capture or upload", extra={"live": live})
        else:
            diffs = []
            compared = 0
            for key, title in (("bios_version", "BIOS"), ("bmc_version", "BMC"), ("cpld_version", "CPLD"), ("bkc_version", "Bundle"), ("global_vbios", "GPU VBIOS")):
                if _blank_ref(ref.get(key)):
                    continue
                compared += 1
                if _blank_ref(live.get(key)):
                    continue
                if not _same(ref.get(key), live.get(key)):
                    diffs.append(f"{title}: ref { _na(ref.get(key)) } vs { _na(live.get(key)) }")
            if compared == 0:
                live_bits = ", ".join(f"{title} {_na(live.get(key))}" for key, title in (("bios_version", "BIOS"), ("bmc_version", "BMC"), ("cpld_version", "CPLD")) if not _blank_ref(live.get(key)))
                result["checks"]["fw"] = _check_result("SKIP", detail="golden has no firmware values — capture golden" + (f" ({live_bits})" if live_bits else ""), extra={"live": live})
            else:
                result["checks"]["fw"] = _check_result("FAIL" if diffs else "PASS", diffs, "vs fw_golden.json", extra={"live": live})
            note(f"fw: {result['checks']['fw']['status']}")

    if "sw" in checks:
        ref = goldens.get("sw") if isinstance(goldens.get("sw"), dict) else None
        if not software.get("ok") and software.get("os_version") == "N/A":
            result["checks"]["sw"] = _check_result("SKIP", detail=software.get("error") or "OS SSH unreachable")
        elif not ref:
            result["checks"]["sw"] = _check_result("SKIP", detail="no software golden — capture or upload", extra={"live": software})
        else:
            diffs = []
            compared = 0
            for key, title in (("os_version", "OS"), ("kernel_version", "Kernel"), ("driver", "Driver"), ("cuda", "CUDA"), ("ofed", "OFED")):
                if key not in ref or _blank_ref(ref.get(key)):
                    continue
                compared += 1
                if not _same(ref.get(key), software.get(key)):
                    diffs.append(f"{title}: ref {_na(ref.get(key))} vs {_na(software.get(key))}")
            if compared == 0:
                result["checks"]["sw"] = _check_result("SKIP", detail=f"golden has no software values — capture golden (OS {_na(software.get('os_version'))})", extra={"live": software})
            else:
                result["checks"]["sw"] = _check_result("FAIL" if diffs else "PASS", diffs, "vs sw_golden.json", extra={"live": software})
            note(f"sw: {result['checks']['sw']['status']}")

    if "bom" in checks:
        ref = goldens.get("bom") if isinstance(goldens.get("bom"), dict) else None
        if not ref:
            result["checks"]["bom"] = _check_result("SKIP", detail="no BOM golden — capture or upload")
        elif not bom:
            result["checks"]["bom"] = _check_result("FAIL", ["BOM capture failed"])
        else:
            diffs = compare_bom(ref, bom)
            if not diffs and not any(not _blank_ref(_dig(ref, path)) for _label, path in _BOM_ROWS):
                result["checks"]["bom"] = _check_result("SKIP", detail="golden BOM is empty — capture golden")
            else:
                result["checks"]["bom"] = _check_result(
                    "FAIL" if diffs else "PASS",
                    [f"{d['label']}: ref {d['ref']} vs {d['sys']}" for d in diffs],
                    f"{len(diffs)} diffs" if diffs else "matches golden",
                    extra={"diffs": diffs},
                )

    if "psu" in checks:
        supplies = _dig(script_bom or {}, ("power_and_fan", "power_supplies"))
        if isinstance(supplies, list) and supplies:
            result["checks"]["psu"] = _check_result("PASS", detail=f"{len(supplies)} PSU from the host", extra={"items": supplies})
            note(f"psu: PASS")
        else:
            note("psu: reading sensors")
            result["checks"]["psu"] = check_psu(ip, user, password)
            if result["checks"]["psu"].get("status") == "FAIL" and "404" in str(result["checks"]["psu"].get("failures")):
                result["checks"]["psu"] = _check_result("SKIP", detail="BMC has no Redfish power resource")
            note(f"psu: {result['checks']['psu'].get('status')}")
    if "voltage" in checks:
        note("voltage: reading sensors")
        result["checks"]["voltage"] = check_voltage(ip, user, password)
        note(f"voltage: {result['checks']['voltage'].get('status')}")
    if "sel" in checks:
        note("sel: reading log")
        result["checks"]["sel"] = check_sel(ip, user, password)
        note(f"sel: {result['checks']['sel'].get('status')}")

    statuses = [str((result["checks"].get(c) or {}).get("status") or "SKIP") for c in checks]
    if any(s == "FAIL" for s in statuses):
        result["overall"] = "FAIL"
    elif all(s in {"PASS", "SKIP"} for s in statuses) and any(s == "PASS" for s in statuses):
        result["overall"] = "PASS"
    elif all(s == "SKIP" for s in statuses):
        result["overall"] = "SKIP"
    else:
        result["overall"] = "FAIL"
    note(f"done {result['overall']}")
    return result


def _blank_status(nodes: list[MaxLpsNode], checks: list[str], rack: MaxLpsRack, job_id: str) -> dict[str, Any]:
    table: dict[str, Any] = {}
    for node in nodes:
        label = _node_label(node)
        table[label] = {
            "label": label,
            "serial": node.serial,
            "hostname": node.hostname,
            "overall": "RUNNING",
            "timestamp": None,
            "checks": {cid: {"status": "RUNNING", "failures": [], "detail": ""} for cid in checks},
        }
    return {
        "job_id": job_id,
        "status": "running",
        "overall": "RUNNING",
        "rack_serial": rack.serial or rack.id,
        "rack_label": rack.label,
        "started_at": _now(),
        "finished_at": None,
        "checks": CHECKS,
        "nodes": table,
    }


def job_running() -> bool:
    with _LOCK:
        return bool(_JOB.get("running"))


def stop_job() -> dict[str, Any]:
    _STOP.set()
    with _LOCK:
        running = bool(_JOB.get("running"))
    return {"stopped": running}


def _write_run(payload: dict[str, Any]) -> Path:
    _ensure_dirs()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    serial = re.sub(r"[^A-Za-z0-9._-]+", "_", str(payload.get("rack_serial") or "rack"))[:40]
    path = RUNS_DIR / f"sanity_{serial}_{stamp}.json"
    _dump_json(path, payload)
    latest = RUNS_DIR / "sanity_latest.json"
    _dump_json(latest, payload)
    return path


def _run_job(nodes: list[MaxLpsNode], checks: list[str], rack: MaxLpsRack, job_id: str) -> None:
    goldens = {
        "bom": load_golden("bom") if isinstance(load_golden("bom"), dict) else None,
        "fw": load_golden("fw") if isinstance(load_golden("fw"), dict) else None,
        "sw": load_golden("sw") if isinstance(load_golden("sw"), dict) else None,
    }
    payload = _blank_status(nodes, checks, rack, job_id)
    workers = min(6, max(1, len(nodes)))

    def publish(label: str, snap: dict[str, Any]) -> None:
        with _LOCK:
            row = payload["nodes"].get(label) or {}
            row.update(snap)
            payload["nodes"][label] = row
            _dump_json(RUNS_DIR / "sanity_latest.json", payload)

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(run_node, node, checks, goldens, publish): node for node in nodes}
            for fut in as_completed(futs):
                if _STOP.is_set():
                    break
                node = futs[fut]
                label = _node_label(node)
                try:
                    row = fut.result()
                except Exception as exc:
                    row = {
                        "label": label,
                        "serial": node.serial,
                        "hostname": node.hostname,
                        "overall": "FAIL",
                        "skip_reason": str(exc)[:180],
                        "timestamp": _now(),
                        "checks": {cid: {"status": "FAIL", "failures": [str(exc)[:180]], "detail": ""} for cid in checks},
                    }
                payload["nodes"][label] = row
                _dump_json(RUNS_DIR / "sanity_latest.json", payload)
        overall = "PASS"
        if _STOP.is_set():
            overall = "STOPPED"
        else:
            rows = list(payload["nodes"].values())
            if any(r.get("overall") == "FAIL" for r in rows):
                overall = "FAIL"
            elif rows and all(r.get("overall") == "SKIP" for r in rows):
                overall = "SKIP"
        payload["overall"] = overall
        payload["status"] = "done"
        payload["finished_at"] = _now()
        path = _write_run(payload)
        payload["result_file"] = path.name
        _dump_json(RUNS_DIR / "sanity_latest.json", payload)
    except Exception as exc:
        payload["status"] = "done"
        payload["overall"] = "FAIL"
        payload["error"] = str(exc)[:240]
        payload["finished_at"] = _now()
        _dump_json(RUNS_DIR / "sanity_latest.json", payload)
    finally:
        with _LOCK:
            _JOB["running"] = False
            _JOB["kind"] = None


def start_sanity(
    db: Session,
    *,
    rack_serial: str | None = None,
    rack_name: str | None = None,
    node_macs: list[str] | None = None,
    checks: list[str] | None = None,
) -> dict[str, Any]:
    if job_running():
        return {"ok": False, "error": "a sanity job is already running", **load_status(rack_serial)}
    named = (rack_serial or rack_name or "").strip()
    rack = pick_rack(db, rack_serial, rack_name)
    if rack is None:
        if named:
            return {"ok": False, "error": f"no rack matches {named}"}
        return {"ok": False, "error": "no rack in inventory"}
    picked = _pick_nodes(rack, node_macs)
    if node_macs and not picked:
        return {"ok": False, "error": "node not found on this rack"}
    nodes = picked if node_macs else [node for node in picked if node_has_serial(node.serial) or (node.bmc_ip or "").strip()]
    if not nodes:
        return {"ok": False, "error": "no nodes with a serial or BMC address on this rack"}
    want = [c for c in (checks or CHECK_IDS) if c in CHECK_IDS] or list(CHECK_IDS)
    job_id = uuid.uuid4().hex[:12]
    _STOP.clear()
    payload = _blank_status(nodes, want, rack, job_id)
    _dump_json(RUNS_DIR / "sanity_latest.json", payload)
    with _LOCK:
        _JOB.update(
            {
                "running": True,
                "job_id": job_id,
                "kind": "sanity",
                "started_at": payload["started_at"],
                "rack_serial": rack.serial,
                "rack_label": rack.label,
            }
        )
    thread = threading.Thread(target=_run_job, args=(list(nodes), want, rack, job_id), daemon=True)
    globals()["_THREAD"] = thread
    thread.start()
    return {"ok": True, "job_id": job_id, **payload, "golden": golden_status()}


def _bom_has_data(bom: dict[str, Any]) -> bool:
    bios = _dig(bom, ("firmware", "bios_version"))
    os_ver = _dig(bom, ("system", "os_version"))
    return not _blank_ref(bios) or not _blank_ref(os_ver)


def _capture_with_script(node: Any) -> dict[str, Any]:
    """Run trilsanitychk on the node and return the JSON it writes."""
    import shlex

    host = (getattr(node, "os_ip", None) or "").strip()
    user = (getattr(node, "os_username", None) or "root").strip() or "root"
    password = getattr(node, "os_password", None) or ""
    if not host or not password:
        raise RuntimeError("OS SSH is not configured on this node")
    script = SCRIPTS_DIR / "sanitycheck/02-bom_checks/01-trilsanitychk.sh"
    if not script.is_file():
        raise RuntimeError("BOM script is missing")
    bmc_user = (getattr(node, "bmc_user", None) or "root").strip() or "root"
    bmc_pwd = getattr(node, "bmc_password", None) or ""
    bmc_ip = (getattr(node, "bmc_ip", None) or "").strip()
    if not bmc_ip or not bmc_pwd:
        raise RuntimeError("node has no BMC IP or password to give the sanity script")
    remote = "/tmp/l12-trilsanitychk.sh"
    out_path = "/tmp/l12-golden-bom.json"
    client = _open_ssh(host, user, password)
    try:
        sftp = client.open_sftp()
        try:
            sftp.put(str(script), remote)
        finally:
            sftp.close()
        cmd = (
            f"bash {remote} --bmc-ip {shlex.quote(bmc_ip)} "
            f"--bmc-user {shlex.quote(bmc_user)} --bmc-pwd {shlex.quote(bmc_pwd)} "
            f"--export {out_path}"
        )
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        stdout.read()
        sftp = client.open_sftp()
        try:
            with sftp.open(out_path, "r") as handle:
                raw = handle.read().decode("utf-8", "replace")
        finally:
            sftp.close()
    finally:
        try:
            client.close()
        except Exception:
            pass
    try:
        bom = json.loads(raw)
    except json.JSONDecodeError as exc:
        tail = (err or raw or "")[-400:]
        raise RuntimeError(f"BOM script did not write JSON ({exc}). {tail}") from exc
    if not isinstance(bom, dict):
        raise RuntimeError("BOM script wrote something that is not a JSON object")
    if code not in (0, None) and not _bom_has_data(bom):
        raise RuntimeError((err or "BOM script failed")[-400:])
    return bom


def _save_captured(node: Any, bom: dict[str, Any], firmware: dict[str, Any], software: dict[str, Any], note: str) -> None:
    fw = bom.get("firmware") if isinstance(bom.get("firmware"), dict) else {}
    sw = bom.get("software") if isinstance(bom.get("software"), dict) else {}
    system = bom.get("system") if isinstance(bom.get("system"), dict) else {}
    gpu = bom.get("accelerators_gpu") if isinstance(bom.get("accelerators_gpu"), dict) else {}
    save_golden("bom", bom)
    save_golden(
        "fw",
        {
            "bios_version": fw.get("bios_version") or firmware.get("bios_version"),
            "bmc_version": fw.get("bmc_version") or firmware.get("bmc_version"),
            "cpld_version": fw.get("cpld_version") or firmware.get("cpld_version"),
            "bkc_version": fw.get("bkc_version") or firmware.get("bkc_version"),
            "global_vbios": gpu.get("global_vbios") or firmware.get("global_vbios"),
            "captured_from": getattr(node, "serial", None) or getattr(node, "hostname", None),
            "captured_at": _now(),
        },
    )
    save_golden(
        "sw",
        {
            "os_version": system.get("os_version") or software.get("os_version"),
            "kernel_version": system.get("kernel_version") or software.get("kernel_version"),
            "driver": sw.get("driver") or software.get("driver"),
            "cuda": sw.get("cuda") or software.get("cuda"),
            "ofed": sw.get("ofed") or software.get("ofed"),
            "dcgm": sw.get("dcgm") or software.get("dcgm"),
            "captured_from": getattr(node, "serial", None) or getattr(node, "hostname", None),
            "captured_at": _now(),
        },
    )
    save_golden("log", note)


def _capture_age() -> float:
    started = _CAPTURE.get("started_at")
    if not started:
        return 0
    try:
        then = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
    except ValueError:
        return 10**9
    return (datetime.now(timezone.utc) - then).total_seconds()


def _finish_capture(gen: int, **fields: Any) -> None:
    if _CAPTURE.get("gen") != gen:
        return
    _CAPTURE.update(running=False, finished_at=_now(), **fields)


def _capture_job(node: Any, gen: int) -> None:
    label = getattr(node, "hostname", None) or getattr(node, "serial", None) or "node"
    try:
        bom = _capture_with_script(node)
        if not _bom_has_data(bom):
            raise RuntimeError("BOM script ran but BIOS and OS were still empty")
        note = (
            f"Golden capture {_now()}\n"
            f"  node: {label}\n"
            f"  source: trilsanitychk on {getattr(node, 'os_ip', None) or '-'}\n"
            f"  BIOS {_dig(bom, ('firmware', 'bios_version'))} BMC {_dig(bom, ('firmware', 'bmc_version'))}\n"
            f"  OS {_dig(bom, ('system', 'os_version'))} kernel {_dig(bom, ('system', 'kernel_version'))}\n"
        )
        _save_captured(node, bom, {}, {}, note)
        _finish_capture(gen, error=None, node=label)
    except Exception as script_exc:
        ip = (getattr(node, "bmc_ip", None) or "").strip()
        user = (getattr(node, "bmc_user", None) or "root").strip() or "root"
        password = getattr(node, "bmc_password", None) or ""
        try:
            firmware = collect_firmware(ip, user, password) if ip and password else {}
            software = collect_software(node)
            bom = collect_bom(ip, user, password, node, firmware or {}, software or {})
        except Exception as exc:
            _finish_capture(gen, error=str(exc)[:240], node=label)
            return
        if not _bom_has_data(bom):
            detail = str(script_exc)
            extra = software.get("error")
            if extra and extra not in detail:
                detail = f"{detail}; {extra}"
            _finish_capture(gen, error=f"Nothing captured. {detail}"[:240], node=label)
            return
        note = (
            f"Golden capture {_now()} (Redfish fallback)\n"
            f"  node: {label}\n"
            f"  script failed: {script_exc}\n"
            f"  BIOS {firmware.get('bios_version')} OS {software.get('os_version')}\n"
        )
        _save_captured(node, bom, firmware, software, note)
        _finish_capture(gen, error=None, node=label)
    finally:
        _finish_capture(gen, error=_CAPTURE.get("error"), node=label)


def capture_golden(db: Session, *, rack_serial: str | None = None, rack_name: str | None = None, node: str | None = None) -> dict[str, Any]:
    if _CAPTURE.get("running") and _capture_age() < 480:
        return {"ok": True, "running": True, "node": {"hostname": _CAPTURE.get("node")}, "golden": golden_status()}
    named = (rack_serial or rack_name or "").strip()
    rack = pick_rack(db, rack_serial, rack_name)
    if rack is None:
        if named:
            return {"ok": False, "error": f"no rack matches {named}"}
        return {"ok": False, "error": "no rack in inventory"}
    target: MaxLpsNode | None = None
    needle = (node or "").strip().lower()
    for n in rack.nodes:
        if not needle or _node_selected(n, needle):
            target = n
            break
    if target is None:
        return {"ok": False, "error": "node not found"}
    if not (target.os_ip or "").strip() or not target.os_password:
        return {"ok": False, "error": "node has no OS IP or password"}
    snap = SimpleNamespace(
        id=target.id,
        hostname=target.hostname,
        serial=target.serial,
        os_ip=target.os_ip,
        os_username=target.os_username,
        os_password=target.os_password,
        bmc_ip=target.bmc_ip,
        bmc_user=target.bmc_user,
        bmc_password=target.bmc_password,
    )
    label = target.hostname or target.serial or "node"
    gen = int(_CAPTURE.get("gen") or 0) + 1
    _CAPTURE.update(running=True, error=None, finished_at=None, started_at=_now(), node=label, gen=gen)
    thread = threading.Thread(target=_capture_job, args=(snap, gen), name="golden-capture", daemon=True)
    thread.start()
    return {"ok": True, "running": True, "node": {"serial": target.serial, "hostname": target.hostname, "label": _node_label(target)}, "golden": golden_status()}


def run_script_ssh(node: MaxLpsNode, script_id: str, timeout: int = 90) -> dict[str, Any]:
    spec = next((s for s in SCRIPTS if s["id"] == script_id), None)
    if spec is None:
        return {"ok": False, "error": "unknown script"}
    path = SCRIPTS_DIR / spec["entry"]
    if not path.is_file():
        return {"ok": False, "error": f"script missing: {spec['entry']}"}
    host = (node.os_ip or "").strip()
    user = (node.os_username or "root").strip() or "root"
    password = node.os_password or ""
    if not host or not password:
        return {"ok": False, "error": "OS SSH not configured on this node"}
    import paramiko

    remote = f"/tmp/l12_{script_id}.sh"
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            host,
            username=user,
            password=password,
            timeout=8,
            allow_agent=False,
            look_for_keys=False,
            banner_timeout=8,
            auth_timeout=8,
        )
        sftp = client.open_sftp()
        try:
            sftp.put(str(path), remote)
        finally:
            sftp.close()
        _stdin, stdout, stderr = client.exec_command(f"bash {remote}", timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:220], "script": spec["id"]}
    finally:
        try:
            client.close()
        except Exception:
            pass
    _ensure_dirs()
    log_path = RUNS_DIR / f"script_{script_id}_{int(time.time())}.log"
    log_path.write_text(out + ("\n" + err if err else ""), encoding="utf-8", errors="replace")
    return {
        "ok": code == 0,
        "script": spec["id"],
        "exit": code,
        "stdout": out[-8000:],
        "stderr": err[-2000:],
        "log": log_path.name,
        "node": node.hostname or node.serial,
    }
