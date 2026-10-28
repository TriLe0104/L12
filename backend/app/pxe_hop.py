"""SSH jump through the PXE server to BMC networks (SOL + KVM tunnel)."""

from __future__ import annotations

import base64
import concurrent.futures
import contextlib
import gzip
import hashlib
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


class _Hop:
    """One SSH session to one PXE. Tunnels and uploaded scripts stay on that host."""

    def __init__(self, host: str, user: str, client: paramiko.SSHClient) -> None:
        self.host = host
        self.user = user
        self.client = client
        self.tunnels: dict[str, dict[str, Any]] = {}
        self.scripts_ready = False
        self.cap_script = ""
        self.power_script = ""
        self.power_pipe = None
        self.pipe_lock = threading.Lock()
        self.exec_gate = threading.Semaphore(4)


_pool: dict[str, _Hop] = {}
_active: str | None = None
_lock = threading.Lock()
_local = threading.local()
_fail_until: dict[str, float] = {}
_host_locks_guard = threading.Lock()
_host_locks: dict[str, threading.Lock] = {}


class NeedsHop(RuntimeError):
    pass


def check_reachable(host: str, username: str | None = None, password: str | None = None) -> dict[str, Any]:
    host = host.strip()
    if not host:
        raise ValueError("PXE host IP is required")
    try:
        with socket.create_connection((host, 22), timeout=4):
            pass
    except OSError:
        return {"reachable": False, "authenticated": False, "detail": "SSH port is not reachable"}

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            username=(username or settings.cluster_pxe_user or "root").strip(),
            password=password or None,
            look_for_keys=not bool(password),
            allow_agent=not bool(password),
            timeout=4,
            auth_timeout=4,
            banner_timeout=4,
        )
    except paramiko.AuthenticationException:
        return {"reachable": True, "authenticated": False, "detail": "SSH login rejected"}
    except Exception:
        return {"reachable": True, "authenticated": False, "detail": "SSH handshake failed"}
    finally:
        client.close()
    return {"reachable": True, "authenticated": True, "detail": "SSH login accepted"}


def _host_key(host: str | None) -> str:
    return (host or "").strip().lower()


def _host_lock(key: str) -> threading.Lock:
    with _host_locks_guard:
        lock = _host_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _host_locks[key] = lock
        return lock


def _transport_ok(client: paramiko.SSHClient | None) -> bool:
    if client is None:
        return False
    transport = client.get_transport()
    return transport is not None and bool(transport.is_active())


def _hop_ok(hop: _Hop | None) -> bool:
    return hop is not None and _transport_ok(hop.client)


def _set_active(key: str | None) -> None:
    global _active
    _active = key


@contextlib.contextmanager
def on_host(host: str | None):
    """Run hop calls in this thread against one PXE. Other threads keep their own."""
    key = _host_key(host)
    if not key:
        yield
        return
    prev = getattr(_local, "host", None)
    _local.host = key
    try:
        yield
    finally:
        _local.host = prev


def _session() -> _Hop:
    requested = _host_key(getattr(_local, "host", None))
    with _lock:
        if requested:
            hop = _pool.get(requested)
            if not _hop_ok(hop):
                raise NeedsHop(f"Connect to PXE {requested} first")
            return hop
        if _active and _hop_ok(_pool.get(_active)):
            return _pool[_active]
        alive = [hop for hop in _pool.values() if _hop_ok(hop)]
        if alive:
            return alive[0]
        raise NeedsHop("Connect to the PXE jump host first")


def _is_up(host: str) -> bool:
    with _lock:
        return _hop_ok(_pool.get(_host_key(host)))


def _shutdown_hop(hop: _Hop) -> None:
    for item in list(hop.tunnels.values()):
        item["alive"] = False
        sock = item.get("sock")
        if sock:
            try:
                sock.close()
            except OSError:
                pass
    hop.tunnels.clear()
    hop.scripts_ready = False
    hop.cap_script = ""
    hop.power_script = ""
    _stop_power_pipe(hop)
    try:
        hop.client.close()
    except Exception:
        pass


def _drop_host(host: str) -> None:
    key = _host_key(host)
    with _lock:
        hop = _pool.pop(key, None)
        if _active == key:
            nxt = next((k for k, item in _pool.items() if _hop_ok(item)), None)
            _set_active(nxt)
    if hop is not None:
        _shutdown_hop(hop)


def _note_if_all_down() -> None:
    if status().get("connected"):
        return
    try:
        from . import gpu_power

        gpu_power._note_hop_down()
    except Exception:
        pass


def status() -> dict[str, Any]:
    with _lock:
        hops: list[dict[str, Any]] = []
        for hop in _pool.values():
            ok = _hop_ok(hop)
            hops.append({"host": hop.host, "user": hop.user if ok else None, "connected": bool(ok)})
        hops.sort(key=lambda row: str(row["host"]))
        chosen: _Hop | None = None
        if _active and _hop_ok(_pool.get(_active)):
            chosen = _pool[_active]
        else:
            for hop in _pool.values():
                if _hop_ok(hop):
                    chosen = hop
                    break
        tunnels = {}
        if chosen is not None:
            tunnels = {k: {"port": v["port"], "bmc_ip": v["bmc_ip"]} for k, v in chosen.tunnels.items()}
        hosts = [str(row["host"]) for row in hops if row["connected"]]
        return {
            "connected": bool(hosts),
            "host": (chosen.host if chosen is not None else None) or settings.cluster_pxe_host,
            "user": chosen.user if chosen is not None and _hop_ok(chosen) else None,
            "hosts": hosts,
            "hops": hops,
            "tunnels": tunnels,
        }


