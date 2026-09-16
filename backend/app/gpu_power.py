"""GB300 GPU / node / power-shelf telemetry for the MaxLPS tab.

Topology is fixed for this campus: 18 compute nodes per rack, 4 GB300 GPUs
per node (NVL72). Rack input comes from a simulated power shelf; per-GPU
watts are the DCGM-style readings the limiter would cap via Redfish SetPoint.
"""

from __future__ import annotations

import hashlib
import math
import time
from typing import Any

from . import power_limit

GPU_MODEL = "GB300"
NODES_PER_RACK = 18
GPUS_PER_NODE = 4
GPUS_PER_RACK = NODES_PER_RACK * GPUS_PER_NODE  # 72
GPU_TDP_W = 1400.0
GPU_IDLE_W = 180.0
NODE_OH_W = 260.0  # CPU, NIC, BMC, fans per node
SHELF_OH_W = 350.0  # PSU / busbar loss


def _h01(key: str) -> float:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


HEADROOM = 0.12
_HISTORY: list[dict[str, float]] = []
_HISTORY_N = 36


def _mix(gpu_id: str, now: float) -> float:
    phase = _h01(gpu_id) * math.tau
    a = 0.5 + 0.5 * math.sin(now / 5.8 + phase)
    b = 0.5 + 0.5 * math.sin(now / 11.4 + phase * 1.73)
    return 0.72 * a + 0.28 * b


def _activity(gpu_id: str, now: float, hot: bool, run_status: str) -> float:
    """0–1 GPU load. Unused devices sit near idle so MaxLPS can reclaim their limit."""
    mix = _mix(gpu_id, now)
    busy_gate = _h01(gpu_id + ":busy")
    if hot:
        return (0.86 + 0.14 * mix) if busy_gate > 0.70 else (0.02 + 0.06 * mix)
    if run_status == "running":
        return (0.50 + 0.38 * mix) if busy_gate > 0.55 else (0.03 + 0.10 * mix)
    return 0.02 + 0.10 * mix


def _allocate(
    activities: list[float],
    budget_w: float,
    dynamic: bool,
) -> tuple[list[float], list[float]]:
    """Return (watts, setpoint_w) per GPU. Dynamic steals unused limits."""
    n = len(activities)
    if n <= 0:
        return [], []
    tdp, idle = GPU_TDP_W, GPU_IDLE_W
    demands = [idle + (tdp - idle) * max(0.0, min(1.0, a)) for a in activities]
    if not dynamic:
        fair = max(0.0, budget_w) / n
        sps = [min(tdp, max(idle, fair)) for _ in range(n)]
        return [min(d, s) for d, s in zip(demands, sps)], sps

    sps = [idle] * n
    left = max(0.0, budget_w - idle * n)
    order = sorted(range(n), key=lambda i: -demands[i])
    for i in order:
        if left <= 0.05:
            break
        if activities[i] < 0.12:
            continue
        want = min(tdp, max(idle, demands[i] / (1.0 - HEADROOM)))
        take = min(left, max(0.0, want - sps[i]))
        sps[i] += take
        left -= take
    watts = [min(d, s) for d, s in zip(demands, sps)]
    return watts, sps


def _short(name: str) -> str:
    return power_limit._short(name)


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
    }


