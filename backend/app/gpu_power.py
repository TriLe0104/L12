"""GB300 GPU / node / power-shelf telemetry for the MaxLPS tab.

Topology is fixed for this campus: 18 compute nodes per rack, 4 GB300 GPUs
per node (NVL72). Rack input comes from a simulated power shelf; per-GPU
watts are the DCGM-style readings the limiter would cap via Redfish SetPoint.
"""

from __future__ import annotations

import math
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


GPU_POWER_PERCENT = 0.86
DESIRED_CAP_PERCENT = 0.80  # usage should sit at this fraction of the posted cap
DEFAULT_INTERVAL_S = 10.0
_HISTORY: list[dict[str, float]] = []
_HISTORY_N = 48
HIST_N = 128
HIST_DT = 0.25
BACKFILL_N = 100


class LoopState:
    def __init__(self) -> None:
        self.interval_s = DEFAULT_INTERVAL_S
        self.gpu_power_percent = GPU_POWER_PERCENT
        self.desired_cap_percent = DESIRED_CAP_PERCENT
        self.gpu_min_w = GPU_IDLE_W
        self.gpu_max_w = GPU_TDP_W
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
        self.cached_out: dict[str, Any] | None = None
        self.cached_key: tuple[Any, ...] | None = None
        self.cache_t = 0.0


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
        LOOP.desired_cap_percent = v
    if gpu_min_w is not None:
        v = max(50.0, min(GPU_TDP_W, float(gpu_min_w)))
        if abs(v - LOOP.gpu_min_w) >= 0.5:
            changed = True
        LOOP.gpu_min_w = v
    if gpu_max_w is not None:
        v = max(50.0, min(GPU_TDP_W, float(gpu_max_w)))
        if abs(v - LOOP.gpu_max_w) >= 0.5:
            changed = True
        LOOP.gpu_max_w = v
    if LOOP.gpu_min_w > LOOP.gpu_max_w:
        LOOP.gpu_min_w, LOOP.gpu_max_w = LOOP.gpu_max_w, LOOP.gpu_min_w
        changed = True
    if changed:
        LOOP.force = True
        LOOP.last_caps = None
        LOOP.last_cap_by_id.clear()
        LOOP.cached_out = None
        LOOP.prev_usage.clear()
        LOOP.prev_usage_t.clear()
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


def _workload_load(gpu_id: str, now: float) -> float:
    """0–1 envelope: idle → ramp up → hold → ramp down → idle."""
    cycle = 160.0
    phase = _h01(gpu_id + ":wl") * cycle
    t = (now + phase) % cycle
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
    load = _workload_load(gpu_id, now)
    busy = _h01(gpu_id + ":busy")
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
    q = LOOP.gpu_hist.get(gid)
    if q is None or len(q) < 8:
        _backfill_hist(gid, now, watts, cap, lo, hi, hot=hot, run=run, off=off)
    else:
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
    off = bool(cached is not None and not cached.get("enabled", True))
    hot = False
    run = "running"
    if LOOP.cached_out and cached:
        rid = cached.get("rack_id")
        for r in LOOP.cached_out.get("racks") or []:
            if r.get("id") == rid:
                hot = bool(r.get("hot"))
                break
    act = 0.0 if off else _activity(gpu_id, now, hot, run)
    demand = 0.0 if off else _usage_w(act)
    if gpu_id in LOOP.last_cap_by_id:
        sp = min(hi, max(lo, LOOP.last_cap_by_id[gpu_id]))
    elif cached and cached.get("setpoint_w") is not None:
        sp = float(cached["setpoint_w"])
    else:
        sp = min(hi, max(lo, demand / max(LOOP.desired_cap_percent, 0.1)))
    target = min(demand, sp)
    u = 0.0 if off else _smooth_usage(gpu_id, target, now)
    watts = 0.0 if off else min(u, sp)
    curve = _ensure_hist(gpu_id, now, watts, sp, lo, hi, hot=hot, run=run, off=off)
    return {
        "id": gpu_id,
        "watts": round(watts, 1),
        "setpoint_w": round(sp, 1),
        "min_w": round(lo, 1),
        "max_w": round(hi, 1),
        "curve": curve,
    }


def _usage_w(activity: float) -> float:
    a = max(0.0, min(1.0, activity))
    lo, hi = LOOP.gpu_min_w, LOOP.gpu_max_w
    return lo + (hi - lo) * a


