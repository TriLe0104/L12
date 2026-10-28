"""Client for Cluster Backend Controller (rack / node / powershelf inventory)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import settings

class _Conn:
    __slots__ = ("token", "down_until")

    def __init__(self) -> None:
        self.token: str | None = None
        self.down_until = 0.0


_conns: dict[str, _Conn] = {}
_sensor_cache: dict[str, tuple[float, dict[str, float]]] = {}
_SENSOR_TTL_S = 5.0


def _base(base: str | None = None) -> str:
    return ((base if base is not None else settings.cluster_controller_url) or "").rstrip("/")


def _conn(base: str) -> _Conn:
    conn = _conns.get(base)
    if conn is None:
        conn = _Conn()
        _conns[base] = conn
    return conn


def _url(path: str, base: str | None = None) -> str:
    root = _base(base)
    if not path.startswith("/"):
        path = "/" + path
    return root + path


def _host_of(base: str) -> str:
    return urllib.parse.urlparse(base).hostname or base


def _request(
    method: str,
    path: str,
    *,
    data: dict | None = None,
    token: str | None = None,
    timeout: float = 3.0,
    base: str | None = None,
) -> Any:
    root = _base(base)
    if not root:
        raise RuntimeError("cluster controller URL is not set")
    conn = _conn(root)
    if time.time() < conn.down_until:
        raise RuntimeError(f"controller unreachable {_host_of(root)}: recent fail")
    headers: dict[str, str] = {"Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(_url(path, root), data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode())
    except urllib.error.HTTPError as exc:
        exc.read()
        raise RuntimeError(f"controller {method} {path} -> {exc.code}") from None
    except urllib.error.URLError as exc:
        conn.down_until = time.time() + 20.0
        raise RuntimeError(f"controller unreachable {_host_of(root)}: {exc.reason}") from None
    except TimeoutError as exc:
        conn.down_until = time.time() + 20.0
        raise RuntimeError(f"controller unreachable {_host_of(root)}: {exc}") from None


def login(base: str | None = None) -> str:
    root = _base(base)
    conn = _conn(root)
    payload = {"username": settings.cluster_controller_user, "password": settings.cluster_controller_password}
    out = _request("POST", "/api/login", data=payload, base=root)
    token = None
    if isinstance(out, dict):
        token = out.get("token") or out.get("access_token")
    if not token:
        raise RuntimeError(f"controller login failed {_host_of(root)}")
    conn.token = str(token)
    return conn.token


def _request_bytes(
    method: str,
    path: str,
    *,
    token: str | None = None,
    timeout: float = 20.0,
    base: str | None = None,
) -> tuple[bytes, str]:
    root = _base(base)
    if not root:
        raise RuntimeError("cluster controller URL is not set")
    conn = _conn(root)
    if time.time() < conn.down_until:
        raise RuntimeError(f"controller unreachable {_host_of(root)}: recent fail")
    headers: dict[str, str] = {"Accept": "*/*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(_url(path, root), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read() or b""
            ctype = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
            return raw, ctype or "application/octet-stream"
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"controller {method} {path} -> {exc.code} {detail}") from None
    except urllib.error.URLError as exc:
        conn.down_until = time.time() + 20.0
        raise RuntimeError(f"controller unreachable {_host_of(root)}: {exc.reason}") from None
    except TimeoutError as exc:
        conn.down_until = time.time() + 20.0
        raise RuntimeError(f"controller unreachable {_host_of(root)}: {exc}") from None


def _authed_bytes(path: str, timeout: float = 20.0, base: str | None = None) -> tuple[bytes, str]:
    root = _base(base)
    conn = _conn(root)
    if not conn.token:
        login(root)
    try:
        return _request_bytes("GET", path, token=_conn(root).token, timeout=timeout, base=root)
    except RuntimeError as exc:
        if "-> 401" not in str(exc):
            raise
        login(root)
        return _request_bytes("GET", path, token=_conn(root).token, timeout=timeout, base=root)


def _authed(method: str, path: str, data: dict | None = None, timeout: float = 8.0, base: str | None = None) -> Any:
    root = _base(base)
    conn = _conn(root)
    if not conn.token:
        login(root)
    try:
        return _request(method, path, data=data, token=_conn(root).token, timeout=timeout, base=root)
    except RuntimeError as exc:
        if "-> 401" not in str(exc):
            raise
        login(root)
        return _request(method, path, data=data, token=_conn(root).token, timeout=timeout, base=root)


def _rack_path(serial: str, name: str, extra: str = "") -> str:
    sn = urllib.parse.quote(str(serial), safe="")
    nm = urllib.parse.quote(str(name), safe="")
    path = f"/api/racks/{sn}/{nm}"
    if extra:
        path += extra if extra.startswith("/") else "/" + extra
    return path


def list_racks(base: str | None = None) -> list[dict[str, Any]]:
    rows = _authed("GET", "/api/racks/", base=base)
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict)]


def get_rack(serial: str, name: str, base: str | None = None) -> dict[str, Any]:
    row = _authed("GET", _rack_path(serial, name), base=base)
    return row if isinstance(row, dict) else {}


def enabled() -> bool:
    return bool((settings.cluster_controller_url or "").strip())


def tests_list(rack_serial: str | None = None, rack_name: str | None = None) -> list[dict[str, Any]]:
    params: list[tuple[str, str]] = []
    if rack_serial:
        params.append(("rack_serial_number", rack_serial))
    if rack_name:
        params.append(("rack_name", rack_name))
    path = "/api/tests/tests-list"
    if params:
        path += "?" + urllib.parse.urlencode(params)
    rows = _authed("GET", path, timeout=12.0)
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def active_test_runs() -> dict[str, Any]:
    row = _authed("GET", "/api/tests/active-runs")
    return row if isinstance(row, dict) else {"active_runs": []}


def run_test(tests: list[str], racks: list[dict[str, Any]], l10_subtests: dict[str, list[str]] | None = None) -> Any:
    body: dict[str, Any] = {"tests": tests, "racks": racks}
    if l10_subtests:
        body["l10_subtests"] = l10_subtests
    return _authed("POST", "/api/tests/run-test", data=body, timeout=30.0)


def cancel_test(serial: str) -> Any:
    sn = urllib.parse.quote(str(serial), safe="")
    return _authed("POST", f"/api/tests/cancel/{sn}", data={})


def reports(serial: str | None = None, name: str | None = None) -> list[dict[str, Any]]:
    params: list[tuple[str, str]] = []
    if serial:
        params.append(("serial_number", serial))
    if name:
        params.append(("name", name))
    path = "/api/reports/all"
    if params:
        path += "?" + urllib.parse.urlencode(params)
    rows = _authed("GET", path, timeout=25.0)
    if isinstance(rows, dict):
        inner = rows.get("reports") or rows.get("data") or rows.get("items")
        rows = inner if isinstance(inner, list) else []
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def rack_test_results(serial: str, name: str) -> Any:
    return _authed("GET", _rack_path(serial, name, "/test_results"), timeout=12.0)


def rack_latest_report(serial: str, name: str) -> Any:
    return _authed("GET", _rack_path(serial, name, "/latest_report"), timeout=12.0)


def node_logs(bmc_mac: str) -> Any:
    mac = urllib.parse.quote(str(bmc_mac), safe="")
    return _authed("GET", f"/api/logs/nodes/{mac}", timeout=12.0)


def logs_all() -> Any:
    return _authed("GET", "/api/logs/all", timeout=12.0)


def read_log_file(path: str) -> Any:
    q = urllib.parse.urlencode({"path": path})
    return _authed("GET", f"/api/logs?{q}", timeout=20.0)


def read_file_bytes(path: str) -> tuple[bytes, str]:
    q = urllib.parse.urlencode({"path": path})
    return _authed_bytes(f"/api/logs?{q}", timeout=20.0)


def node_test_status(bmc_mac: str) -> Any:
    q = urllib.parse.urlencode({"bmc_mac": bmc_mac})
    return _authed("GET", f"/api/nodes/test_status?{q}")


def power_operation(serial: str, name: str, operation: str, limit: list[str] | None = None) -> Any:
    sn = urllib.parse.quote(str(serial), safe="")
    nm = urllib.parse.quote(str(name), safe="")
    body: dict[str, Any] = {"operation": operation}
    if limit:
        body["limit"] = limit
    return _authed("POST", f"/api/power/operation/{sn}/{nm}", data=body, timeout=20.0)


def latest_sensor(sensor_name: str, macs: list[str], *, seconds_ago: int = 180) -> dict[str, float]:
    """Latest Argus sensor reading per BMC MAC. Values are in the sensor's native unit (watts for TotalPowerOut)."""
    cleaned = [str(m).strip().lower() for m in macs if m]
    if not cleaned or not enabled():
        return {}
    key = f"{sensor_name}|{','.join(sorted(cleaned))}|{seconds_ago}"
    now = time.time()
    hit = _sensor_cache.get(key)
    if hit and now - hit[0] < _SENSOR_TTL_S:
        return dict(hit[1])
    params: list[tuple[str, str]] = [
        ("sensor_name", sensor_name),
        ("seconds_ago", str(seconds_ago)),
        ("max_points", "8"),
    ]
    params.extend(("bmc_mac", m) for m in cleaned)
    path = "/api/sensors/graphdata?" + urllib.parse.urlencode(params)
    try:
        rows = _authed("GET", path)
    except Exception:
        return dict(hit[1]) if hit else {}
    out: dict[str, float] = {}
    if isinstance(rows, list):
        for item in rows:
            if not isinstance(item, dict):
                continue
            mac = str(item.get("name") or "").strip().lower()
            val = None
            for pt in item.get("data") or []:
                if not isinstance(pt, dict) or pt.get("data") is None:
                    continue
                try:
                    val = float(pt["data"])
                except (TypeError, ValueError):
                    continue
            if mac and val is not None:
                out[mac] = val
    _sensor_cache[key] = (now, out)
    return dict(out)
