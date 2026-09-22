"""SSH jump through the PXE server to BMC networks (SOL + KVM tunnel)."""

from __future__ import annotations

import base64
import concurrent.futures
import gzip
import http.client
import json
import re
import shlex
import socket
import ssl
import threading
import time
from typing import Any

import paramiko

from .config import settings

_TLS = ssl._create_unverified_context()

_client: paramiko.SSHClient | None = None
_user: str | None = None
_host: str | None = None
_tunnels: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
_scripts_ready = False


class NeedsHop(RuntimeError):
    pass


def status() -> dict[str, Any]:
    with _lock:
        ok = _client is not None and _client.get_transport() is not None and _client.get_transport().is_active()
        return {
            "connected": bool(ok),
            "host": _host or settings.cluster_pxe_host,
            "user": _user or settings.cluster_pxe_user,
            "tunnels": {k: {"port": v["port"], "bmc_ip": v["bmc_ip"]} for k, v in _tunnels.items()},
        }


def close() -> None:
    global _client, _user, _host, _scripts_ready
    _scripts_ready = False
    try:
        from . import gpu_power

        gpu_power._note_hop_down()
    except Exception:
        pass
    with _lock:
        for item in list(_tunnels.values()):
            item["alive"] = False
            sock = item.get("sock")
            if sock:
                try:
                    sock.close()
                except OSError:
                    pass
        _tunnels.clear()
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
        _client = None
        _user = None
        _host = None


def connect(username: str | None = None, password: str | None = None, host: str | None = None) -> dict[str, Any]:
    global _client, _user, _host
    user = (username or settings.cluster_pxe_user or "root").strip()
    host = (host or settings.cluster_pxe_host or "").strip()
    if not host:
        raise RuntimeError("PXE host IP is required")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            username=user,
            password=password or None,
            look_for_keys=not bool(password),
            allow_agent=not bool(password),
            timeout=12,
            auth_timeout=12,
            banner_timeout=12,
        )
    except paramiko.AuthenticationException as exc:
        raise NeedsHop("PXE host rejected the login") from exc
    except Exception as exc:
        raise RuntimeError(f"cannot reach PXE host {host}: {exc}") from exc
    close()
    with _lock:
        _client = client
        _user = user
        _host = host
    transport = client.get_transport()
    if transport is not None:
        transport.set_keepalive(30)
    # sanity
    code, out, err = run("echo hop-ok && hostname")
    if code != 0 or "hop-ok" not in (out or ""):
        close()
        raise RuntimeError(err or "PXE hop failed")
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    try:
        from . import gpu_power

        gpu_power.force_live_gpu_poll()
    except Exception:
        pass
    return status()


def _ssh() -> paramiko.SSHClient:
    with _lock:
        if _client is None or _client.get_transport() is None or not _client.get_transport().is_active():
            raise NeedsHop("Connect to the PXE jump host first")
        return _client


def run(command: str, timeout: float = 20.0, stdin_data: str | None = None) -> tuple[int, str, str]:
    client = _ssh()
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_data is not None:
        stdin.write(stdin_data)
        stdin.channel.shutdown_write()
    stdout.channel.settimeout(timeout)
    try:
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    except Exception as exc:
        return 1, "", str(exc)
    return int(code), out, err


def _pipe(src, dst) -> None:
    send = getattr(dst, "sendall", None) or getattr(dst, "send")
    recv = getattr(src, "recv")
    try:
        while True:
            data = recv(32768)
            if not data:
                break
            send(data)
    except Exception:
        pass
    for side in (dst, src):
        try:
            side.close()
        except Exception:
            pass


# Userspace TCP pipe on the PXE host — does not need sshd AllowTcpForwarding
# to the BMC network (direct-tcpip is often disabled on jump hosts).
_HOP_PIPE = r"""
import os, select, socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.create_connection((host, port), 20)
fd = s.fileno()
try:
    while True:
        r, _, _ = select.select([0, fd], [], [], 120)
        if not r:
            continue
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                break
            s.sendall(data)
        if fd in r:
            data = s.recv(65536)
            if not data:
                break
            os.write(1, data)
finally:
    try:
        s.close()
    except Exception:
        pass
"""

_HOP_HTTP = r"""
import base64, json, ssl, sys, urllib.error, urllib.request
spec = json.loads(sys.stdin.read())
ctx = ssl._create_unverified_context()
url = spec["url"]
body = base64.b64decode(spec["body"]) if spec.get("body") else None
req = urllib.request.Request(url, data=body, method=spec["method"])
for k, v in (spec.get("headers") or {}).items():
    if v:
        req.add_header(k, v)
def pack(msg, status, data):
    headers = {}
    cookies = []
    if msg is not None:
        get_all = getattr(msg, "get_all", None)
        if get_all:
            cookies = get_all("set-cookie") or get_all("Set-Cookie") or []
        for k, v in msg.items():
            if k.lower() == "set-cookie":
                continue
            headers[k.lower()] = v
    if cookies:
        headers["set-cookie"] = "\n".join(cookies)
    json.dump({"status": int(status), "headers": headers, "body": base64.b64encode(data or b"").decode("ascii")}, sys.stdout)

try:
    with urllib.request.urlopen(req, context=ctx, timeout=float(spec.get("timeout") or 20)) as r:
        pack(r.headers, r.status, r.read())
except urllib.error.HTTPError as e:
    pack(e.headers, e.code, e.read() or b"")
except Exception as e:
    json.dump({"status": 502, "headers": {}, "body": "", "error": str(e)}, sys.stdout)
"""


