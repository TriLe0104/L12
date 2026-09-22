"""Client for Cluster Backend Controller (rack / node / powershelf inventory)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import settings

_token: str | None = None
_sensor_cache: dict[str, tuple[float, dict[str, float]]] = {}
_SENSOR_TTL_S = 5.0


def _url(path: str) -> str:
    base = (settings.cluster_controller_url or "").rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def _request(method: str, path: str, *, data: dict | None = None, token: str | None = None, timeout: float = 25.0) -> Any:
    headers: dict[str, str] = {"Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(_url(path), data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"controller {method} {path} -> {exc.code}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"controller unreachable: {exc.reason}") from None


def login() -> str:
    global _token
    payload = {"username": settings.cluster_controller_user, "password": settings.cluster_controller_password}
    out = _request("POST", "/api/login", data=payload)
    token = None
    if isinstance(out, dict):
        token = out.get("token") or out.get("access_token")
    if not token:
        raise RuntimeError("controller login failed")
    _token = str(token)
    return _token


def _authed(method: str, path: str) -> Any:
    global _token
    if not _token:
        login()
    try:
        return _request(method, path, token=_token)
    except RuntimeError as exc:
        if "-> 401" not in str(exc):
            raise
        login()
        return _request(method, path, token=_token)


def _rack_path(serial: str, name: str, extra: str = "") -> str:
    sn = urllib.parse.quote(str(serial), safe="")
    nm = urllib.parse.quote(str(name), safe="")
    path = f"/api/racks/{sn}/{nm}"
    if extra:
        path += extra if extra.startswith("/") else "/" + extra
    return path


def list_racks() -> list[dict[str, Any]]:
    rows = _authed("GET", "/api/racks/")
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict)]


def get_rack(serial: str, name: str) -> dict[str, Any]:
    row = _authed("GET", _rack_path(serial, name))
    return row if isinstance(row, dict) else {}


def enabled() -> bool:
    return bool((settings.cluster_controller_url or "").strip())


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