def snapshot(
    power_snap: dict[str, Any],
    *,
    top: int = 80,
    rack_id: str | None = None,
) -> dict[str, Any]:
    now = time.time()
    rows = power_snap.get("racks") or []
    lo_kw = float(power_snap.get("min_rack_kw") or 40.0)
    hi_kw = float(power_snap.get("max_rack_kw") or 135.0)
    min_w = GPU_IDLE_W
    tdp_w = GPU_TDP_W
    top_n = max(8, min(int(top), 240))
    dynamic = (power_snap.get("mode") or "dynamic") == "dynamic"

    rack_out: list[dict[str, Any]] = []
    gpu_pool: list[dict[str, Any]] = []
    shelf_total = 0.0
    gpu_total_w = 0.0
    overhead_total_w = 0.0
    at_cap = 0
    hottest_w = 0.0
    sp_sum = 0.0
    sp_n = 0

    for r in rows:
        rid = r["id"]
        enabled = bool(r.get("enabled"))
        denied = bool(r.get("denied"))
        off = (r.get("power_state") or "on") == "off" or (not enabled and not denied)
        hot = bool(r.get("hot") or r.get("at_cap"))
        alloc_kw = float(r.get("allocated_kw") or 0.0)
        used_kw = float(r.get("consumed_kw") or 0.0)
        run_status = r.get("run_status") or "ready"
        label = r.get("label") or _short(r.get("name") or "")
        hall_id = r.get("hall_id") or ""
        keep = (not rack_id) or rid == rack_id
        load = 0.0 if off else min(1.0, used_kw / max(alloc_kw, hi_kw, 1.0))
        overhead_w = 0.0 if off else NODES_PER_RACK * NODE_OH_W * (0.35 + 0.65 * load) + SHELF_OH_W
        gpu_budget_w = 0.0 if off or alloc_kw <= 0 else max(0.0, alloc_kw * 1000.0 - overhead_w)

        slots: list[tuple[str, int, int]] = [
            (f"{rid}-n{n:02d}-g{g}", n, g)
            for n in range(1, NODES_PER_RACK + 1)
            for g in range(1, GPUS_PER_NODE + 1)
        ]
        activities = [_activity(gid, now, hot, run_status) if not off else 0.0 for gid, _, _ in slots]
        if off or gpu_budget_w <= 0:
            watts_l = [0.0] * len(slots)
            sps_l = [0.0] * len(slots)
        else:
            watts_l, sps_l = _allocate(activities, gpu_budget_w, dynamic)

        rack_gpu_w = 0.0
        rack_cap = 0
        rack_sp = 0.0
        for (gid, n, g), watts, sp, act in zip(slots, watts_l, sps_l, activities):
            watts = round(watts, 1)
            sp = round(sp, 1)
            pct_lim = (watts / sp * 100.0) if sp > 1 else 0.0
            if sp >= tdp_w - 8:
                rack_cap += 1
            rack_gpu_w += watts
            rack_sp += sp
            if watts > hottest_w:
                hottest_w = watts
            if keep:
                gpu_pool.append(
                    {
                        "id": gid,
                        "rack_id": rid,
                        "rack_label": label,
                        "hall_id": hall_id,
                        "node": n,
                        "gpu": g,
                        "watts": watts,
                        "setpoint_w": sp,
                        "tdp_w": tdp_w,
                        "min_w": round(min_w, 1),
                        "pct_limit": round(pct_lim, 1),
                        "pct_tdp": round(watts / tdp_w * 100.0, 1),
                        "hot": hot and act >= 0.5,
                        "enabled": enabled and not off,
                    }
                )

        shelf_kw = round((rack_gpu_w + overhead_w) / 1000.0, 2)
        gpu_kw = round(rack_gpu_w / 1000.0, 2)
        shelf_total += shelf_kw
        gpu_total_w += rack_gpu_w
        overhead_total_w += overhead_w
        at_cap += rack_cap
        n_on = GPUS_PER_RACK if not off else 0
        sp_sum += rack_sp
        sp_n += n_on

        rack_out.append(
            {
                "id": rid,
                "label": r.get("label") or _short(r.get("name") or ""),
                "name": r.get("name") or "",
                "hall_id": r.get("hall_id") or "",
                "power_state": "off" if off else "on",
                "enabled": enabled,
                "denied": denied,
                "hot": hot,
                "extra": bool(r.get("extra")),
                "shelf_kw": shelf_kw,
                "gpu_kw": gpu_kw,
                "overhead_kw": round(overhead_w / 1000.0, 2),
                "allocated_kw": round(alloc_kw, 1),
                "consumed_kw": round(used_kw, 1),
                "setpoint_w": round(rack_sp / n_on, 1) if n_on else 0.0,
                "gpus_at_cap": rack_cap,
            }
        )

    gpu_pool.sort(key=lambda g: (-g["watts"], g["id"]))
    for i, g in enumerate(gpu_pool, start=1):
        g["rank"] = i
    shown = gpu_pool if rack_id else gpu_pool[:top_n]
    rack_out.sort(key=lambda r: (-r["shelf_kw"], r["label"]))

    n_racks = len(rows)
    _HISTORY.append(
        {
            "t": round(now, 1),
            "gpu_kw": round(gpu_total_w / 1000.0, 1),
            "overhead_kw": round(overhead_total_w / 1000.0, 1),
            "shelf_kw": round(shelf_total, 1),
        }
    )
    del _HISTORY[:-_HISTORY_N]
    return {
        "topology": topology(n_racks),
        "mode": power_snap.get("mode"),
        "tick": power_snap.get("tick"),
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
        "totals": {
            "shelf_kw": round(shelf_total, 1),
            "gpu_kw": round(gpu_total_w / 1000.0, 1),
            "overhead_kw": round(overhead_total_w / 1000.0, 1),
            "hottest_w": round(hottest_w, 1),
            "avg_setpoint_w": round(sp_sum / sp_n, 1) if sp_n else 0.0,
            "gpus_at_cap": at_cap,
            "gpus_listed": len(shown),
            "gpus_total": n_racks * GPUS_PER_RACK if not rack_id else GPUS_PER_RACK,
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
            "static": power_snap.get("static"),
            "dynamic": power_snap.get("dynamic"),
            "active": power_snap.get("active"),
            "rack_policy_kw": power_snap.get("rack_policy_kw"),
            "rack_count": power_snap.get("rack_count"),
            "racks_on": power_snap.get("racks_on"),
            "racks_pool": power_snap.get("racks_pool"),
            "power_source": power_snap.get("power_source"),
            "stay_under_pct": power_snap.get("stay_under_pct"),
        },
    }