def close(host: str | None = None) -> None:
    """Close one PXE, or every PXE when host is omitted."""
    if host:
        _drop_host(host)
        _note_if_all_down()
        return
    try:
        from . import gpu_power

        gpu_power._note_hop_down()
    except Exception:
        pass
    with _lock:
        hops = list(_pool.values())
        _pool.clear()
        _set_active(None)
    for hop in hops:
        _shutdown_hop(hop)


def connect(username: str | None = None, password: str | None = None, host: str | None = None) -> dict[str, Any]:
    """Open this PXE and leave every other hop up."""
    user = (username or settings.cluster_pxe_user or "root").strip()
    host = (host or settings.cluster_pxe_host or "").strip()
    if not host:
        raise RuntimeError("PXE host IP is required")
    key = _host_key(host)
    with _host_lock(key):
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
        _drop_host(host)
        hop = _Hop(host, user, client)
        with _lock:
            _pool[key] = hop
            _set_active(key)
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)
        with on_host(host):
            code, out, err = run("echo hop-ok && hostname")
            if code != 0 or "hop-ok" not in (out or ""):
                _drop_host(host)
                _note_if_all_down()
                raise RuntimeError(err or "PXE hop failed")
            try:
                _ensure_hop_scripts()
            except Exception:
                pass
        _fail_until.pop(key, None)
    try:
        from . import gpu_power

        gpu_power.force_live_gpu_poll()
    except Exception:
        pass
    return status()


def _saved_login(host: str) -> tuple[str | None, str | None]:
    key = _host_key(host)
    try:
        from .db import SessionLocal
        from .pxe_servers import list_servers, normalize_host

        with SessionLocal() as db:
            for row in list_servers(db):
                if _host_key(normalize_host(row.host)) == key:
                    return row.username, row.password
    except Exception:
        pass
    return None, None


def ensure_host(host: str) -> bool:
    """Connect one saved PXE if it is not already up. Failures wait 60s before retry."""
    from .pxe_servers import normalize_host

    host = normalize_host(host)
    if not host:
        return False
    if _is_up(host):
        return True
    key = _host_key(host)
    if _fail_until.get(key, 0) > time.monotonic():
        return False
    user, password = _saved_login(host)
    try:
        connect(user, password, host)
    except Exception:
        _fail_until[key] = time.monotonic() + 60
        return False
    return _is_up(host)


def ensure_saved() -> list[str]:
    """Open every PXE saved in Provision. Racks are polled on the host stored with them."""
    from .db import SessionLocal
    from .pxe_servers import list_servers, normalize_host

    hosts: list[str] = []
    try:
        with SessionLocal() as db:
            hosts = [normalize_host(row.host) for row in list_servers(db)]
    except Exception:
        return list(status().get("hosts") or [])
    up: list[str] = []
    for host in hosts:
        if host and ensure_host(host):
            up.append(host)
    return up


def bind_target(addr: str, host: str | None = None) -> str:
    """PXE that owns this BMC or OS address. Connects that saved hop. Does not use another rack's PXE."""
    from .pxe_servers import normalize_host, pxe_for_address

    assigned = pxe_for_address(addr) if (addr or "").strip() else ""
    chosen = assigned or normalize_host(host or "")
    if not chosen:
        pinned = _host_key(getattr(_local, "host", None))
        if pinned and _is_up(pinned):
            return pinned
        ensure_saved()
        hosts = [str(item) for item in (status().get("hosts") or [])]
        if hosts:
            return hosts[0]
        raise NeedsHop("Connect to the PXE jump host first")
    if not ensure_host(chosen):
        raise NeedsHop(f"PXE {chosen} is not connected")
    return chosen


def _ssh() -> paramiko.SSHClient:
    return _session().client


def run(command: str, timeout: float = 20.0, stdin_data: str | None = None) -> tuple[int, str, str]:
    hop = _session()
    if not hop.exec_gate.acquire(timeout=max(1.0, float(timeout))):
        return 1, "", "PXE hop busy"
    try:
        client = hop.client
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
    finally:
        hop.exec_gate.release()


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
import base64, concurrent.futures, http.client, json, socket, ssl, sys, threading, time
raw_spec = sys.stdin.readline()
spec = json.loads(raw_spec or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 1.2)
interval = float(spec.get("interval") or 1)
loop = bool(spec.get("loop"))
persist = bool(spec.get("persist"))
_print_lock = threading.Lock()
_pool_guard = threading.Lock()
_tls_guard = threading.Lock()
_pools = {}
_tls_sessions = {}