_HOP_GPU_POWER = r"""
import base64, concurrent.futures, json, ssl, sys, threading, time, urllib.error, urllib.request
spec = json.loads(sys.stdin.read() or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 1.2)
interval = float(spec.get("interval") or 1)
loop = bool(spec.get("loop"))
_print_lock = threading.Lock()

def emit(obj):
    with _print_lock:
        json.dump(obj, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()

def get(url, user, password):
    req = urllib.request.Request(url, method="GET")
    token = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    req.add_header("Authorization", "Basic " + token)
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            code = int(getattr(r, "status", None) or r.getcode())
            try:
                return code, json.loads(raw or "{}")
            except Exception:
                return code, {"_error": "parse"}
    except urllib.error.HTTPError as e:
        return e.code, {"_error": "HTTP %s" % e.code}
    except Exception as e:
        return 0, {"_error": str(e)}

def gpu_num(name):
    parts = str(name or "").replace("/", "_").split("_")
    for p in reversed(parts):
        if p.isdigit():
            return int(p)
    return None

def parse_metrics(body):
    pw = body.get("PowerWatts") if isinstance(body.get("PowerWatts"), dict) else {}
    pl = body.get("PowerLimitWatts") if isinstance(body.get("PowerLimitWatts"), dict) else {}
    oem = (body.get("Oem") or {}).get("Nvidia") if isinstance(body.get("Oem"), dict) else {}
    base = oem.get("GPUBasePowerWatts") if isinstance(oem, dict) and isinstance(oem.get("GPUBasePowerWatts"), dict) else {}
    reading = pw.get("Reading")
    if reading is None:
        reading = pl.get("Reading")
    if reading is None:
        reading = base.get("Reading")
    amin = pl.get("AllowableMin")
    if amin is None:
        amin = base.get("AllowableMin")
    amax = pl.get("AllowableMax")
    if amax is None:
        amax = base.get("AllowableMax")
    sp = pl.get("SetPoint")
    if sp is None:
        sp = base.get("SetPoint")
    return {"watts": reading, "min_w": amin, "max_w": amax, "setpoint_w": sp}

def fetch_bmc(target):
    ip = target.get("bmc_ip") or ""
    user = target.get("user") or "root"
    password = target.get("password") or ""
    out = {"bmc_ip": ip, "gpus": [], "error": None}
    if not ip:
        out["error"] = "no-ip"
        return out
    last_st = [0]
    def one(name):
        path = "/redfish/v1/Systems/HGX_Baseboard_0/Processors/%s" % name
        st_m, body = get("https://%s%s/EnvironmentMetrics" % (ip, path), user, password)
        last_st[0] = st_m
        if st_m != 200 or not isinstance(body, dict) or body.get("_error"):
            return None
        row = parse_metrics(body)
        if row.get("watts") is None:
            return None
        row["id"] = name
        row["processor"] = name
        row["path"] = path + "/EnvironmentMetrics"
        row["raw_index"] = gpu_num(name)
        return row
    def pull(names):
        rows = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(names))) as ex:
            for row in ex.map(one, names):
                if row:
                    rows.append(row)
        return rows
    raw = pull(["GPU_0", "GPU_1", "GPU_2", "GPU_3"])
    if not raw:
        raw = pull(["GPU_SXM_0", "GPU_SXM_1", "GPU_SXM_2", "GPU_SXM_3"])
    zero = any(g.get("raw_index") == 0 for g in raw)
    used = set()
    for g in raw:
        ri = g.get("raw_index")
        if ri is None:
            continue
        idx = ri + 1 if zero else ri
        if idx < 1 or idx in used:
            continue
        used.add(idx)
        g["index"] = idx
        out["gpus"].append(g)
    if not out["gpus"]:
        out["error"] = "HTTP %s" % last_st[0] if last_st[0] else "no-gpu-metrics"
    return out

def fetch_and_emit(target):
    row = fetch_bmc(target)
    emit(row)
    return row

targets = spec.get("targets") or []
n = max(1, min(18, len(targets) or 1))

def once():
    nodes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        for row in ex.map(fetch_and_emit if loop else fetch_bmc, targets):
            nodes.append(row)
    if not loop:
        json.dump({"ok": True, "nodes": nodes}, sys.stdout)
    else:
        emit({"ok": True, "round": True})

if not loop:
    once()
else:
    while True:
        t0 = time.time()
        once()
        dt = time.time() - t0
        if dt < interval:
            time.sleep(interval - dt)
"""


def _ensure_hop_scripts() -> None:
    global _scripts_ready
    if _scripts_ready:
        return
    run("cat > /tmp/l12-bmc-pipe.py", timeout=8, stdin_data=_HOP_PIPE)
    run("cat > /tmp/l12-bmc-http.py", timeout=8, stdin_data=_HOP_HTTP)
    run("cat > /tmp/l12-gpu-power.py", timeout=8, stdin_data=_HOP_GPU_POWER)
    run("cat > /tmp/l12-gpu-cap.py", timeout=8, stdin_data=_HOP_GPU_CAP)
    run("cat > /tmp/l12-psu-power.py", timeout=8, stdin_data=_HOP_PSU_POWER)
    _scripts_ready = True


_HOP_GPU_CAP = r"""
import base64, concurrent.futures, json, ssl, sys, urllib.error, urllib.request
spec = json.loads(sys.stdin.read() or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 8)

def patch_one(item):
    ip = item.get("bmc_ip") or ""
    path = item.get("path") or ""
    user = item.get("user") or "ADMIN"
    password = item.get("password") or ""
    sp = int(item.get("setpoint") or 0)
    url = "https://%s%s" % (ip, path)
    body = json.dumps({
        "PowerLimitWatts": {"SetPoint": sp},
        "Oem": {"Nvidia": {"PowerLimitPersistency": False}},
    }).encode()
    req = urllib.request.Request(url, data=body, method="PATCH")
    token = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    req.add_header("Authorization", "Basic " + token)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            code = int(getattr(r, "status", None) or r.getcode())
            r.read()
            return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": code}
    except urllib.error.HTTPError as e:
        return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": int(e.code), "error": str(e)}
    except Exception as e:
        return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": 0, "error": str(e)}

patches = spec.get("patches") or []
n = max(1, min(8, len(patches) or 1))
out = []
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
    for row in ex.map(patch_one, patches):
        out.append(row)
json.dump({"ok": True, "results": out}, sys.stdout)
"""


