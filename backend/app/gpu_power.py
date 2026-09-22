"""GB300 GPU / node / power-shelf telemetry for the MaxLPS tab.

Topology is fixed for this campus: 18 compute nodes per rack, 4 GB300 GPUs
per node (NVL72). Per-GPU watts come from BMC Redfish EnvironmentMetrics
(PowerWatts.Reading) through the PXE hop when a jump session is up.
"""

from __future__ import annotations

import math
import re
import threading
import time
from collections import deque
from typing import Any

from . import power_limit

GPU_MODEL = "GB300"
NODES_PER_RACK = 18
GPUS_PER_NODE = 4
GPUS_PER_RACK = NODES_PER_RACK * GPUS_PER_NODE  # 72
SHELVES_PER_RACK = 8  # NVL72 power shelves feeding the 50 V busbar
GPU_TDP_W = 1400.0
GPU_IDLE_W = 180.0
NODE_OH_W = 260.0  # CPU, NIC, BMC, fans per node
SHELF_OH_W = 350.0  # PSU / busbar loss


def _h01(key: str) -> float:
    h = 2166136261
    for ch in key:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h / 0xFFFFFFFF


GPU_POWER_PERCENT = 0.75
DESIRED_CAP_PERCENT = 0.80  # usage should sit at this fraction of the posted cap
DEFAULT_INTERVAL_S = 10.0
DEFAULT_GPU_MIN_W = 200.0
DEFAULT_GPU_MAX_W = 1200.0
_HISTORY: list[dict[str, float]] = []
_HISTORY_N = 120
HIST_N = 128
HIST_DT = 0.25
BACKFILL_N = 100


class LoopState:
    def __init__(self) -> None:
        self.interval_s = DEFAULT_INTERVAL_S
        self.gpu_power_percent = GPU_POWER_PERCENT
        self.desired_cap_percent = DESIRED_CAP_PERCENT
        self.gpu_min_w = DEFAULT_GPU_MIN_W
        self.gpu_max_w = DEFAULT_GPU_MAX_W
        self.last_step = 0.0
        self.last_used_kw = 0.0
        self.last_caps: list[float] | None = None
        self.last_cap_by_id: dict[str, float] = {}
        self.last_best_p = DESIRED_CAP_PERCENT
        self.step_n = 0
        self.force = True
        self.bounds: dict[str, dict[str, float]] = {}
        self.prev_usage: dict[str, float] = {}
        self.prev_usage_t: dict[str, float] = {}
        self.gpu_hist: dict[str, deque[dict[str, float]]] = {}
        self.gpu_meta: dict[str, tuple[float, float]] = {}
        self.usage_win: dict[str, deque[float]] = {}
        self.sample_t: dict[str, float] = {}
        self.cached_out: dict[str, Any] | None = None
        self.cached_key: tuple[Any, ...] | None = None
        self.cache_t = 0.0
        self.hist_t = 0.0
        self.last_posted: dict[str, float] = {}


LOOP = LoopState()


def apply_loop(
    *,
    interval_s: float | None = None,
    gpu_power_percent: float | None = None,
    desired_cap_percent: float | None = None,
    gpu_min_w: float | None = None,
    gpu_max_w: float | None = None,
) -> bool:
    """Tune the GPU cap loop. Percents may be 0–1 or 10–100."""
    changed = False
    reset_caps = False
    if interval_s is not None:
        v = max(1.0, min(300.0, float(interval_s)))
        if abs(v - LOOP.interval_s) >= 0.049:
            changed = True
        LOOP.interval_s = v
    if gpu_power_percent is not None:
        raw = float(gpu_power_percent)
        v = raw / 100.0 if raw > 1.0 else raw
        v = max(0.10, min(1.0, v))
        if abs(v - LOOP.gpu_power_percent) >= 0.0005:
            changed = True
        LOOP.gpu_power_percent = v
    if desired_cap_percent is not None:
        raw = float(desired_cap_percent)
        v = raw / 100.0 if raw > 1.0 else raw
        v = max(0.10, min(1.0, v))
        if abs(v - LOOP.desired_cap_percent) >= 0.0005:
            changed = True
            reset_caps = True
        LOOP.desired_cap_percent = v
    if gpu_min_w is not None:
        v = max(50.0, min(GPU_TDP_W, float(gpu_min_w)))
        if abs(v - LOOP.gpu_min_w) >= 0.5:
            changed = True
            reset_caps = True
        LOOP.gpu_min_w = v
    if gpu_max_w is not None:
        v = max(50.0, min(GPU_TDP_W, float(gpu_max_w)))
        if abs(v - LOOP.gpu_max_w) >= 0.5:
            changed = True
            reset_caps = True
        LOOP.gpu_max_w = v
    if LOOP.gpu_min_w > LOOP.gpu_max_w:
        LOOP.gpu_min_w, LOOP.gpu_max_w = LOOP.gpu_max_w, LOOP.gpu_min_w
        changed = True
        reset_caps = True
    if changed:
        LOOP.cached_out = None
    if reset_caps:
        LOOP.force = True
        LOOP.last_caps = None
        LOOP.last_cap_by_id.clear()
        LOOP.last_posted.clear()
        LOOP.prev_usage.clear()
        LOOP.prev_usage_t.clear()
        LOOP.usage_win.clear()
        LOOP.sample_t.clear()
    return changed


def set_bounds(gpu_id: str, min_w: float | None = None, max_w: float | None = None) -> dict[str, float]:
    """Per-GPU floor / ceiling. Empty dict means the loop owns both ends."""
    cur = dict(LOOP.bounds.get(gpu_id) or {})
    if min_w is not None:
        cur["min_w"] = max(50.0, min(GPU_TDP_W, float(min_w)))
    if max_w is not None:
        cur["max_w"] = max(50.0, min(GPU_TDP_W, float(max_w)))
    lo, hi = cur.get("min_w"), cur.get("max_w")
    if lo is not None and hi is not None and lo > hi:
        cur["min_w"], cur["max_w"] = hi, lo
    LOOP.bounds[gpu_id] = cur
    LOOP.force = True
    LOOP.last_caps = None
    LOOP.cached_out = None
    return cur


def _bounds_of(gid: str) -> tuple[float, float]:
    b = LOOP.bounds.get(gid) or {}
    lo = float(b["min_w"]) if "min_w" in b else LOOP.gpu_min_w
    hi = float(b["max_w"]) if "max_w" in b else LOOP.gpu_max_w
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi


_JOBS = (
    ("python", "pretrain_gb300.py", "training"),
    ("python", "sft_llama70b.py", "training"),
    ("python", "mlperf_llama2_70b", "mlperf"),
    ("tritonserver", "vllm-openai", "inference"),
    ("python", "qwen3_52b_serve", "inference"),
    ("nccl-tests", "all_reduce_perf", "nccl"),
    ("python", "inference_test", "inference"),
    ("python", "gpt_oss_infer", "inference"),
)


