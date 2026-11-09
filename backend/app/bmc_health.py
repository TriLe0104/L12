"""Live BMC health for the cluster Overview: leak, thermal, PSU, fans, system.

Reads Redfish on each inventory compute BMC. Nodes with a PXE in Provision are
polled by one script on that PXE. This process does not open an SSH session per
Redfish GET. A node with no PXE is read directly only when it is the local probe.
"""

from __future__ import annotations

import base64
import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import settings

_TLS = ssl._create_unverified_context()
_EXPAND = "?$expand=.($levels=1)"
# A pass that returns immediately still waits this long so a down PXE does not
# tight-spin. A pass that already took longer starts the next one at once.
_POLL_FLOOR_S = 0.25
_GET_TIMEOUT = 8.0
# Redfish often answers with an empty TemperatureReadingsCelsius or PowerWatts
# object when the previous read is still settling. Keep the last real values
# this long before the panel is allowed to go blank.
_ATTR_HOLD_S = 120.0
_SAMPLE_S = 10.0
_HIST_KEEP_S = 8 * 86400
TELEM_SPANS = {"1d": 86400, "3d": 3 * 86400, "1w": 7 * 86400}
TELEM_POINTS = {"1d": 288, "3d": 216, "1w": 168}

_RANK = {"ok": 0, "unknown": 1, "warning": 2, "critical": 3}

_LOCK = threading.Lock()
_SNAP: dict[str, Any] = {
    "source": None,
    "via": None,
    "error": None,
    "poll_age_s": None,
    "t": 0.0,
    "nodes": [],
    "summary": None,
}
_WATCH: threading.Thread | None = None
_WATCH_LOCK = threading.Lock()
_FAIL_UNTIL: dict[str, float] = {}
_FAIL_HOLD_S = 60.0
_CENSUS: dict[str, float] = {"t": 0.0, "total": 0}
_HIST: list[tuple[float, float | None, float | None]] = []
_NODE_HIST: list[tuple[float, list]] = []
_HIST_LOCK = threading.Lock()
_HIST_LOADED = False
_last_node_sample = 0.0
_NODE_SAMPLE_S = 30.0
_last_sample = 0.0
_last_prune = 0.0


def _worse(a: str | None, b: str | None) -> str:
    aa = a if a in _RANK else "unknown"
    bb = b if b in _RANK else "unknown"
    return aa if _RANK[aa] >= _RANK[bb] else bb


def _fold(cur: str | None, nxt: str | None) -> str:
    """Roll up live statuses; unknown must not outrank OK."""
    if nxt in (None, "", "unknown"):
        return cur or "unknown"
    if cur in (None, "", "unknown"):
        return str(nxt)
    return _worse(cur, str(nxt))


def _level(health: Any = None, state: Any = None, detector: Any = None) -> str:
    bits = [str(x).strip() for x in (health, state, detector) if x is not None and str(x).strip()]
    blob = " ".join(bits).lower()
    if not blob:
        return "unknown"
    if any(
        x in blob
        for x in ("critical", "leakdetected", "failed", "emergency", "unusable", "absent")
    ):
        return "critical"
    if any(x in blob for x in ("warning", "degraded", "throttl", "non-critical")):
        return "warning"
    if any(x in blob for x in ("ok", "enabled", "on", "healthy")):
        return "ok"
    return "unknown"


def _status_level(obj: Any) -> str:
    if not isinstance(obj, dict):
        return "unknown"
    st = obj.get("Status") if isinstance(obj.get("Status"), dict) else obj
    if not isinstance(st, dict):
        return "unknown"
    return _level(st.get("HealthRollup") or st.get("Health"), st.get("State"), obj.get("DetectorState"))


def _num(x: Any) -> float | None:
    if isinstance(x, dict):
        return _num(x.get("Reading") if x.get("Reading") is not None else x.get("Value"))
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x)
        except ValueError:
            return None
    return None


_GPU_INLET = re.compile(r"ProcessorModule_(\d+)_Inlet_Temp_(\d+)", re.I)
_GPU_EXHAUST = re.compile(r"ProcessorModule_(\d+)_Exhaust_Temp_(\d+)", re.I)


def _gpu_index(name: str, kind: str = "inlet") -> int | None:
    pat = _GPU_INLET if kind == "inlet" else _GPU_EXHAUST
    m = pat.search(name or "")
    if not m:
        return None
    idx = int(m.group(1)) * 2 + int(m.group(2))
    return idx if 0 <= idx <= 3 else None