_HOP_PSU_POWER = r"""
import base64, concurrent.futures, json, ssl, sys, urllib.error, urllib.request, re
spec = json.loads(sys.stdin.read() or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 6)

def get(url, user, password):
    req = urllib.request.Request(url, method="GET")
    token = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    req.add_header("Authorization", "Basic " + token)
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            code = int(getattr(r, "status", None) or r.getcode())
            try:
                return code, json.loads(raw or "{}")
            except Exception:
                return code, {}
    except urllib.error.HTTPError as e:
        raw = (e.read() or b"").decode("utf-8", "replace")
        try:
            return int(e.code), json.loads(raw or "{}")
        except Exception:
            return int(e.code), {}
    except Exception as e:
        return 0, {"_error": str(e)}

def num(x):
    if isinstance(x, dict):
        for k in ("Value", "Reading", "PowerOutputWatts", "LastPowerOutputWatts", "PowerConsumedWatts", "PowerInputWatts"):
            if x.get(k) is not None and not isinstance(x.get(k), dict):
                try:
                    return float(x[k])
                except Exception:
                    pass
        return None
    if isinstance(x, (int, float)):
        return float(x)
    try:
        return float(x)
    except Exception:
        return None

def is_watt_unit(u):
    u = str(u or "").strip().lower()
    return u in ("w", "watt", "watts", "kw") or u.endswith("w")

def watt_points(obj, acc, depth=0):
    if depth > 6 or not isinstance(obj, dict):
        return
    name = str(obj.get("Name") or obj.get("Id") or obj.get("MemberId") or "")
    units = obj.get("ReadingUnits") or obj.get("Unit") or obj.get("Units") or ""
    for key in ("pout", "Pout", "pin", "Pin", "PowerWatts", "PowerOutputWatts", "LastPowerOutputWatts", "PowerConsumedWatts", "PowerInputWatts"):
        v = num(obj.get(key))
        if v is not None:
            acc.append((name or key, v, key))
    rtype = str(obj.get("ReadingType") or "").lower()
    if obj.get("Reading") is not None and (is_watt_unit(units) or rtype == "power"):
        v = num(obj.get("Reading"))
        if v is not None:
            acc.append((name, v, "Reading"))
    if obj.get("Value") is not None and (is_watt_unit(units) or rtype == "power"):
        v = num(obj.get("Value"))
        if v is not None:
            acc.append((name, v, "Value"))
    for k, v in obj.items():
        if str(k).startswith("@") or k in ("RelatedItem", "Links", "Status", "Thresholds"):
            continue
        if isinstance(v, dict):
            watt_points(v, acc, depth + 1)
        elif isinstance(v, list):
            for item in v[:24]:
                if isinstance(item, dict):
                    watt_points(item, acc, depth + 1)

def members(body):
    out = []
    for m in (body or {}).get("Members") or []:
        if isinstance(m, dict) and m.get("@odata.id"):
            out.append(m["@odata.id"])
    return out

def fetch_shelf(target):
    ip = target.get("bmc_ip") or ""
    user = target.get("user") or "root"
    password = target.get("password") or ""
    out = {"bmc_ip": ip, "psus": [], "total_w": None, "error": None}
    if not ip:
        out["error"] = "no-ip"
        return out
    host = "https://%s" % ip
    st, col = get(host + "/redfish/v1/Chassis", user, password)
    hrefs = members(col) if st == 200 else []
    if not hrefs:
        hrefs = ["/redfish/v1/Chassis/powershelf", "/redfish/v1/Chassis/PMC_0"]
    hits = []
    seen = set()
    extra = []
    for href in hrefs[:8]:
        path = href if str(href).startswith("/") else "/" + str(href)
        if path in seen:
            continue
        seen.add(path)
        st, ch = get(host + path, user, password)
        if st == 200 and isinstance(ch, dict):
            watt_points(ch, hits)
            for rel in ("Power", "Sensors", "EnvironmentMetrics", "PowerSubsystem"):
                link = ch.get(rel)
                if isinstance(link, dict) and link.get("@odata.id"):
                    extra.append(link["@odata.id"])
        extra.append(path + "/Power")
        extra.append(path + "/Sensors")
        extra.append(path + "/Sensors?$expand=Members")
        extra.append(path + "/EnvironmentMetrics")
        extra.append(path + "/PowerSubsystem")
        extra.append(path + "/PowerSubsystem/PowerSupplies")
        extra.append(path + "/Power/Oem/LiteOn/PowerUnits")
        extra.append(path + "/PowerUnits")
        extra.append(path + "/Sensors/TotalPowerOut")
        extra.append(path + "/Sensors/total_power")
    extra.append("/redfish/v1/Chassis/powershelf/Power/Oem/LiteOn/PowerUnits")
    extra.append("/redfish/v1/Chassis/powershelf/Sensors")
    extra.append("/redfish/v1/Chassis/chassis/Sensors")
    extra.append("/redfish/v1/Chassis/chassis/Power")
    for href in extra:
        path = href if str(href).startswith("/") else "/" + str(href)
        if path in seen:
            continue
        seen.add(path)
        st, body = get(host + path, user, password)
        if st != 200 or not isinstance(body, dict):
            continue
        watt_points(body, hits)
        kids = members(body)
        if "Sensor" in path or "PowerUnit" in path or "PowerSupplies" in path:
            for kid in kids[:40]:
                ident = str(kid).lower()
                if "Sensor" in path and not any(x in ident for x in ("power", "pout", "psu", "watt", "pin", "total")):
                    continue
                if kid in seen:
                    continue
                seen.add(kid)
                st2, body2 = get(host + kid, user, password)
                if st2 == 200 and isinstance(body2, dict):
                    watt_points(body2, hits)
    psus = []
    totals = []
    used = set()
    for name, watts, key in hits:
        label = ("%s %s" % (name, key)).lower()
        if "energy" in label or "kwh" in label or "joule" in label:
            continue
        if watts < 0 or watts > 40000:
            continue
        is_psu = bool(re.search(r"psu|powerdevice|power.?unit|power.?supply|pout|output.?power|ps[0-9]|pin\b", label))
        is_total = bool(re.search(r"totalpower|total_power|total power|consumed", label))
        if is_psu:
            ident = name or key
            if ident in used:
                continue
            used.add(ident)
            psus.append({"index": len(psus) + 1, "id": ident, "watts": watts})
        elif is_total or key in ("PowerConsumedWatts", "PowerWatts"):
            totals.append(watts)
    out["psus"] = psus
    if psus:
        out["total_w"] = sum(p["watts"] for p in psus)
    elif totals:
        out["total_w"] = max(totals)
    elif hits:
        # last resort: largest plausible shelf reading
        vals = [w for _n, w, _k in hits if 50 <= w <= 40000]
        if vals:
            out["total_w"] = max(vals)
    if out["total_w"] is None:
        out["error"] = "no-watt-reading"
    return out

targets = spec.get("targets") or []
n = max(1, min(8, len(targets) or 1))
nodes = []
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
    for row in ex.map(fetch_shelf, targets):
        nodes.append(row)
json.dump({"ok": True, "nodes": nodes}, sys.stdout)
"""