def _post_caps(
    usages: list[float],
    max_allowable_w: float,
    desired_p: float,
) -> tuple[list[float], float]:
    """cap_i = usage_i / bestCapPercent, with bestCapPercent high enough that
    sum(caps) fits in max_allowable_w.

    DESIRED_CAP_PERCENT is usage/cap (e.g. 0.80 → cap is 125% of usage).
    If the cluster is short on budget, usage/cap is raised so total caps fit.
    (p_fit = sum(usage)/allowable, not allowable/sum(usage).)
    """
    n = len(usages)
    idle, tdp = LOOP.gpu_min_w, LOOP.gpu_max_w
    s = sum(usages)
    if n <= 0:
        return [], desired_p
    if s <= 1:
        return [idle] * n, desired_p
    p_fit = s / max(max_allowable_w, 1.0)
    best_p = max(desired_p, p_fit, 1e-6)
    caps = [min(tdp, max(idle, u / best_p)) for u in usages]
    total_cap = sum(caps)
    if total_cap > max_allowable_w and total_cap > 0:
        scale = max_allowable_w / total_cap
        caps = [min(tdp, max(idle, c * scale)) for c in caps]
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
    usages: list[float] = []
    overhead_total_w = 0.0
    shelf_pre = 0.0

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
        load = 0.0 if off else min(1.0, used_kw / max(alloc_kw, hi_kw, 1.0))
        overhead_w = 0.0 if off else NODES_PER_RACK * NODE_OH_W * (0.35 + 0.65 * load) + SHELF_OH_W
        overhead_total_w += overhead_w
        rack_usage = 0.0
        for n in range(1, NODES_PER_RACK + 1):
            for g in range(1, GPUS_PER_NODE + 1):
                gid = f"{rid}-n{n:02d}-g{g}"
                act = 0.0 if off else _activity(gid, now, hot, run_status)
                demand = 0.0 if off else _usage_w(act)
                records.append(
                    {
                        "id": gid,
                        "rack_id": rid,
                        "rack_label": label,
                        "hall_id": hall_id,
                        "node": n,
                        "gpu": g,
                        "demand": demand,
                        "act": act,
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
        shelf_pre += overhead_w

    due = LOOP.force or (now - LOOP.last_step >= LOOP.interval_s)
    best_p = LOOP.last_best_p
    caps: list[float] = []
    for rec in records:
        lo, hi = _bounds_of(rec["id"])
        stored = LOOP.last_cap_by_id.get(rec["id"])
        if stored is None:
            stored = rec["demand"] / max(desired_p, 0.1)
        caps.append(min(hi, max(lo, stored)))

    usages: list[float] = []
    at_posted: list[bool] = []
    for rec, cap in zip(records, caps):
        lo, hi = _bounds_of(rec["id"])
        posted = min(hi, max(lo, cap))
        demand = rec["demand"]
        target = min(demand, posted)
        u = 0.0 if rec["off"] else _smooth_usage(rec["id"], target, now)
        rec["usage"] = u
        usages.append(u)
        at_posted.append(
            (not rec["off"]) and u >= posted - 12 and demand > posted + 8 and posted < hi - 4
        )

    hitting = any(at_posted)
    if due:
        LOOP.last_step = now
        LOOP.force = False
        LOOP.step_n += 1
        caps, best_p = _post_caps(usages, max_allowable_w, desired_p)
        LOOP.last_best_p = best_p
    elif hitting:
        new_caps, best_p = _post_caps(usages, max_allowable_w, desired_p)
        merged: list[float] = []
        for old, new, rec, at in zip(caps, new_caps, records, at_posted):
            lo, hi = _bounds_of(rec["id"])
            merged.append(min(hi, max(lo, new if at else old)))
        total_cap = sum(merged)
        if total_cap > max_allowable_w and total_cap > 0:
            scale = max_allowable_w / total_cap
            merged = [min(_bounds_of(rec["id"])[1], max(_bounds_of(rec["id"])[0], c * scale)) for rec, c in zip(records, merged)]
        caps = merged
        LOOP.last_best_p = max(best_p, LOOP.last_best_p)
        LOOP.force = False

    LOOP.last_caps = caps
    for rec, c in zip(records, caps):
        LOOP.last_cap_by_id[rec["id"]] = c
    rack_usage_acc: dict[str, float] = {}
    for rec, u in zip(records, usages):
        rack_usage_acc[rec["rack_id"]] = rack_usage_acc.get(rec["rack_id"], 0.0) + u
    shelf_pre += sum(rack_usage_acc.values())

    gpu_pool: list[dict[str, Any]] = []
    rack_acc: dict[str, dict[str, Any]] = {}
    gpu_total_w = 0.0
    cap_total_w = 0.0
    at_cap = 0
    hottest_w = 0.0
    sp_sum = 0.0
    sp_n = 0

    jobs = workloads or []
    running_jobs = [w for w in jobs if (w.get("status") or "") == "running"]
    track_hist: set[str] = set(LOOP.bounds)
    if gpu_id:
        track_hist.add(gpu_id)
    track_hist.update(LOOP.gpu_hist)

    for rec, u, cap in zip(records, usages, caps):
        lo, hi = _bounds_of(rec["id"])
        sp = round(min(hi, max(lo, cap)), 1)
        watts = round(min(u, sp), 1)
        if rec["off"]:
            watts = 0.0
            sp = 0.0
        gpu_total_w += watts
        cap_total_w += sp
        if watts > hottest_w:
            hottest_w = watts
        if sp >= tdp_w - 8:
            at_cap += 1
        if rec["enabled"]:
            sp_sum += sp
            sp_n += 1
        keep = (not rack_id) or rec["rack_id"] == rack_id
        if keep:
            job = _process(rec["id"], rec["act"], rec["hot_rack"], rec["run"], running_jobs)
            item = {
                "id": rec["id"],
                "rack_id": rec["rack_id"],
                "rack_label": rec["rack_label"],
                "node": rec["node"],
                "gpu": rec["gpu"],
                "watts": watts,
                "setpoint_w": sp,
                "min_w": round(lo, 1),
                "max_w": round(hi, 1),
                "enabled": rec["enabled"],
                "process": job["process"],
                "workload": job["workload"],
                "pid": job["pid"],
                "spark": _spark_curve(rec["id"], now, rec["hot_rack"], rec["run"]),
            }
            if gpu_id and rec["id"] == gpu_id:
                item["tdp_w"] = tdp_w
                item["workload_kind"] = job["workload_kind"]
                item["curve"] = _ensure_hist(
                    rec["id"],
                    now,
                    watts,
                    sp,
                    lo,
                    hi,
                    hot=rec["hot_rack"],
                    run=rec["run"],
                    off=rec["off"],
                )
            gpu_pool.append(item)
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
            },
        )
        acc["gpu_w"] += watts
        acc["cap_w"] += sp
        acc["n"] += 1
        if sp >= tdp_w - 8:
            acc["gpus_at_cap"] += 1

    rack_out = []
    shelf_total = 0.0
    for acc in rack_acc.values():
        gpu_kw = acc["gpu_w"] / 1000.0
        oh_kw = acc["overhead_w"] / 1000.0
        shelf_kw = round(gpu_kw + oh_kw, 2)
        shelf_total += shelf_kw
        n_on = acc["n"] if acc["power_state"] != "off" else 0
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
    gpu_pool = [g for g in gpu_pool if g["rack_id"] in keep_ids]
    gpu_pool.sort(key=lambda g: (-g["watts"], g["id"]))
    for i, g in enumerate(gpu_pool, start=1):
        g["rank"] = i
    if gpu_id:
        for g in gpu_pool:
            if g["id"] != gpu_id:
                continue
            g["curve"] = _ensure_hist(
                g["id"],
                now,
                g["watts"],
                g["setpoint_w"],
                g["min_w"],
                g["max_w"],
                hot=bool(g.get("hot")),
                run="running",
                off=not g.get("enabled", True),
            )
            break
    if due:
        for g in gpu_pool[:32]:
            track_hist.add(g["id"])
        if gpu_id:
            track_hist.add(gpu_id)
        by_id = {g["id"]: g for g in gpu_pool}
        for gid in list(track_hist):
            g = by_id.get(gid)
            if not g:
                continue
            _record_hist(gid, now, g["watts"], g["setpoint_w"], g["min_w"], g["max_w"])
            if gpu_id and gid == gpu_id:
                hist = LOOP.gpu_hist.get(gid)
                if hist:
                    g["curve"] = list(hist)
    shown = gpu_pool if (not top or rack_id) else gpu_pool[: max(8, min(int(top), len(gpu_pool)))]
    gpu_total_w = sum(float(g["watts"]) for g in gpu_pool)
    cap_total_w = sum(float(g["setpoint_w"]) for g in gpu_pool)
    overhead_total_w = sum(float(r["overhead_kw"]) for r in rack_out) * 1000.0
    n_racks = len(rack_out)
    free_kw = available_kw - used_kw
    shelf_total = used_kw
    prev_used = LOOP.last_used_kw
    used_delta = 0.0
    if due:
        used_delta = 0.0 if prev_used <= 0 else used_kw - prev_used
        LOOP.last_used_kw = used_kw
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
            "gpu_kw": round(gpu_total_w / 1000.0, 1),
            "overhead_kw": round(overhead_total_w / 1000.0, 1),
            "hottest_w": round(hottest_w, 1),
            "avg_setpoint_w": round(sp_sum / sp_n, 1) if sp_n else 0.0,
            "gpus_at_cap": at_cap,
            "gpus_listed": len(shown),
            "gpus_total": n_racks * GPUS_PER_RACK if not rack_id else GPUS_PER_RACK,
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
