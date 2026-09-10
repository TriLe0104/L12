"""Closed-loop rack power limiter (MaxLPS-style).

Static reservation gives every powered rack its nameplate, so unused headroom
is stranded and leftover racks get no budget. The dynamic loop reclaims slack
(>20% unused allocation), tops up racks near the cap (<5% unused), then spends
leftover DC budget to enable one extra rack per tick — always staying inside
the hall budget.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

TDP_KW = 120.0
AUTO_BUDGET_FRAC = 0.72
REDUCE_GAP = 0.20
INCREASE_GAP = 0.05
TARGET_HEADROOM = 0.12
MIN_ALLOC_KW = 18.0
STEP_INTERVAL_S = 1.0
ENABLE_PER_TICK = 1


def _r(v: float) -> float:
    return round(max(0.0, v), 1)


def _short(name: str) -> str:
    import re

    m = re.search(r"R\d+C\d+$", name, re.I)
    if m:
        return m.group(0).upper()
    parts = name.split("-")
    return parts[-1] if parts else name


@dataclass
class Sample:
    id: str
    name: str
    hall_id: str
    power_state: str
    run_status: str
    demand_kw: float


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


STATE = LimiterState()


def _on(sample: Sample) -> bool:
    return (sample.power_state or "on") != "off"


def auto_budget(n_on: int, tdp: float = TDP_KW) -> float:
    if n_on <= 0:
        return 0.0
    return _r(max(tdp, n_on * tdp * AUTO_BUDGET_FRAC))


def _consumed(demand: float, allocated: float) -> float:
    if allocated <= 0:
        return 0.0
    return min(demand, allocated)


def _target_alloc(demand: float) -> float:
    if demand <= 0:
        return MIN_ALLOC_KW
    return min(TDP_KW, max(MIN_ALLOC_KW, demand / (1.0 - TARGET_HEADROOM)))


def static_plan(samples: list[Sample], budget_kw: float) -> list[RackAlloc]:
    on = [s for s in samples if _on(s)]
    off = [s for s in samples if not _on(s)]
    on.sort(key=lambda s: s.name)
    n_fit = int(budget_kw // TDP_KW) if TDP_KW > 0 else 0
    out: list[RackAlloc] = []
    for i, s in enumerate(on):
        enabled = i < n_fit
        alloc = TDP_KW if enabled else 0.0
        used = _consumed(s.demand_kw, alloc)
        out.append(
            RackAlloc(
                id=s.id,
                name=s.name,
                hall_id=s.hall_id,
                power_state=s.power_state,
                run_status=s.run_status,
                demand_kw=_r(s.demand_kw),
                consumed_kw=_r(used),
                allocated_kw=_r(alloc),
                unused_kw=_r(alloc - used),
                nameplate_kw=TDP_KW,
                enabled=enabled,
                denied=not enabled,
                extra=False,
                action="hold" if enabled else "deny",
                gap_pct=_r((alloc - used) / alloc * 100) if alloc else None,
            )
        )
    for s in off:
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
                nameplate_kw=TDP_KW,
                enabled=False,
                denied=False,
                extra=False,
                action="off",
                gap_pct=None,
            )
        )
    return out


def _summarize(rows: list[RackAlloc], budget_kw: float, static_enabled: set[str] | None = None) -> dict[str, Any]:
    enabled = [r for r in rows if r.enabled]
    denied = [r for r in rows if r.denied]
    extra = [r for r in rows if r.extra]
    consumed = sum(r.consumed_kw for r in rows)
    allocated = sum(r.allocated_kw for r in rows)
    stranded = sum(r.unused_kw for r in rows)
    actions = {"reduce": 0, "increase": 0, "hold": 0, "enable": 0, "deny": 0, "off": 0}
    for r in rows:
        actions[r.action] = actions.get(r.action, 0) + 1
    return {
        "budget_kw": _r(budget_kw),
        "consumed_kw": _r(consumed),
        "allocated_kw": _r(allocated),
        "stranded_kw": _r(stranded),
        "headroom_kw": _r(max(0.0, budget_kw - allocated)),
        "racks_enabled": len(enabled),
        "racks_denied": len(denied),
        "racks_extra": len(extra),
        "racks_off": actions["off"],
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
        "enabled": r.enabled,
        "denied": r.denied,
        "extra": r.extra,
        "action": r.action,
        "gap_pct": r.gap_pct,
    }


def _rows_from_alloc(samples: list[Sample], alloc: dict[str, float], action: dict[str, str], static_ids: set[str]) -> list[RackAlloc]:
    rows: list[RackAlloc] = []
    for s in samples:
        a = alloc.get(s.id, 0.0)
        if not _on(s):
            a = 0.0
        used = _consumed(s.demand_kw, a)
        enabled = a > 0
        denied = _on(s) and not enabled
        extra = enabled and s.id not in static_ids
        act = action.get(s.id) or ("off" if not _on(s) else ("deny" if denied else "hold"))
        rows.append(
            RackAlloc(
                id=s.id,
                name=s.name,
                hall_id=s.hall_id,
                power_state=s.power_state,
                run_status=s.run_status,
                demand_kw=_r(s.demand_kw),
                consumed_kw=_r(used),
                allocated_kw=_r(a),
                unused_kw=_r(a - used),
                nameplate_kw=TDP_KW,
                enabled=enabled,
                denied=denied,
                extra=extra,
                action=act,
                gap_pct=_r((a - used) / a * 100) if a else None,
            )
        )
    return rows


def _seed_from_static(samples: list[Sample], static_rows: list[RackAlloc]) -> None:
    STATE.alloc = {r.id: r.allocated_kw for r in static_rows}
    STATE.action = {r.id: r.action for r in static_rows}
    STATE.seeded = True
    STATE.tick = 0
    STATE.last_event = "Seeded from static reservation"
    STATE.last_step = 0.0


def _step(samples: list[Sample], budget_kw: float, _static_ids: set[str]) -> None:
    live_ids = {s.id for s in samples}
    for rid in list(STATE.alloc):
        if rid not in live_ids:
            STATE.alloc.pop(rid, None)
            STATE.action.pop(rid, None)
    for s in samples:
        if s.id not in STATE.alloc:
            STATE.alloc[s.id] = 0.0

    by_id = {s.id: s for s in samples}
    on_ids = [s.id for s in samples if _on(s)]

    # Classify using current caps.
    reduce_ids: list[str] = []
    increase_ids: list[str] = []
    hold_ids: list[str] = []
    for rid in on_ids:
        alloc = STATE.alloc.get(rid, 0.0)
        if alloc <= 0:
            continue
        used = _consumed(by_id[rid].demand_kw, alloc)
        gap = (alloc - used) / alloc if alloc else 1.0
        if gap > REDUCE_GAP:
            reduce_ids.append(rid)
        elif gap < INCREASE_GAP:
            increase_ids.append(rid)
        else:
            hold_ids.append(rid)

    for rid in reduce_ids:
        alloc = STATE.alloc[rid]
        target = _target_alloc(_consumed(by_id[rid].demand_kw, alloc))
        delta = min(max(abs(alloc - target) * 0.4, 5.0), 20.0)
        STATE.alloc[rid] = max(target, alloc - delta)
        STATE.action[rid] = "reduce"

    pool = budget_kw - sum(STATE.alloc.get(rid, 0.0) for rid in on_ids)

    increase_ids.sort(key=lambda rid: STATE.alloc.get(rid, 0.0) - _consumed(by_id[rid].demand_kw, STATE.alloc.get(rid, 0.0)))
    for rid in increase_ids:
        if pool <= 0.5:
            STATE.action[rid] = "hold"
            continue
        alloc = STATE.alloc[rid]
        target = min(TDP_KW, _target_alloc(by_id[rid].demand_kw))
        if target <= alloc:
            STATE.action[rid] = "hold"
            continue
        delta = min(max((target - alloc) * 0.45, 4.0), 16.0, pool)
        STATE.alloc[rid] = alloc + delta
        pool -= delta
        STATE.action[rid] = "increase"

    for rid in hold_ids:
        STATE.action[rid] = "hold"

    # Compliance clamp.
    total = sum(STATE.alloc.get(rid, 0.0) for rid in on_ids)
    if total > budget_kw + 0.05 and total > 0:
        scale = budget_kw / total
        for rid in on_ids:
            STATE.alloc[rid] = STATE.alloc.get(rid, 0.0) * scale
        pool = 0.0
        STATE.last_event = "Clamped allocations to DC budget"

    pool = max(0.0, budget_kw - sum(STATE.alloc.get(rid, 0.0) for rid in on_ids))

    enabled_this = 0
    denied = [rid for rid in on_ids if STATE.alloc.get(rid, 0.0) <= 0]
    denied.sort(key=lambda rid: by_id[rid].name)
    for rid in denied:
        if enabled_this >= ENABLE_PER_TICK:
            STATE.action[rid] = "deny"
            continue
        grant = min(TDP_KW, max(MIN_ALLOC_KW, _target_alloc(by_id[rid].demand_kw)), pool)
        if grant < MIN_ALLOC_KW:
            STATE.action[rid] = "deny"
            continue
        STATE.alloc[rid] = grant
        pool -= grant
        STATE.action[rid] = "enable"
        enabled_this += 1
        STATE.last_event = f"Enabled {_short(by_id[rid].name)} · +{grant:.0f} kW"

    for s in samples:
        if not _on(s):
            STATE.alloc[s.id] = 0.0
            STATE.action[s.id] = "off"

    STATE.tick += 1


def _wobble(demand: float, rack_id: str, now: float) -> float:
    seed = sum(ord(c) for c in rack_id) % 17
    return max(0.0, demand * (1.0 + 0.045 * math.sin(now / 6.5 + seed)))


def _showcase(static_rows: list[RackAlloc], dynamic_rows: list[RackAlloc]) -> list[dict[str, Any]]:
    dyn = {r.id: r for r in dynamic_rows}
    static_on = [r for r in static_rows if r.enabled]
    static_on.sort(key=lambda r: -r.consumed_kw)
    extras = [r for r in dynamic_rows if r.extra]
    extras.sort(key=lambda r: r.name)
    picks: list[RackAlloc] = []
    if static_on:
        n = len(static_on)
        idxs = sorted({0, n // 3, (2 * n) // 3, n - 1})
        picks = [static_on[i] for i in idxs][:4]
    extra = extras[0] if extras else next((r for r in static_rows if r.denied), None)
    slots: list[dict[str, Any]] = []
    for r in picks:
        d = dyn.get(r.id)
        slots.append(
            {
                "id": r.id,
                "name": r.name,
                "label": _short(r.name),
                "static": _dump_rack(r),
                "dynamic": _dump_rack(d) if d else _dump_rack(r),
            }
        )
    if extra is not None:
        srow = next((r for r in static_rows if r.id == extra.id), extra)
        drow = dyn.get(extra.id, extra)
        slots.append(
            {
                "id": extra.id,
                "name": extra.name,
                "label": _short(extra.name),
                "static": _dump_rack(srow),
                "dynamic": _dump_rack(drow),
                "additional": True,
            }
        )
    return slots[:5]


def apply_patch(mode: str | None = None, budget_kw: float | None = None, reset: bool = False, auto_budget_flag: bool = False) -> None:
    if mode in ("static", "dynamic"):
        if mode == "dynamic" and STATE.mode != "dynamic":
            reset = True
        STATE.mode = mode
    if auto_budget_flag:
        STATE.budget_kw = None
    elif budget_kw is not None:
        STATE.budget_kw = max(TDP_KW, float(budget_kw))
    if reset:
        STATE.seeded = False
        STATE.alloc.clear()
        STATE.action.clear()
        STATE.tick = 0
        STATE.last_event = "Reset to static reservation"
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
            )
        s.demand_kw = _wobble(s.demand_kw, s.id, now)
        parsed.append(s)

    n_on = sum(1 for s in parsed if _on(s))
    budget = STATE.budget_kw if STATE.budget_kw is not None else auto_budget(n_on)
    static_rows = static_plan(parsed, budget)
    static_ids = {r.id for r in static_rows if r.enabled}

    if not STATE.seeded or set(STATE.alloc) != {s.id for s in parsed}:
        # Keep existing alloc for known ids; seed only missing.
        if not STATE.seeded:
            _seed_from_static(parsed, static_rows)
        else:
            for r in static_rows:
                if r.id not in STATE.alloc:
                    STATE.alloc[r.id] = r.allocated_kw
                    STATE.action[r.id] = r.action

    if STATE.mode == "dynamic" and now - STATE.last_step >= STEP_INTERVAL_S:
        _step(parsed, budget, static_ids)
        STATE.last_step = now

    dynamic_rows = _rows_from_alloc(parsed, STATE.alloc, STATE.action, static_ids)
    active_rows = static_rows if STATE.mode == "static" else dynamic_rows
    static_sum = _summarize(static_rows, budget)
    dynamic_sum = _summarize(dynamic_rows, budget)
    active_sum = static_sum if STATE.mode == "static" else dynamic_sum

    return {
        "mode": STATE.mode,
        "budget_kw": _r(budget),
        "auto_budget": STATE.budget_kw is None,
        "nameplate_kw": _r(len(parsed) * TDP_KW),
        "tdp_kw": TDP_KW,
        "policy": {
            "reduce_gap_pct": int(REDUCE_GAP * 100),
            "increase_gap_pct": int(INCREASE_GAP * 100),
            "target_headroom_pct": int(TARGET_HEADROOM * 100),
            "enable_per_tick": ENABLE_PER_TICK,
        },
        "tick": STATE.tick,
        "last_event": STATE.last_event,
        "static": static_sum,
        "dynamic": dynamic_sum,
        "active": active_sum,
        "showcase": _showcase(static_rows, dynamic_rows),
        "racks": [_dump_rack(r) for r in active_rows],
    }
