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


GPU_POWER_PERCENT = 0.86
DESIRED_CAP_PERCENT = 0.80  # usage should sit at this fraction of the posted cap
_HISTORY: list[dict[str, float]] = []
_HISTORY_N = 48


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


def _usage_w(activity: float) -> float:
    a = max(0.0, min(1.0, activity))
    return GPU_IDLE_W + (GPU_TDP_W - GPU_IDLE_W) * a


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
    idle, tdp = GPU_IDLE_W, GPU_TDP_W
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
    top: int = 0,
    rack_id: str | None = None,
) -> dict[str, Any]:
    now = time.time()
    rows = power_snap.get("racks") or []
    lo_kw = float(power_snap.get("min_rack_kw") or 40.0)
    hi_kw = float(power_snap.get("max_rack_kw") or 135.0)
    min_w = GPU_IDLE_W
    tdp_w = GPU_TDP_W
    power_budget_w = float(power_snap.get("total_budget_kw") or 0.0) * 1000.0
    if power_budget_w <= 0:
        power_budget_w = float(power_snap.get("envelope_kw") or 0.0) * 1000.0
    grace = max(0.01, min(1.0, float(power_snap.get("stay_under_pct") or power_snap.get("threshold_pct") or 80.0) / 100.0))
    max_allowable_w = power_budget_w * grace * GPU_POWER_PERCENT

    records: list[dict[str, Any]] = []
    usages: list[float] = []
    overhead_total_w = 0.0
    shelf_pre = 0.0

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
        load = 0.0 if off else min(1.0, used_kw / max(alloc_kw, hi_kw, 1.0))
        overhead_w = 0.0 if off else NODES_PER_RACK * NODE_OH_W * (0.35 + 0.65 * load) + SHELF_OH_W
        overhead_total_w += overhead_w
        rack_usage = 0.0
        for n in range(1, NODES_PER_RACK + 1):
            for g in range(1, GPUS_PER_NODE + 1):
                gid = f"{rid}-n{n:02d}-g{g}"
                act = 0.0 if off else _activity(gid, now, hot, run_status)
                u = 0.0 if off else _usage_w(act)
                usages.append(u)
                records.append(
                    {
                        "id": gid,
                        "rack_id": rid,
                        "rack_label": label,
                        "hall_id": hall_id,
                        "node": n,
                        "gpu": g,
                        "usage": u,
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
                rack_usage += u
        shelf_pre += rack_usage + overhead_w

    caps, best_p = _post_caps(usages, max_allowable_w, DESIRED_CAP_PERCENT)

    gpu_pool: list[dict[str, Any]] = []
    rack_acc: dict[str, dict[str, Any]] = {}
    gpu_total_w = 0.0
    cap_total_w = 0.0
    at_cap = 0
    hottest_w = 0.0
    sp_sum = 0.0
    sp_n = 0

    for rec, u, cap in zip(records, usages, caps):
        watts = round(min(u, cap), 1)
        sp = round(cap, 1)
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
            gpu_pool.append(
                {
                    "id": rec["id"],
                    "rack_id": rec["rack_id"],
                    "rack_label": rec["rack_label"],
                    "hall_id": rec["hall_id"],
                    "node": rec["node"],
                    "gpu": rec["gpu"],
                    "watts": watts,
                    "setpoint_w": sp,
                    "tdp_w": tdp_w,
                    "min_w": round(min_w, 1),
                    "max_w": tdp_w,
                    "pct_limit": round((watts / sp * 100.0) if sp > 1 else 0.0, 1),
                    "pct_tdp": round(watts / tdp_w * 100.0, 1),
                    "hot": rec["hot_rack"] and rec["act"] >= 0.5,
                    "enabled": rec["enabled"],
                }
            )
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
        shelf_kw = gpu_kw + oh_kw
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
                "shelf_kw": round(shelf_kw, 2),
                "gpu_kw": round(gpu_kw, 2),
                "overhead_kw": round(oh_kw, 2),
                "allocated_kw": round(acc["alloc_kw"], 1),
                "consumed_kw": round(shelf_kw, 1),
                "setpoint_w": round(acc["cap_w"] / n_on, 1) if n_on else 0.0,
                "gpus_at_cap": acc["gpus_at_cap"],
            }
        )

    gpu_pool.sort(key=lambda g: (-g["watts"], g["id"]))
    for i, g in enumerate(gpu_pool, start=1):
        g["rank"] = i
    shown = gpu_pool if (not top or rack_id) else gpu_pool[: max(8, min(int(top), len(gpu_pool)))]
    rack_out.sort(key=lambda r: (-r["shelf_kw"], r["label"]))

    n_racks = len(rows)
    _HISTORY.append(
        {
            "t": round(now, 1),
            "gpu_kw": round(gpu_total_w / 1000.0, 1),
            "overhead_kw": round(overhead_total_w / 1000.0, 1),
            "shelf_kw": round(shelf_total, 1),
            "cap_kw": round(cap_total_w / 1000.0, 1),
            "allowable_kw": round(max_allowable_w / 1000.0, 1),
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
            "cap_kw": round(cap_total_w / 1000.0, 1),
            "allowable_kw": round(max_allowable_w / 1000.0, 1),
            "best_cap_percent": round(best_p * 100.0, 2),
        },
        "algo": {
            "power_budget_w": round(power_budget_w, 0),
            "budget_grace": round(grace * 100.0, 1),
            "gpu_power_percent": round(GPU_POWER_PERCENT * 100.0, 1),
            "desired_cap_percent": round(DESIRED_CAP_PERCENT * 100.0, 1),
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