def _stdout_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        out = json.loads(text)
        return out if isinstance(out, dict) else {}
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            out = json.loads(text[start : end + 1])
            return out if isinstance(out, dict) else {}
        except Exception:
            return {}


def stream_gpu_environment_metrics(
    targets: list[dict[str, str]],
    on_event,
    *,
    interval: float = 1.0,
) -> None:
    """Run EnvironmentMetrics in a 1s loop on the hop; on_event(dict) per BMC line."""
    if not targets:
        return
    try:
        run("cat > /tmp/l12-gpu-power.py", timeout=8, stdin_data=_HOP_GPU_POWER)
    except Exception:
        try:
            _ensure_hop_scripts()
        except Exception:
            pass
    spec = json.dumps({"timeout": 1.2, "interval": interval, "loop": True, "targets": targets})
    client = _ssh()
    stdin, stdout, stderr = client.exec_command(
        "PYTHONUNBUFFERED=1 python3 -u /tmp/l12-gpu-power.py",
        timeout=None,
    )
    try:
        stdin.write(spec)
        stdin.channel.shutdown_write()
    except Exception:
        pass
    stdout.channel.settimeout(3.0)
    try:
        while True:
            try:
                line = stdout.readline()
            except Exception:
                if not status().get("connected"):
                    break
                continue
            if not line:
                break
            payload = _stdout_json(line)
            if payload:
                on_event(payload)
    finally:
        try:
            stdout.channel.close()
        except Exception:
            pass


def fetch_gpu_environment_metrics(targets: list[dict[str, str]], timeout: float = 20.0) -> dict[str, list[dict[str, Any]]]:
    """Per-GPU PowerWatts via BMC EnvironmentMetrics, run on the PXE hop."""
    if not targets:
        return {}
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    spec = json.dumps({"timeout": 1.2, "targets": targets})
    _code, out, err = run("PYTHONUNBUFFERED=1 python3 -u /tmp/l12-gpu-power.py", timeout=timeout, stdin_data=spec)
    payload = _stdout_json(out)
    if not payload:
        raise RuntimeError(err or f"GPU EnvironmentMetrics empty (exit {_code})")
    by_ip: dict[str, list[dict[str, Any]]] = {}
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        ip = str(node.get("bmc_ip") or "")
        if not ip:
            continue
        gpus = [g for g in (node.get("gpus") or []) if isinstance(g, dict) and g.get("watts") is not None]
        if gpus:
            by_ip[ip] = gpus
    return by_ip


def apply_gpu_setpoints(patches: list[dict[str, Any]], timeout: float = 45.0) -> list[dict[str, Any]]:
    """PATCH PowerLimitWatts.SetPoint on each GPU via the PXE hop."""
    if not patches:
        return []
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    spec = json.dumps({"timeout": 8, "patches": patches})
    code, out, err = run("python3 /tmp/l12-gpu-cap.py", timeout=timeout, stdin_data=spec)
    raw = (out or "").strip()
    if not raw:
        raise RuntimeError(err or f"GPU SetPoint PATCH empty (exit {code})")
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"GPU SetPoint parse: {exc} {(raw or err)[:160]}") from exc
    return list(payload.get("results") or [])