def _gpu_temps(temps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found: dict[int, dict[str, Any]] = {}
    for t in temps:
        name = str(t.get("name") or "")
        idx = _gpu_index(name, "inlet")
        if idx is None or t.get("celsius") is None:
            continue
        found[idx] = {"index": idx, "label": f"GPU {idx}", "celsius": t["celsius"], "name": name}
    return [found[i] for i in range(4) if i in found]


def _short(name: str) -> str:
    s = name or ""
    inlet = _gpu_index(s, "inlet")
    if inlet is not None:
        return f"GPU {inlet}"
    exhaust = _gpu_index(s, "exhaust")
    if exhaust is not None:
        return f"GPU {exhaust} Exhaust"
    s = s.replace("Chassis 0 LeakDetector ", "Leak ")
    s = s.replace("Chassis_0_", "").replace("HGX_", "")
    s = s.replace("_Temp_0", "").replace("_Temp_1", "").replace("_Temp", "")
    s = s.replace("ProcessorModule_", "GPU ").replace("LeakDetector_", "Leak ")
    s = s.replace("_", " ").strip()
    return s or name or "sensor"


def _fmt_c(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v:.0f}°C" if abs(v) >= 10 else f"{v:.1f}°C"


def _fmt_w(v: float | None) -> str:
    if v is None:
        return "—"
    if abs(v) >= 1000:
        return f"{v / 1000.0:.2f} kW"
    return f"{v:.0f} W"


def _fmt_rpm(v: float | None) -> str:
    if v is None:
        return "—"
    if v >= 1000:
        return f"{v / 1000.0:.1f}k RPM"
    return f"{v:.0f} RPM"


def _direct_get(ip: str, path: str, user: str, password: str, timeout: float) -> dict[str, Any]:
    url = f"https://{ip}{path}"
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Host": ip,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_TLS) as resp:
            raw = resp.read()
            status = int(getattr(resp, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        return {"_error": f"HTTP {exc.code}", "_path": path}
    except Exception as exc:
        return {"_error": str(exc)[:180], "_path": path}
    if status >= 400:
        return {"_error": f"HTTP {status}", "_path": path}
    try:
        return json.loads(raw.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        return {"_error": str(exc)[:120], "_path": path}


def redfish_get(ip: str, path: str, user: str, password: str, timeout: float = _GET_TIMEOUT) -> dict[str, Any]:
    """Overview health talks to BMCs from this process only.

    Never SSH-exec through the PXE jump host. A 16-path × N-node poll as root
    hits sshd MaxSessions / pam_faillock and locks the jump account.
    """
    body = _direct_get(ip, path, user, password, timeout)
    if isinstance(body, dict) and not body.get("_error"):
        body["_via"] = "direct"
    return body


def redfish_call(
    ip: str,
    path: str,
    user: str,
    password: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 12.0,
) -> dict[str, Any]:
    """Direct HTTPS Redfish. Never through the PXE hop."""
    method = (method or "GET").upper()
    if method == "GET" and body is None:
        return redfish_get(ip, path, user, password, timeout)
    url = f"https://{ip}{path}"
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    raw_body = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Basic {token}",
        "Accept": "application/json",
        "Host": ip,
    }
    if raw_body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=raw_body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_TLS) as resp:
            raw = resp.read()
            status = int(getattr(resp, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", "replace")[:400]
        return {"_error": f"HTTP {exc.code}", "_path": path, "_body": err_body, "_via": "direct"}
    except Exception as exc:
        return {"_error": str(exc)[:180], "_path": path, "_via": "direct"}
    parsed: Any = {}
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            parsed = {"_raw": raw.decode("utf-8", "replace")[:400]}
    if not isinstance(parsed, dict):
        parsed = {"value": parsed}
    parsed["_status"] = status
    parsed["_via"] = "direct"
    return parsed


def _targets() -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    probe = (getattr(settings, "bmc_probe_ip", None) or "").strip()
    probe_user = (getattr(settings, "bmc_probe_user", None) or "root").strip() or "root"
    probe_pw = getattr(settings, "bmc_probe_password", None) or ""
    try:
        from .gpu_power import _gpu_live_targets

        for rid, idx, ip, user, pw in _gpu_live_targets():
            ip = (ip or "").strip()
            if not ip or ip in seen:
                continue
            password = pw or (probe_pw if ip == probe else "")
            if not password:
                continue
            hold = _FAIL_UNTIL.get(ip) or 0.0
            if hold > time.time() and ip != probe:
                continue
            seen.add(ip)
            out.append(
                {
                    "rack_id": str(rid),
                    "node_index": str(idx),
                    "bmc_ip": ip,
                    "user": user or "root",
                    "password": password,
                }
            )
    except Exception:
        pass
    return out


def _members(body: dict[str, Any]) -> list[dict[str, Any]]:
    rows = body.get("Members") or []
    return [m for m in rows if isinstance(m, dict)]


def _temps(body: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in body.get("TemperatureReadingsCelsius") or []:
        if not isinstance(row, dict):
            continue
        reading = _num(row)
        name = str(row.get("DeviceName") or row.get("Name") or row.get("Id") or "")
        if reading is None:
            continue
        out.append(
            {
                "name": name,
                "label": _short(name),
                "celsius": round(reading, 2),
                "context": row.get("PhysicalContext"),
            }
        )
    out.sort(key=lambda r: -float(r["celsius"]))
    return out


def _fans(env: dict[str, Any]) -> dict[str, Any]:
    pwm: list[float] = []
    rpm: list[float] = []
    items: list[dict[str, Any]] = []
    health = "ok"
    for row in env.get("FanSpeedsPercent") or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("DeviceName") or row.get("Name") or "")
        ident = name.lower()
        raw = _num(row.get("SpeedRPM") if row.get("SpeedRPM") is not None else row)
        if raw is None:
            continue
        kind = "pwm" if "pwm" in ident else "rpm"
        if kind == "pwm":
            pct = raw if raw <= 100 else raw / 100.0
            pwm.append(pct)
            items.append({"name": _short(name), "kind": "pwm", "pct": round(pct, 1)})
        else:
            rpm.append(raw)
            st = "ok" if raw > 500 else "critical"
            health = _worse(health, st)
            items.append({"name": _short(name), "kind": "rpm", "rpm": round(raw), "status": st})
    total = max(len(pwm), len(rpm) // 2, 0)
    running = sum(1 for p in pwm if p > 0) if pwm else sum(1 for r in rpm if r > 500) // 2
    running = max(0, min(total, running))
    if total and running < total:
        health = _worse(health, "warning" if running else "critical")
    return {
        "status": health if (pwm or rpm) else "unknown",
        "pwm_pct": round(sum(pwm) / len(pwm), 1) if pwm else None,
        "rpm_avg": round(sum(rpm) / len(rpm)) if rpm else None,
        "rpm_min": round(min(rpm)) if rpm else None,
        "count": total,
        "running": running,
        "ok": sum(1 for i in items if i.get("kind") == "rpm" and i.get("status") == "ok"),
        "items": items[:24],
    }


def _leaks(body: dict[str, Any]) -> dict[str, Any]:
    dets: list[dict[str, Any]] = []
    for row in _members(body):
        name = str(row.get("Name") or row.get("Id") or "")
        st = _status_level(row)
        dets.append(
            {
                "id": row.get("Id"),
                "name": name,
                "label": _short(name),
                "type": row.get("LeakDetectorType"),
                "detector_state": row.get("DetectorState"),
                "status": st,
            }
        )
    health = "ok"
    for d in dets:
        health = _worse(health, str(d["status"]))
    if not dets:
        health = _status_level(body) if body and not body.get("_error") else "unknown"
    ok_n = sum(1 for d in dets if d["status"] == "ok")
    return {
        "status": health,
        "ok": ok_n,
        "total": len(dets),
        "detectors": dets,
    }


def _health_paths() -> dict[str, str]:
    return {
        "system": "/redfish/v1/Systems/System_0",
        "hgx_system": "/redfish/v1/Systems/HGX_Baseboard_0",
        "chassis": "/redfish/v1/Chassis/Chassis_0",
        "thermal": "/redfish/v1/Chassis/Chassis_0/ThermalSubsystem",
        "leaks": f"/redfish/v1/Chassis/Chassis_0/ThermalSubsystem/LeakDetection/LeakDetectors{_EXPAND}",
        "temps": "/redfish/v1/Chassis/Chassis_0/ThermalSubsystem/ThermalMetrics",
        "env": "/redfish/v1/Chassis/Chassis_0/EnvironmentMetrics",
        "power_sub": "/redfish/v1/Chassis/Chassis_0/PowerSubsystem",
        "psus": f"/redfish/v1/Chassis/Chassis_0/PowerSubsystem/PowerSupplies{_EXPAND}",
        "hgx_chassis": "/redfish/v1/Chassis/HGX_Chassis_0",
        "hgx_temps": "/redfish/v1/Chassis/HGX_Chassis_0/ThermalSubsystem/ThermalMetrics",
        "hgx_env": "/redfish/v1/Chassis/HGX_Chassis_0/EnvironmentMetrics",
        "pdb": "/redfish/v1/Chassis/PDB_0",
        "cbc0": "/redfish/v1/Chassis/CBC_0",
        "cbc1": "/redfish/v1/Chassis/CBC_1",
        "cbc2": "/redfish/v1/Chassis/CBC_2",
        "cbc3": "/redfish/v1/Chassis/CBC_3",
    }


def _bodies_ok(fetched: dict[str, Any]) -> bool:
    return any(isinstance(v, dict) and v and not v.get("_error") for v in fetched.values())


def _assemble(target: dict[str, str], fetched: dict[str, Any], via: str) -> dict[str, Any]:
    ip = target["bmc_ip"]
    if not _bodies_ok(fetched):
        _FAIL_UNTIL[ip] = time.time() + _FAIL_HOLD_S
        return {
            "bmc_ip": ip,
            "rack_id": target.get("rack_id"),
            "node_index": target.get("node_index"),
            "via": via,
            "error": "no-bmc-reading",
            "status": "unknown",
        }
    errors = [f"{k}:{v.get('_error')}" for k, v in fetched.items() if isinstance(v, dict) and v.get("_error")]
    if len(errors) >= 12:
        _FAIL_UNTIL[ip] = time.time() + _FAIL_HOLD_S
    elif ip in _FAIL_UNTIL:
        _FAIL_UNTIL.pop(ip, None)
    system = fetched.get("system") or {}
    hgx_sys = fetched.get("hgx_system") or {}
    chassis = fetched.get("chassis") or {}
    thermal = fetched.get("thermal") or {}
    env = fetched.get("env") or {}
    hgx_ch = fetched.get("hgx_chassis") or {}
    hgx_env = fetched.get("hgx_env") or {}
    pdb = fetched.get("pdb") or {}
    power_sub = fetched.get("power_sub") or {}
    psus_body = fetched.get("psus") or {}

    temps = _temps(fetched.get("temps") or {})
    hgx_temps = _temps(fetched.get("hgx_temps") or {})
    all_temps = temps + hgx_temps
    gpu_temps = _gpu_temps(all_temps)
    hottest = all_temps[0] if all_temps else None
    inlet = next((t for t in hgx_temps if "inlet" in t["name"].lower()), None)
    exhaust = next((t for t in hgx_temps if "exhaust" in t["name"].lower()), None)

    leaks = _leaks(fetched.get("leaks") or {})
    fans = _fans(env)

    watts = _num((env.get("PowerWatts") if isinstance(env.get("PowerWatts"), dict) else None) or env.get("PowerWatts"))
    psu_rows = []
    for row in _members(psus_body):
        psu_rows.append(
            {
                "id": row.get("Id") or row.get("Name"),
                "status": _status_level(row),
                "watts": _num(row.get("OutputWatts") or row.get("LastPowerOutputWatts") or row.get("PowerOutputWatts")),
            }
        )
    cbc_items = []
    for key in ("cbc0", "cbc1", "cbc2", "cbc3"):
        body = fetched.get(key) or {}
        if body.get("_error"):
            continue
        cbc_items.append(
            {
                "id": body.get("Id") or key,
                "model": body.get("Model"),
                "health": _status_level(body),
                "power_state": body.get("PowerState"),
            }
        )
    cbc_health = "ok" if cbc_items else "unknown"
    for c in cbc_items:
        cbc_health = _worse(cbc_health, str(c["health"]))

    limit = hgx_env.get("PowerLimitWatts") if isinstance(hgx_env.get("PowerLimitWatts"), dict) else {}
    node_health = "ok"
    for src in (
        _status_level(system),
        _status_level(hgx_sys),
        _status_level(chassis),
        _status_level(thermal),
        leaks.get("status"),
        fans.get("status"),
        _status_level(power_sub),
        _status_level(pdb),
        cbc_health,
    ):
        node_health = _worse(node_health, src)

    return {
        "bmc_ip": ip,
        "rack_id": target.get("rack_id"),
        "node_index": target.get("node_index"),
        "via": via,
        "error": errors[0] if len(errors) >= 12 else None,
        "status": node_health,
        "product": system.get("Model") or chassis.get("Model") or "GB NVL",
        "vendor": system.get("Manufacturer") or chassis.get("Manufacturer"),
        "serial": chassis.get("SerialNumber") or system.get("SerialNumber"),
        "system": {
            "id": system.get("Id") or "System_0",
            "model": system.get("Model"),
            "manufacturer": system.get("Manufacturer"),
            "serial": system.get("SerialNumber"),
            "power_state": system.get("PowerState") or chassis.get("PowerState"),
            "status": _status_level(system) if not system.get("_error") else "unknown",
        },
        "hgx": {
            "id": hgx_sys.get("Id") or "HGX_Baseboard_0",
            "model": hgx_sys.get("Model") or hgx_ch.get("Model"),
            "power_state": hgx_sys.get("PowerState") or hgx_ch.get("PowerState"),
            "status": _worse(_status_level(hgx_sys), _status_level(hgx_ch)),
            "inlet_c": inlet["celsius"] if inlet else None,
            "exhaust_c": exhaust["celsius"] if exhaust else None,
            "power_limit_w": _num(limit.get("SetPoint")) if limit else None,
        },
        "thermal": {
            "status": _status_level(thermal) if not thermal.get("_error") else "unknown",
            "hottest_c": hottest["celsius"] if hottest else None,
            "hottest": hottest["label"] if hottest else None,
            "inlet_c": inlet["celsius"] if inlet else None,
            "exhaust_c": exhaust["celsius"] if exhaust else None,
            "temps": all_temps[:48],
            "gpu_temps": gpu_temps,
        },
        "leak": leaks,
        "fans": fans,
        "power": {
            "status": _worse(_status_level(power_sub), _status_level(pdb)),
            "subsystem": _status_level(power_sub),
            "pdb": _status_level(pdb) if not pdb.get("_error") else "unknown",
            "pdb_model": pdb.get("Model") or pdb.get("Name"),
            "watts": round(watts, 1) if watts is not None else None,
            "psus": psu_rows,
            "psu_count": len(psu_rows),
        },
        "cbc": {"status": cbc_health, "ok": sum(1 for c in cbc_items if c["health"] == "ok"), "total": len(cbc_items), "items": cbc_items},
    }


def _poll_node(target: dict[str, str]) -> dict[str, Any]:
    """Direct Redfish for a BMC this machine can reach. Assigned racks use the PXE batch."""
    ip = target["bmc_ip"]
    user = target.get("user") or "root"
    password = target.get("password") or ""
    fetched: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(redfish_get, ip, path, user, password): key for key, path in _health_paths().items()}
        for fut in as_completed(futs):
            key = futs[fut]
            try:
                body = fut.result()
            except Exception as exc:
                body = {"_error": str(exc)[:180]}
            fetched[key] = body if isinstance(body, dict) else {"_error": "bad-body"}
    return _assemble(target, fetched, "direct")


def _card(status: str, value: str, label: str, detail: str | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"status": status, "value": value, "label": label}
    if detail:
        out["detail"] = detail
    out.update(extra)
    return out


def _inventory_total() -> int:
    now = time.time()
    if now - float(_CENSUS.get("t") or 0) < 8.0 and _CENSUS.get("total"):
        return int(_CENSUS["total"])
    total = 0
    try:
        from sqlalchemy import func, select

        from .db import SessionLocal
        from .models import MaxLpsNode

        with SessionLocal() as db:
            total = int(
                db.scalar(
                    select(func.count())
                    .select_from(MaxLpsNode)
                    .where(MaxLpsNode.bmc_ip.isnot(None), MaxLpsNode.bmc_ip != "")
                )
                or 0
            )
    except Exception:
        total = int(_CENSUS.get("total") or 0)
    _CENSUS["t"] = now
    _CENSUS["total"] = total
    return total


def _leak_bucket(n: dict[str, Any]) -> str:
    if n.get("error"):
        return "unknown"
    st = str((n.get("leak") or {}).get("status") or "")
    if st == "ok":
        return "dry"
    if st == "warning":
        return "warn"
    if st == "critical":
        return "leak"
    return "unknown"


def _summarize(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    live = [n for n in nodes if not n.get("error")]
    inv = max(_inventory_total(), len(live))
    leak_dry = leak_warn = leak_crit = 0
    leak_st: str | None = None
    leak_ok = leak_tot = 0
    hot_c: float | None = None
    hot_name = ""
    gpu_hi: dict[int, float] = {}
    inlet_c: float | None = None
    temp_ok = temp_warn = temp_crit = 0
    sys_st: str | None = None
    sys_on = sys_off = 0
    sys_model = ""
    pdb_st: str | None = None
    pdb_ok = 0
    watts_sum = 0.0
    watts_n = 0
    psu_n = 0
    fan_st: str | None = None
    fan_run = fan_tot = 0
    rpm_w = 0.0
    rpm_n = 0
    cbc_ok = cbc_tot = 0
    hgx_st: str | None = None

    for n in live:
        lk = n.get("leak") or {}
        bucket = _leak_bucket(n)
        if bucket == "dry":
            leak_dry += 1
        elif bucket == "warn":
            leak_warn += 1
        elif bucket == "leak":
            leak_crit += 1
        leak_st = _fold(leak_st, lk.get("status"))
        leak_ok += int(lk.get("ok") or 0)
        leak_tot += int(lk.get("total") or 0)
        th = n.get("thermal") or {}
        gpu_cs = [
            float(g["celsius"])
            for g in (th.get("gpu_temps") or [])
            if isinstance(g, dict) and isinstance(g.get("celsius"), (int, float))
        ]
        c = max(gpu_cs) if gpu_cs else th.get("hottest_c")
        if isinstance(c, (int, float)):
            cf = float(c)
            if hot_c is None or cf > hot_c:
                hot_c = cf
                hot_name = str(th.get("hottest") or "")
                if gpu_cs:
                    hot_name = "GPU"
            if cf >= 85:
                temp_crit += 1
            elif cf >= 75:
                temp_warn += 1
            else:
                temp_ok += 1
        if th.get("inlet_c") is not None:
            inlet_c = float(th["inlet_c"]) if inlet_c is None else max(inlet_c, float(th["inlet_c"]))
        for g in th.get("gpu_temps") or []:
            if not isinstance(g, dict):
                continue
            idx = g.get("index")
            gc = g.get("celsius")
            if not isinstance(idx, int) or idx < 0 or idx > 3 or not isinstance(gc, (int, float)):
                continue
            prev = gpu_hi.get(idx)
            if prev is None or float(gc) > prev:
                gpu_hi[idx] = float(gc)
        sy = n.get("system") or {}
        sys_st = _fold(sys_st, sy.get("status"))
        state = str(sy.get("power_state") or "").lower()
        if state == "on":
            sys_on += 1
        elif state == "off":
            sys_off += 1
        sys_model = sys_model or str(sy.get("model") or n.get("product") or "")
        pw = n.get("power") or {}
        pdb_st = _fold(pdb_st, pw.get("status"))
        if str(pw.get("status") or "") == "ok":
            pdb_ok += 1
        if pw.get("watts") is not None:
            watts_sum += float(pw["watts"])
            watts_n += 1
        psu_n += int(pw.get("psu_count") or 0)
        fn = n.get("fans") or {}
        fan_st = _fold(fan_st, fn.get("status"))
        n_tot = int(fn.get("count") or 0)
        n_run = int(fn["running"]) if fn.get("running") is not None else (n_tot if fn.get("status") == "ok" else 0)
        fan_tot += n_tot
        fan_run += n_run
        if fn.get("rpm_avg") is not None and n_tot:
            rpm_w += float(fn["rpm_avg"]) * n_tot
            rpm_n += n_tot
        elif fn.get("rpm_avg") is not None:
            rpm_w += float(fn["rpm_avg"])
            rpm_n += 1
        cb = n.get("cbc") or {}
        cbc_ok += int(cb.get("ok") or 0)
        cbc_tot += int(cb.get("total") or 0)
        hgx_st = _fold(hgx_st, (n.get("hgx") or {}).get("status"))

    unknown = max(0, inv - len(live))
    leak_unknown = unknown + max(0, len(live) - leak_dry - leak_warn - leak_crit)
    if leak_crit:
        leak_st = "critical"
    elif leak_warn:
        leak_st = "warning"
    elif leak_dry:
        leak_st = "ok"
    else:
        leak_st = "unknown"

    temp_st = "ok"
    if hot_c is not None:
        if hot_c >= 85:
            temp_st = "critical"
        elif hot_c >= 75:
            temp_st = "warning"
    elif not live:
        temp_st = "unknown"

    sys_unknown = max(0, inv - sys_on - sys_off)
    if sys_on and not sys_off and not live:
        sys_st = "ok"
    elif sys_on and sys_unknown == 0 and sys_off == 0:
        sys_st = "ok"
    elif sys_on:
        sys_st = _worse(sys_st if sys_st != "unknown" else "ok", "ok")
    elif sys_off and sys_unknown == 0:
        sys_st = "warning"
    else:
        sys_st = "unknown" if not live else sys_st

    rpm_avg = (rpm_w / rpm_n) if rpm_n else None
    fan_unknown = unknown
    if fan_tot and fan_run < fan_tot:
        fan_st = _worse(fan_st, "warning" if fan_run else "critical")
    elif fan_tot:
        fan_st = _worse(fan_st if fan_st != "unknown" else "ok", "ok")
    else:
        fan_st = "unknown"

    leak_bits = [f"Dry {leak_dry}", f"Warn {leak_warn}", f"Leak {leak_crit}"]
    sys_bits = []
    if sys_off:
        sys_bits.append(f"{sys_off} off")
    if sys_unknown:
        sys_bits.append(f"{sys_unknown} unknown")
    fan_label = _fmt_rpm(rpm_avg) if rpm_avg is not None else "no tach"
    if fan_unknown:
        fan_label = f"avg {fan_label}" if rpm_avg is not None else fan_label
        fan_label += f" · {fan_unknown} nodes unknown"
    elif rpm_avg is not None:
        fan_label = f"avg {fan_label}"

    return {
        "inventory_nodes": inv,
        "leak": _card(
            str(leak_st),
            " · ".join(leak_bits),
            f"Unknown {leak_unknown} · {inv} nodes",
            f"{leak_ok}/{leak_tot} detectors" if leak_tot else None,
            ok=leak_ok,
            total=inv,
            counts={"dry": leak_dry, "warn": leak_warn, "leak": leak_crit, "unknown": leak_unknown, "total": inv},
        ),
        "temperature": _card(
            temp_st,
            f"Hot {temp_crit}" if temp_crit else (f"Warn {temp_warn}" if temp_warn else f"OK {temp_ok}"),
            f"hottest {_fmt_c(hot_c)} · {len(live)}/{inv} nodes" if hot_c is not None else f"{len(live)}/{inv} nodes",
            f"GPU inlet {_fmt_c(inlet_c)}" if inlet_c is not None else None,
            celsius=hot_c,
            hottest=hot_name or None,
            gpus=[{"index": i, "celsius": gpu_hi.get(i), "label": f"GPU {i}"} for i in range(4)],
            counts={"ok": temp_ok, "warn": temp_warn, "critical": temp_crit, "unknown": unknown, "total": inv},
        ),
        "system": _card(
            str(sys_st),
            f"{sys_on}/{inv} On",
            " · ".join(sys_bits) if sys_bits else (sys_model or "GB NVL"),
            f"HGX {'OK' if hgx_st == 'ok' else (str(hgx_st).upper() if hgx_st and hgx_st != 'unknown' else '—')}",
            ok=sys_on,
            total=inv,
            counts={"on": sys_on, "off": sys_off, "unknown": sys_unknown, "total": inv},
        ),
        "power_shelf": _card(
            str(pdb_st if live else "unknown"),
            f"{pdb_ok}/{inv} OK",
            f"{cbc_ok}/{cbc_tot} CBC" if cbc_tot else f"{unknown} nodes unknown",
            "PDB · node power path",
            ok=pdb_ok,
            total=inv,
            counts={"ok": pdb_ok, "unknown": unknown, "total": inv},
        ),
        "psu": _card(
            str(pdb_st if watts_n else "unknown"),
            _fmt_w(watts_sum if watts_n else None),
            f"{watts_n}/{inv} nodes reporting",
            f"{psu_n} PSU" if psu_n else "Chassis HSC meter",
            watts=round(watts_sum, 1) if watts_n else None,
            ok=watts_n,
            total=inv,
        ),
        "fans": _card(
            str(fan_st),
            f"{fan_run}/{fan_tot} running" if fan_tot else "—",
            fan_label,
            f"{len(live)}/{inv} nodes",
            rpm_avg=round(rpm_avg) if rpm_avg is not None else None,
            ok=fan_run,
            total=fan_tot,
            counts={"running": fan_run, "total": fan_tot, "unknown": fan_unknown, "nodes": inv},
        ),
    }


def _health_checks(nodes: list[dict[str, Any]], summary: dict[str, Any]) -> list[dict[str, Any]]:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    checks: list[dict[str, Any]] = []
    mapping = [
        ("leak", "Leak detection"),
        ("temperature", "Temperature"),
        ("system", "System"),
        ("power_shelf", "Power shelf"),
        ("psu", "PSU"),
        ("fans", "Fans"),
    ]
    for key, name in mapping:
        card = summary.get(key) or {}
        st = card.get("status") or "unknown"
        ui = {"ok": "healthy", "warning": "warning", "critical": "critical"}.get(st, "offline")
        checks.append(
            {
                "entity": name,
                "name": key,
                "value": f"{card.get('value') or '—'} · {card.get('label') or ''}".strip(" ·"),
                "last_check": now,
                "status": ui,
            }
        )
    for n in nodes[:8]:
        ip = n.get("bmc_ip") or ""
        for d in (n.get("leak") or {}).get("detectors") or []:
            st = d.get("status") or "unknown"
            ui = {"ok": "healthy", "warning": "warning", "critical": "critical"}.get(st, "offline")
            checks.append(
                {
                    "entity": ip or "BMC",
                    "name": d.get("label") or d.get("name") or "leak",
                    "value": str(d.get("detector_state") or st),
                    "last_check": now,
                    "status": ui,
                }
            )
    return checks[:40]


def _public_node(n: dict[str, Any], *, brief: bool = False) -> dict[str, Any]:
    th = n.get("thermal") or {}
    fn = n.get("fans") or {}
    leak = n.get("leak") or {}
    if brief and isinstance(leak, dict):
        leak = {k: v for k, v in leak.items() if k != "detectors"}
    return {
        "bmc_ip": n.get("bmc_ip"),
        "rack_id": n.get("rack_id"),
        "node_index": n.get("node_index"),
        "status": n.get("status"),
        "product": n.get("product"),
        "vendor": n.get("vendor"),
        "serial": n.get("serial"),
        "via": n.get("via"),
        "error": n.get("error"),
        "system": n.get("system"),
        "hgx": n.get("hgx"),
        "thermal": {
            "status": th.get("status"),
            "hottest_c": th.get("hottest_c"),
            "hottest": th.get("hottest"),
            "inlet_c": th.get("inlet_c"),
            "exhaust_c": th.get("exhaust_c"),
            "temps": [] if brief else (th.get("temps") or [])[:48],
            "gpu_temps": (th.get("gpu_temps") or [])[:4],
        },
        "leak": leak,
        "fans": {
            "status": fn.get("status"),
            "pwm_pct": fn.get("pwm_pct"),
            "rpm_avg": fn.get("rpm_avg"),
            "rpm_min": fn.get("rpm_min"),
            "count": fn.get("count"),
            "running": fn.get("running"),
            "items": [] if brief else (fn.get("items") or [])[:24],
        },
        "power": n.get("power"),
        "cbc": n.get("cbc"),
    }


def nodes_reporting(snap: dict[str, Any] | None) -> int:
    """BMCs that answered with a health status. Unknown and missing nodes do not count."""
    n = 0
    for node in (snap or {}).get("nodes") or []:
        if str(node.get("status") or "") in {"ok", "warning", "critical"}:
            n += 1
    return n


def snapshot(*, brief: bool = False) -> dict[str, Any]:
    _ensure_watch()
    with _LOCK:
        snap = dict(_SNAP)
        nodes = list(_SNAP.get("nodes") or [])
        t = float(_SNAP.get("t") or 0.0)
        alive = bool(_WATCH is not None and _WATCH.is_alive())
    age = round(max(0.0, time.time() - t), 1) if t else None
    summary = snap.get("summary") or _summarize(nodes)
    return {
        "source": snap.get("source"),
        "via": snap.get("via"),
        "error": snap.get("error"),
        "poll_age_s": age,
        "watch": alive,
        "probe_ip": (getattr(settings, "bmc_probe_ip", None) or None),
        "node_count": len(nodes),
        "inventory_nodes": summary.get("inventory_nodes") if isinstance(summary, dict) else None,
        "nodes": [_public_node(n, brief=brief) for n in nodes],
        **summary,
        "checks": _health_checks(nodes, summary),
    }


def _lookup_target(ip: str) -> dict[str, str] | None:
    ip = (ip or "").strip()
    if not ip:
        return None
    probe = (getattr(settings, "bmc_probe_ip", None) or "").strip()
    probe_user = (getattr(settings, "bmc_probe_user", None) or "root").strip() or "root"
    probe_pw = getattr(settings, "bmc_probe_password", None) or ""
    found = None
    try:
        from .gpu_power import _gpu_live_targets

        for rid, idx, bip, user, pw in _gpu_live_targets():
            if (bip or "").strip() != ip:
                continue
            if ip == probe and probe_pw:
                user, password = probe_user, probe_pw
            else:
                password = pw
            if not password:
                continue
            found = {
                "rack_id": str(rid),
                "node_index": str(idx),
                "bmc_ip": ip,
                "user": user or "root",
                "password": password,
            }
            break
    except Exception:
        pass
    return found


def _poll_on_pxe(host: str, targets: list[dict[str, str]]) -> list[dict[str, Any]]:
    from . import pxe_hop

    if not targets or not pxe_hop.ensure_host(host):
        return []
    index = {t["bmc_ip"]: t for t in targets}

    def _sink(ip: str, bodies: dict[str, Any]) -> None:
        tgt = index.get(ip)
        if tgt:
            _merge_node(_assemble(tgt, bodies or {}, "hop"))

    pxe_hop.set_health_sink(_sink)
    try:
        by_ip = pxe_hop.fetch_bmc_health(
            [{"bmc_ip": t["bmc_ip"], "user": t.get("user") or "ADMIN", "password": t.get("password") or ""} for t in targets],
            _health_paths(),
            timeout=40.0,
            host=host,
        )
    finally:
        pxe_hop.set_health_sink(None)
    return [_assemble(t, by_ip.get(t["bmc_ip"]) or {}, "hop") for t in targets]


def poll_one(ip: str) -> dict[str, Any]:
    """On-demand Redfish for one compute BMC (node click), through that node's PXE."""
    target = _lookup_target(ip)
    if not target:
        return {"bmc_ip": (ip or "").strip(), "error": "no-credentials", "status": "unknown"}
    from .pxe_servers import pxe_for_address
    from . import pxe_hop

    pxe = pxe_for_address(ip)
    if pxe:
        if not pxe_hop.ensure_host(pxe):
            rec = _unknown(target, f"PXE {pxe} is not connected", "hop")
        else:
            rows = _poll_on_pxe(pxe, [target])
            rec = rows[0] if rows else _assemble(target, {}, "hop")
    else:
        rec = _poll_node(target)
    if not rec.get("error"):
        with _LOCK:
            prev = next((n for n in (_SNAP.get("nodes") or []) if n.get("bmc_ip") == rec.get("bmc_ip")), None)
            others = [n for n in (_SNAP.get("nodes") or []) if n.get("bmc_ip") != rec.get("bmc_ip")]
            chosen = _apply_rec(rec, prev)
            nodes = others + [chosen]
            live = [n for n in nodes if not n.get("error")]
            summary = _summarize(live)
            _SNAP["nodes"] = live or nodes[:1]
            _SNAP["summary"] = summary
            _SNAP["source"] = "redfish"
            _SNAP["via"] = chosen.get("via") or _SNAP.get("via")
            _SNAP["error"] = None
            _SNAP["t"] = time.time()
        _note_telemetry(summary)
        rec = chosen
    return _public_node(rec)


def _rich_thermal(th: Any) -> bool:
    if not isinstance(th, dict):
        return False
    return bool(th.get("temps") or th.get("gpu_temps") or th.get("hottest_c") is not None)


def _rich_power(pw: Any) -> bool:
    if not isinstance(pw, dict):
        return False
    return pw.get("watts") is not None or bool(pw.get("psus"))


def _rich_fans(fn: Any) -> bool:
    if not isinstance(fn, dict):
        return False
    return bool(fn.get("items")) or fn.get("rpm_avg") is not None or fn.get("pwm_pct") is not None


def _rich_leak(lk: Any) -> bool:
    if not isinstance(lk, dict):
        return False
    if lk.get("detectors"):
        return True
    return str(lk.get("status") or "") in {"ok", "warning", "critical"}


_ATTR_SECTIONS = (
    ("thermal", _rich_thermal),
    ("power", _rich_power),
    ("fans", _rich_fans),
    ("leak", _rich_leak),
)


def _keep_attrs(rec: dict[str, Any], prev: dict[str, Any] | None, now: float | None = None) -> dict[str, Any]:
    """Hold the last thermal, PSU, fan, and leak attributes when this read is empty."""
    if rec.get("error"):
        return rec
    now = time.time() if now is None else now
    out = dict(rec)
    held = dict(out.get("held") or {})
    prev_held = (prev or {}).get("held") or {}
    for key, rich in _ATTR_SECTIONS:
        if rich(out.get(key)):
            held[key] = now
            continue
        prev_t = float(prev_held.get(key) or 0)
        if prev and rich(prev.get(key)) and prev_t and now - prev_t <= _ATTR_HOLD_S:
            out[key] = prev[key]
            held[key] = prev_t
    if held:
        out["held"] = held
    return out


def _apply_rec(rec: dict[str, Any], prev: dict[str, Any] | None) -> dict[str, Any]:
    if rec.get("error") and prev and not prev.get("error"):
        return prev
    return _keep_attrs(rec, prev)


def _publish(nodes: list[dict[str, Any]], via: str, errors: list[str]) -> None:
    global _SNAP
    live = [n for n in nodes if not n.get("error")]
    keep = live or nodes[:1]
    summary = _summarize(live)
    with _LOCK:
        _SNAP = {
            "source": "redfish" if live else None,
            "via": via if live else None,
            "error": None if live else (errors[0] if errors else "no-bmc-targets"),
            "t": time.time(),
            "nodes": keep,
            "summary": summary,
        }
    _note_telemetry(summary)


def _merge_node(rec: dict[str, Any]) -> None:
    """Publish one BMC as soon as it answers. A miss keeps the last good row."""
    if not rec.get("bmc_ip"):
        return
    with _LOCK:
        prev = next((n for n in (_SNAP.get("nodes") or []) if n.get("bmc_ip") == rec.get("bmc_ip")), None)
        others = [n for n in (_SNAP.get("nodes") or []) if n.get("bmc_ip") != rec.get("bmc_ip")]
        chosen = _apply_rec(rec, prev)
        nodes = others + [chosen]
        live = [n for n in nodes if not n.get("error")]
        summary = _summarize(live)
        _SNAP["nodes"] = live or nodes[:1]
        _SNAP["summary"] = summary
        _SNAP["t"] = time.time()
        if live:
            _SNAP["source"] = "redfish"
            _SNAP["via"] = rec.get("via") or _SNAP.get("via")
            _SNAP["error"] = None
    _note_telemetry(summary)


def _store(nodes: list[dict[str, Any]], via: str, errors: list[str], *, final: bool = False) -> None:
    """Upsert this pass into the snapshot. The final pass drops nodes that were not polled."""
    with _LOCK:
        prev_by = {n.get("bmc_ip"): n for n in (_SNAP.get("nodes") or []) if n.get("bmc_ip")}
    merged: dict[str, dict[str, Any]] = {} if final else dict(prev_by)
    for rec in nodes:
        ip = rec.get("bmc_ip")
        if not ip:
            continue
        merged[ip] = _apply_rec(rec, prev_by.get(ip))
    _publish(list(merged.values()), via, errors)


def _hist_ts(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _ensure_hist() -> None:
    global _HIST_LOADED
    if _HIST_LOADED:
        return
    with _HIST_LOCK:
        if _HIST_LOADED:
            return
        loaded: list[tuple[float, float | None, float | None]] = []
        loaded_nodes: list[tuple[float, list]] = []
        try:
            from sqlalchemy import select

            from .db import SessionLocal
            from .models import ClusterHealthSample

            cutoff = datetime.now(timezone.utc) - timedelta(seconds=_HIST_KEEP_S)
            with SessionLocal() as db:
                rows = db.execute(
                    select(
                        ClusterHealthSample.ts,
                        ClusterHealthSample.temp_c,
                        ClusterHealthSample.psu_w,
                        ClusterHealthSample.nodes,
                    )
                    .where(ClusterHealthSample.ts >= cutoff)
                    .order_by(ClusterHealthSample.ts.asc())
                ).all()
            for ts, temp, psu, nodes in rows:
                stamp = _hist_ts(ts)
                loaded.append((stamp, temp, psu))
                if isinstance(nodes, list) and nodes:
                    loaded_nodes.append((stamp, nodes))
        except Exception:
            loaded = []
            loaded_nodes = []
        if _HIST:
            _HIST[:0] = loaded
        else:
            _HIST.extend(loaded)
        if _NODE_HIST:
            _NODE_HIST[:0] = loaded_nodes
        else:
            _NODE_HIST.extend(loaded_nodes)
        _HIST_LOADED = True


def _node_readings() -> list[list]:
    """Per-node hottest °C and chassis watts. Nodes with neither are left out."""
    with _LOCK:
        nodes = list(_SNAP.get("nodes") or [])
    out: list[list] = []
    for node in nodes:
        if node.get("error"):
            continue
        ip = str(node.get("bmc_ip") or "")
        if not ip:
            continue
        thermal = node.get("thermal") or {}
        power = node.get("power") or {}
        temp = thermal.get("hottest_c")
        watts = power.get("watts")
        temp_v = float(temp) if isinstance(temp, (int, float)) else None
        psu_v = float(watts) if isinstance(watts, (int, float)) else None
        if temp_v is None and psu_v is None:
            continue
        index = node.get("node_index")
        rack = node.get("rack_id")
        out.append(
            [
                ip,
                int(index) if isinstance(index, int) else None,
                str(rack) if rack else None,
                temp_v,
                psu_v,
            ]
        )
    return out


def _note_telemetry(summary: dict[str, Any] | None) -> None:
    """Remember a temperature and PSU sample. Empty attributes are not written as zeros."""
    global _last_sample, _last_prune, _last_node_sample
    card_t = (summary or {}).get("temperature") or {}
    card_p = (summary or {}).get("psu") or {}
    temp = card_t.get("celsius")
    psu = card_p.get("watts")
    temp_v = float(temp) if isinstance(temp, (int, float)) else None
    psu_v = float(psu) if isinstance(psu, (int, float)) else None
    if temp_v is None and psu_v is None:
        return
    now = time.time()
    if now - _last_sample < _SAMPLE_S:
        return
    # Read nodes before the history lock. The health lock and the history lock
    # must not be taken in opposite orders.
    node_rows = _node_readings() if now - _last_node_sample >= _NODE_SAMPLE_S else None
    with _HIST_LOCK:
        if now - _last_sample < _SAMPLE_S:
            return
        _last_sample = now
        _HIST.append((now, temp_v, psu_v))
        if node_rows is not None:
            _last_node_sample = now
            if node_rows:
                _NODE_HIST.append((now, node_rows))
        cutoff = now - _HIST_KEEP_S
        if _HIST and _HIST[0][0] < cutoff:
            _HIST[:] = [row for row in _HIST if row[0] >= cutoff]
        if _NODE_HIST and _NODE_HIST[0][0] < cutoff:
            _NODE_HIST[:] = [row for row in _NODE_HIST if row[0] >= cutoff]
    _write_sample(now, temp_v, psu_v, node_rows)


def _write_sample(now: float, temp: float | None, psu: float | None, nodes: list | None = None) -> None:
    global _last_prune
    try:
        from sqlalchemy import delete

        from .db import SessionLocal
        from .models import ClusterHealthSample

        with SessionLocal() as db:
            db.add(
                ClusterHealthSample(
                    ts=datetime.fromtimestamp(now, timezone.utc),
                    temp_c=temp,
                    psu_w=psu,
                    nodes=nodes or None,
                )
            )
            if now - _last_prune > 60:
                cutoff = datetime.fromtimestamp(now - _HIST_KEEP_S, timezone.utc)
                db.execute(delete(ClusterHealthSample).where(ClusterHealthSample.ts < cutoff))
                _last_prune = now
            db.commit()
    except Exception:
        return


def bucket_telemetry(
    rows: list[tuple[float, float | None, float | None]],
    start: float,
    end: float,
    points: int,
) -> list[dict[str, Any]]:
    """Hottest temperature and average PSU watts in each bucket. Empty buckets stay out."""
    points = max(1, int(points))
    span = max(float(end) - float(start), 1.0)
    width = span / points
    bins: list[dict[str, float | None]] = [
        {"temp": None, "temp_n": 0, "psu": 0.0, "psu_n": 0, "n": 0} for _ in range(points)
    ]
    for t, temp, psu in rows:
        if t < start or t > end:
            continue
        i = min(points - 1, int((t - start) / width))
        b = bins[i]
        b["n"] = float(b["n"] or 0) + 1
        if temp is not None:
            prev = b["temp"]
            b["temp"] = float(temp) if prev is None else max(float(prev), float(temp))
            b["temp_n"] = float(b["temp_n"] or 0) + 1
        if psu is not None:
            b["psu"] = float(b["psu"] or 0) + float(psu)
            b["psu_n"] = float(b["psu_n"] or 0) + 1
    out: list[dict[str, Any]] = []
    for i, b in enumerate(bins):
        if not b["n"]:
            continue
        out.append(
            {
                "t": start + (i + 0.5) * width,
                "temp_c": round(float(b["temp"]), 2) if b["temp"] is not None else None,
                "psu_w": round(float(b["psu"] or 0) / float(b["psu_n"]), 1) if b["psu_n"] else None,
            }
        )
    return out


def telemetry_window(span: str, now: float | None = None) -> tuple[float, float, str, int]:
    key = span if span in TELEM_SPANS else "1d"
    end = time.time() if now is None else float(now)
    return end - TELEM_SPANS[key], end, key, TELEM_POINTS[key]


def _live_reading() -> tuple[float | None, float | None, float]:
    with _LOCK:
        summary = _SNAP.get("summary") or {}
        t = float(_SNAP.get("t") or 0)
    card_t = summary.get("temperature") or {}
    card_p = summary.get("psu") or {}
    temp = card_t.get("celsius")
    psu = card_p.get("watts")
    return (
        float(temp) if isinstance(temp, (int, float)) else None,
        float(psu) if isinstance(psu, (int, float)) else None,
        t,
    )


def telemetry_series(start: float, end: float, points: int = 180) -> list[dict[str, Any]]:
    _ensure_hist()
    with _HIST_LOCK:
        rows = [row for row in _HIST if start <= row[0] <= end]
    temp, psu, snap_t = _live_reading()
    if snap_t >= start and snap_t <= end + 2 and (temp is not None or psu is not None):
        if not rows or snap_t > rows[-1][0] + 0.2:
            rows.append((snap_t, temp, psu))
    return bucket_telemetry(rows, start, end, points)


def _node_fields(item: Any) -> tuple[str, int | None, str | None, float | None, float | None] | None:
    if not isinstance(item, (list, tuple)) or len(item) < 5:
        return None
    ip = str(item[0] or "")
    if not ip:
        return None
    index = item[1] if isinstance(item[1], int) else None
    rack = str(item[2]) if item[2] else None
    temp = float(item[3]) if isinstance(item[3], (int, float)) else None
    watts = float(item[4]) if isinstance(item[4], (int, float)) else None
    return ip, index, rack, temp, watts


def bucket_node_telemetry(
    rows: list[tuple[float, list]],
    start: float,
    end: float,
    points: int,
) -> list[dict[str, Any]]:
    """Per-node hottest temperature and average PSU watts. Empty buckets stay out."""
    points = max(1, int(points))
    span = max(float(end) - float(start), 1.0)
    width = span / points
    bins: dict[str, list[dict[str, float | None]]] = {}
    meta: dict[str, tuple[int | None, str | None]] = {}
    for stamp, nodes in rows:
        if stamp < start or stamp > end or not isinstance(nodes, list):
            continue
        index = min(points - 1, int((stamp - start) / width))
        for item in nodes:
            parsed = _node_fields(item)
            if not parsed:
                continue
            ip, node_index, rack, temp, watts = parsed
            meta[ip] = (node_index, rack)
            series = bins.get(ip)
            if series is None:
                series = [{"temp": None, "temp_n": 0, "psu": 0.0, "psu_n": 0, "n": 0} for _ in range(points)]
                bins[ip] = series
            bucket = series[index]
            bucket["n"] = float(bucket["n"] or 0) + 1
            if temp is not None:
                prev = bucket["temp"]
                bucket["temp"] = float(temp) if prev is None else max(float(prev), float(temp))
                bucket["temp_n"] = float(bucket["temp_n"] or 0) + 1
            if watts is not None:
                bucket["psu"] = float(bucket["psu"] or 0) + float(watts)
                bucket["psu_n"] = float(bucket["psu_n"] or 0) + 1
    out: list[dict[str, Any]] = []
    for ip, series in bins.items():
        node_index, rack = meta.get(ip, (None, None))
        plotted: list[dict[str, Any]] = []
        for i, bucket in enumerate(series):
            if not bucket["n"]:
                continue
            plotted.append(
                {
                    "t": start + (i + 0.5) * width,
                    "temp_c": round(float(bucket["temp"]), 2) if bucket["temp"] is not None else None,
                    "psu_w": round(float(bucket["psu"] or 0) / float(bucket["psu_n"]), 1) if bucket["psu_n"] else None,
                }
            )
        if not plotted:
            continue
        out.append(
            {
                "bmc_ip": ip,
                "node_index": node_index,
                "rack_id": rack,
                "points": plotted,
            }
        )
    out.sort(key=lambda row: (str(row.get("rack_id") or ""), int(row.get("node_index") or 0), str(row.get("bmc_ip"))))
    return out


def node_telemetry(start: float, end: float, points: int = 180) -> list[dict[str, Any]]:
    """Per-node temperature and PSU history for the overview detail graphs."""
    _ensure_hist()
    with _HIST_LOCK:
        rows = [row for row in _NODE_HIST if start <= row[0] <= end]
    live = _node_readings()
    _temp, _psu, snap_t = _live_reading()
    if live and snap_t >= start and snap_t <= end + 2:
        if not rows or snap_t > rows[-1][0] + 0.2:
            rows.append((snap_t, live))
    return bucket_node_telemetry(rows, start, end, points)


def _unknown(target: dict[str, str], error: str, via: str) -> dict[str, Any]:
    return {
        "bmc_ip": target.get("bmc_ip"),
        "rack_id": target.get("rack_id"),
        "node_index": target.get("node_index"),
        "via": via,
        "error": error,
        "status": "unknown",
    }


def _poll_once() -> None:
    from . import pxe_hop
    from .gpu_power import _rack_pxe_map, group_by_pxe

    pxe_hop.ensure_saved()
    targets = _targets()
    probe = (getattr(settings, "bmc_probe_ip", None) or "").strip()
    if not targets:
        _store([], "direct", ["no-bmc-targets"], final=True)
        return
    grouped, bare = group_by_pxe(targets, _rack_pxe_map(), lambda row: row.get("rack_id"))
    print(
        f"bmc_health poll targets={len(targets)} pxe={len(grouped)} bare={len(bare)} probe={probe or '-'}",
        flush=True,
    )
    nodes: list[dict[str, Any]] = []
    errors: list[str] = []
    via = "direct"
    for host, group in grouped.items():
        try:
            rows = _poll_on_pxe(host, group)
            if not rows:
                raise RuntimeError(f"{host} is not connected")
            nodes.extend(rows)
            via = "hop"
            errors.extend(str(r.get("error")) for r in rows if r.get("error"))
        except Exception as exc:
            errors.append(f"{host}: {exc}"[:180])
            nodes.extend(_unknown(t, "pxe-down", "hop") for t in group)
        _store(nodes, via, errors)
    hosts = list(pxe_hop.status().get("hosts") or [])
    pending = list(bare)
    for host in hosts:
        if not pending:
            break
        try:
            rows = _poll_on_pxe(host, pending)
        except Exception as exc:
            errors.append(f"{host}: {exc}"[:180])
            continue
        answered = {r.get("bmc_ip") for r in rows if not r.get("error")}
        if not answered:
            continue
        nodes.extend(r for r in rows if r.get("bmc_ip") in answered)
        via = "hop"
        pending = [t for t in pending if t.get("bmc_ip") not in answered]
    for tgt in pending:
        if probe and tgt.get("bmc_ip") == probe:
            try:
                nodes.append(_poll_node(tgt))
            except Exception as exc:
                errors.append(f"{tgt.get('bmc_ip')}: {exc}"[:180])
        else:
            nodes.append(_unknown(tgt, "no-pxe", "direct"))
    _store(nodes, via, errors, final=True)


def _watch_forever() -> None:
    while True:
        started = time.time()
        try:
            _poll_once()
        except Exception as exc:
            with _LOCK:
                _SNAP["error"] = str(exc)[:180]
                _SNAP["t"] = time.time()
        remain = _POLL_FLOOR_S - (time.time() - started)
        if remain > 0:
            time.sleep(remain)


def _ensure_watch() -> None:
    global _WATCH
    with _WATCH_LOCK:
        t = _WATCH
        if t is not None and t.is_alive():
            return
        t = threading.Thread(target=_watch_forever, daemon=True, name="bmc-health-watch")
        _WATCH = t
        t.start()
