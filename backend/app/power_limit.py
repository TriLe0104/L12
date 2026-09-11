"""Closed-loop rack power limiter (MaxLPS-style).

Default kW/rack = (total_power × threshold%) / rack_count, then clamped to
[min_rack, max_rack]. The loop steals from idle racks and feeds hot ones
inside that band. Total power is a manual input today; a smart-breaker
reading can replace it later.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

CLUSTER_MAX_KW = 135_000.0  # legacy demo ceiling; allocation is capped by envelope and max kW/rack
MAX_TOTAL_KW = 10_000_000.0  # 10 GW planning cap for typed total power
DEFAULT_MAX_RACK_KW = 300.0
DEFAULT_MIN_RACK_KW = 40.0
DEFAULT_STAY_UNDER_PCT = 80.0
REDUCE_GAP = 0.20
INCREASE_GAP = 0.05
TARGET_HEADROOM = 0.12
MIN_ALLOC_KW = 40.0
STEP_INTERVAL_S = 1.0
GPUS_PER_HOT_RACK = 8.0  # 64 GPU test → 8 racks at 100%
EXTRA_EPS_KW = 0.5


def _r(v: float) -> float:
    return round(max(0.0, v), 1)


def _short(name: str) -> str:
    import re

    m = re.search(r"R\d+C\d+$", name, re.I)
    if m:
        return m.group(0).upper()
    parts = name.split("-")
    return parts[-1] if parts else name


def rack_hard_kw() -> float:
    return STATE.max_rack_kw


def rack_min_kw() -> float:
    return min(STATE.min_rack_kw, STATE.max_rack_kw)


def _plan_n(n_on: int = 0) -> int:
    if STATE.rack_count and STATE.rack_count > 0:
        return int(STATE.rack_count)
    if n_on > 0:
        return int(n_on)
    if STATE.live_on > 0:
        return int(STATE.live_on)
    return 1


def threshold_pct() -> float:
    return max(0.01, min(STATE.stay_under_pct, 100.0))


def envelope_kw(n_on: int = 0) -> float:
    """Operating pool: total power × threshold%."""
    pct = threshold_pct() / 100.0
    if STATE.total_budget_kw is not None:
        return STATE.total_budget_kw * pct
    return _plan_n(n_on) * STATE.max_rack_kw * pct


def n_feed(n_on: int = 0) -> int:
    """How many racks the envelope can actually feed.

    Fair share is envelope / planned racks. If that is below min kW, drop racks
    so we do not run anyone at full max while the pool is short of power.
    """
    live = n_on or STATE.live_on
    want = _plan_n(live)
    env = envelope_kw(live)
    lo = rack_min_kw()
    cap = live if live > 0 else want
    if want <= 0:
        return max(1, cap)
    fair = env / want
    if lo > 0 and fair < lo:
        fit = int(env // lo)
        return max(1, min(fit, cap, want))
    return max(1, min(want, cap))


def rack_share_kw(n_on: int = 0) -> float:
    """Even split of the envelope across racks we will feed."""
    n = n_feed(n_on)
    if n <= 0:
        return 0.0
    return max(0.0, envelope_kw(n_on) / n)


def rack_policy_kw() -> float:
    """Default kW/rack = envelope / fed racks, then clamp to [min, max]."""
    lo, hi = rack_min_kw(), rack_hard_kw()
    return min(hi, max(lo, rack_share_kw()))


def pool_size(n_on: int = 0) -> int:
    if STATE.pool_ids:
        return len(STATE.pool_ids)
    live = n_on or STATE.live_on
    return n_feed(live) if live else n_feed()


def pick_pool_ids(samples: list[Sample], n: int) -> tuple[str, ...]:
    on = [s for s in samples if _on(s)]
    on.sort(key=lambda s: (not s.saturating, (s.run_status or "") != "running", s.name))
    return tuple(s.id for s in on[: max(0, n)])


def placeable_kw(n_on: int, n_fed: int | None = None) -> float:
    """Power that can actually sit on fed racks: min(envelope, n × max kW)."""
    n = n_fed if n_fed is not None else pool_size(n_on)
    if n <= 0:
        return 0.0
    return min(envelope_kw(n_on), n * rack_hard_kw())


def unplaced_budget_kw(n_on: int) -> float:
    """Envelope leftover that cannot land because every fed rack is at max."""
    return max(0.0, envelope_kw(n_on) - placeable_kw(n_on))


def min_alloc_kw() -> float:
    return max(8.0, rack_min_kw())


def hall_on_counts(samples: Iterable[Sample]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for s in samples:
        if _on(s):
            counts[s.hall_id] = counts.get(s.hall_id, 0) + 1
    return counts


def rack_share_for_hall(_n_on: int) -> float:
    return rack_policy_kw()


def rack_hard_for_hall(_n_on: int) -> float:
    return rack_hard_kw()


def hall_policy_kw(n_on: int) -> float:
    return n_on * rack_policy_kw()


def cluster_policy_budget(n_on: int) -> float:
    if n_on <= 0:
        return 0.0
    env = envelope_kw(n_on)
    if STATE.mode == "dynamic":
        return min(env, n_on * rack_hard_kw())
    n = pool_size(n_on)
    return min(env, n * rack_policy_kw(), n * rack_hard_kw())


def cluster_hard_budget(n_on: int) -> float:
    if n_on <= 0:
        return 0.0
    return n_on * rack_hard_kw()


def hot_rack_count(workloads: Iterable[Any]) -> int:
    n = 0
    for w in workloads:
        status = getattr(w, "status", None) or (w.get("status") if isinstance(w, dict) else "")
        if status != "running":
            continue
        gpu = getattr(w, "gpu_allocation", None) if not isinstance(w, dict) else w.get("gpu_allocation")
        req = getattr(w, "gpu_request", None) if not isinstance(w, dict) else w.get("gpu_request")
        g = int(gpu or req or 0)
        n += max(1, math.ceil(g / GPUS_PER_HOT_RACK)) if g else 0
    return n


def pick_hot_ids(rack_rows: list[Any], workloads: Iterable[Any]) -> set[str]:
    n = hot_rack_count(workloads)
    if n <= 0:
        return set()
    on = [
        r
        for r in rack_rows
        if (getattr(r, "power_state", None) or "on") != "off"
    ]
    on.sort(key=lambda r: ((getattr(r, "run_status", None) or "") != "running", getattr(r, "name", "") or ""))
    return {getattr(r, "id") for r in on[:n]}


@dataclass
class Sample:
    id: str
    name: str
    hall_id: str
    power_state: str
    run_status: str
    demand_kw: float
    saturating: bool = False


@dataclass
class RackAlloc:
    id: str
    name: str
    hall_id: str
    power_state: str
    run_status: str
    demand_kw: float
    consumed_kw: float
    allocated_kw: float
    unused_kw: float
    nameplate_kw: float
    enabled: bool
    denied: bool
    extra: bool
    hot: bool
    at_cap: bool
    action: str
    gap_pct: float | None


@dataclass
class LimiterState:
    mode: str = "dynamic"
    budget_kw: float | None = None
    alloc: dict[str, float] = field(default_factory=dict)
    action: dict[str, str] = field(default_factory=dict)
    tick: int = 0
    last_step: float = 0.0
    last_event: str = ""
    seeded: bool = False
    hot_ids: tuple[str, ...] = ()
    max_rack_kw: float = DEFAULT_MAX_RACK_KW
    min_rack_kw: float = DEFAULT_MIN_RACK_KW
    stay_under_pct: float = DEFAULT_STAY_UNDER_PCT
    total_budget_kw: float | None = None
    rack_count: int | None = None
    live_on: int = 0
    power_source: str = "manual"
    pool_ids: tuple[str, ...] = ()
    base_ids: tuple[str, ...] = ()


STATE = LimiterState()


def _on(sample: Sample) -> bool:
    return (sample.power_state or "on") != "off"


def _consumed(demand: float, allocated: float) -> float:
    if allocated <= 0:
        return 0.0
    return min(demand, allocated)


def rack_usage_pct(consumed: float) -> float:
    """Actual usage as a percent of the control-loop max kW (min is the floor, not 0%)."""
    hi = rack_hard_kw()
    if hi <= 0:
        return 0.0
    return _r(max(0.0, min(100.0, consumed / hi * 100.0)))


def _demand_kw(sample: Sample) -> float:
    if sample.saturating:
        return rack_hard_kw() * 1.05
    return sample.demand_kw


def static_plan(samples: list[Sample]) -> list[RackAlloc]:
    counts = hall_on_counts(samples)
    hard = rack_hard_kw()
    pool = set(STATE.base_ids or STATE.pool_ids)
    out: list[RackAlloc] = []
    for s in samples:
        n = counts.get(s.hall_id, 0)
        share = rack_share_for_hall(n)
        if not _on(s) or (pool and s.id not in pool):
            out.append(
                RackAlloc(
                    id=s.id,
                    name=s.name,
                    hall_id=s.hall_id,
                    power_state=s.power_state,
                    run_status=s.run_status,
                    demand_kw=0.0,
                    consumed_kw=0.0,
                    allocated_kw=0.0,
                    unused_kw=0.0,
                    nameplate_kw=_r(hard),
                    enabled=False,
                    denied=False,
                    extra=False,
                    hot=False,
                    at_cap=False,
                    action="off",
                    gap_pct=None,
                )
            )
            continue
        demand = _demand_kw(s)
        used = _consumed(demand, share)
        gap = (share - used) / share * 100 if share else None
        out.append(
            RackAlloc(
                id=s.id,
                name=s.name,
                hall_id=s.hall_id,
                power_state=s.power_state,
                run_status=s.run_status,
                demand_kw=_r(demand),
                consumed_kw=_r(used),
                allocated_kw=_r(share),
                unused_kw=_r(share - used),
                nameplate_kw=_r(hard),
                enabled=True,
                denied=False,
                extra=False,
                hot=s.saturating,
                at_cap=s.saturating or (gap is not None and gap < INCREASE_GAP * 100),
                action="hold",
                gap_pct=_r(gap) if gap is not None else None,
            )
        )
    return out


def _summarize(rows: list[RackAlloc], budget_kw: float, envelope: float | None = None) -> dict[str, Any]:
    enabled = [r for r in rows if r.enabled]
    denied = [r for r in rows if r.denied]
    extra = [r for r in rows if r.extra]
    consumed = sum(r.consumed_kw for r in rows)
    allocated = sum(r.allocated_kw for r in rows)
    stranded = sum(r.unused_kw for r in rows)
    actions = {"reduce": 0, "increase": 0, "hold": 0, "enable": 0, "deny": 0, "off": 0}
    for r in rows:
        actions[r.action] = actions.get(r.action, 0) + 1
    env = envelope if envelope is not None else budget_kw
    n_en = len(enabled)
    placed = placeable_kw(STATE.live_on, n_en)
    placed = max(placed, allocated)
    floating = max(0.0, placed - allocated)
    surplus = max(0.0, env - placed)
    return {
        "budget_kw": _r(budget_kw),
        "consumed_kw": _r(consumed),
        "allocated_kw": _r(allocated),
        "stranded_kw": _r(stranded),
        "headroom_kw": _r(max(0.0, budget_kw - allocated)),
        "racks_enabled": n_en,
        "racks_denied": len(denied),
        "racks_extra": len(extra),
        "racks_off": actions["off"],
        "racks_hot": sum(1 for r in rows if r.hot),
        "racks_at_cap": sum(1 for r in rows if r.at_cap),
        "used_kw": _r(consumed),
        "available_kw": _r(stranded),
        "floating_kw": _r(floating),
        "placeable_kw": _r(placed),
        "surplus_kw": _r(surplus),
        "actions": actions,
    }


def _dump_rack(r: RackAlloc) -> dict[str, Any]:
    return {
        "id": r.id,
        "name": r.name,
        "label": _short(r.name),
        "hall_id": r.hall_id,
        "power_state": r.power_state,
        "run_status": r.run_status,
        "demand_kw": r.demand_kw,
        "consumed_kw": r.consumed_kw,
        "allocated_kw": r.allocated_kw,
        "unused_kw": r.unused_kw,
        "nameplate_kw": r.nameplate_kw,
        "min_kw": _r(rack_min_kw()),
        "max_kw": _r(rack_hard_kw()),
        "usage_pct": rack_usage_pct(r.consumed_kw),
        "policy_kw": _r(rack_policy_kw()),
        "enabled": r.enabled,
        "denied": r.denied,
        "extra": r.extra,
        "hot": r.hot,
        "at_cap": r.at_cap,
        "action": r.action,
        "gap_pct": r.gap_pct,
    }


def _rows_from_alloc(
    samples: list[Sample],
    alloc: dict[str, float],
    action: dict[str, str],
    counts: dict[str, int],
) -> list[RackAlloc]:
    rows: list[RackAlloc] = []
    hard = rack_hard_kw()
    policy = rack_policy_kw()
    for s in samples:
        a = alloc.get(s.id, 0.0)
        if not _on(s) or (STATE.pool_ids and s.id not in STATE.pool_ids):
            a = 0.0
        demand = _demand_kw(s)
        used = _consumed(demand, a)
        enabled = a > 0
        denied = _on(s) and not enabled
        gap = (a - used) / a * 100 if a else None
        act = action.get(s.id) or ("off" if not _on(s) else ("deny" if denied else "hold"))
        rows.append(
            RackAlloc(
                id=s.id,
                name=s.name,
                hall_id=s.hall_id,
                power_state=s.power_state,
                run_status=s.run_status,
                demand_kw=_r(demand),
                consumed_kw=_r(used),
                allocated_kw=_r(a),
                unused_kw=_r(a - used),
                nameplate_kw=_r(hard),
                enabled=enabled,
                denied=denied,
                extra=enabled and (a > policy + EXTRA_EPS_KW or (STATE.base_ids and s.id not in STATE.base_ids)),
                hot=s.saturating,
                at_cap=s.saturating or (gap is not None and gap < INCREASE_GAP * 100),
                action=act,
                gap_pct=_r(gap) if gap is not None else None,
            )
        )
    return rows


def _seed_from_static(static_rows: list[RackAlloc]) -> None:
    STATE.alloc = {r.id: r.allocated_kw for r in static_rows}
    STATE.action = {r.id: r.action for r in static_rows}
    STATE.seeded = True
    STATE.tick = 0
    avg = next((r.allocated_kw for r in static_rows if r.enabled), 0.0)
    n = _plan_n()
    STATE.last_event = (
        f"Default {avg:.0f} kW/rack · {n} racks · envelope {envelope_kw():.0f} kW · "
        f"[{rack_min_kw():.0f}–{STATE.max_rack_kw:.0f}] kW"
    )
    STATE.last_step = 0.0


def _step(samples: list[Sample], budget_kw: float) -> float:
    live_ids = {s.id for s in samples}
    for rid in list(STATE.alloc):
        if rid not in live_ids:
            STATE.alloc.pop(rid, None)
            STATE.action.pop(rid, None)
    by_id = {s.id: s for s in samples}
    counts = hall_on_counts(samples)
    halls: dict[str, list[str]] = {}
    for s in samples:
        if _on(s):
            halls.setdefault(s.hall_id, []).append(s.id)
        else:
            STATE.alloc[s.id] = 0.0
            STATE.action[s.id] = "off"

    pool = set(STATE.pool_ids)
    if pool:
        for s in samples:
            if s.id not in pool:
                STATE.alloc[s.id] = 0.0
                STATE.action[s.id] = "off" if not _on(s) else "out"
        halls = {h: [i for i in ids if i in pool] for h, ids in halls.items()}
        halls = {h: ids for h, ids in halls.items() if ids}

    held_hot = 0
    hot_total = 0

    floor = min_alloc_kw()
    boosted = 0
    for hall_id, on_ids in halls.items():
        policy = rack_policy_kw()
        hard = rack_hard_kw()
        hall_budget = hall_policy_kw(len(on_ids))
        for rid in on_ids:
            if rid not in STATE.alloc:
                STATE.alloc[rid] = policy
            else:
                STATE.alloc[rid] = min(max(STATE.alloc[rid], floor), hard)

        reduce_ids: list[str] = []
        increase_ids: list[str] = []
        hold_ids: list[str] = []
        for rid in on_ids:
            alloc = STATE.alloc.get(rid, 0.0)
            if alloc <= 0:
                continue
            s = by_id[rid]
            used = alloc if s.saturating else _consumed(s.demand_kw, alloc)
            gap = (alloc - used) / alloc if alloc else 1.0
            if s.saturating or gap < INCREASE_GAP:
                increase_ids.append(rid)
            elif gap > REDUCE_GAP:
                reduce_ids.append(rid)
            else:
                hold_ids.append(rid)

        for rid in reduce_ids:
            alloc = STATE.alloc[rid]
            used = _consumed(by_id[rid].demand_kw, alloc)
            target = max(floor, used / (1.0 - TARGET_HEADROOM) if used else floor)
            delta = min(max(abs(alloc - target) * 0.45, 8.0), alloc * 0.25, max(0.0, alloc - floor))
            STATE.alloc[rid] = max(target, alloc - max(delta, 0.0))
            STATE.action[rid] = "reduce"

        pool = hall_budget - sum(STATE.alloc.get(rid, 0.0) for rid in on_ids)
        sat_ids = [rid for rid in increase_ids if by_id[rid].saturating]
        rest_ids = [rid for rid in increase_ids if not by_id[rid].saturating]
        hot_total += len(sat_ids)
        if sat_ids and pool > 0:
            slice_kw = pool / len(sat_ids)
            for rid in sat_ids:
                alloc = STATE.alloc[rid]
                room_rack = max(0.0, hard - alloc)
                take = min(max(alloc * 0.18, 12.0), slice_kw, pool, room_rack)
                if take <= 0:
                    STATE.action[rid] = "hold"
                    held_hot += 1
                    continue
                STATE.alloc[rid] = alloc + take
                pool -= take
                STATE.action[rid] = "increase"
                boosted += 1
        elif sat_ids:
            for rid in sat_ids:
                STATE.action[rid] = "hold"
            held_hot += len(sat_ids)
        for rid in rest_ids:
            alloc = STATE.alloc[rid]
            s = by_id[rid]
            used = _consumed(s.demand_kw, alloc)
            target = max(alloc, min(hard, used / (1.0 - TARGET_HEADROOM) if used else alloc))
            if pool <= 0.5:
                STATE.action[rid] = "hold"
                continue
            delta = min(max(target - alloc, 0.0), max(alloc * 0.18, 12.0), pool, max(0.0, hard - alloc))
            if delta <= 0:
                STATE.action[rid] = "hold"
                continue
            STATE.alloc[rid] = alloc + delta
            pool -= delta
            STATE.action[rid] = "increase"
            boosted += 1
        for rid in hold_ids:
            STATE.action[rid] = "hold"

        total = sum(STATE.alloc.get(rid, 0.0) for rid in on_ids)
        if total > hall_budget + 0.05 and total > 0:
            overflow = total - hall_budget
            slack = [rid for rid in on_ids if not by_id[rid].saturating and STATE.alloc.get(rid, 0.0) > floor]
            slack.sort(key=lambda rid: -STATE.alloc.get(rid, 0.0))
            for rid in slack:
                if overflow <= 0:
                    break
                take = min(overflow, STATE.alloc[rid] - floor)
                STATE.alloc[rid] -= take
                overflow -= take
                STATE.action[rid] = "reduce"
            if overflow > 0:
                scale = hall_budget / max(sum(STATE.alloc.get(rid, 0.0) for rid in on_ids), 1.0)
                for rid in on_ids:
                    STATE.alloc[rid] *= scale
                STATE.last_event = (
                    f"Clamped hall to {rack_policy_kw():.0f} kW/rack · cap {STATE.max_rack_kw:.0f} kW"
                )

    added = _enable_extras(samples)
    if added:
        STATE.last_event = (
            f"Enabled {added} extra racks from leftover envelope · "
            f"{len(STATE.pool_ids)} racks in pool"
        )
    elif boosted:
        STATE.last_event = (
            f"Reallocated slack to {boosted} racks · share {rack_policy_kw():.0f} kW · "
            f"cap {STATE.max_rack_kw:.0f} kW"
        )
    elif hot_total and held_hot == hot_total:
        STATE.last_event = (
            f"Held {hot_total} hot racks at {STATE.max_rack_kw:.0f} kW cap · "
            f"share {rack_policy_kw():.0f} kW/rack"
        )

    STATE.tick += 1
    return min(budget_kw, cluster_policy_budget(STATE.live_on))


def _enable_extras(samples: list[Sample]) -> int:
    """Spend leftover envelope on more racks instead of leaving it floating."""
    floor = min_alloc_kw()
    policy = rack_policy_kw()
    hard = rack_hard_kw()
    leftover = envelope_kw(STATE.live_on) - sum(STATE.alloc.get(s.id, 0.0) for s in samples if _on(s))
    if leftover < floor:
        return 0
    have = set(STATE.pool_ids)
    cand = [s for s in samples if _on(s) and s.id not in have]
    cand.sort(key=lambda s: ((s.run_status or "") != "running", s.name))
    added = 0
    pool = list(STATE.pool_ids)
    for s in cand:
        if leftover < floor:
            break
        take = min(hard, leftover, max(policy, floor))
        if take < floor:
            break
        STATE.alloc[s.id] = take
        STATE.action[s.id] = "enable"
        pool.append(s.id)
        leftover -= take
        added += 1
        if added >= 48:
            break
    STATE.pool_ids = tuple(pool)
    return added


def _wobble(demand: float, rack_id: str, now: float) -> float:
    seed = sum(ord(c) for c in rack_id) % 17
    return max(0.0, demand * (1.0 + 0.045 * math.sin(now / 6.5 + seed)))


def _showcase(static_rows: list[RackAlloc], dynamic_rows: list[RackAlloc]) -> list[dict[str, Any]]:
    dyn = {r.id: r for r in dynamic_rows}
    hot = [r for r in dynamic_rows if r.hot]
    hot.sort(key=lambda r: -r.consumed_kw)
    idle = [r for r in dynamic_rows if r.enabled and not r.hot]
    idle.sort(key=lambda r: r.consumed_kw)
    picks: list[RackAlloc] = hot[:3]
    for r in idle[: max(0, 5 - len(picks))]:
        picks.append(r)
    if len(picks) < 5:
        rest = [r for r in static_rows if r.enabled and r.id not in {p.id for p in picks}]
        picks.extend(rest[: 5 - len(picks)])
    slots: list[dict[str, Any]] = []
    for r in picks[:5]:
        d = dyn.get(r.id)
        srow = next((x for x in static_rows if x.id == r.id), r)
        slots.append(
            {
                "id": r.id,
                "name": r.name,
                "label": _short(r.name),
                "additional": bool(d.hot) if d else False,
                "static": _dump_rack(srow),
                "dynamic": _dump_rack(d) if d else _dump_rack(r),
            }
        )
    return slots


def apply_patch(
    mode: str | None = None,
    budget_kw: float | None = None,
    reset: bool = False,
    auto_budget_flag: bool = False,
    max_rack_kw: float | None = None,
    max_hall_kw: float | None = None,
    stay_under_pct: float | None = None,
    max_pod_kw: float | None = None,
    total_budget_kw: float | None = None,
    rack_count: int | None = None,
    min_rack_kw: float | None = None,
) -> None:
    if mode in ("static", "dynamic"):
        if mode == "dynamic" and STATE.mode != "dynamic":
            reset = True
        STATE.mode = mode
    if max_rack_kw is not None:
        STATE.max_rack_kw = max(20.0, min(2_000.0, float(max_rack_kw)))
        reset = True
    elif max_hall_kw is not None:
        STATE.max_rack_kw = max(20.0, min(2_000.0, float(max_hall_kw) / 64.0))
        reset = True
    elif max_pod_kw is not None:
        STATE.max_rack_kw = max(20.0, min(2_000.0, float(max_pod_kw) * 4))
        reset = True
    if min_rack_kw is not None:
        STATE.min_rack_kw = max(8.0, min(2_000.0, float(min_rack_kw)))
        reset = True
    if STATE.min_rack_kw > STATE.max_rack_kw:
        STATE.min_rack_kw = STATE.max_rack_kw
    if rack_count is not None:
        STATE.rack_count = max(1, min(2_000, int(rack_count)))
        reset = True
    if total_budget_kw is not None:
        STATE.total_budget_kw = min(MAX_TOTAL_KW, max(100.0, float(total_budget_kw)))
        reset = True
    elif budget_kw is not None and total_budget_kw is None:
        STATE.total_budget_kw = min(MAX_TOTAL_KW, max(100.0, float(budget_kw)))
        reset = True
    if stay_under_pct is not None:
        STATE.stay_under_pct = max(10.0, min(100.0, float(stay_under_pct)))
        reset = True
    if auto_budget_flag:
        STATE.total_budget_kw = None
        STATE.budget_kw = None
        STATE.rack_count = None
        reset = True
    if reset:
        STATE.seeded = False
        STATE.alloc.clear()
        STATE.action.clear()
        STATE.tick = 0
        STATE.budget_kw = None
        n = _plan_n()
        STATE.last_event = (
            f"Default {rack_policy_kw():.0f} kW/rack · {n} racks · "
            f"{threshold_pct():.0f}% of total · [{rack_min_kw():.0f}–{STATE.max_rack_kw:.0f}] kW"
        )
        STATE.last_step = 0.0


def snapshot(samples: Iterable[dict[str, Any]] | Iterable[Sample]) -> dict[str, Any]:
    now = time.time()
    parsed: list[Sample] = []
    for raw in samples:
        if isinstance(raw, Sample):
            s = raw
        else:
            s = Sample(
                id=raw["id"],
                name=raw["name"],
                hall_id=raw.get("hall_id") or "",
                power_state=raw.get("power_state") or "on",
                run_status=raw.get("run_status") or "ready",
                demand_kw=float(raw.get("demand_kw") or 0.0),
                saturating=bool(raw.get("saturating")),
            )
        if not s.saturating:
            s.demand_kw = _wobble(s.demand_kw, s.id, now)
        parsed.append(s)

    counts = hall_on_counts(parsed)
    n_halls = len(counts)
    n_on = sum(counts.values())
    STATE.live_on = n_on
    base = pick_pool_ids(parsed, n_feed(n_on))
    STATE.base_ids = base
    if not STATE.seeded:
        STATE.pool_ids = base
    else:
        live = {s.id for s in parsed if _on(s)}
        kept = tuple(i for i in STATE.pool_ids if i in live)
        STATE.pool_ids = kept or base
    share = rack_policy_kw()
    policy_budget = cluster_policy_budget(n_on)
    hard_budget = cluster_hard_budget(n_on)
    budget = policy_budget
    static_rows = static_plan(parsed)

    hot_now = tuple(sorted(s.id for s in parsed if s.saturating))
    if hot_now != STATE.hot_ids:
        STATE.hot_ids = hot_now
        if hot_now:
            STATE.last_event = f"Test saturating {len(hot_now)} racks at cap"
        elif STATE.seeded:
            STATE.last_event = "Tests stopped · reclaiming slack"

    if not STATE.seeded:
        _seed_from_static(static_rows)
    else:
        for r in static_rows:
            if r.id not in STATE.alloc:
                STATE.alloc[r.id] = r.allocated_kw
                STATE.action[r.id] = r.action

    if STATE.mode == "dynamic" and now - STATE.last_step >= STEP_INTERVAL_S:
        budget = _step(parsed, budget)
        STATE.last_step = now

    dynamic_rows = _rows_from_alloc(parsed, STATE.alloc, STATE.action, counts)
    active_rows = static_rows if STATE.mode == "static" else dynamic_rows
    planned = _plan_n(n_on)
    total = STATE.total_budget_kw if STATE.total_budget_kw is not None else (planned * STATE.max_rack_kw)
    env = envelope_kw(n_on)
    stay = threshold_pct()
    static_sum = _summarize(static_rows, policy_budget, env)
    dynamic_sum = _summarize(dynamic_rows, budget, env)
    active_sum = static_sum if STATE.mode == "static" else dynamic_sum
    return {
        "mode": STATE.mode,
        "budget_kw": _r(budget if STATE.mode == "dynamic" else policy_budget),
        "auto_budget": STATE.total_budget_kw is None,
        "nameplate_kw": _r(hard_budget),
        "tdp_kw": _r(share),
        "default_budget_kw": _r(policy_budget),
        "max_budget_kw": _r(hard_budget),
        "total_budget_kw": _r(total),
        "envelope_kw": _r(env),
        "placeable_kw": _r(placeable_kw(n_on, len(STATE.pool_ids))),
        "surplus_kw": _r(unplaced_budget_kw(n_on)),
        "unplaced_budget_kw": _r(unplaced_budget_kw(n_on)),
        "max_rack_kw": _r(STATE.max_rack_kw),
        "min_rack_kw": _r(rack_min_kw()),
        "stay_under_pct": _r(stay),
        "threshold_pct": _r(stay),
        "power_source": STATE.power_source,
        "halls": n_halls,
        "rack_count": planned,
        "rack_count_auto": STATE.rack_count is None,
        "racks_on": n_on,
        "racks_pool": len(STATE.pool_ids),
        "rack_avg_kw": _r(rack_policy_kw()),
        "rack_policy_kw": _r(rack_policy_kw()),
        "rack_share_kw": _r(rack_share_kw(n_on)),
        "rack_hard_kw": _r(rack_hard_kw()),
        "policy": {
            "reduce_gap_pct": int(REDUCE_GAP * 100),
            "increase_gap_pct": int(INCREASE_GAP * 100),
            "target_headroom_pct": int(max(0.0, 100.0 - stay)),
            "enable_per_tick": 0,
            "min_rack_kw": _r(rack_min_kw()),
            "max_rack_kw": _r(STATE.max_rack_kw),
            "stay_under_pct": _r(stay),
            "threshold_pct": _r(stay),
            "rack_avg_kw": _r(rack_policy_kw()),
            "rack_count": planned,
            "total_budget_kw": _r(total),
            "envelope_kw": _r(env),
            "max_mw": MAX_TOTAL_KW / 1000.0,
        },
        "tick": STATE.tick,
        "last_event": STATE.last_event,
        "static": static_sum,
        "dynamic": dynamic_sum,
        "active": active_sum,
        "showcase": _showcase(static_rows, dynamic_rows),
        "racks": [_dump_rack(r) for r in active_rows],
        "static_racks": [_dump_rack(r) for r in static_rows if r.enabled],
        "dynamic_racks": [_dump_rack(r) for r in dynamic_rows if r.enabled],
    }