def _redfish_get(bmc_ip: str, path: str, user: str, password: str, timeout: float = 8.0) -> dict[str, Any]:
    status, _hdrs, data = https_request(
        bmc_ip,
        "GET",
        path,
        headers={**_basic_auth(user, password), "Accept": "application/json"},
        timeout=timeout,
        prefer_exec=True,
    )
    if status >= 400 or not data:
        return {"_error": f"HTTP {status}", "_path": path}
    try:
        return json.loads(data.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        return {"_error": str(exc), "_path": path}


def _num(x: Any) -> float | None:
    if isinstance(x, dict):
        for k in ("Value", "Reading", "PowerOutputWatts", "LastPowerOutputWatts", "PowerConsumedWatts", "PowerInputWatts"):
            v = x.get(k)
            if isinstance(v, (int, float)):
                return float(v)
            if isinstance(v, str):
                try:
                    return float(v)
                except ValueError:
                    continue
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return None
    return None


def _watt_hits(obj: Any, acc: list[tuple[str, float]], depth: int = 0) -> None:
    if depth > 5 or not isinstance(obj, dict):
        return
    name = str(obj.get("Name") or obj.get("Id") or obj.get("MemberId") or "")
    units = str(obj.get("ReadingUnits") or obj.get("Unit") or obj.get("Units") or "").lower()
    rtype = str(obj.get("ReadingType") or "").lower()
    for key in ("pout", "Pout", "pin", "Pin", "PowerWatts", "PowerOutputWatts", "LastPowerOutputWatts", "PowerConsumedWatts", "PowerInputWatts"):
        v = _num(obj.get(key))
        if v is not None:
            acc.append((name or key, v))
    if obj.get("Reading") is not None and (units in {"w", "watt", "watts"} or rtype == "power"):
        v = _num(obj.get("Reading"))
        if v is not None:
            acc.append((name or "Reading", v))
    for k, v in obj.items():
        if str(k).startswith("@") or k in {"RelatedItem", "Links", "Status", "Thresholds", "Oem"}:
            continue
        if isinstance(v, dict):
            _watt_hits(v, acc, depth + 1)
        elif isinstance(v, list):
            for item in v[:32]:
                if isinstance(item, dict):
                    _watt_hits(item, acc, depth + 1)


def _pmc_power_one(target: dict[str, str]) -> dict[str, Any]:
    ip = (target.get("bmc_ip") or "").strip()
    password = target.get("password") or ""
    users: list[str] = []
    for u in (target.get("user") or "", "root", "ADMIN", "admin"):
        if u and u not in users:
            users.append(u)
    out: dict[str, Any] = {"bmc_ip": ip, "psus": [], "total_w": None, "error": None}
    if not ip:
        out["error"] = "no-ip"
        return out
    col: dict[str, Any] = {}
    user = users[0] if users else "root"
    for u in users:
        col = _redfish_get(ip, "/redfish/v1/Chassis", u, password)
        if not col.get("_error"):
            user = u
            break
    hrefs = [
        str(m.get("@odata.id"))
        for m in (col.get("Members") or [])
        if isinstance(m, dict) and m.get("@odata.id")
    ]
    if not hrefs:
        hrefs = [
            "/redfish/v1/Chassis/powershelf",
            "/redfish/v1/Chassis/chassis",
            "/redfish/v1/Chassis/PMC_0",
        ]
    hits: list[tuple[str, float]] = []
    seen: set[str] = set()
    follow: list[str] = []
    for href in hrefs[:6]:
        path = href if href.startswith("/") else "/" + href
        ch = _redfish_get(ip, path, user, password)
        if ch.get("_error"):
            continue
        _watt_hits(ch, hits)
        for rel in ("Power", "Sensors", "EnvironmentMetrics", "PowerSubsystem"):
            link = ch.get(rel)
            if isinstance(link, dict) and link.get("@odata.id"):
                follow.append(str(link["@odata.id"]))
        follow.extend(
            [
                f"{path}/Power",
                f"{path}/Sensors",
                f"{path}/EnvironmentMetrics",
                f"{path}/PowerSubsystem/PowerSupplies",
                f"{path}/Power/Oem/LiteOn/PowerUnits",
                f"{path}/Sensors/TotalPowerOut",
            ]
        )
    follow.extend(
        [
            "/redfish/v1/Chassis/powershelf/Power",
            "/redfish/v1/Chassis/powershelf/Sensors",
            "/redfish/v1/Chassis/powershelf/Power/Oem/LiteOn/PowerUnits",
            "/redfish/v1/Chassis/chassis/Power",
            "/redfish/v1/Chassis/chassis/Sensors",
        ]
    )
    for href in follow:
        path = href if href.startswith("/") else "/" + href
        if path in seen:
            continue
        seen.add(path)
        body = _redfish_get(ip, path, user, password)
        if body.get("_error"):
            continue
        _watt_hits(body, hits)
        kids = [
            str(m.get("@odata.id"))
            for m in (body.get("Members") or [])
            if isinstance(m, dict) and m.get("@odata.id")
        ]
        powerish = any(x in path.lower() for x in ("sensor", "powerunit", "powersuppl"))
        if not powerish:
            continue
        for kid in kids[:24]:
            ident = kid.lower()
            if "sensor" in path.lower() and not any(
                x in ident for x in ("power", "pout", "psu", "watt", "pin", "total")
            ):
                continue
            if kid in seen:
                continue
            seen.add(kid)
            kid_body = _redfish_get(ip, kid, user, password)
            if not kid_body.get("_error"):
                _watt_hits(kid_body, hits)
    psus: list[dict[str, Any]] = []
    totals: list[float] = []
    used: set[str] = set()
    for name, watts in hits:
        label = name.lower()
        if any(x in label for x in ("energy", "kwh", "joule")):
            continue
        if watts < 0 or watts > 40000:
            continue
        is_psu = bool(re.search(r"psu|powerdevice|power.?unit|power.?supply|pout|output.?power|ps[0-9]|pin\b", label))
        is_total = bool(re.search(r"totalpower|total_power|total power|consumed", label))
        if is_psu:
            if name in used:
                continue
            used.add(name)
            psus.append({"index": len(psus) + 1, "id": name or f"psu{len(psus)+1}", "watts": watts})
        elif is_total:
            totals.append(watts)
    if psus:
        out["psus"] = psus
        out["total_w"] = sum(float(p["watts"]) for p in psus)
    elif totals:
        out["total_w"] = max(totals)
    elif hits:
        vals = [w for _n, w in hits if 50 <= w <= 40000]
        if vals:
            out["total_w"] = max(vals)
    if out["total_w"] is None:
        out["error"] = "no-watt-reading"
    return out


def fetch_psu_power(targets: list[dict[str, str]], timeout: float = 70.0) -> dict[str, dict[str, Any]]:
    """Per-PSU watts from each PMC via hop HTTPS, keyed by BMC IP."""
    del timeout
    if not targets:
        return {}
    by_ip: dict[str, dict[str, Any]] = {}
    workers = min(8, max(1, len(targets)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_pmc_power_one, t): t for t in targets}
        for fut in concurrent.futures.as_completed(futs):
            try:
                row = fut.result()
            except Exception as exc:
                t = futs[fut]
                row = {"bmc_ip": t.get("bmc_ip"), "psus": [], "total_w": None, "error": str(exc)}
            ip = str(row.get("bmc_ip") or "")
            if ip:
                by_ip[ip] = row
    return by_ip


def _hop_tcp_channel(bmc_ip: str, remote_port: int):
    transport = _ssh().get_transport()
    if transport is None:
        raise NeedsHop("PXE hop dropped")
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    chan = transport.open_session()
    chan.exec_command(f"python3 /tmp/l12-bmc-pipe.py {shlex.quote(bmc_ip)} {int(remote_port)}")
    return chan


def open_https_tunnel(key: str, bmc_ip: str, remote_port: int = 443) -> int:
    """Local TCP port on this API, piped over SSH exec to BMC (not sshd direct-tcpip)."""
    client = _ssh()
    transport = client.get_transport()
    if transport is None:
        raise NeedsHop("PXE hop dropped")
    with _lock:
        existing = _tunnels.get(key)
        if existing and existing.get("alive") and existing.get("bmc_ip") == bmc_ip and existing.get("rport") == remote_port:
            return int(existing["port"])
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(16)
    port = int(sock.getsockname()[1])
    item = {"alive": True, "sock": sock, "port": port, "bmc_ip": bmc_ip, "rport": remote_port}

    def accept_loop() -> None:
        while item["alive"]:
            try:
                sock.settimeout(1.0)
                try:
                    local, addr = sock.accept()
                except TimeoutError:
                    continue
                chan = None
                try:
                    chan = _hop_tcp_channel(bmc_ip, remote_port)
                except Exception:
                    try:
                        chan = transport.open_channel("direct-tcpip", (bmc_ip, remote_port), addr)
                    except Exception:
                        local.close()
                        continue
                threading.Thread(target=_pipe, args=(local, chan), daemon=True).start()
                threading.Thread(target=_pipe, args=(chan, local), daemon=True).start()
            except Exception:
                if not item["alive"]:
                    break
                time.sleep(0.2)

    threading.Thread(target=accept_loop, daemon=True).start()
    with _lock:
        old = _tunnels.get(key)
        if old:
            old["alive"] = False
            try:
                old["sock"].close()
            except Exception:
                pass
        _tunnels[key] = item
    return port


class _TunneledHTTPS(http.client.HTTPSConnection):
    """TLS to a BMC through the PXE hop tunnel, with SNI/Host of the BMC IP."""

    def __init__(self, tunnel_port: int, server_hostname: str, timeout: float):
        super().__init__("127.0.0.1", tunnel_port, context=_TLS, timeout=timeout)
        self._server_hostname = server_hostname

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._server_hostname)