def emit(obj):
    with _print_lock:
        json.dump(obj, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()

class _BMCConn(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection((self.host, self.port), self.timeout)
        try:
            raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        with _tls_guard:
            session = _tls_sessions.get(self.host)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host, session=session)
        except TypeError:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            try:
                raw.close()
            except Exception:
                pass
            raw = socket.create_connection((self.host, self.port), self.timeout)
            try:
                raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        resumed = getattr(self.sock, "session", None)
        if resumed is not None:
            with _tls_guard:
                _tls_sessions[self.host] = resumed

def _borrow(ip):
    with _pool_guard:
        pool = _pools.get(ip)
        if pool:
            return pool.pop()
    return _BMCConn(ip, 443, timeout=timeout, context=ctx)

def _give(ip, conn):
    with _pool_guard:
        pool = _pools.setdefault(ip, [])
        if len(pool) >= 4:
            try:
                conn.close()
            except Exception:
                pass
            return
        pool.append(conn)

def _drop(conn):
    try:
        conn.close()
    except Exception:
        pass

def get(ip, path, user, password):
    # Reuse the TLS session. The first call pays the handshake; the next calls do not.
    basic = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    headers = {
        "Authorization": "Basic " + basic,
        "Accept": "application/json",
        "Connection": "keep-alive",
    }
    last = "request"
    for _attempt in (0, 1):
        conn = _borrow(ip)
        t0 = time.time()
        try:
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            ms = round((time.time() - t0) * 1000, 1)
            code = int(resp.status)
            try:
                body = json.loads(raw.decode("utf-8", "replace") or "{}")
            except Exception:
                body = {"_error": "parse"}
            if not isinstance(body, dict):
                body = {"value": body}
            if resp.will_close:
                _drop(conn)
            else:
                _give(ip, conn)
            return code, body, ms
        except Exception as e:
            _drop(conn)
            last = str(e)
    return 0, {"_error": last}, None

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
    flags = {"empty": False, "status": 0}
    def one(name):
        path = "/redfish/v1/Systems/HGX_Baseboard_0/Processors/%s" % name
        st_m, body, ms = get(ip, path + "/EnvironmentMetrics", user, password)
        if st_m != 200 or not isinstance(body, dict) or body.get("_error"):
            if st_m:
                flags["status"] = st_m
            return None
        row = parse_metrics(body)
        if row.get("watts") is None:
            pw = body.get("PowerWatts") if isinstance(body.get("PowerWatts"), dict) else {}
            uri = str(pw.get("DataSourceUri") or "").strip()
            if uri:
                if not uri.startswith("/"):
                    uri = "/" + uri
                st_s, sensor, sensor_ms = get(ip, uri, user, password)
                reading = sensor.get("Reading") if st_s == 200 and isinstance(sensor, dict) else None
                if reading is not None:
                    row["watts"] = reading
                    ms = sensor_ms
            if row.get("watts") is None:
                flags["empty"] = True
                return None
        row["id"] = name
        row["processor"] = name
        row["path"] = path + "/EnvironmentMetrics"
        row["raw_index"] = gpu_num(name)
        if ms is not None:
            row["ms"] = ms
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
        if flags["empty"]:
            out["error"] = "power-reading-empty"
        elif flags["status"]:
            out["error"] = "HTTP %s" % flags["status"]
        else:
            out["error"] = "no-gpu-metrics"
    return out

def fetch_and_emit(target):
    row = fetch_bmc(target)
    emit(row)
    return row

targets = spec.get("targets") or []
n = max(1, min(18, len(targets) or 1))

def once():
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        list(ex.map(fetch_and_emit, targets))
    if persist:
        emit({"ready": True})
    elif loop:
        emit({"ok": True, "round": True})
    else:
        emit({"ok": True, "done": True})

if persist:
    while True:
        kick = sys.stdin.readline()
        if not kick:
            break
        once()
elif not loop:
    once()
else:
    while True:
        t0 = time.time()
        once()
        dt = time.time() - t0
        if dt < interval:
            time.sleep(interval - dt)
"""


_HOP_HEALTH = r"""
import base64, concurrent.futures, json, ssl, sys, urllib.error, urllib.request
spec = json.loads(sys.stdin.read() or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 3)
paths = spec.get("paths") or {}
targets = spec.get("targets") or []

def get(ip, path, user, password):
    url = "https://%s%s" % (ip, path)
    req = urllib.request.Request(url, method="GET")
    token = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
    req.add_header("Authorization", "Basic " + token)
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            raw = r.read()
        if not raw:
            return {}
        body = json.loads(raw.decode("utf-8", "replace") or "{}")
        return body if isinstance(body, dict) else {"value": body}
    except urllib.error.HTTPError as e:
        return {"_error": "HTTP %s" % e.code}
    except Exception as e:
        return {"_error": str(e)[:180]}

def one(target):
    ip = target.get("bmc_ip") or ""
    user = target.get("user") or "ADMIN"
    password = target.get("password") or ""
    bodies = {}
    if not ip:
        return {"bmc_ip": ip, "bodies": bodies}
    items = list(paths.items())
    def pull(item):
        key, path = item
        return key, get(ip, path, user, password)
    workers = max(1, min(6, len(items) or 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for key, body in ex.map(pull, items):
            bodies[key] = body if isinstance(body, dict) else {"_error": "bad-body"}
    return {"bmc_ip": ip, "bodies": bodies}

n = max(1, min(8, len(targets) or 1))
nodes = []
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
    for row in ex.map(one, targets):
        nodes.append(row)
json.dump({"ok": True, "nodes": nodes}, sys.stdout)
"""


def _script_stamp(src: str) -> str:
    return hashlib.sha256(src.encode()).hexdigest()


def _ensure_hop_scripts() -> None:
    hop = _session()
    cap_stamp = _script_stamp(_HOP_GPU_CAP)
    power_stamp = _script_stamp(_HOP_GPU_POWER)
    if hop.scripts_ready and hop.cap_script == cap_stamp and hop.power_script == power_stamp:
        return
    if not hop.scripts_ready:
        run("cat > /tmp/l12-bmc-pipe.py", timeout=8, stdin_data=_HOP_PIPE)
        run("cat > /tmp/l12-bmc-http.py", timeout=8, stdin_data=_HOP_HTTP)
        run("cat > /tmp/l12-psu-power.py", timeout=8, stdin_data=_HOP_PSU_POWER)
        run("cat > /tmp/l12-bmc-health.py", timeout=8, stdin_data=_HOP_HEALTH)
    if not hop.scripts_ready or hop.power_script != power_stamp:
        run("cat > /tmp/l12-gpu-power.py", timeout=8, stdin_data=_HOP_GPU_POWER)
        hop.power_script = power_stamp
    if not hop.scripts_ready or hop.cap_script != cap_stamp:
        run("cat > /tmp/l12-gpu-cap.py", timeout=8, stdin_data=_HOP_GPU_CAP)
        hop.cap_script = cap_stamp
    hop.scripts_ready = True


_HOP_GPU_CAP = r"""
import base64, concurrent.futures, json, ssl, sys, time, urllib.error, urllib.request
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
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            code = int(getattr(r, "status", None) or r.getcode())
            r.read()
            ms = round((time.time() - t0) * 1000, 1)
            return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": code, "ms": ms}
    except urllib.error.HTTPError as e:
        ms = round((time.time() - t0) * 1000, 1)
        return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": int(e.code), "error": str(e), "ms": ms}
    except Exception as e:
        ms = round((time.time() - t0) * 1000, 1)
        return {"bmc_ip": ip, "path": path, "setpoint": sp, "status": 0, "error": str(e), "ms": ms}

patches = spec.get("patches") or []
n = max(1, min(8, len(patches) or 1))
out = []
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
    for row in ex.map(patch_one, patches):
        out.append(row)
json.dump({"ok": True, "results": out}, sys.stdout)
"""


_HOP_PSU_POWER = r"""
import base64, concurrent.futures, json, ssl, sys, threading, time, urllib.error, urllib.request
spec = json.loads(sys.stdin.read() or "{}")
ctx = ssl._create_unverified_context()
timeout = float(spec.get("timeout") or 1.2)
interval = float(spec.get("interval") or 1)
loop = bool(spec.get("loop"))
_print_lock = threading.Lock()
PATHS = [
    "/redfish/v1/Chassis/PowerShelf_0/Sensors/total_power_out",
    "/redfish/v1/Chassis/PowerShelf_0/Sensors/TotalPowerOut",
    "/redfish/v1/Chassis/powershelf/Sensors/total_power_out",
    "/redfish/v1/Chassis/PMC_0/Sensors/total_power_out",
]

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

def reading(body):
    if not isinstance(body, dict) or body.get("_error"):
        return None
    v = body.get("Reading")
    if isinstance(v, dict):
        v = v.get("Reading") if v.get("Reading") is not None else v.get("Value")
    try:
        w = float(v)
    except Exception:
        return None
    if w < 0 or w > 80000:
        return None
    name = str(body.get("Id") or body.get("Name") or "total_power_out")
    return name, w

def fetch_shelf(target):
    ip = target.get("bmc_ip") or ""
    password = target.get("password") or ""
    users = []
    for u in (target.get("user") or "", "root", "ADMIN", "admin"):
        if u and u not in users:
            users.append(u)
    out = {"bmc_ip": ip, "psus": [], "total_w": None, "sensor_name": None, "path": None, "error": None}
    if not ip:
        out["error"] = "no-ip"
        return out
    last_st = 0
    for user in users:
        for path in PATHS:
            st, body = get("https://%s%s" % (ip, path), user, password)
            last_st = st
            parsed = reading(body)
            if parsed is None:
                continue
            name, watts = parsed
            out["sensor_name"] = name
            out["watts"] = watts
            out["total_w"] = watts
            out["path"] = path
            out["user"] = user
            out["psus"] = [{"index": 1, "id": name, "watts": watts}]
            return out
    out["error"] = "HTTP %s" % last_st if last_st else "no-watt-reading"
    return out

def fetch_and_emit(target):
    row = fetch_shelf(target)
    emit(row)
    return row

targets = spec.get("targets") or []
n = max(1, min(18, len(targets) or 1))

def once():
    nodes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        for row in ex.map(fetch_and_emit if loop else fetch_shelf, targets):
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
    host: str | None = None,
) -> None:
    """Run EnvironmentMetrics in a 1s loop on the hop; on_event(dict) per BMC line."""
    with on_host(host):
        _stream_gpu_environment_metrics(targets, on_event, interval=interval)


def _stream_gpu_environment_metrics(targets: list[dict[str, str]], on_event, *, interval: float) -> None:
    if not targets:
        return
    pinned = _session().host
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
                if not _is_up(pinned):
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


def read_gpu_round(
    targets: list[dict[str, str]],
    on_node,
    *,
    timeout: float = 30.0,
    host: str | None = None,
) -> str:
    """One EnvironmentMetrics pass. Calls on_node as each BMC finishes.

    Returns a short error when no BMC reported watts.
    """
    with on_host(host):
        return _read_gpu_round(targets, on_node, timeout=timeout)


def _take_gpu_line(payload: dict[str, Any], on_node) -> tuple[int, list[str], bool]:
    """Ingest one hop line. Returns (nodes with watts, errors, stop)."""
    if not isinstance(payload, dict) or not payload:
        return 0, [], False
    if payload.get("done"):
        return 0, [], True
    nodes = payload.get("nodes")
    if isinstance(nodes, list) and not payload.get("bmc_ip"):
        got = 0
        errors: list[str] = []
        for node in nodes:
            if not isinstance(node, dict):
                continue
            n, errs, _stop = _take_gpu_line(node, on_node)
            got += n
            errors.extend(errs)
        return got, errors, True
    ip = str(payload.get("bmc_ip") or "")
    if not ip:
        return 0, [], False
    gpus = [g for g in (payload.get("gpus") or []) if isinstance(g, dict) and g.get("watts") is not None]
    if gpus:
        on_node({"bmc_ip": ip, "gpus": gpus})
        return 1, [], False
    err = str(payload.get("error") or "").strip()
    return 0, [err[:120]] if err else [], False


class _PowerPipe:
    """One long-lived power process on a PXE. Kicks reuse its TLS sessions."""

    def __init__(self) -> None:
        self.stdin = None
        self.stdout = None
        self.stderr = None
        self.ready = threading.Event()
        self.kick_lock = threading.Lock()
        self.dead = False
        self.handler = None
        self.got = 0
        self.errors: list[str] = []
        self.stamp = ""
        self.targets_key: tuple = ()
        self.reader: threading.Thread | None = None
        self.tail = ""


def _close_power_pipe(pipe: _PowerPipe) -> None:
    pipe.dead = True
    pipe.ready.set()
    stream = pipe.stdin or pipe.stdout
    if stream is None:
        return
    try:
        stream.channel.close()
    except Exception:
        pass


def _stop_power_pipe(hop: _Hop) -> None:
    with hop.pipe_lock:
        pipe = hop.power_pipe
        hop.power_pipe = None
    if pipe is not None:
        _close_power_pipe(pipe)


def _power_targets_key(targets: list[dict[str, str]]) -> tuple:
    rows = []
    for item in targets:
        ip = str(item.get("bmc_ip") or "")
        user = str(item.get("user") or "")
        digest = hashlib.sha256(str(item.get("password") or "").encode()).hexdigest()[:12]
        rows.append((ip, user, digest))
    rows.sort()
    return tuple(rows)


def _power_pipe_reader(pipe: _PowerPipe) -> None:
    stdout = pipe.stdout
    while not pipe.dead:
        try:
            line = stdout.readline()
        except Exception:
            break
        if not line:
            break
        payload = _stdout_json(line)
        if not payload:
            continue
        if payload.get("ready") or payload.get("done"):
            pipe.ready.set()
            continue
        handler = pipe.handler
        if handler is None:
            continue
        try:
            n, errs, _stop = _take_gpu_line(payload, handler)
        except Exception:
            continue
        pipe.got += int(n)
        if errs:
            pipe.errors.extend(errs)
    pipe.dead = True
    pipe.ready.set()


def _note_pipe_death(pipe: _PowerPipe) -> None:
    tail = (pipe.tail or "").strip().replace("\n", " ")
    if not tail:
        return
    try:
        import sys

        sys.stderr.write("power pipe closed: %s\n" % tail[-240:])
        sys.stderr.flush()
    except Exception:
        pass


def _drain_power_stderr(pipe: _PowerPipe) -> None:
    err = pipe.stderr
    if err is None:
        return
    try:
        while True:
            try:
                chunk = err.read(512)
            except Exception:
                break
            if not chunk:
                break
            text = chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace")
            pipe.tail = (pipe.tail + text)[-400:]
    finally:
        _note_pipe_death(pipe)


def _open_power_pipe(
    hop: _Hop,
    targets: list[dict[str, str]],
    stamp: str,
    key: tuple,
    timeout: float,
) -> tuple[_PowerPipe | None, str]:
    # The gate is only for opening the channel. Caps need a slot while this process stays up.
    if not hop.exec_gate.acquire(timeout=max(1.0, min(8.0, float(timeout)))):
        return None, "pxe-hop-busy"
    try:
        try:
            stdin, stdout, stderr = hop.client.exec_command(
                "PYTHONUNBUFFERED=1 python3 -u /tmp/l12-gpu-power.py",
                timeout=20,
            )
        except Exception:
            return None, "pxe-hop-down"
        try:
            stdout.channel.settimeout(None)
        except Exception:
            pass
    finally:
        hop.exec_gate.release()
    pipe = _PowerPipe()
    pipe.stdin = stdin
    pipe.stdout = stdout
    pipe.stderr = stderr
    pipe.stamp = stamp
    pipe.targets_key = key
    spec = json.dumps({"timeout": 1.2, "persist": True, "targets": targets}) + "\n"
    try:
        stdin.write(spec)
        stdin.flush()
    except Exception:
        _close_power_pipe(pipe)
        return None, "pxe-hop-down"
    pipe.reader = threading.Thread(target=_power_pipe_reader, args=(pipe,), daemon=True, name="pxe-power-pipe")
    pipe.reader.start()
    threading.Thread(target=_drain_power_stderr, args=(pipe,), daemon=True, name="pxe-power-err").start()
    return pipe, ""


def _ensure_power_pipe(
    hop: _Hop, targets: list[dict[str, str]], timeout: float
) -> tuple[_PowerPipe | None, str]:
    stamp = hop.power_script
    if not stamp:
        return None, "pxe-hop-down"
    key = _power_targets_key(targets)
    with hop.pipe_lock:
        pipe = hop.power_pipe
        if pipe is not None and not pipe.dead and pipe.stamp == stamp and pipe.targets_key == key:
            return pipe, ""
        old = pipe
        hop.power_pipe = None
        if old is not None:
            _close_power_pipe(old)
        opened, err = _open_power_pipe(hop, targets, stamp, key, timeout)
        if opened is not None:
            hop.power_pipe = opened
        return opened, err


def _kick_power_pipe(pipe: _PowerPipe, on_node, timeout: float) -> str:
    with pipe.kick_lock:
        pipe.handler = on_node
        pipe.got = 0
        pipe.errors = []
        pipe.ready.clear()
        try:
            pipe.stdin.write("\n")
            pipe.stdin.flush()
        except Exception:
            _close_power_pipe(pipe)
            return "pxe-hop-down"
        if not pipe.ready.wait(max(0.1, float(timeout))):
            got = pipe.got
            _close_power_pipe(pipe)
            return "" if got else "power-read-timeout"
        if pipe.dead:
            return "" if pipe.got else "pxe-hop-down"
        if pipe.got:
            return ""
        return _most_common(list(pipe.errors)) or "power-reading-empty"


def _power_round(hop: _Hop, targets: list[dict[str, str]], on_node, timeout: float) -> str:
    pipe, err = _ensure_power_pipe(hop, targets, timeout)
    if pipe is None:
        return err or "pxe-hop-down"
    return _kick_power_pipe(pipe, on_node, timeout)


def _read_gpu_round(targets: list[dict[str, str]], on_node, *, timeout: float) -> str:
    if not targets:
        return ""
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    hop = _session()
    err = _power_round(hop, targets, on_node, timeout)
    pipe = hop.power_pipe
    # A dead process pays the TLS handshake again on the retry. An empty BMC reading does not.
    if pipe is None or pipe.dead or err in ("pxe-hop-down", "power-read-timeout", "pxe-hop-busy"):
        _stop_power_pipe(hop)
        err = _power_round(hop, targets, on_node, timeout)
    return err


def fetch_gpu_environment_metrics(
    targets: list[dict[str, str]], timeout: float = 20.0, host: str | None = None
) -> tuple[dict[str, list[dict[str, Any]]], str]:
    with on_host(host):
        return _fetch_gpu_environment_metrics(targets, timeout)


def _most_common(errors: list[str]) -> str:
    if not errors:
        return ""
    counts: dict[str, int] = {}
    for err in errors:
        counts[err] = counts.get(err, 0) + 1
    return max(counts, key=lambda key: (counts[key], key))


def _fetch_gpu_environment_metrics(
    targets: list[dict[str, str]], timeout: float
) -> tuple[dict[str, list[dict[str, Any]]], str]:
    """Per-GPU PowerWatts via BMC EnvironmentMetrics, run on the PXE hop.

    The second value is the most common per-node error when a BMC answered
    without a watt reading. Callers still get the GPUs that did report watts.
    """
    if not targets:
        return {}, ""
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    spec = json.dumps({"timeout": 1.2, "targets": targets})
    _code, out, err = run("PYTHONUNBUFFERED=1 python3 -u /tmp/l12-gpu-power.py", timeout=timeout, stdin_data=spec)
    by_ip: dict[str, list[dict[str, Any]]] = {}
    errors: list[str] = []
    saw = False
    for line in (out or "").splitlines():
        payload = _stdout_json(line)
        if not payload:
            continue
        saw = True
        if payload.get("done") or payload.get("ready") or payload.get("round"):
            continue
        rows = payload.get("nodes") if isinstance(payload.get("nodes"), list) and not payload.get("bmc_ip") else [payload]
        for node in rows:
            if not isinstance(node, dict):
                continue
            ip = str(node.get("bmc_ip") or "")
            if not ip:
                continue
            gpus = [g for g in (node.get("gpus") or []) if isinstance(g, dict) and g.get("watts") is not None]
            if gpus:
                by_ip[ip] = gpus
                continue
            msg = str(node.get("error") or "").strip()
            if msg:
                errors.append(msg[:120])
    if not saw and not by_ip:
        raise RuntimeError(err or f"GPU EnvironmentMetrics empty (exit {_code})")
    return by_ip, _most_common(errors)


def apply_gpu_setpoints(
    patches: list[dict[str, Any]], timeout: float = 45.0, host: str | None = None
) -> list[dict[str, Any]]:
    """PATCH PowerLimitWatts.SetPoint on each GPU via the PXE hop."""
    with on_host(host):
        return _apply_gpu_setpoints(patches, timeout)


def _apply_gpu_setpoints(patches: list[dict[str, Any]], timeout: float) -> list[dict[str, Any]]:
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


def stream_psu_power(
    targets: list[dict[str, str]],
    on_event,
    *,
    interval: float = 1.0,
    host: str | None = None,
) -> None:
    """1 Hz PowerShelf total_power_out on the hop; on_event(dict) per PMC line."""
    with on_host(host):
        _stream_psu_power(targets, on_event, interval=interval)


def _stream_psu_power(targets: list[dict[str, str]], on_event, *, interval: float) -> None:
    if not targets:
        return
    pinned = _session().host
    try:
        run("cat > /tmp/l12-psu-power.py", timeout=8, stdin_data=_HOP_PSU_POWER)
    except Exception:
        try:
            _ensure_hop_scripts()
        except Exception:
            pass
    spec = json.dumps({"timeout": 1.2, "interval": interval, "loop": True, "targets": targets})
    client = _ssh()
    stdin, stdout, stderr = client.exec_command(
        "PYTHONUNBUFFERED=1 python3 -u /tmp/l12-psu-power.py",
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
                if not _is_up(pinned):
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


def fetch_psu_power(
    targets: list[dict[str, str]], timeout: float = 20.0, host: str | None = None
) -> dict[str, dict[str, Any]]:
    with on_host(host):
        return _fetch_psu_power(targets, timeout)


def _fetch_psu_power(targets: list[dict[str, str]], timeout: float) -> dict[str, dict[str, Any]]:
    """Delta GB300 PowerShelf total_power_out via hop, keyed by BMC IP."""
    if not targets:
        return {}
    try:
        run("cat > /tmp/l12-psu-power.py", timeout=8, stdin_data=_HOP_PSU_POWER)
    except Exception:
        try:
            _ensure_hop_scripts()
        except Exception:
            pass
    spec = json.dumps({"timeout": 1.2, "targets": targets})
    _code, out, err = run("PYTHONUNBUFFERED=1 python3 -u /tmp/l12-psu-power.py", timeout=timeout, stdin_data=spec)
    payload = _stdout_json(out)
    if not payload:
        raise RuntimeError(err or f"PowerShelf total_power_out empty (exit {_code})")
    by_ip: dict[str, dict[str, Any]] = {}
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        ip = str(node.get("bmc_ip") or "")
        if ip:
            by_ip[ip] = node
    return by_ip


def fetch_bmc_health(
    targets: list[dict[str, str]],
    paths: dict[str, str],
    timeout: float = 40.0,
    host: str | None = None,
) -> dict[str, dict[str, Any]]:
    """One SSH exec per PXE. The PXE fans Redfish out to that rack's BMCs."""
    with on_host(host):
        return _fetch_bmc_health(targets, paths, timeout)


def _fetch_bmc_health(
    targets: list[dict[str, str]], paths: dict[str, str], timeout: float
) -> dict[str, dict[str, Any]]:
    if not targets:
        return {}
    try:
        _ensure_hop_scripts()
    except Exception:
        pass
    spec = json.dumps({"timeout": 3.0, "targets": targets, "paths": paths})
    code, out, err = run("PYTHONUNBUFFERED=1 python3 -u /tmp/l12-bmc-health.py", timeout=timeout, stdin_data=spec)
    payload = _stdout_json(out)
    if not payload:
        raise RuntimeError(err or f"BMC health empty (exit {code})")
    by_ip: dict[str, dict[str, Any]] = {}
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        ip = str(node.get("bmc_ip") or "")
        bodies = node.get("bodies") if isinstance(node.get("bodies"), dict) else {}
        if ip:
            by_ip[ip] = bodies
    return by_ip


def _hop_tcp_channel(bmc_ip: str, remote_port: int, host: str | None = None):
    with on_host(host):
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


def open_https_tunnel(key: str, bmc_ip: str, remote_port: int = 443, host: str | None = None) -> int:
    """Local TCP port on this API, piped over the rack's PXE (not whichever hop was connected last)."""
    pxe = bind_target(bmc_ip, host)
    if _host_key(getattr(_local, "host", None)) != _host_key(pxe):
        with on_host(pxe):
            return open_https_tunnel(key, bmc_ip, remote_port, host=pxe)
    hop = _session()
    pinned = hop.host
    client = hop.client
    transport = client.get_transport()
    if transport is None:
        raise NeedsHop("PXE hop dropped")
    with _lock:
        existing = hop.tunnels.get(key)
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
                    chan = _hop_tcp_channel(bmc_ip, remote_port, host=pinned)
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
        old = hop.tunnels.get(key)
        if old:
            old["alive"] = False
            try:
                old["sock"].close()
            except Exception:
                pass
        hop.tunnels[key] = item
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
    host: str | None = None,
) -> tuple[int, dict[str, str], bytes]:
    """HTTPS to a BMC through the PXE stored on its rack. Browser never sees 10.10.x. No IPMI."""
    pxe = bind_target(bmc_ip, host)
    with on_host(pxe):
        return _https_request(
            bmc_ip,
            method,
            path,
            headers=headers,
            body=body,
            timeout=timeout,
            tunnel_key=tunnel_key,
            prefer_exec=prefer_exec,
        )


def _https_request(
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


def _redfish_json(bmc_ip: str, path: str, user: str, password: str, host: str | None = None) -> dict[str, Any]:
    status, _headers, data = https_request(
        bmc_ip,
        "GET",
        path,
        headers={**_basic_auth(user, password), "Accept": "application/json"},
        timeout=12,
        tunnel_key=f"https-{bmc_ip}",
        host=host,
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
    """Pull console/logs through the rack's PXE. OpenBMC has Redfish; IPMI RMCP+ does not work."""
    pxe = bind_target(bmc_ip)
    if _host_key(getattr(_local, "host", None)) != _host_key(pxe):
        with on_host(pxe):
            return sol_capture(bmc_ip, username, password)
    user = username or "ADMIN"
    lines = [
        f"=== PXE hop {pxe} → BMC {bmc_ip} (HTTPS via hop python, no IPMI) ===",
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


def find_ip_for_mac(mac: str, host: str | None = None) -> dict[str, Any]:
    """Look up current IP for a MAC on that rack's PXE (neighbor table + DHCP leases)."""
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
    with on_host(bind_target("", host)):
        code, out, err = run(cmd, timeout=15, stdin_data=script)
    rows = []
    try:
        import json as _json

        rows = _json.loads((out or "").strip() or "[]")
    except Exception:
        rows = []
    return {"mac": mac, "matches": rows, "ip": rows[0]["ip"] if rows else None, "error": err.strip() if err and not rows else None}


def find_mac_for_ip(ip: str, host: str | None = None) -> dict[str, Any]:
    """Look up MAC for a BMC IP on that rack's PXE (ping + neighbor + DHCP)."""
    ip = (ip or "").strip()
    if not ip:
        raise RuntimeError("IP is required")
    script = r"""
import os, re, subprocess, sys
ip = sys.argv[1]
found = []

def add(mac, src):
    hex_only = re.sub(r"[^0-9a-fA-F]", "", mac or "")
    if len(hex_only) != 12:
        return
    mac = ":".join(hex_only[i:i+2] for i in range(0, 12, 2)).lower()
    if mac not in {x["mac"] for x in found}:
        found.append({"mac": mac, "source": src})

try:
    subprocess.run(["ping", "-c", "1", "-W", "1", ip], capture_output=True, timeout=3)
except Exception:
    pass
try:
    neigh = subprocess.run(["ip", "neigh", "show", ip], capture_output=True, text=True, timeout=5)
    for line in (neigh.stdout or "").splitlines():
        m = re.search(r"lladdr\s+(\S+)", line)
        if m:
            add(m.group(1), "neighbor")
    br = subprocess.run(["ip", "-br", "neigh"], capture_output=True, text=True, timeout=5)
    for line in (br.stdout or "").splitlines():
        parts = line.split()
        if parts and parts[0] == ip:
            for p in parts[1:]:
                if re.search(r"[0-9a-fA-F]{2}([:.-][0-9a-fA-F]{2}){5}", p):
                    add(p, "neighbor")
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
            if not re.search(r"(^|lease\s+)%s\b" % re.escape(ip), b):
                continue
            m = re.search(r"hardware ethernet\s+([0-9a-fA-F:]+)", b, re.I)
            if m:
                add(m.group(1), path)
    else:
        for line in text.splitlines():
            if ip not in line:
                continue
            for p in line.split():
                if re.search(r"[0-9a-fA-F]{2}([:.-][0-9a-fA-F]{2}){5}", p):
                    add(p, path)
print(__import__("json").dumps(found))
"""
    cmd = "python3 - " + shlex.quote(ip)
    with on_host(bind_target(ip, host)):
        code, out, err = run(cmd, timeout=15, stdin_data=script)
    rows = []
    try:
        import json as _json

        rows = _json.loads((out or "").strip() or "[]")
    except Exception:
        rows = []
    return {"ip": ip, "matches": rows, "mac": rows[0]["mac"] if rows else None, "error": err.strip() if err and not rows else None}


def _first_member(col: dict[str, Any] | None) -> str | None:
    hrefs = _member_hrefs(col)
    return hrefs[0] if hrefs else None


def _member_hrefs(col: dict[str, Any] | None, limit: int = 6) -> list[str]:
    members = (col or {}).get("Members") if isinstance(col, dict) else None
    if not isinstance(members, list):
        return []
    out: list[str] = []
    for row in members[:limit]:
        href = row.get("@odata.id") if isinstance(row, dict) else None
        if href:
            out.append(str(href))
    return out


def _mac_of(rec: dict[str, Any] | None) -> str | None:
    if not isinstance(rec, dict) or rec.get("_error"):
        return None
    for key in ("MACAddress", "PermanentMACAddress", "mac"):
        raw = rec.get(key)
        if raw:
            hex_only = re.sub(r"[^0-9a-fA-F]", "", str(raw))
            if len(hex_only) == 12:
                return ":".join(hex_only[i : i + 2] for i in range(0, 12, 2)).lower()
    return None


def redfish_identity(bmc_ip: str, user: str | None, password: str | None) -> dict[str, Any]:
    """Serial, hostname, model, and NIC MACs from the BMC over the PXE hop."""
    auth = (user or "ADMIN").strip() or "ADMIN"
    pw = password or ""
    out: dict[str, Any] = {
        "serial": None,
        "hostname": None,
        "model": None,
        "manufacturer": None,
        "bmc_mac": None,
        "os_mac": None,
        "power_state": None,
        "error": None,
    }
    try:
        system = None
        for path in ("/redfish/v1/Systems/System_0", "/redfish/v1/Systems/1"):
            rec = _redfish_json(bmc_ip, path, auth, pw)
            if rec and not rec.get("_error"):
                system = rec
                break
        if system is None:
            href = _first_member(_redfish_json(bmc_ip, "/redfish/v1/Systems", auth, pw))
            if href:
                rec = _redfish_json(bmc_ip, href, auth, pw)
                if rec and not rec.get("_error"):
                    system = rec
        chassis = None
        for path in ("/redfish/v1/Chassis/Chassis_0", "/redfish/v1/Chassis/1"):
            rec = _redfish_json(bmc_ip, path, auth, pw)
            if rec and not rec.get("_error"):
                chassis = rec
                break
        if chassis is None:
            href = _first_member(_redfish_json(bmc_ip, "/redfish/v1/Chassis", auth, pw))
            if href:
                rec = _redfish_json(bmc_ip, href, auth, pw)
                if rec and not rec.get("_error"):
                    chassis = rec
        system = system or {}
        chassis = chassis or {}
        serial = chassis.get("SerialNumber") or system.get("SerialNumber") or chassis.get("SKU") or system.get("SKU")
        host = system.get("HostName") or system.get("Name")
        if host and str(host).lower() in {"system", "system_0", "computer system", "system 0"}:
            host = None
        out["serial"] = str(serial).strip() if serial else None
        out["hostname"] = str(host).strip() if host else None
        out["model"] = system.get("Model") or chassis.get("Model")
        out["manufacturer"] = system.get("Manufacturer") or chassis.get("Manufacturer")
        out["power_state"] = system.get("PowerState") or chassis.get("PowerState")

        mgr_mac = None
        nic_paths = [
            "/redfish/v1/Managers/BMC_0/EthernetInterfaces",
            "/redfish/v1/Managers/1/EthernetInterfaces",
            "/redfish/v1/Managers/Self/EthernetInterfaces",
        ]
        href = _first_member(_redfish_json(bmc_ip, "/redfish/v1/Managers", auth, pw))
        if href:
            nic_paths.append(f"{href.rstrip('/')}/EthernetInterfaces")
        for path in nic_paths:
            col = _redfish_json(bmc_ip, path, auth, pw)
            for nic_href in _member_hrefs(col):
                mgr_mac = _mac_of(_redfish_json(bmc_ip, nic_href, auth, pw))
                if mgr_mac:
                    break
            if mgr_mac:
                break
        out["bmc_mac"] = mgr_mac

        os_mac = None
        nics_href = ((system.get("EthernetInterfaces") or {}) if isinstance(system.get("EthernetInterfaces"), dict) else {}).get("@odata.id")
        col = _redfish_json(bmc_ip, nics_href, auth, pw) if nics_href else None
        href = _first_member(col)
        if href:
            os_mac = _mac_of(_redfish_json(bmc_ip, href, auth, pw))
        if os_mac and os_mac != mgr_mac:
            out["os_mac"] = os_mac
        if not out["serial"] and not out["hostname"] and not out["bmc_mac"]:
            err = (system or {}).get("_error") or (chassis or {}).get("_error")
            out["error"] = str(err) if err else "Redfish returned no identity"
    except NeedsHop:
        raise
    except Exception as exc:
        out["error"] = str(exc)
    return out