def _process(gid: str, act: float, hot: bool, run_status: str, running: list[dict[str, Any]]) -> dict[str, Any]:
    if act < 0.12:
        return {"process": "idle", "workload": "—", "workload_kind": "idle", "pid": 0, "workload_id": None}
    h = _h01(gid + ":job")
    if running and (hot or run_status == "running"):
        w = running[int(h * len(running)) % len(running)]
        kind = w.get("kind") or "training"
        proc = "tritonserver" if kind in ("inference", "workspace") else "python"
        return {
            "process": proc,
            "workload": w.get("name") or "job",
            "workload_kind": kind,
            "pid": 20000 + int(h * 40000),
            "workload_id": w.get("id"),
        }
    proc, name, kind = _JOBS[int(h * len(_JOBS)) % len(_JOBS)]
    return {"process": proc, "workload": name, "workload_kind": kind, "pid": 20000 + int(h * 40000), "workload_id": None}


def _smoothstep(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


def _gpu_meta(gpu_id: str) -> tuple[float, float]:
    meta = LOOP.gpu_meta.get(gpu_id)
    if meta is None:
        meta = (_h01(gpu_id + ":wl") * 160.0, _h01(gpu_id + ":busy"))
        LOOP.gpu_meta[gpu_id] = meta
    return meta


def _workload_load(gpu_id: str, now: float) -> float:
    """0–1 envelope: idle → ramp up → hold → ramp down → idle."""
    phase, _ = _gpu_meta(gpu_id)
    t = (now + phase) % 160.0
    idle0, up, hold, down = 28.0, 22.0, 72.0, 26.0
    if t < idle0:
        return 0.0
    t -= idle0
    if t < up:
        return _smoothstep(t / up)
    t -= up
    if t < hold:
        return 1.0
    t -= hold
    if t < down:
        return _smoothstep(1.0 - t / down)
    return 0.0


def _activity(gpu_id: str, now: float, hot: bool, run_status: str) -> float:
    """0–1 GPU load with workload ramp-up / ramp-down."""
    phase, busy = _gpu_meta(gpu_id)
    t = (now + phase) % 160.0
    idle0, up, hold, down = 28.0, 22.0, 72.0, 26.0
    if t < idle0:
        load = 0.0
    else:
        t -= idle0
        if t < up:
            load = _smoothstep(t / up)
        elif t < up + hold:
            load = 1.0
        elif t < up + hold + down:
            load = _smoothstep(1.0 - (t - up - hold) / down)
        else:
            load = 0.0
    if hot:
        lo_a, hi_a = (0.06, 0.92) if busy > 0.32 else (0.04, 0.18)
    elif run_status == "running":
        lo_a, hi_a = (0.05, 0.62) if busy > 0.40 else (0.04, 0.16)
    else:
        lo_a, hi_a = 0.02, 0.12
    wobble = 0.025 * math.sin(now / 13.0 + busy * math.tau) * load
    return max(0.0, min(1.0, lo_a + (hi_a - lo_a) * load + wobble))


def _spark_curve(gid: str, now: float, hot: bool, run: str, n: int = 12) -> list[float]:
    step = 1.0
    cap = LOOP.last_cap_by_id.get(gid)
    pts: list[float] = []
    for i in range(n):
        w = _usage_w(_activity(gid, now - (n - 1 - i) * step, hot, run))
        if cap is not None:
            w = min(w, cap)
        pts.append(round(w, 1))
    return pts


def _smooth_usage(gid: str, target: float, now: float | None = None) -> float:
    """Ramp measured watts toward target at a visible ~1 s rate. Cannot overshoot."""
    now = time.time() if now is None else now
    prev = LOOP.prev_usage.get(gid)
    t0 = LOOP.prev_usage_t.get(gid)
    LOOP.prev_usage_t[gid] = now
    if prev is None or t0 is None:
        LOOP.prev_usage[gid] = target
        return target
    dt = max(0.0, min(2.5, now - t0))
    if dt < 0.02:
        return prev
    span = max(80.0, LOOP.gpu_max_w - LOOP.gpu_min_w)
    rate = span * 0.18
    delta = target - prev
    step = math.copysign(min(abs(delta), rate * dt), delta)
    nxt = prev + step
    LOOP.prev_usage[gid] = nxt
    return nxt


def _hist_point(now: float, watts: float, cap: float, lo: float, hi: float) -> dict[str, float]:
    return {
        "t": round(now, 3),
        "w": round(watts, 1),
        "cap": round(cap, 1),
        "min": round(lo, 1),
        "max": round(hi, 1),
    }


def _record_hist(gid: str, now: float, watts: float, cap: float, lo: float, hi: float, *, min_dt: float = HIST_DT) -> None:
    q = LOOP.gpu_hist.get(gid)
    if q is None:
        if len(LOOP.gpu_hist) >= 160:
            drop = next((k for k in LOOP.gpu_hist if k not in LOOP.bounds), None)
            if drop:
                LOOP.gpu_hist.pop(drop, None)
        q = deque(maxlen=HIST_N)
        LOOP.gpu_hist[gid] = q
    elif q.maxlen != HIST_N:
        q = deque(q, maxlen=HIST_N)
        LOOP.gpu_hist[gid] = q
    if q and now - q[-1]["t"] < min_dt:
        q[-1] = _hist_point(now, watts, cap, lo, hi)
        return
    q.append(_hist_point(now, watts, cap, lo, hi))


def _backfill_hist(gid: str, now: float, watts: float, cap: float, lo: float, hi: float, *, hot: bool, run: str, off: bool) -> None:
    """Seed a time series so the inspector is not empty on first click."""
    n = BACKFILL_N
    step = HIST_DT
    q: deque[dict[str, float]] = deque(maxlen=HIST_N)
    hi_w = hi if hi is not None else GPU_TDP_W
    for i in range(n):
        t = now - (n - 1 - i) * step
        if off:
            w = 0.0
        else:
            w = min(hi_w, _usage_w(_activity(gid, t, hot, run)))
        c = min(hi_w, max(lo, w / max(LOOP.desired_cap_percent, 0.1)))
        q.append(_hist_point(t, w, c, lo, hi_w))
    q.append(_hist_point(now, watts, cap, lo, hi_w))
    LOOP.gpu_hist[gid] = q


def _ensure_hist(
    gid: str,
    now: float,
    watts: float,
    cap: float,
    lo: float,
    hi: float,
    *,
    hot: bool,
    run: str,
    off: bool,
) -> list[dict[str, float]]:
    _record_hist(gid, now, watts, cap, lo, hi)
    return list(LOOP.gpu_hist.get(gid) or [])


def watch_curve(gpu_id: str) -> dict[str, Any]:
    """Live inspector trace: append a sample and return the retained window."""
    now = time.time()
    lo, hi = _bounds_of(gpu_id)
    cached: dict[str, Any] | None = None
    if LOOP.cached_out:
        for g in LOOP.cached_out.get("gpus") or []:
            if g.get("id") == gpu_id:
                cached = g
                break
    live_map, _src = _live_gpu_readings()
    live = live_map.get(gpu_id)
    if live and live.get("watts") is not None:
        watts = float(live["watts"])
        if live.get("setpoint_w") is not None:
            sp = float(live["setpoint_w"])
        elif cached and cached.get("setpoint_w") is not None:
            sp = float(cached["setpoint_w"])
        else:
            sp = LOOP.last_cap_by_id.get(gpu_id) or 0.0
        if live.get("min_w") is not None:
            lo = float(live["min_w"])
        if live.get("max_w") is not None:
            hi = float(live["max_w"])
        curve = _ensure_hist(gpu_id, now, watts, sp, lo, hi, hot=False, run="ready", off=False)
        return {
            "id": gpu_id,
            "watts": round(watts, 1),
            "setpoint_w": round(sp, 1),
            "min_w": round(lo, 1),
            "max_w": round(hi, 1),
            "process": "—",
            "workload": "—",
            "workload_kind": "idle",
            "pid": 0,
            "curve": curve,
        }
    watts = float(cached.get("watts") or 0.0) if cached and cached.get("source") == "redfish" else 0.0
    sp = float(cached.get("setpoint_w") or 0.0) if cached and cached.get("source") == "redfish" else 0.0
    return {
        "id": gpu_id,
        "watts": round(watts, 1),
        "setpoint_w": round(sp, 1),
        "min_w": round(lo, 1),
        "max_w": round(hi, 1),
        "process": "—",
        "workload": "—",
        "workload_kind": "idle",
        "pid": 0,
        "curve": list(LOOP.gpu_hist.get(gpu_id) or []),
    }


def _usage_w(activity: float) -> float:
    a = max(0.0, min(1.0, activity))
    lo, hi = LOOP.gpu_min_w, LOOP.gpu_max_w
    return lo + (hi - lo) * a


def _cap_ceiling(lo: float, hi: float) -> float:
    """Posted cap never reaches the GPU max the operator set."""
    if hi <= lo + 1:
        return lo
    return min(hi - 12.0, lo + (hi - lo) * 0.96)


def _note_usage(gid: str, watts: float, now: float) -> None:
    last = LOOP.sample_t.get(gid, 0.0)
    if now - last < 0.7:
        return
    LOOP.sample_t[gid] = now
    q = LOOP.usage_win.get(gid)
    if q is None:
        q = deque(maxlen=400)
        LOOP.usage_win[gid] = q
    q.append(watts)


def _window_avg(gid: str, fallback: float) -> float:
    q = LOOP.usage_win.get(gid)
    if not q:
        return fallback
    return sum(q) / len(q)


def _post_caps(
    usages: list[float],
    max_allowable_w: float,
    desired_p: float,
    bounds: list[tuple[float, float]],
) -> tuple[list[float], float]:
    """cap_i = avg_usage_i / bestCapPercent, fitted to the GPU share of the envelope.

    DESIRED_CAP_PERCENT is usage/cap (e.g. 0.80 → cap is 125% of usage).
    Caps stay below each GPU's max. If the cluster is short on budget,
    usage/cap is raised so total caps fit (p_fit = sum(usage)/allowable).
    """
    n = len(usages)
    if n <= 0:
        return [], desired_p
    s = sum(usages)
    if s <= 1:
        return [lo for lo, _hi in bounds], desired_p
    p_fit = s / max(max_allowable_w, 1.0)
    best_p = max(desired_p, p_fit, 1e-6)
    caps: list[float] = []
    for u, (lo, hi) in zip(usages, bounds):
        ceil = _cap_ceiling(lo, hi)
        caps.append(min(ceil, max(lo, u / best_p)))
    total_cap = sum(caps)
    if total_cap > max_allowable_w and total_cap > 0:
        scale = max_allowable_w / total_cap
        caps = [min(_cap_ceiling(lo, hi), max(lo, c * scale)) for c, (lo, hi) in zip(caps, bounds)]
    return caps, best_p


def _short(name: str) -> str:
    return power_limit._short(name)


def _rack_label(name: str, fallback: str = "") -> str:
    """Keep hall in the label so DH-01-R01C01 and DH-02-R01C01 do not collide."""
    raw = name or fallback or ""
    short = _short(raw)
    if not raw or raw == short:
        return short or raw
    prefix = raw[: -len(short)].rstrip("-") if short and raw.endswith(short) else ""
    if prefix.startswith("DH-"):
        return f"{prefix.replace('DH-', 'DH')}-{short}"
    if prefix:
        return f"{prefix}-{short}"
    return short or raw


def _rack_power_cap(alloc_kw: float, lo_kw: float, hi_kw: float) -> float:
    """Posted rack cap: never above max, never below idle min when the rack is fed."""
    cap = hi_kw
    if alloc_kw > 0:
        cap = min(hi_kw, alloc_kw)
    if cap <= 0:
        return hi_kw
    return max(lo_kw, cap)


def _rack_shelves(rid: str, shelf_w: list[float], oh_w: float, shelf_kw: float) -> list[dict[str, Any]]:
    n = SHELVES_PER_RACK
    raw: list[float] = []
    for i in range(n):
        jitter = 0.9 + 0.2 * _h01(f"{rid}-ps{i}")
        gpu_w = shelf_w[i] if i < len(shelf_w) else 0.0
        raw.append(max(0.0, gpu_w + (oh_w / n) * jitter))
    total = sum(raw)
    out: list[dict[str, Any]] = []
    if total <= 0:
        even = round(shelf_kw / n, 2) if n else 0.0
        for i in range(n):
            kw = even if i < n - 1 else round(shelf_kw - even * (n - 1), 2)
            out.append({"id": f"{rid}-ps{i + 1}", "index": i + 1, "kw": max(0.0, kw)})
        return out
    acc_kw = 0.0
    for i, w in enumerate(raw):
        if i == n - 1:
            kw = round(shelf_kw - acc_kw, 2)
        else:
            kw = round(shelf_kw * (w / total), 2)
            acc_kw += kw
        out.append({"id": f"{rid}-ps{i + 1}", "index": i + 1, "kw": max(0.0, kw)})
    return out


_ARGUS_SHELF_T = 0.0
_ARGUS_SHELF: dict[str, list[dict[str, Any]]] = {}


def _argus_shelf_rows() -> dict[str, list[dict[str, Any]]]:
    """rack_id -> PS1..PS8 rows from Argus TotalPowerOut (kW)."""
    global _ARGUS_SHELF_T, _ARGUS_SHELF
    now = time.time()
    if _ARGUS_SHELF and now - _ARGUS_SHELF_T < 5.0:
        return _ARGUS_SHELF
    try:
        from sqlalchemy import select

        from . import cluster_controller
        from .db import SessionLocal
        from .models import MaxLpsShelf

        with SessionLocal() as db:
            rows = list(db.scalars(select(MaxLpsShelf)).all())
        macs = [s.mac for s in rows if s.mac]
        watts = cluster_controller.latest_sensor("TotalPowerOut", macs) if macs else {}
        raw_idx = [int(s.index) for s in rows] if rows else []
        shift = 1 if raw_idx and min(raw_idx) == 0 else 0
        by_rack: dict[str, list[dict[str, Any]]] = {}
        for s in rows:
            w = watts.get((s.mac or "").lower())
            kw = round(float(w) / 1000.0, 3) if w is not None else None
            by_rack.setdefault(s.rack_id, []).append(
                {"id": s.id, "index": int(s.index) + shift, "kw": kw, "mac": s.mac}
            )
        for rid, items in by_rack.items():
            items.sort(key=lambda x: int(x["index"]))
        _ARGUS_SHELF = by_rack
        _ARGUS_SHELF_T = now
        return by_rack
    except Exception:
        return _ARGUS_SHELF


def _merge_argus_shelves(rid: str) -> tuple[list[dict[str, Any]], float, bool]:
    """Argus TotalPowerOut per power shelf. Shelves with no reading are omitted."""
    live = _argus_shelf_rows().get(rid) or []
    out: list[dict[str, Any]] = []
    total = 0.0
    for src in live:
        if src.get("kw") is None:
            continue
        kw = round(float(src["kw"]), 3)
        total += kw
        out.append(
            {
                "id": src.get("id") or f"{rid}-ps{int(src.get('index') or 0)}",
                "index": int(src.get("index") or 0),
                "kw": kw,
                "source": "argus",
            }
        )
    out.sort(key=lambda x: int(x["index"]))
    return out, round(total, 3), bool(out)


_LIVE_SHELF: dict[str, list[dict[str, Any]]] = {}
_LIVE_SHELF_T = 0.0
_LIVE_SHELF_BUSY = False
_LIVE_SHELF_TTL = 8.0


def _shelf_targets() -> list[dict[str, Any]]:
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import MaxLpsShelf

        with SessionLocal() as db:
            rows = list(db.scalars(select(MaxLpsShelf)).all())
        out: list[dict[str, Any]] = []
        for s in rows:
            ip = (s.ip or "").strip()
            if not ip:
                continue
            out.append(
                {
                    "id": s.id,
                    "rack_id": s.rack_id,
                    "index": int(s.index),
                    "bmc_ip": ip,
                    "user": s.user or "root",
                    "password": s.password or "",
                }
            )
        return out
    except Exception:
        return []


def _poll_live_shelves() -> None:
    global _LIVE_SHELF, _LIVE_SHELF_T, _LIVE_SHELF_BUSY
    try:
        from . import pxe_hop

        if not pxe_hop.status().get("connected"):
            with _LIVE_GPU_LOCK:
                _LIVE_SHELF = {}
                _LIVE_SHELF_T = time.time()
            return
        nodes = _shelf_targets()
        if not nodes:
            with _LIVE_GPU_LOCK:
                _LIVE_SHELF_T = time.time()
            return
        targets = [{"bmc_ip": n["bmc_ip"], "user": n["user"], "password": n["password"]} for n in nodes]
        by_ip = pxe_hop.fetch_psu_power(targets)
        raw_idx = [int(n["index"]) for n in nodes]
        shift = 1 if raw_idx and min(raw_idx) == 0 else 0
        by_rack: dict[str, list[dict[str, Any]]] = {}
        for n in nodes:
            rec = by_ip.get(n["bmc_ip"]) or {}
            total_w = rec.get("total_w")
            psus = rec.get("psus") or []
            if total_w is None and psus:
                total_w = sum(float(p.get("watts") or 0) for p in psus)
            if total_w is None:
                continue
            kw = round(float(total_w) / 1000.0, 3)
            modules = []
            for i, p in enumerate(psus):
                w = p.get("watts")
                if w is None:
                    continue
                modules.append(
                    {
                        "id": str(p.get("id") or i),
                        "index": int(p.get("index") or i + 1),
                        "kw": round(float(w) / 1000.0, 3),
                    }
                )
            by_rack.setdefault(n["rack_id"], []).append(
                {
                    "id": n["id"],
                    "index": int(n["index"]) + shift,
                    "kw": kw,
                    "psus": modules,
                    "source": "redfish",
                }
            )
        for items in by_rack.values():
            items.sort(key=lambda x: int(x["index"]))
        with _LIVE_GPU_LOCK:
            if by_rack:
                _LIVE_SHELF = by_rack
            _LIVE_SHELF_T = time.time()
    except Exception:
        pass
    finally:
        _LIVE_SHELF_BUSY = False


def _kick_live_shelf_poll() -> None:
    global _LIVE_SHELF_BUSY
    now = time.time()
    with _LIVE_GPU_LOCK:
        if _LIVE_SHELF_BUSY or (now - _LIVE_SHELF_T) < _LIVE_SHELF_TTL:
            return
        _LIVE_SHELF_BUSY = True
    threading.Thread(target=_poll_live_shelves, daemon=True, name="maxlps-psu-redfish").start()


def _live_shelf_rows() -> dict[str, list[dict[str, Any]]]:
    _kick_live_shelf_poll()
    with _LIVE_GPU_LOCK:
        return {k: list(v) for k, v in _LIVE_SHELF.items()}


_LIVE_GPU: dict[str, dict[str, Any]] = {}
_LIVE_GPU_SRC = "none"
_LIVE_GPU_T = 0.0
_LIVE_GPU_LOCK = threading.Lock()
_LIVE_GPU_BUSY = False
_LIVE_GPU_BUSY_T = 0.0
_LIVE_GPU_TTL = 1.0
_LIVE_GPU_ERR = ""


_IDENT_T = 0.0
_IDENT: dict[str, dict[str, Any]] = {}


def _gpu_identity() -> dict[str, dict[str, Any]]:
    """gid -> hostname, serial, slot (0-17), node_index."""
    global _IDENT_T, _IDENT
    now = time.time()
    if _IDENT and now - _IDENT_T < 5.0:
        return _IDENT
    try:
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from .db import SessionLocal
        from .models import MaxLpsNode

        with SessionLocal() as db:
            rows = list(db.scalars(select(MaxLpsNode).options(selectinload(MaxLpsNode.gpus))).all())
        out: dict[str, dict[str, Any]] = {}
        for n in rows:
            slot = int(n.index) - 1 if int(n.index) >= 1 else int(n.index)
            host = (n.hostname or "").strip()
            m = re.search(r"slot\s*(\d+)", host, re.I) if host else None
            if m:
                slot = int(m.group(1))
            by_g = {int(g.gpu_index): g for g in (n.gpus or [])}
            for gi in range(1, GPUS_PER_NODE + 1):
                gid = f"{n.rack_id}-n{int(n.index):02d}-g{gi}"
                g = by_g.get(gi)
                out[gid] = {
                    "hostname": host,
                    "serial": (g.serial if g else None) or "",
                    "slot": slot,
                    "node_index": int(n.index),
                    "has_bmc": bool((n.bmc_ip or "").strip()),
                }
        _IDENT = out
        _IDENT_T = now
        return out
    except Exception:
        return _IDENT


def _gpu_live_targets() -> list[tuple[str, str, str, str, str]]:
    """(rack_id, node_index, bmc_ip, user, password) per compute BMC."""
    try:
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from .db import SessionLocal
        from .models import MaxLpsNode

        with SessionLocal() as db:
            rows = list(
                db.scalars(
                    select(MaxLpsNode).options(selectinload(MaxLpsNode.rack)).order_by(MaxLpsNode.rack_id, MaxLpsNode.index)
                ).all()
            )
        by_rack_n: dict[str, int] = {}
        for n in rows:
            if (n.bmc_ip or "").strip():
                by_rack_n[n.rack_id] = by_rack_n.get(n.rack_id, 0) + 1
        rows.sort(key=lambda n: (-by_rack_n.get(n.rack_id, 0), n.rack_id, int(n.index)))
        out: list[tuple[str, str, str, str, str]] = []
        seen: set[str] = set()
        for n in rows:
            ip = (n.bmc_ip or "").strip()
            if not ip or ip in seen:
                continue
            rack = n.rack
            if rack is not None and ((rack.power_state or "on") == "off" or not rack.enabled):
                continue
            seen.add(ip)
            out.append((n.rack_id, str(int(n.index)), ip, n.bmc_user or "ADMIN", n.bmc_password or ""))
        return out
    except Exception:
        return []


def _poll_live_gpus() -> None:
    global _LIVE_GPU, _LIVE_GPU_SRC, _LIVE_GPU_T, _LIVE_GPU_BUSY, _LIVE_GPU_ERR
    try:
        from . import pxe_hop

        if not pxe_hop.status().get("connected"):
            with _LIVE_GPU_LOCK:
                _LIVE_GPU = {}
                _LIVE_GPU_SRC = "none"
                _LIVE_GPU_ERR = "pxe-hop-down"
                _LIVE_GPU_T = time.time()
            return
        nodes = _gpu_live_targets()
        if not nodes:
            with _LIVE_GPU_LOCK:
                _LIVE_GPU_ERR = "no-bmc-targets"
                _LIVE_GPU_T = time.time()
            return
        targets = [{"bmc_ip": ip, "user": user, "password": pw} for _rid, _idx, ip, user, pw in nodes]
        by_ip = pxe_hop.fetch_gpu_environment_metrics(targets)
        mapped: dict[str, dict[str, Any]] = {}
        for rid, idx, ip, _user, _pw in nodes:
            for g in by_ip.get(ip) or []:
                gi = int(g.get("index") or 0)
                if gi < 1 or gi > GPUS_PER_NODE:
                    continue
                if g.get("watts") is None:
                    continue
                gid = f"{rid}-n{int(idx):02d}-g{gi}"
                rec: dict[str, Any] = {"watts": float(g["watts"])}
                if g.get("min_w") is not None:
                    rec["min_w"] = float(g["min_w"])
                if g.get("max_w") is not None:
                    rec["max_w"] = float(g["max_w"])
                if g.get("setpoint_w") is not None:
                    rec["setpoint_w"] = float(g["setpoint_w"])
                if g.get("serial"):
                    rec["serial"] = str(g["serial"])
                rec["processor"] = str(g.get("processor") or g.get("id") or "")
                rec["path"] = str(g.get("path") or "")
                rec["bmc_ip"] = ip
                mapped[gid] = rec
        with _LIVE_GPU_LOCK:
            if mapped:
                _LIVE_GPU = mapped
                _LIVE_GPU_SRC = "redfish"
                _LIVE_GPU_ERR = ""
            else:
                _LIVE_GPU_ERR = f"empty-metrics:{len(targets)}bmc"
            _LIVE_GPU_T = time.time()
    except Exception as exc:
        with _LIVE_GPU_LOCK:
            _LIVE_GPU_ERR = str(exc)[:180]
    finally:
        _LIVE_GPU_BUSY = False


def _kick_live_gpu_poll(*, force: bool = False) -> None:
    global _LIVE_GPU_BUSY, _LIVE_GPU_BUSY_T
    now = time.time()
    with _LIVE_GPU_LOCK:
        if _LIVE_GPU_BUSY:
            if now - _LIVE_GPU_BUSY_T < 30.0 and not force:
                return
        elif not force and (now - _LIVE_GPU_T) < _LIVE_GPU_TTL:
            return
        _LIVE_GPU_BUSY = True
        _LIVE_GPU_BUSY_T = now
    threading.Thread(target=_poll_live_gpus, daemon=True, name="maxlps-gpu-redfish").start()


def force_live_gpu_poll() -> None:
    _kick_live_gpu_poll(force=True)


def _live_gpu_readings() -> tuple[dict[str, dict[str, Any]], str]:
    _kick_live_gpu_poll()
    with _LIVE_GPU_LOCK:
        return dict(_LIVE_GPU), _LIVE_GPU_SRC


def _live_bounds(gid: str, live: dict[str, Any]) -> tuple[float, float]:
    lo, hi = _bounds_of(gid)
    if live.get("min_w") is not None:
        lo = max(lo, float(live["min_w"]))
    if live.get("max_w") is not None:
        hi = min(hi, float(live["max_w"]))
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi


_CAP_BUSY = False


def _apply_gpu_caps(patches: list[dict[str, Any]]) -> None:
    global _CAP_BUSY
    try:
        from . import pxe_hop

        if not patches or not pxe_hop.status().get("connected"):
            return
        results = pxe_hop.apply_gpu_setpoints(patches)
        ok = {
            (r.get("bmc_ip"), r.get("path"))
            for r in results
            if 200 <= int(r.get("status") or 0) < 400
        }
        with _LIVE_GPU_LOCK:
            for p in patches:
                if (p.get("bmc_ip"), p.get("path")) not in ok:
                    continue
                sp = float(p.get("setpoint") or 0)
                gid = p.get("gid")
                if gid:
                    LOOP.last_posted[str(gid)] = sp
                for rec in _LIVE_GPU.values():
                    if rec.get("bmc_ip") == p.get("bmc_ip") and rec.get("path") == p.get("path"):
                        rec["setpoint_w"] = sp
    except Exception:
        pass
    finally:
        _CAP_BUSY = False


def _kick_cap_patch(patches: list[dict[str, Any]]) -> None:
    global _CAP_BUSY
    if not patches:
        return
    if _CAP_BUSY:
        return
    _CAP_BUSY = True
    threading.Thread(target=_apply_gpu_caps, args=(patches,), daemon=True, name="maxlps-gpu-cap").start()


def topology(n_racks: int) -> dict[str, Any]:
    return {
        "model": GPU_MODEL,
        "racks": n_racks,
        "nodes_per_rack": NODES_PER_RACK,
        "gpus_per_node": GPUS_PER_NODE,
        "gpus_per_rack": GPUS_PER_RACK,
        "gpu_tdp_w": GPU_TDP_W,
        "gpu_idle_w": GPU_IDLE_W,
        "gpu_count": n_racks * GPUS_PER_RACK,
        "node_count": n_racks * NODES_PER_RACK,
        "shelves_per_rack": SHELVES_PER_RACK,
    }


def snapshot(
    power_snap: dict[str, Any],
    *,
    top: int = 0,
    rack_id: str | None = None,
    gpu_id: str | None = None,
    workloads: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    now = time.time()
    rows = power_snap.get("racks") or []
    cache_key = (
        rack_id,
        gpu_id,
        int(top or 0),
        len(rows),
        round(LOOP.gpu_power_percent, 4),
        round(LOOP.desired_cap_percent, 4),
        round(LOOP.gpu_min_w, 1),
        round(LOOP.gpu_max_w, 1),
        round(_LIVE_GPU_T, 0),
        len(_LIVE_GPU),
    )
    if (
        not gpu_id
        and LOOP.cached_out is not None
        and LOOP.cached_key == cache_key
        and (now - LOOP.cache_t) < 0.2
    ):
        return LOOP.cached_out
    lo_kw = float(power_snap.get("min_rack_kw") or 40.0)
    hi_kw = float(power_snap.get("max_rack_kw") or 135.0)
    min_w = GPU_IDLE_W
    tdp_w = GPU_TDP_W
    power_budget_w = float(power_snap.get("total_budget_kw") or 0.0) * 1000.0
    if power_budget_w <= 0:
        power_budget_w = float(power_snap.get("envelope_kw") or 0.0) * 1000.0
    grace = max(0.01, min(1.0, float(power_snap.get("stay_under_pct") or power_snap.get("threshold_pct") or 80.0) / 100.0))
    gpu_frac = LOOP.gpu_power_percent
    desired_p = LOOP.desired_cap_percent
    max_allowable_w = power_budget_w * grace * gpu_frac

    records: list[dict[str, Any]] = []
    overhead_total_w = 0.0

    for r in rows:
        rid = r["id"]
        enabled = bool(r.get("enabled"))
        denied = bool(r.get("denied"))
        off = (r.get("power_state") or "on") == "off" or not enabled
        if off or denied:
            continue
        hot = bool(r.get("hot") or r.get("at_cap"))
        alloc_kw = float(r.get("allocated_kw") or 0.0)
        used_kw = float(r.get("consumed_kw") or 0.0)
        run_status = r.get("run_status") or "ready"
        label = _rack_label(r.get("name") or "", r.get("label") or "")
        hall_id = r.get("hall_id") or ""
        overhead_w = 0.0
        for n in range(1, NODES_PER_RACK + 1):
            for g in range(1, GPUS_PER_NODE + 1):
                gid = f"{rid}-n{n:02d}-g{g}"
                records.append(
                    {
                        "id": gid,
                        "rack_id": rid,
                        "rack_label": label,
                        "hall_id": hall_id,
                        "node": n,
                        "gpu": g,
                        "demand": 0.0,
                        "act": 0.0,
                        "off": off,
                        "enabled": enabled and not off,
                        "hot_rack": hot,
                        "run": run_status,
                        "denied": denied,
                        "extra": bool(r.get("extra")),
                        "overhead_w": overhead_w,
                        "alloc_kw": alloc_kw,
                    }
                )

    live_map, _live_src = _live_gpu_readings()
    ident = _gpu_identity()
    live_rows: list[dict[str, Any]] = []
    for rec in records:
        live = live_map.get(rec["id"])
        if not live or live.get("watts") is None or rec["off"]:
            continue
        watts = float(live["watts"])
        lo, hi = _live_bounds(rec["id"], live)
        rec["live"] = True
        rec["watts"] = watts
        rec["bmc_lo"] = lo
        rec["bmc_hi"] = hi
        rec["bmc_sp"] = float(live["setpoint_w"]) if live.get("setpoint_w") is not None else None
        rec["path"] = live.get("path") or ""
        rec["bmc_ip"] = live.get("bmc_ip") or ""
        rec["processor"] = live.get("processor") or ""
        live_rows.append(rec)
        _note_usage(rec["id"], watts, now)

    due = LOOP.force or (now - LOOP.last_step >= LOOP.interval_s)
    should_post = bool(live_rows) and (due or (not LOOP.last_posted and not _CAP_BUSY))
    if due:
        LOOP.last_step = now
        LOOP.force = False
        LOOP.step_n += 1
    best_p = LOOP.last_best_p
    if should_post:
        if not due:
            LOOP.last_step = now
            LOOP.force = False
            LOOP.step_n += 1
        avgs = [_window_avg(r["id"], float(r["watts"])) for r in live_rows]
        bounds = [(float(r["bmc_lo"]), float(r["bmc_hi"])) for r in live_rows]
        new_caps, best_p = _post_caps(avgs, max_allowable_w, desired_p, bounds)
        LOOP.last_best_p = best_p
        LOOP.last_caps = new_caps
        LOOP.usage_win.clear()
        LOOP.sample_t.clear()
        creds = {ip: (user, pw) for _rid, _idx, ip, user, pw in _gpu_live_targets()}
        patches: list[dict[str, Any]] = []
        for rec, cap in zip(live_rows, new_caps):
            cap_w = float(round(cap))
            LOOP.last_cap_by_id[rec["id"]] = cap_w
            prev = LOOP.last_posted.get(rec["id"])
            bmc_sp = rec.get("bmc_sp")
            if not rec.get("path") or not rec.get("bmc_ip"):
                continue
            if prev is not None and abs(prev - cap_w) < 2:
                continue
            if bmc_sp is not None and prev is None and abs(float(bmc_sp) - cap_w) < 2:
                LOOP.last_posted[rec["id"]] = cap_w
                continue
            user, pw = creds.get(str(rec["bmc_ip"]), ("ADMIN", ""))
            patches.append(
                {
                    "gid": rec["id"],
                    "bmc_ip": rec["bmc_ip"],
                    "user": user,
                    "password": pw,
                    "path": rec["path"],
                    "setpoint": int(cap_w),
                }
            )
        _kick_cap_patch(patches)

    gpu_pool: list[tuple] = []
    rack_acc: dict[str, dict[str, Any]] = {}
    gpu_total_w = 0.0
    cap_total_w = 0.0
    at_cap = 0
    hottest_w = 0.0
    sp_sum = 0.0
    sp_n = 0
    live_n = 0

    for rec in records:
        lo, hi = _bounds_of(rec["id"])
        sp = 0.0
        watts = 0.0
        live = live_map.get(rec["id"])
        if rec.get("live") and live and live.get("watts") is not None:
            watts = round(float(live["watts"]), 1)
            lo, hi = _live_bounds(rec["id"], live)
            posted = LOOP.last_cap_by_id.get(rec["id"])
            if posted is not None:
                sp = round(float(posted), 1)
            elif live.get("setpoint_w") is not None:
                sp = round(float(live["setpoint_w"]), 1)
            live_n += 1
        gpu_total_w += watts
        cap_total_w += sp
        if watts > hottest_w:
            hottest_w = watts
        if sp >= tdp_w - 8:
            at_cap += 1
        if rec.get("live"):
            sp_sum += sp
            sp_n += 1
        keep = (not rack_id) or rec["rack_id"] == rack_id
        if keep and rec.get("live"):
            gpu_pool.append((watts, rec["id"], rec, sp, lo, hi))
        acc = rack_acc.setdefault(
            rec["rack_id"],
            {
                "id": rec["rack_id"],
                "label": rec["rack_label"],
                "name": rec["rack_label"],
                "hall_id": rec["hall_id"],
                "power_state": "off" if rec["off"] else "on",
                "enabled": rec["enabled"] or not rec["off"],
                "denied": rec["denied"],
                "hot": rec["hot_rack"],
                "extra": rec["extra"],
                "gpu_w": 0.0,
                "cap_w": 0.0,
                "overhead_w": rec["overhead_w"],
                "alloc_kw": rec["alloc_kw"],
                "gpus_at_cap": 0,
                "n": 0,
                "n_live": 0,
                "shelf_w": [0.0] * SHELVES_PER_RACK,
                "live": False,
            },
        )
        if rec.get("live"):
            acc["live"] = True
            acc["n_live"] += 1
        acc["gpu_w"] += watts
        acc["cap_w"] += sp
        acc["n"] += 1
        gpus_per_shelf = max(1, GPUS_PER_RACK // SHELVES_PER_RACK)
        gpu_i = (int(rec["node"]) - 1) * GPUS_PER_NODE + (int(rec["gpu"]) - 1)
        si = min(SHELVES_PER_RACK - 1, max(0, gpu_i // gpus_per_shelf))
        acc["shelf_w"][si] += watts
        if sp >= tdp_w - 8:
            acc["gpus_at_cap"] += 1

    for acc in rack_acc.values():
        enabled = bool(acc["enabled"]) and acc["power_state"] != "off"
        raw_kw = (acc["gpu_w"] + acc["overhead_w"]) / 1000.0
        acc["fit_kw"] = raw_kw if enabled else 0.0

    rack_out = []
    shelf_total = 0.0
    argus_shelves = False
    for acc in rack_acc.values():
        gpu_kw = acc["gpu_w"] / 1000.0
        oh_kw = 0.0
        n_on = acc["n_live"] if acc["power_state"] != "off" else 0
        shelves, live_sum, live = _merge_argus_shelves(str(acc["id"]))
        if live:
            shelf_kw = live_sum
            argus_shelves = True
            if shelf_kw > gpu_kw + 0.001:
                oh_kw = max(0.0, shelf_kw - gpu_kw)
        else:
            shelf_kw = 0.0
        shelf_total += shelf_kw
        rack_out.append(
            {
                "id": acc["id"],
                "label": acc["label"],
                "name": acc["name"],
                "hall_id": acc["hall_id"],
                "power_state": acc["power_state"],
                "enabled": acc["enabled"],
                "denied": acc["denied"],
                "hot": acc["hot"],
                "extra": acc["extra"],
                "shelf_kw": shelf_kw,
                "shelf_count": SHELVES_PER_RACK,
                "shelves": shelves,
                "gpu_kw": round(gpu_kw, 2),
                "overhead_kw": round(oh_kw, 2),
                "allocated_kw": round(acc["alloc_kw"], 1),
                "consumed_kw": round(shelf_kw, 1),
                "setpoint_w": round(acc["cap_w"] / n_on, 1) if n_on else 0.0,
                "gpus_at_cap": acc["gpus_at_cap"],
            }
        )

    total_kw = power_budget_w / 1000.0
    available_kw = total_kw * grace
    rack_out.sort(key=lambda r: (bool(r.get("extra")), r["label"]))
    kept: list[dict[str, Any]] = []
    used_kw = 0.0
    for r in rack_out:
        nxt = used_kw + float(r["shelf_kw"])
        if nxt > available_kw + 0.05:
            continue
        kept.append(r)
        used_kw = nxt
    rack_out = kept
    keep_ids = {r["id"] for r in rack_out}
    gpu_pool = [row for row in gpu_pool if row[2]["rack_id"] in keep_ids]
    gpu_pool.sort(key=lambda row: (-row[0], row[1]))
    limit = len(gpu_pool) if (not top or rack_id) else max(8, min(int(top), len(gpu_pool)))
    shown: list[dict[str, Any]] = []
    picked: dict[str, Any] | None = None
    gpu_total_w = 0.0
    cap_total_w = 0.0
    for i, (watts, gid, rec, sp, lo, hi) in enumerate(gpu_pool, start=1):
        gpu_total_w += watts
        cap_total_w += sp
        if i > limit and not (gpu_id and gid == gpu_id):
            continue
        meta = ident.get(gid) or {}
        live_row = live_map.get(gid) or {}
        serial = str(live_row.get("serial") or "").strip()
        if not serial or serial.count("-") == 4:
            serial = str(meta.get("serial") or "").strip()
        if not serial or serial.count("-") == 4:
            serial = str(live_row.get("processor") or f"g{rec['gpu']}").strip()
        hostname = str(meta.get("hostname") or "").strip()
        slot = meta.get("slot")
        if slot is None:
            slot = int(rec["node"]) - 1
        item = {
            "id": gid,
            "rack_id": rec["rack_id"],
            "rack_label": rec["rack_label"],
            "node": rec["node"],
            "gpu": rec["gpu"],
            "slot": int(slot),
            "serial": serial,
            "hostname": hostname,
            "watts": watts,
            "setpoint_w": sp,
            "min_w": round(lo, 1),
            "max_w": round(hi, 1),
            "enabled": rec["enabled"],
            "rank": i,
            "source": "redfish",
        }
        if gpu_id and gid == gpu_id:
            item["process"] = "—"
            item["workload"] = "—"
            item["pid"] = 0
            item["tdp_w"] = tdp_w
            item["workload_kind"] = "idle"
            item["curve"] = _ensure_hist(
                gid, now, watts, sp, lo, hi, hot=rec["hot_rack"], run=rec["run"], off=rec["off"]
            )
            picked = item
        shown.append(item)
        if due and i <= 32:
            _record_hist(gid, now, watts, sp, lo, hi)
    by_sn_host: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in shown:
        key = (str(item.get("hostname") or ""), str(item.get("serial") or ""))
        by_sn_host.setdefault(key, []).append(item)
    for (_host, sn), group in by_sn_host.items():
        if sn and len(group) > 1:
            for item in group:
                item["serial"] = f"{sn}-g{item.get('gpu')}"
    if due and gpu_id and picked:
        _record_hist(gpu_id, now, picked["watts"], picked["setpoint_w"], picked["min_w"], picked["max_w"])
        hist = LOOP.gpu_hist.get(gpu_id)
        if hist:
            picked["curve"] = list(hist)
    overhead_total_w = sum(float(r["overhead_kw"]) for r in rack_out) * 1000.0
    n_racks = len(rack_out)
    free_kw = available_kw - used_kw
    shelf_total = used_kw
    prev_used = LOOP.last_used_kw
    used_delta = 0.0
    if due:
        used_delta = 0.0 if prev_used <= 0 else used_kw - prev_used
        LOOP.last_used_kw = used_kw
    if now - LOOP.hist_t >= 0.85:
        LOOP.hist_t = now
        _HISTORY.append(
            {
                "t": round(now, 1),
                "gpu_kw": round(gpu_total_w / 1000.0, 1),
                "overhead_kw": round(overhead_total_w / 1000.0, 1),
                "shelf_kw": round(shelf_total, 1),
                "used_kw": round(used_kw, 1),
                "available_kw": round(available_kw, 1),
                "free_kw": round(free_kw, 1),
                "cap_kw": round(cap_total_w / 1000.0, 1),
                "allowable_kw": round(max_allowable_w / 1000.0, 1),
            }
        )
        del _HISTORY[:-_HISTORY_N]
    out = {
        "topology": topology(n_racks),
        "mode": power_snap.get("mode"),
        "tick": power_snap.get("tick"),
        "loop_step": LOOP.step_n,
        "last_event": power_snap.get("last_event"),
        "min_rack_kw": lo_kw,
        "max_rack_kw": hi_kw,
        "total_budget_kw": power_snap.get("total_budget_kw"),
        "envelope_kw": power_snap.get("envelope_kw"),
        "threshold_pct": power_snap.get("threshold_pct"),
        "racks_static_max": power_snap.get("racks_static_max"),
        "racks_lps_max": power_snap.get("racks_lps_max"),
        "racks_lps_gain": power_snap.get("racks_lps_gain"),
        "racks_pool": power_snap.get("racks_pool"),
        "stay_under_pct": power_snap.get("stay_under_pct"),
        "power_source": power_snap.get("power_source"),
        "filter_rack_id": rack_id,
        "filter_gpu_id": gpu_id,
        "totals": {
            "total_kw": round(total_kw, 1),
            "available_kw": round(available_kw, 1),
            "used_kw": round(used_kw, 1),
            "free_kw": round(free_kw, 1),
            "used_delta_kw": round(used_delta, 1),
            "shelf_kw": round(shelf_total, 1),
            "shelf_source": "argus" if argus_shelves else "none",
            "gpu_source": "redfish" if live_n else "none",
            "gpu_error": _LIVE_GPU_ERR or None,
            "gpu_live": live_n,
            "gpu_poll_age_s": round(max(0.0, now - _LIVE_GPU_T), 1) if _LIVE_GPU_T else None,
            "gpu_busy": _LIVE_GPU_BUSY,
            "gpu_kw": round(gpu_total_w / 1000.0, 2),
            "overhead_kw": round(overhead_total_w / 1000.0, 1),
            "hottest_w": round(hottest_w, 1),
            "avg_setpoint_w": round(sp_sum / sp_n, 1) if sp_n else 0.0,
            "gpus_at_cap": at_cap,
            "gpus_listed": len(shown),
            "gpus_total": sum(
                1
                for gid, meta in ident.items()
                if meta.get("has_bmc") and (not rack_id or gid.startswith(f"{rack_id}-"))
            )
            or live_n,
            "cap_kw": round(cap_total_w / 1000.0, 1),
            "allowable_kw": round(max_allowable_w / 1000.0, 1),
            "best_cap_percent": round(best_p * 100.0, 2),
        },
        "algo": {
            "interval_s": round(LOOP.interval_s, 1),
            "power_budget_w": round(power_budget_w, 0),
            "budget_grace": round(grace * 100.0, 1),
            "gpu_power_percent": round(gpu_frac * 100.0, 1),
            "desired_cap_percent": round(desired_p * 100.0, 1),
            "gpu_min_w": round(LOOP.gpu_min_w, 1),
            "gpu_max_w": round(LOOP.gpu_max_w, 1),
            "max_allowable_w": round(max_allowable_w, 0),
            "best_cap_percent": round(best_p * 100.0, 2),
            "n": len(records),
        },
        "history": list(_HISTORY),
        "racks": rack_out,
        "gpus": shown,
        "limiter": {
            "mode": power_snap.get("mode"),
            "tick": power_snap.get("tick"),
            "last_event": power_snap.get("last_event"),
            "total_budget_kw": power_snap.get("total_budget_kw"),
            "envelope_kw": power_snap.get("envelope_kw"),
            "threshold_pct": power_snap.get("threshold_pct"),
            "min_rack_kw": lo_kw,
            "max_rack_kw": hi_kw,
            "racks_static_max": power_snap.get("racks_static_max"),
            "racks_lps_max": power_snap.get("racks_lps_max"),
            "racks_lps_gain": power_snap.get("racks_lps_gain"),
            "rack_policy_kw": power_snap.get("rack_policy_kw"),
            "rack_count": power_snap.get("rack_count"),
            "racks_on": power_snap.get("racks_on"),
            "racks_pool": power_snap.get("racks_pool"),
            "power_source": power_snap.get("power_source"),
            "stay_under_pct": power_snap.get("stay_under_pct"),
        },
    }
    LOOP.cached_out = out
    LOOP.cached_key = cache_key
    LOOP.cache_t = now
    return out