def _https_via_hop_exec(
    bmc_ip: str,
    method: str,
    path: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
) -> tuple[int, dict[str, str], bytes]:
    """HTTPS from python on the PXE host (same path that already reached Redfish)."""
    spec = {
        "url": f"https://{bmc_ip}{path or '/'}",
        "method": method,
        "headers": headers,
        "timeout": timeout,
    }
    if body:
        spec["body"] = base64.b64encode(body).decode("ascii")
    code, out, err = run("python3 /tmp/l12-bmc-http.py", timeout=timeout + 8, stdin_data=json.dumps(spec))
    if not (out or "").strip():
        _ensure_hop_scripts()
        code, out, err = run("python3 /tmp/l12-bmc-http.py", timeout=timeout + 8, stdin_data=json.dumps(spec))
    raw = (out or "").strip()
    if not raw:
        raise RuntimeError(err or f"PXE hop HTTP empty (exit {code})")
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"PXE hop HTTP parse: {exc} {(raw or err)[:200]}") from exc
    if payload.get("error") and int(payload.get("status") or 0) == 502:
        raise RuntimeError(str(payload.get("error")))
    data = base64.b64decode(payload.get("body") or "")
    rh = {str(k).lower(): str(v) for k, v in (payload.get("headers") or {}).items()}
    return int(payload.get("status") or 502), rh, data


def _https_via_tunnel(
    bmc_ip: str,
    method: str,
    path: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
    tunnel_key: str,
) -> tuple[int, dict[str, str], bytes]:
    port = open_https_tunnel(tunnel_key, bmc_ip, 443)
    conn = _TunneledHTTPS(port, bmc_ip, timeout)
    try:
        conn.request(method, path or "/", body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        rh: dict[str, str] = {}
        cookies: list[str] = []
        for k, v in resp.getheaders():
            if k.lower() == "set-cookie":
                cookies.append(v)
            else:
                rh[k.lower()] = v
        if cookies:
            rh["set-cookie"] = "\n".join(cookies)
        status = int(resp.status)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if rh.get("content-encoding", "").lower() == "gzip":
        try:
            data = gzip.decompress(data)
            rh.pop("content-encoding", None)
        except Exception:
            pass
    return status, rh, data


def https_request(
    bmc_ip: str,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 20.0,
    tunnel_key: str | None = None,
    prefer_exec: bool = True,
) -> tuple[int, dict[str, str], bytes]:
    """HTTPS to a BMC from the PXE hop. Browser never sees 10.10.x. No IPMI."""
    hdrs = {"Host": bmc_ip, "Connection": "close", "Accept-Encoding": "identity"}
    if headers:
        for k, v in headers.items():
            if not v:
                continue
            if k.lower() in {"host", "connection", "accept-encoding"}:
                continue
            hdrs[k] = v
    key = tunnel_key or f"https-{bmc_ip}"
    first = _https_via_hop_exec if prefer_exec else _https_via_tunnel
    second = _https_via_tunnel if prefer_exec else _https_via_hop_exec
    try:
        if prefer_exec:
            return first(bmc_ip, method, path, hdrs, body, timeout)
        return first(bmc_ip, method, path, hdrs, body, timeout, key)
    except NeedsHop:
        raise
    except Exception:
        if prefer_exec:
            return second(bmc_ip, method, path, hdrs, body, timeout, key)
        return second(bmc_ip, method, path, hdrs, body, timeout)


def _basic_auth(user: str, password: str) -> dict[str, str]:
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _redfish_json(bmc_ip: str, path: str, user: str, password: str) -> dict[str, Any]:
    status, _headers, data = https_request(
        bmc_ip,
        "GET",
        path,
        headers={**_basic_auth(user, password), "Accept": "application/json"},
        timeout=12,
        tunnel_key=f"https-{bmc_ip}",
    )
    if status >= 400:
        return {"_error": f"HTTP {status}", "_path": path, "_body": data[:240].decode("utf-8", "replace")}
    try:
        return json.loads(data.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        return {"_error": str(exc), "_path": path}


def _port_probe(bmc_ip: str) -> str:
    script = (
        "import socket,sys\n"
        f"ip={bmc_ip!r}\n"
        "for p in (22, 443, 2200, 623):\n"
        "    s=socket.socket(); s.settimeout(2.0)\n"
        "    try:\n"
        "        r=s.connect_ex((ip,p))\n"
        "        print(f'{p}={\"open\" if r==0 else \"closed\"}')\n"
        "    except Exception as e:\n"
        "        print(f'{p}={e}')\n"
        "    finally:\n"
        "        s.close()\n"
    )
    code, out, err = run("python3 -", timeout=12, stdin_data=script)
    text = (out or "").strip() or (err or "").strip() or f"probe exit {code}"
    return "ports  " + "  ".join(text.splitlines())


def _bmc_ssh(bmc_ip: str, username: str, password: str, port: int) -> paramiko.SSHClient:
    local = open_https_tunnel(f"ssh-{bmc_ip}-{port}", bmc_ip, port)
    inner = paramiko.SSHClient()
    inner.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    inner.connect(
        hostname="127.0.0.1",
        port=local,
        username=username,
        password=password,
        timeout=10,
        auth_timeout=10,
        banner_timeout=10,
        look_for_keys=False,
        allow_agent=False,
    )
    return inner


def _read_chan(chan: paramiko.Channel, seconds: float = 4.0, limit: int = 8000) -> str:
    deadline = time.time() + seconds
    buf = b""
    chan.settimeout(0.4)
    while time.time() < deadline and len(buf) < limit:
        try:
            chunk = chan.recv(2048)
            if not chunk:
                break
            buf += chunk
        except Exception:
            time.sleep(0.15)
    return buf.decode("utf-8", "replace")


def _ssh_sol(bmc_ip: str, user: str, password: str) -> str:
    lines: list[str] = []
    for port in (2200, 22):
        try:
            client = _bmc_ssh(bmc_ip, user, password, port)
        except Exception as exc:
            lines.append(f"SSH :{port}  {exc}")
            continue
        try:
            lines.append(f"SSH :{port}  login {user} ok")
            sess = client.get_transport()
            if sess is None:
                continue
            chan = sess.open_session()
            chan.get_pty(width=120, height=32)
            try:
                chan.exec_command("obmc-console-client")
                blob = _read_chan(chan, 5.0)
                if blob.strip():
                    lines.append(blob.strip()[-4000:])
                    return "\n".join(lines)
            except Exception:
                pass
            try:
                chan.close()
            except Exception:
                pass
            shell = client.invoke_shell(width=120, height=32)
            time.sleep(0.6)
            blob = _read_chan(shell, 3.5)
            if blob.strip():
                lines.append(blob.strip()[-4000:])
            else:
                lines.append("(SSH up, console idle)")
            try:
                shell.close()
            except Exception:
                pass
            return "\n".join(lines)
        finally:
            try:
                client.close()
            except Exception:
                pass
    if not lines:
        lines.append("No SSH console on :2200 or :22 from the PXE hop.")
    return "\n".join(lines)


def _walk_logs(bmc_ip: str, user: str, password: str, odata: str | None, lines: list[str]) -> None:
    if not odata:
        return
    svc = _redfish_json(bmc_ip, odata, user, password)
    members = svc.get("Members") or []
    if svc.get("_error") and not members:
        lines.append(f"  LogServices {svc.get('_error')} {odata}")
        return
    for member in members:
        href = (member or {}).get("@odata.id")
        if not href:
            continue
        ls = _redfish_json(bmc_ip, href, user, password)
        name = ls.get("Id") or ls.get("Name") or href
        entries_id = (ls.get("Entries") or {}).get("@odata.id")
        lines.append(f"--- LogService {name} ---")
        if not entries_id:
            lines.append("(no Entries collection)")
            continue
        ent = _redfish_json(bmc_ip, entries_id, user, password)
        rows = ent.get("Members") or []
        if ent.get("_error") and not rows:
            lines.append(str(ent.get("_error")))
            continue
        if not rows:
            lines.append("(empty)")
            continue
        for row in rows[-20:]:
            if isinstance(row, dict) and "@odata.id" in row and len(row) <= 3:
                row = _redfish_json(bmc_ip, row["@odata.id"], user, password)
            if not isinstance(row, dict):
                continue
            msg = row.get("Message") or row.get("Description") or json.dumps(row)[:240]
            created = row.get("Created") or row.get("EventTimestamp") or ""
            lines.append(f"{created}  {msg}")


def sol_capture(bmc_ip: str, username: str, password: str) -> str:
    """Pull console/logs through the PXE hop. OpenBMC has Redfish; IPMI RMCP+ does not work."""
    user = username or "ADMIN"
    hop = status()
    lines = [
        f"=== PXE hop {hop.get('host')} → BMC {bmc_ip} (HTTPS via hop python, no IPMI) ===",
    ]
    try:
        lines.append(_port_probe(bmc_ip))
    except Exception as exc:
        lines.append(f"ports  (probe failed: {exc})")

    users: list[str] = []
    for candidate in (user, "ADMIN", "root"):
        if candidate and candidate not in users:
            users.append(candidate)

    root: dict[str, Any] = {}
    auth_user = user
    lines.append(f"=== Redfish {bmc_ip} ===")
    for candidate in users:
        root = _redfish_json(bmc_ip, "/redfish/v1/", candidate, password or "")
        if not root.get("_error") and root.get("RedfishVersion"):
            auth_user = candidate
            lines.append(f"auth {candidate}")
            break
    else:
        lines.append(f"Redfish auth failed for {','.join(users)}  {root.get('_error')} {root.get('_body','')}")
        lines.append("Open BMC KVM/SOL in the UI after a successful hop login — HTML5 console uses HTTPS, not IPMI.")
        return "\n".join(lines)[-14000:]

    lines.append(f"RedfishVersion {root.get('RedfishVersion')} UUID {str(root.get('UUID') or '')[:20]}")
    for key in ("Systems", "Managers"):
        href = (root.get(key) or {}).get("@odata.id") or f"/redfish/v1/{key}"
        col = _redfish_json(bmc_ip, href, auth_user, password or "")
        members = col.get("Members") or []
        if col.get("_error") and not members:
            lines.append(f"[{key}] {col.get('_error')} {href}")
            continue
        if not members:
            lines.append(f"[{key}] (no members at {href})")
        for member in members:
            rec_href = (member or {}).get("@odata.id")
            if not rec_href:
                continue
            rec = _redfish_json(bmc_ip, rec_href, auth_user, password or "")
            lines.append(f"[{key[:-1]}] {rec.get('Id') or rec_href}  {rec.get('Name','')}  power={rec.get('PowerState','')}")
            serials = rec.get("SerialInterfaces") or rec.get("SerialConsole") or rec.get("GraphicalConsole")
            if isinstance(serials, dict):
                if serials.get("@odata.id"):
                    si = _redfish_json(bmc_ip, serials["@odata.id"], auth_user, password or "")
                    lines.append(f"  {list(serials)[0] if serials else 'console'} {serials.get('@odata.id')}")
                    for sm in si.get("Members") or [si]:
                        if not isinstance(sm, dict):
                            continue
                        sref = sm.get("@odata.id")
                        srec = _redfish_json(bmc_ip, sref, auth_user, password or "") if sref and len(sm) <= 3 else sm
                        lines.append(
                            f"  serial {srec.get('Id') or srec.get('Name')}  "
                            f"Enabled={srec.get('InterfaceEnabled', srec.get('ServiceEnabled'))}  "
                            f"{srec.get('Name') or ''}"
                        )
                else:
                    lines.append(
                        f"  console ServiceEnabled={serials.get('ServiceEnabled')} "
                        f"ConnectTypes={serials.get('ConnectTypesSupported')}"
                    )
            _walk_logs(bmc_ip, auth_user, password or "", (rec.get("LogServices") or {}).get("@odata.id"), lines)

    lines.append("=== Serial console (SSH via PXE hop) ===")
    try:
        lines.append(_ssh_sol(bmc_ip, auth_user, password or ""))
    except NeedsHop:
        raise
    except Exception as exc:
        lines.append(f"SSH SOL failed: {exc}")
    lines.append("No IPMI / RMCP+ — this OpenBMC is Redfish/HTTPS from the PXE hop.")
    lines.append("Use the KVM tab for live HTML5 SOL/video (same hop python path).")
    return "\n".join(lines)[-14000:]


def find_ip_for_mac(mac: str) -> dict[str, Any]:
    """Look up current IP for a MAC on the PXE host (neighbor table + DHCP leases)."""
    mac = (mac or "").strip().lower().replace("-", ":")
    if not mac:
        raise RuntimeError("MAC is required")
    compact = mac.replace(":", "")
    script = r"""
import os, re, sys
mac = sys.argv[1].lower()
compact = mac.replace(":", "")
found = []

def add(ip, src):
    if ip and ip not in {x["ip"] for x in found}:
        found.append({"ip": ip, "source": src})

# ip neighbor
try:
    import subprocess
    neigh = subprocess.run(["ip", "-br", "neigh"], capture_output=True, text=True, timeout=5)
    for line in (neigh.stdout or "").splitlines():
        if mac in line.lower():
            parts = line.split()
            if parts:
                add(parts[0], "neighbor")
except Exception:
    pass

lease_files = [
    "/var/lib/dhcp/dhcpd.leases",
    "/var/lib/misc/dnsmasq.leases",
    "/var/lib/dnsmasq/dnsmasq.leases",
    "/tmp/dhcp.leases",
]
for path in lease_files:
    if not os.path.exists(path):
        continue
    try:
        text = open(path, errors="replace").read()
    except Exception:
        continue
    if "lease " in text:
        blocks = re.split(r"\nlease\s+", text)
        for b in blocks:
            if mac not in b.lower() and compact not in b.lower():
                continue
            m = re.search(r"^([\d.]+)\s*\{", b, re.M)
            if not m:
                m = re.search(r"lease\s+([\d.]+)", b)
            if m:
                add(m.group(1), path)
    else:
        for line in text.splitlines():
            if mac in line.lower() or compact in line.lower():
                parts = line.split()
                for p in parts:
                    if re.match(r"^\d+\.\d+\.\d+\.\d+$", p):
                        add(p, path)
print(__import__("json").dumps(found))
"""
    cmd = "python3 - " + shlex.quote(mac)
    code, out, err = run(cmd, timeout=15, stdin_data=script)
    rows = []
    try:
        import json as _json

        rows = _json.loads((out or "").strip() or "[]")
    except Exception:
        rows = []
    return {"mac": mac, "matches": rows, "ip": rows[0]["ip"] if rows else None, "error": err.strip() if err and not rows else None}
