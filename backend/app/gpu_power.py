"""GB300 GPU / node / power-shelf telemetry for the MaxLPS tab.

Topology is fixed for this campus: 18 compute nodes per rack, 4 GB300 GPUs
per node (NVL72). Per-GPU watts come from BMC Redfish EnvironmentMetrics
(PowerWatts.Reading) over direct HTTPS — same path as cluster health.
The PXE hop is only used to write GPU caps, and for PowerShelf BMCs that
are off-net. Do not SSH-exec GPU polls through the hop (root lock).
"""

from __future__ import annotations

import math
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
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
# 1 ms. The page does not stack polls, so a shorter ask waits on the refresh in flight.
MIN_INTERVAL_S = 0.001
MAX_INTERVAL_S = 300.0
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
        self.cap_result: dict[str, dict[str, int]] = {}
        self.control = True
        # When on, PowerWatts and PowerLimitWatts run back to back.
        # Frequency still paces shelves, and paces both calls when this is off.
        self.continuous = False


LOOP = LoopState()


def apply_loop(
    *,
    interval_s: float | None = None,
    gpu_power_percent: float | None = None,
    desired_cap_percent: float | None = None,
    gpu_min_w: float | None = None,
    gpu_max_w: float | None = None,
    continuous: bool | None = None,
) -> bool:
    """Tune the GPU cap loop. Percents may be 0–1 or 10–100."""
    changed = False
    reset_caps = False
    if continuous is not None:
        flag = bool(continuous)
        if flag != LOOP.continuous:
            changed = True
            # Recompute on the next pass. Leave the last posted watts so an
            # unchanged cap, within 2 W, is still not sent again.
            if flag:
                LOOP.force = True
        LOOP.continuous = flag
    if interval_s is not None:
        v = max(MIN_INTERVAL_S, min(MAX_INTERVAL_S, float(interval_s)))
        if abs(v - LOOP.interval_s) >= 0.0005:
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


_LOOP_LOCK = threading.Lock()
_LOOP_CACHE: tuple[float, set[tuple[str, int]] | None] | None = None
_LOOP_TTL = 2.0
_RELEASE: set[str] = set()


def invalidate_loop_targets() -> None:
    global _LOOP_CACHE
    with _LOOP_LOCK:
        _LOOP_CACHE = None


def loop_node_keys() -> set[tuple[str, int]] | None:
    """Nodes the cap loop may write. None means do not filter."""
    global _LOOP_CACHE
    now = time.time()
    with _LOOP_LOCK:
        if _LOOP_CACHE and now - _LOOP_CACHE[0] < _LOOP_TTL:
            return _LOOP_CACHE[1]
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import MaxLpsNode

        with SessionLocal() as db:
            rows = db.execute(
                select(MaxLpsNode.rack_id, MaxLpsNode.index).where(MaxLpsNode.loop_on.is_(True))
            ).all()
        keys = {(str(rid), int(idx)) for rid, idx in rows}
    except Exception:
        with _LOOP_LOCK:
            if _LOOP_CACHE:
                return _LOOP_CACHE[1]
        return None
    with _LOOP_LOCK:
        _LOOP_CACHE = (now, keys)
    return keys


def _row_in_loop(rec: dict[str, Any], keys: set[tuple[str, int]] | None) -> bool:
    if keys is None:
        return True
    try:
        return (str(rec.get("rack_id") or ""), int(rec.get("node") or 0)) in keys
    except (TypeError, ValueError):
        return False


def _unselected_draw_w(live_rows: list[dict[str, Any]], loop_keys: set[tuple[str, int]] | None) -> float:
    """Live watts on nodes that are not selected for a dynamic cap.

    Those watts stay in GPU power used. Caps are not posted to these nodes.
    """
    total = 0.0
    for rec in live_rows:
        if _row_in_loop(rec, loop_keys):
            continue
        total += max(0.0, float(rec.get("watts") or 0.0))
    return total


def _unselected_hold_w(live_rows: list[dict[str, Any]], loop_keys: set[tuple[str, int]] | None) -> float:
    """Power reserved for nodes that are not in the loop.

    An uncapped node is restored to its BMC max, so GPU cap left holds that
    ceiling, not only the watts it is drawing right now.
    """
    total = 0.0
    for rec in live_rows:
        if _row_in_loop(rec, loop_keys):
            continue
        draw = max(0.0, float(rec.get("watts") or 0.0))
        ceiling = rec.get("hw_max")
        if ceiling is None:
            ceiling = rec.get("bmc_hi")
        if ceiling is None:
            ceiling = GPU_TDP_W
        total += max(draw, float(ceiling))
    return total


def node_gpu_ids(rack_id: str, index: int) -> list[str]:
    return [f"{rack_id}-n{int(index):02d}-g{g}" for g in range(1, GPUS_PER_NODE + 1)]


def note_loop_release(gids: set[str]) -> None:
    if not gids:
        return
    with _LOOP_LOCK:
        _RELEASE.update(gids)


def cancel_loop_release(gids: set[str]) -> None:
    if not gids:
        return
    with _LOOP_LOCK:
        _RELEASE.difference_update(gids)


def take_loop_release() -> set[str]:
    with _LOOP_LOCK:
        gids = set(_RELEASE)
        _RELEASE.clear()
        return gids


def read_loop_targets(db: Any) -> dict[str, Any]:
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from .models import MaxLpsRack

    racks = list(db.scalars(select(MaxLpsRack).options(selectinload(MaxLpsRack.nodes))).all())
    racks.sort(key=lambda rack: (rack.label or "").lower())
    out: list[dict[str, Any]] = []
    for rack in racks:
        nodes = [
            {
                "id": n.id,
                "index": int(n.index),
                "hostname": (n.hostname or "").strip(),
                "on": bool(n.loop_on),
            }
            for n in sorted(rack.nodes, key=lambda n: int(n.index))
        ]
        out.append({"id": rack.id, "label": rack.label, "nodes": nodes})
    return {"racks": out}


def write_loop_targets(
    db: Any,
    *,
    racks: list[dict[str, Any]] | None = None,
    nodes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from sqlalchemy import select

    from .models import MaxLpsNode

    wanted_racks = {str(r.get("id") or ""): bool(r.get("on")) for r in (racks or []) if r.get("id")}
    wanted_nodes = {str(n.get("id") or ""): bool(n.get("on")) for n in (nodes or []) if n.get("id")}
    turned_on: set[str] = set()
    turned_off: set[str] = set()
    if wanted_racks or wanted_nodes:
        for n in db.scalars(select(MaxLpsNode)).all():
            on: bool | None = None
            if n.rack_id in wanted_racks:
                on = wanted_racks[n.rack_id]
            if n.id in wanted_nodes:
                on = wanted_nodes[n.id]
            if on is None or bool(n.loop_on) == on:
                continue
            n.loop_on = on
            gids = set(node_gpu_ids(n.rack_id, int(n.index)))
            if on:
                turned_on |= gids
            else:
                turned_off |= gids
        if turned_on or turned_off:
            db.commit()
            LOOP.force = True
            LOOP.cached_out = None
    invalidate_loop_targets()
    cancel_loop_release(turned_on)
    note_loop_release(turned_off - turned_on)
    return read_loop_targets(db)


def set_control(on: bool) -> None:
    """MaxLPS on writes closed-loop caps. Off restores hardware max and only monitors."""
    if on:
        if LOOP.control:
            return
        LOOP.control = True
        LOOP.force = True
        LOOP.last_caps = None
        LOOP.last_posted.clear()
        LOOP.last_cap_by_id.clear()
        LOOP.cached_out = None
        return
    if not LOOP.control:
        return
    LOOP.control = False
    LOOP.force = False
    LOOP.cached_out = None


def _release_cap_w(live: dict[str, Any]) -> float:
    if live.get("max_w") is not None:
        return max(50.0, float(live["max_w"]))
    return GPU_TDP_W


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


_GID_RE = re.compile(r"^(?P<rack>.+)-n(?P<node>\d+)-g(?P<gpu>\d+)$")
_PROC_TTL = 2.0
_OS_LOGIN_TTL = 5.0
_PROC_LOCK = threading.Lock()
_PROC_BUSY: set[str] = set()
# os ip -> (stamp, rows by nvidia-smi index, command succeeded)
_PROC_CACHE: dict[str, tuple[float, dict[int, dict[str, Any]], bool]] = {}
_OS_LOGIN_LOCK = threading.Lock()
_OS_LOGIN: dict[str, tuple[float, dict[str, str] | None]] = {}
_UNKNOWN_PROC = {"process": "—", "workload": "—", "workload_kind": "idle", "pid": 0}
_IDLE_PROC = {"process": "idle", "workload": "—", "workload_kind": "idle", "pid": 0}

# One shot on the node OS. The first nvidia-smi must succeed; an empty app
# list is a real idle GPU, not a failed read.
_OS_PROC_SH = """set -e
nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits
printf '\\n--APPS--\\n'
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits || true
printf '\\n--CMD--\\n'
pids=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null || true)
for p in $pids; do
  case $p in
    ''|*[!0-9]*) continue ;;
  esac
  printf '%s ' "$p"
  if [ -r "/proc/$p/cmdline" ]; then
    tr '\\0' ' ' < "/proc/$p/cmdline"
  fi
  printf '\\n'
done
"""


def _parse_gid(gpu_id: str) -> tuple[str, int, int] | None:
    match = _GID_RE.match(gpu_id or "")
    if not match:
        return None
    node = int(match.group("node"))
    gpu = int(match.group("gpu"))
    if node < 1 or gpu < 1 or gpu > GPUS_PER_NODE:
        return None
    return match.group("rack"), node, gpu


def _csv_cell(value: str) -> str:
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1].strip()
    return text


def _procs_from_smi(raw: str) -> tuple[dict[int, dict[str, Any]], bool]:
    """Parse one node OS nvidia-smi dump. False means the read did not succeed."""
    text = raw or ""
    if "--APPS--" not in text:
        return {}, False
    gpu_part, rest = text.split("--APPS--", 1)
    if "--CMD--" in rest:
        app_part, cmd_part = rest.split("--CMD--", 1)
    else:
        app_part, cmd_part = rest, ""
    uuid_index: dict[str, int] = {}
    for line in gpu_part.splitlines():
        parts = [_csv_cell(part) for part in line.split(",")]
        if len(parts) < 2 or not parts[0].lstrip("-").isdigit():
            continue
        uuid_index[parts[1]] = int(parts[0])
    cmds: dict[int, str] = {}
    for line in cmd_part.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_s, _, cmd = line.partition(" ")
        if not pid_s.isdigit():
            continue
        cmds[int(pid_s)] = cmd.strip()
    grouped: dict[int, list[tuple[int, int, str, str]]] = {}
    for line in app_part.splitlines():
        parts = [_csv_cell(part) for part in line.split(",")]
        if len(parts) < 3 or not parts[1].isdigit():
            continue
        idx = uuid_index.get(parts[0])
        if idx is None:
            continue
        mem = 0
        if len(parts) >= 4:
            try:
                mem = int(float(parts[3]))
            except ValueError:
                mem = 0
        pid = int(parts[1])
        name = parts[2]
        base = (name.rsplit("/", 1)[-1] or name)[:80]
        cmd = (cmds.get(pid) or name)[:160]
        grouped.setdefault(idx, []).append((mem, pid, base, cmd))
    out: dict[int, dict[str, Any]] = {}
    for idx, bucket in grouped.items():
        bucket.sort(key=lambda row: row[0], reverse=True)
        _mem, pid, base, cmd = bucket[0]
        extra = len(bucket) - 1
        workload = cmd or base or "—"
        if extra:
            workload = f"{workload} +{extra}"[:160]
        out[idx] = {
            "process": base or "—",
            "workload": workload,
            "workload_kind": "idle",
            "pid": pid,
        }
    return out, True


def _proc_row(rows: dict[int, dict[str, Any]] | None, *, ok: bool, gpu_n: int) -> dict[str, Any]:
    if not ok or rows is None:
        return dict(_UNKNOWN_PROC)
    found = rows.get(gpu_n - 1)
    if not found:
        return dict(_IDLE_PROC)
    return found


def _load_os_login(rack_id: str, node_index: int) -> dict[str, str] | None:
    try:
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from .db import SessionLocal
        from .models import MaxLpsNode

        with SessionLocal() as db:
            node = db.scalars(
                select(MaxLpsNode)
                .where(MaxLpsNode.rack_id == rack_id, MaxLpsNode.index == node_index)
                .options(selectinload(MaxLpsNode.rack))
                .limit(1)
            ).first()
            if node is None:
                return None
            os_ip = (node.os_ip or "").strip()
            user = (node.os_username or "").strip()
            password = node.os_password or ""
            pxe = (node.rack.pxe_server or "").strip() if node.rack is not None else ""
        if not os_ip or not user or not password:
            return None
        return {"os_ip": os_ip, "user": user, "password": password, "pxe": pxe}
    except Exception:
        return None


def _os_login_for(rack_id: str, node_index: int) -> dict[str, str] | None:
    key = f"{rack_id}|{node_index}"
    now = time.time()
    with _OS_LOGIN_LOCK:
        hit = _OS_LOGIN.get(key)
        if hit and now - hit[0] < _OS_LOGIN_TTL:
            return hit[1]
    loaded = _load_os_login(rack_id, node_index)
    with _OS_LOGIN_LOCK:
        _OS_LOGIN[key] = (time.time(), loaded)
    return loaded


def _read_os_procs(login: dict[str, str]) -> tuple[dict[int, dict[str, Any]], bool]:
    """nvidia-smi on the node OS, through that rack's PXE. No password in the command."""
    import paramiko

    from . import pxe_hop

    host = login["os_ip"]
    pxe = (login.get("pxe") or "").strip()
    try:
        if pxe:
            if not pxe_hop.ensure_host(pxe):
                return {}, False
            with pxe_hop.on_host(pxe):
                local = pxe_hop.open_https_tunnel(f"ssh-{host}", host, 22)
        else:
            pxe_hop.ensure_saved()
            chosen = pxe_hop.bind_target(host)
            with pxe_hop.on_host(chosen):
                local = pxe_hop.open_https_tunnel(f"ssh-{host}", host, 22)
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                "127.0.0.1",
                port=int(local),
                username=login["user"],
                password=login["password"],
                timeout=8,
                allow_agent=False,
                look_for_keys=False,
                banner_timeout=8,
                auth_timeout=8,
            )
            stdin, stdout, _stderr = client.exec_command("bash -s", timeout=8)
            stdin.write(_OS_PROC_SH)
            stdin.channel.shutdown_write()
            stdout.channel.settimeout(8)
            raw = stdout.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
        finally:
            try:
                client.close()
            except Exception:
                pass
    except Exception:
        return {}, False
    if code != 0:
        return {}, False
    return _procs_from_smi(raw)


def _refresh_os_procs(login: dict[str, str]) -> None:
    ip = login["os_ip"]
    try:
        rows, ok = _read_os_procs(login)
        now = time.time()
        with _PROC_LOCK:
            prev = _PROC_CACHE.get(ip)
            if ok:
                _PROC_CACHE[ip] = (now, rows, True)
            elif prev:
                _PROC_CACHE[ip] = (now, prev[1], prev[2])
            else:
                _PROC_CACHE[ip] = (now, {}, False)
    finally:
        with _PROC_LOCK:
            _PROC_BUSY.discard(ip)


def _gpu_process(gpu_id: str) -> dict[str, Any]:
    """Latest process on this GPU. A read still running keeps the previous one."""
    parsed = _parse_gid(gpu_id)
    if not parsed:
        return dict(_UNKNOWN_PROC)
    rack_id, node_index, gpu_n = parsed
    login = _os_login_for(rack_id, node_index)
    if not login:
        return dict(_UNKNOWN_PROC)
    ip = login["os_ip"]
    now = time.time()
    with _PROC_LOCK:
        hit = _PROC_CACHE.get(ip)
        stale = hit is None or now - hit[0] >= _PROC_TTL
        if stale and ip not in _PROC_BUSY:
            _PROC_BUSY.add(ip)
            threading.Thread(
                target=_refresh_os_procs, args=(dict(login),), daemon=True, name="maxlps-gpu-proc"
            ).start()
        rows = hit[1] if hit else None
        ok = bool(hit and hit[2])
        tried = hit is not None
    if tried and not ok:
        return {"process": "—", "workload": "OS did not answer", "workload_kind": "idle", "pid": 0}
    return _proc_row(rows, ok=ok, gpu_n=gpu_n)


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
        proc = _gpu_process(gpu_id)
        return {
            "id": gpu_id,
            "watts": round(watts, 1),
            "setpoint_w": round(sp, 1),
            "min_w": round(lo, 1),
            "max_w": round(hi, 1),
            **proc,
            "curve": curve,
            "read_ms": live_read_ms(gpu_id),
            **cap_post_stats(gpu_id),
        }
    watts = float(cached.get("watts") or 0.0) if cached and cached.get("source") == "redfish" else 0.0
    sp = float(cached.get("setpoint_w") or 0.0) if cached and cached.get("source") == "redfish" else 0.0
    proc = _gpu_process(gpu_id)
    return {
        "id": gpu_id,
        "watts": round(watts, 1),
        "setpoint_w": round(sp, 1),
        "min_w": round(lo, 1),
        "max_w": round(hi, 1),
        **proc,
        "curve": list(LOOP.gpu_hist.get(gpu_id) or []),
        "read_ms": live_read_ms(gpu_id),
        **cap_post_stats(gpu_id),
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


def _poll_wait_s(elapsed_s: float, interval_s: float | None = None) -> float:
    """Seconds until the next live read may start.

    Frequency is the interval when the caller does not pass one. A round that
    already ran longer than the interval waits nothing, so polls do not stack.
    """
    interval = LOOP.interval_s if interval_s is None else interval_s
    return max(0.0, float(interval) - max(0.0, elapsed_s))


# A hop that fails before this, or a loop with no BMCs, must not tight-spin SQLite.
_GPU_SPIN_FLOOR_S = 0.05


def _gpu_round_wait_s(elapsed_s: float, *, had_targets: bool) -> float:
    """Seconds before the next PowerWatts round.

    Continuous starts the next read as soon as this one finishes. A pass with
    no BMCs, or one that returned in under 50 ms, still waits so an empty
    inventory or a dead hop does not tight-spin SQLite. Shelves do not use
    this; they stay on Frequency.
    """
    elapsed = max(0.0, float(elapsed_s))
    if not had_targets:
        return max(float(LOOP.interval_s), _GPU_SPIN_FLOOR_S)
    if LOOP.continuous:
        if elapsed < _GPU_SPIN_FLOOR_S:
            return _GPU_SPIN_FLOOR_S - elapsed
        return 0.0
    return _poll_wait_s(elapsed)


def _cap_check_open(*, due: bool, busy: bool) -> bool:
    """True when a PowerLimitWatts pass may start.

    Frequency opens a pass on each tick. Continuous opens one whenever the
    previous pass has finished. A pass still running does not start another.
    """
    if busy:
        return False
    if LOOP.continuous:
        return True
    return bool(due)


def _sleep_poll_interval(started: float) -> None:
    time.sleep(_poll_wait_s(time.time() - started))


def _sleep_poll_idle() -> None:
    """No BMC to read. Follow Frequency, but don't tight-loop the database."""
    time.sleep(max(LOOP.interval_s, 0.05))


def _note_usage(gid: str, watts: float, now: float) -> None:
    last = LOOP.sample_t.get(gid, 0.0)
    # One sample per Frequency tick. A slower interval still keeps a reading
    # about every 0.7s so the cap uses the window average, not one spike.
    # Continuous keeps every reading so the next cap sees the latest watts.
    gap = 0.0 if LOOP.continuous else min(0.7, max(LOOP.interval_s, MIN_INTERVAL_S))
    if gap > 0 and now - last < gap:
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


def _gpu_allowable_w(envelope_w: float, rack_draw_w: float, gpu_frac: float) -> float:
    """GPU cap budget. GPU power % of total available power.

    Total available is the threshold envelope minus live rack draw.
    The cap stays inside that available power.
    """
    headroom = max(0.0, float(envelope_w) - max(0.0, float(rack_draw_w)))
    frac = min(1.0, max(0.0, float(gpu_frac)))
    return headroom * frac


def _shown_rack_draw_w(racks: list[tuple[str, bool, str]], envelope_w: float) -> float:
    """Watts of live shelf draw for the racks the page still shows.

    A rack that would push the running sum past the envelope is left out,
    matching the snapshot filter that builds the rack list.
    """
    items: list[tuple[bool, str, float]] = []
    for rid, extra, label in racks:
        _rows, live_sum, live, _src = _merge_shelves(rid)
        shelf_kw = float(live_sum) if live else 0.0
        items.append((bool(extra), label, shelf_kw))
    items.sort(key=lambda row: (row[0], row[1]))
    used_kw = 0.0
    limit_kw = max(0.0, float(envelope_w)) / 1000.0
    for _extra, _label, shelf_kw in items:
        nxt = used_kw + shelf_kw
        if nxt > limit_kw + 0.05:
            continue
        used_kw = nxt
    return used_kw * 1000.0


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
_ARGUS_BUSY = False
_ARGUS_BUSY_LOCK = threading.Lock()


def _refresh_argus_shelves() -> None:
    """Background Argus TotalPowerOut ingest. Never called on the request thread."""
    global _ARGUS_SHELF_T, _ARGUS_SHELF, _ARGUS_BUSY
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
        _ARGUS_SHELF_T = time.time()
    except Exception:
        if not _ARGUS_SHELF:
            _ARGUS_SHELF_T = time.time()
    finally:
        with _ARGUS_BUSY_LOCK:
            _ARGUS_BUSY = False


def _argus_shelf_rows() -> dict[str, list[dict[str, Any]]]:
    """Cached Argus shelf rows. Request path never waits on the controller."""
    global _ARGUS_BUSY
    now = time.time()
    stale = (not _ARGUS_SHELF) or (now - _ARGUS_SHELF_T >= 5.0)
    if stale:
        with _ARGUS_BUSY_LOCK:
            kick = not _ARGUS_BUSY
            if kick:
                _ARGUS_BUSY = True
        if kick:
            threading.Thread(target=_refresh_argus_shelves, daemon=True, name="argus-shelf").start()
    return _ARGUS_SHELF


def _rows_from_shelf_map(rid: str, live: list[dict[str, Any]], source: str) -> tuple[list[dict[str, Any]], float, bool]:
    """Sum only shelves that answered. A miss is 0 kW with down=True, not the previous reading."""
    out: list[dict[str, Any]] = []
    total = 0.0
    any_up = False
    for src in live:
        down = bool(src.get("down"))
        if src.get("kw") is None and not down:
            continue
        kw = 0.0 if down else round(float(src["kw"]), 3)
        if not down:
            any_up = True
            total += kw
        out.append(
            {
                "id": src.get("id") or f"{rid}-ps{int(src.get('index') or 0)}",
                "index": int(src.get("index") or 0),
                "kw": kw,
                "down": down,
                "source": source,
                "sensor": src.get("sensor_name") or src.get("sensor"),
            }
        )
    out.sort(key=lambda x: int(x["index"]))
    return out, round(total, 3), any_up


def _merge_shelf_rows(rid: str, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float, bool, str]:
    """Current PowerShelf readings only. Argus TotalPowerOut is a last-known sensor, not a live BMC."""
    redfish, total, ok = _rows_from_shelf_map(rid, rows, "redfish")
    if redfish and ok:
        return redfish, total, True, "redfish"
    if redfish:
        return redfish, 0.0, False, "down"
    return [], 0.0, False, "none"


def _merge_shelves(rid: str) -> tuple[list[dict[str, Any]], float, bool, str]:
    return _merge_shelf_rows(rid, _live_shelf_rows().get(rid) or [])


_LIVE_SHELF: dict[str, list[dict[str, Any]]] = {}
_LIVE_SHELF_T = 0.0
_LIVE_SHELF_BUSY = False
# Backstop if a poll never finishes. A miss zeroes the shelf immediately; this only
# expires a success the watcher did not replace. Longer than one dual-PXE poll (25s each).
_LIVE_SHELF_TTL = 75.0


def group_by_pxe(rows: list, pxe_of: dict[str, str], rack_id_of) -> tuple[dict[str, list], list]:
    """Split power targets into the PXE stored on the rack, and rows with no PXE."""
    grouped: dict[str, list] = {}
    bare: list = []
    for row in rows:
        rid = str(rack_id_of(row) or "")
        pxe = (pxe_of.get(rid) or "").strip()
        if pxe:
            grouped.setdefault(pxe, []).append(row)
        else:
            bare.append(row)
    return grouped, bare


def _rack_pxe_map() -> dict[str, str]:
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import MaxLpsRack
        from .pxe_servers import normalize_host

        with SessionLocal() as db:
            rows = db.execute(select(MaxLpsRack.id, MaxLpsRack.pxe_server)).all()
        return {str(rid): host for rid, raw in rows if (host := normalize_host(raw))}
    except Exception:
        return {}


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


_LIVE_SHELF_ERR = ""
_SHELF_WATCH: threading.Thread | None = None
_SHELF_WATCH_LOCK = threading.Lock()


def _write_shelf(
    meta: dict[str, Any],
    *,
    kw: float,
    down: bool,
    sensor_name: str | None = None,
    path: str | None = None,
    error: str | None = None,
    bmc_ip: str = "",
) -> None:
    """Replace this shelf's row. A miss stores 0 kW so the last reading cannot linger."""
    global _LIVE_SHELF, _LIVE_SHELF_T, _LIVE_SHELF_ERR
    rec = {
        "id": meta["id"],
        "index": int(meta["index"]),
        "kw": 0.0 if down else round(float(kw), 3),
        "down": bool(down),
        "source": "redfish",
        "sensor_name": sensor_name,
        "path": path,
        "bmc_ip": bmc_ip,
        "error": (error or "")[:180] or None,
        "t": time.time(),
    }
    rid = str(meta["rack_id"])
    with _LIVE_GPU_LOCK:
        rows = [r for r in (_LIVE_SHELF.get(rid) or []) if int(r.get("index") or -1) != rec["index"]]
        rows.append(rec)
        rows.sort(key=lambda x: int(x.get("index") or 0))
        _LIVE_SHELF[rid] = rows
        if not down:
            _LIVE_SHELF_ERR = ""
        _LIVE_SHELF_T = rec["t"]


def _ingest_shelf(index: dict[str, dict[str, Any]], node: dict[str, Any]) -> None:
    ip = str(node.get("bmc_ip") or "")
    meta = index.get(ip)
    if not meta:
        return
    watts = node.get("total_w")
    if watts is None:
        watts = node.get("watts")
    if watts is None:
        _write_shelf(
            meta,
            kw=0.0,
            down=True,
            error=str(node.get("error") or "no-watt-reading"),
            bmc_ip=ip,
        )
        return
    _write_shelf(
        meta,
        kw=float(watts) / 1000.0,
        down=False,
        sensor_name=node.get("sensor_name"),
        path=node.get("path"),
        bmc_ip=ip,
    )


def _mark_group_down(nodes: list[dict[str, Any]], index: dict[str, dict[str, Any]], error: str) -> None:
    for n in nodes:
        ip = str(n.get("bmc_ip") or "")
        meta = index.get(ip)
        if meta:
            _write_shelf(meta, kw=0.0, down=True, error=error, bmc_ip=ip)


def _shelf_index(nodes: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    raw_idx = [int(n["index"]) for n in nodes]
    shift = 1 if raw_idx and min(raw_idx) == 0 else 0
    return {
        str(n["bmc_ip"]): {
            "id": n["id"],
            "rack_id": n["rack_id"],
            "index": int(n["index"]) + shift,
        }
        for n in nodes
    }


def _poll_shelf_group(host: str, nodes: list[dict[str, Any]], index: dict[str, dict[str, Any]]) -> bool:
    from . import pxe_hop

    if not nodes:
        return False
    if not pxe_hop.ensure_host(host):
        _mark_group_down(nodes, index, "pxe-hop-down")
        return False
    targets = [{"bmc_ip": n["bmc_ip"], "user": n["user"], "password": n["password"]} for n in nodes]
    try:
        got = pxe_hop.fetch_psu_power(targets, timeout=25.0, host=host)
    except Exception as exc:
        _mark_group_down(nodes, index, str(exc)[:180] or "no-response")
        raise
    seen: set[str] = set()
    any_watts = False
    for ip, node in (got or {}).items():
        if not isinstance(node, dict):
            continue
        _ingest_shelf(index, node)
        seen.add(str(ip))
        if node.get("total_w") is not None or node.get("watts") is not None:
            any_watts = True
    for n in nodes:
        ip = str(n.get("bmc_ip") or "")
        if ip and ip not in seen:
            meta = index.get(ip)
            if meta:
                _write_shelf(meta, kw=0.0, down=True, error="no-response", bmc_ip=ip)
    return any_watts


def _shelf_watch_forever() -> None:
    global _LIVE_SHELF, _LIVE_SHELF_T, _LIVE_SHELF_ERR
    while True:
        t0 = time.time()
        try:
            from . import pxe_hop

            pxe_hop.ensure_saved()
            nodes = _shelf_targets()
            if not nodes:
                with _LIVE_GPU_LOCK:
                    _LIVE_SHELF_ERR = "no-pmc-targets"
                    _LIVE_SHELF_T = time.time()
                _sleep_poll_idle()
                continue
            index = _shelf_index(nodes)
            grouped, bare = group_by_pxe(nodes, _rack_pxe_map(), lambda n: n.get("rack_id"))
            hosts = list(pxe_hop.status().get("hosts") or [])
            if not grouped and not (bare and hosts):
                _mark_group_down(nodes, index, "pxe-hop-down")
                with _LIVE_GPU_LOCK:
                    _LIVE_SHELF_ERR = "pxe-hop-down"
                _sleep_poll_idle()
                continue
            any_ok = False
            last_err = ""
            for host, group in grouped.items():
                try:
                    if _poll_shelf_group(host, group, index):
                        any_ok = True
                except Exception as exc:
                    last_err = str(exc)[:180]
            # Racks with no PXE in Provision are tried on each hop that is already up.
            for host in hosts:
                if not bare:
                    break
                try:
                    if _poll_shelf_group(host, bare, index):
                        any_ok = True
                except Exception as exc:
                    last_err = str(exc)[:180]
            with _LIVE_GPU_LOCK:
                if any_ok:
                    _LIVE_SHELF_ERR = ""
                elif last_err:
                    _LIVE_SHELF_ERR = last_err
                elif not _LIVE_SHELF:
                    _LIVE_SHELF_ERR = "pxe-hop-down"
        except Exception as exc:
            with _LIVE_GPU_LOCK:
                _LIVE_SHELF_ERR = str(exc)[:180]
        _sleep_poll_interval(t0)


def _ensure_shelf_watch() -> None:
    global _SHELF_WATCH
    with _SHELF_WATCH_LOCK:
        t = _SHELF_WATCH
        if t is not None and t.is_alive():
            return
        t = threading.Thread(target=_shelf_watch_forever, daemon=True, name="maxlps-psu-redfish")
        _SHELF_WATCH = t
        t.start()


def _kick_live_shelf_poll() -> None:
    _ensure_shelf_watch()


def _read_shelf_cache() -> dict[str, list[dict[str, Any]]]:
    """Copy the shelf cache. A row that missed its poll, or is older than the backstop, is 0 kW."""
    now = time.time()
    with _LIVE_GPU_LOCK:
        out: dict[str, list[dict[str, Any]]] = {}
        for rid, rows in _LIVE_SHELF.items():
            fresh: list[dict[str, Any]] = []
            for row in rows:
                rec = dict(row)
                age = now - float(rec.get("t") or 0.0)
                if rec.get("down") or age > _LIVE_SHELF_TTL:
                    rec["kw"] = 0.0
                    rec["down"] = True
                fresh.append(rec)
            out[rid] = fresh
        return out


def _live_shelf_rows() -> dict[str, list[dict[str, Any]]]:
    _ensure_shelf_watch()
    return _read_shelf_cache()


_LIVE_GPU: dict[str, dict[str, Any]] = {}
_LIVE_GPU_SRC = "none"
_LIVE_GPU_T = 0.0
_LIVE_GPU_LOCK = threading.Lock()
_LIVE_GPU_BUSY = False
_LIVE_GPU_BUSY_T = 0.0
_LIVE_GPU_TTL = 1.0
_LIVE_GPU_ERR = ""
_LIVE_NODE_W: dict[str, dict[str, float]] = {}  # rack_id -> {bmc_ip: chassis HSC watts}

_GPU_ENV_NAMES = (
    ("GPU_0", "GPU_1", "GPU_2", "GPU_3"),
    ("GPU_SXM_0", "GPU_SXM_1", "GPU_SXM_2", "GPU_SXM_3"),
)


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
    rows, _err = _query_gpu_targets()
    return rows


def _query_gpu_targets() -> tuple[list[tuple[str, str, str, str, str]], str]:
    """Targets, and a short error when the inventory query itself failed."""
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
        return out, ""
    except Exception as exc:
        return [], str(exc)[:180]


def _gpu_rec(rid: str, idx: str, ip: str, g: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    gi = int(g.get("index") or 0)
    if gi < 1 or gi > GPUS_PER_NODE:
        return None
    watts = g.get("watts")
    if watts is None:
        if not g.get("present"):
            return None
        watts = 0.0
    gid = f"{rid}-n{int(idx):02d}-g{gi}"
    rec: dict[str, Any] = {"watts": float(watts)}
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
    ms = g.get("ms")
    if isinstance(ms, (int, float)) and float(ms) >= 0:
        rec["read_ms"] = round(float(ms), 1)
    return gid, rec


def _ingest_bmc(index: dict[str, tuple[str, str]], node: dict[str, Any]) -> None:
    global _LIVE_GPU, _LIVE_GPU_SRC, _LIVE_GPU_T, _LIVE_GPU_ERR
    ip = str(node.get("bmc_ip") or "")
    loc = index.get(ip)
    if not loc:
        return
    rid, idx = loc
    mapped: dict[str, dict[str, Any]] = {}
    for g in node.get("gpus") or []:
        if not isinstance(g, dict):
            continue
        item = _gpu_rec(rid, idx, ip, g)
        if item:
            mapped[item[0]] = item[1]
    if not mapped:
        return
    with _LIVE_GPU_LOCK:
        for gid, rec in mapped.items():
            if "read_ms" in rec:
                continue
            prev = _LIVE_GPU.get(gid)
            if isinstance(prev, dict) and isinstance(prev.get("read_ms"), (int, float)):
                rec["read_ms"] = prev["read_ms"]
        _LIVE_GPU.update(mapped)
        _LIVE_GPU_SRC = "redfish"
        _LIVE_GPU_ERR = ""
        _LIVE_GPU_T = time.time()


def _ingest_node_watts(rid: str, ip: str, watts: Any) -> None:
    """Chassis EnvironmentMetrics PowerWatts (HSC) for rack draw when PMC shelves are dark."""
    if watts is None or not rid or not ip:
        return
    try:
        w = float(watts)
    except (TypeError, ValueError):
        return
    with _LIVE_GPU_LOCK:
        bucket = dict(_LIVE_NODE_W.get(rid) or {})
        bucket[ip] = w
        _LIVE_NODE_W[rid] = bucket


def _note_hop_down() -> None:
    """Hop dropped. Keep last Redfish GPU / chassis readings; direct watch refreshes them."""
    global _LIVE_GPU_ERR, _LIVE_SHELF_ERR
    with _LIVE_GPU_LOCK:
        if not _LIVE_GPU:
            _LIVE_GPU_ERR = "pxe-hop-down"
        if not _LIVE_SHELF:
            _LIVE_SHELF_ERR = "pxe-hop-down"


def _gpu_index_of(name: str) -> int | None:
    parts = str(name or "").replace("/", "_").split("_")
    for p in reversed(parts):
        if p.isdigit():
            return int(p)
    return None


def _metrics_watts(body: dict[str, Any]) -> dict[str, Any]:
    pw = body.get("PowerWatts") if isinstance(body.get("PowerWatts"), dict) else {}
    pl = body.get("PowerLimitWatts") if isinstance(body.get("PowerLimitWatts"), dict) else {}
    oem = (body.get("Oem") or {}).get("Nvidia") if isinstance(body.get("Oem"), dict) else {}
    base = (
        oem.get("GPUBasePowerWatts")
        if isinstance(oem, dict) and isinstance(oem.get("GPUBasePowerWatts"), dict)
        else {}
    )

    def _rd(block: Any, *keys: str) -> float | None:
        if not isinstance(block, dict):
            return None
        for k in keys:
            v = block.get(k)
            if v is None:
                continue
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        return None

    reading = _rd(pw, "Reading")
    if reading is None:
        reading = _rd(pl, "Reading")
    if reading is None:
        reading = _rd(base, "Reading")
    return {
        "watts": reading,
        "min_w": _rd(pl, "AllowableMin") if _rd(pl, "AllowableMin") is not None else _rd(base, "AllowableMin"),
        "max_w": _rd(pl, "AllowableMax") if _rd(pl, "AllowableMax") is not None else _rd(base, "AllowableMax"),
        "setpoint_w": _rd(pl, "SetPoint") if _rd(pl, "SetPoint") is not None else _rd(base, "SetPoint"),
    }


def _one_gpu_env(ip: str, user: str, password: str, name: str) -> dict[str, Any] | None:
    from . import bmc_health

    path = f"/redfish/v1/Systems/HGX_Baseboard_0/Processors/{name}/EnvironmentMetrics"
    t0 = time.time()
    body = bmc_health.redfish_get(ip, path, user, password, timeout=8.0)
    ms = round((time.time() - t0) * 1000, 1)
    if not isinstance(body, dict) or body.get("_error"):
        return None
    row = _metrics_watts(body)
    if row.get("watts") is None:
        pw = body.get("PowerWatts") if isinstance(body.get("PowerWatts"), dict) else {}
        uri = str(pw.get("DataSourceUri") or "").strip()
        if uri:
            t1 = time.time()
            sensor = bmc_health.redfish_get(ip, uri, user, password, timeout=8.0)
            reading = sensor.get("Reading") if isinstance(sensor, dict) else None
            try:
                if reading is not None:
                    row["watts"] = float(reading)
                    ms = round((time.time() - t1) * 1000, 1)
            except (TypeError, ValueError):
                pass
    row["id"] = name
    row["processor"] = name
    row["path"] = path
    row["raw_index"] = _gpu_index_of(name)
    row["present"] = True
    row["ms"] = ms
    return row


def _chassis_watts(ip: str, user: str, password: str) -> float | None:
    from . import bmc_health

    body = bmc_health.redfish_get(ip, "/redfish/v1/Chassis/Chassis_0/EnvironmentMetrics", user, password, timeout=8.0)
    if not isinstance(body, dict) or body.get("_error"):
        return None
    pw = body.get("PowerWatts")
    if isinstance(pw, dict):
        pw = pw.get("Reading")
    try:
        return float(pw) if pw is not None else None
    except (TypeError, ValueError):
        return None


def _fetch_direct_node(ip: str, user: str, password: str) -> dict[str, Any]:
    out: dict[str, Any] = {"bmc_ip": ip, "gpus": [], "total_w": None, "error": None}
    raw: list[dict[str, Any]] = []
    for names in _GPU_ENV_NAMES:
        with ThreadPoolExecutor(max_workers=len(names)) as pool:
            futs = [pool.submit(_one_gpu_env, ip, user, password, n) for n in names]
            raw = [r for r in (f.result() for f in futs) if r]
        if raw:
            break
    out["total_w"] = _chassis_watts(ip, user, password)
    zero = any(g.get("raw_index") == 0 for g in raw)
    used: set[int] = set()
    for g in raw:
        ri = g.get("raw_index")
        if ri is None:
            continue
        idx = int(ri) + 1 if zero else int(ri)
        if idx < 1 or idx in used:
            continue
        used.add(idx)
        g["index"] = idx
        out["gpus"].append(g)
    if not out["gpus"] and out["total_w"] is None:
        out["error"] = "no-gpu-metrics"
    return out


def _direct_gpu_targets() -> list[tuple[str, str, str, str, str]]:
    """Credentialed compute BMCs for a direct Redfish poll (probe overlay, skip dead)."""
    from .config import settings

    probe = (getattr(settings, "bmc_probe_ip", None) or "").strip()
    probe_user = (getattr(settings, "bmc_probe_user", None) or "root").strip() or "root"
    probe_pw = getattr(settings, "bmc_probe_password", None) or ""
    fail_until: dict[str, float] = {}
    try:
        from . import bmc_health

        fail_until = bmc_health._FAIL_UNTIL
    except Exception:
        pass
    now = time.time()
    out: list[tuple[str, str, str, str, str]] = []
    seen: set[str] = set()
    for rid, idx, ip, user, pw in _gpu_live_targets():
        ip = (ip or "").strip()
        if not ip or ip in seen:
            continue
        if ip == probe and probe_pw:
            user, pw = probe_user, probe_pw
        if not pw:
            continue
        hold = float(fail_until.get(ip) or 0.0)
        if hold > now and ip != probe:
            continue
        seen.add(ip)
        out.append((str(rid), str(idx), ip, user or "root", pw))
    out.sort(key=lambda t: 0 if t[2] == probe else 1)
    return out[:8]


def _poll_gpus_direct(nodes: list[tuple[str, str, str, str, str]]) -> set[str]:
    index = {ip: (rid, idx) for rid, idx, ip, _user, _pw in nodes}
    found: set[str] = set()
    found_lock = threading.Lock()

    def one(n: tuple[str, str, str, str, str]) -> None:
        rid, _idx, ip, user, pw = n
        try:
            rec = _fetch_direct_node(ip, user, pw)
        except Exception:
            return
        _ingest_bmc(index, rec)
        _ingest_node_watts(rid, ip, rec.get("total_w"))
        if any(isinstance(g, dict) and g.get("watts") is not None for g in rec.get("gpus") or []):
            with found_lock:
                found.add(ip)

    if not nodes:
        return found
    one(nodes[0])
    rest = nodes[1:]
    if rest:
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(one, rest))
    return found


def _health_chassis_w(rid: str) -> float:
    """Sum chassis HSC watts already collected by the health poller for this rack."""
    try:
        from . import bmc_health

        ips = {ip for r, _idx, ip, _u, _p in _gpu_live_targets() if str(r) == str(rid)}
        total = 0.0
        for n in bmc_health.snapshot().get("nodes") or []:
            w = (n.get("power") or {}).get("watts")
            if w is None:
                continue
            nrid = str(n.get("rack_id") or "")
            ip = str(n.get("bmc_ip") or "").strip()
            if nrid == str(rid) or (ip and ip in ips):
                total += float(w)
        return total
    except Exception:
        return 0.0


def _poll_pxe_gpus(host: str, nodes: list[tuple[str, str, str, str, str]]) -> tuple[set[str], str]:
    """EnvironmentMetrics for these BMCs through the rack's PXE.

    Returns the BMC IPs that reported watts, and a short error when none did.
    """
    from . import pxe_hop

    cred = [n for n in nodes if (n[2] or "").strip() and (n[4] or "").strip()]
    if not cred:
        return set(), "bmc-password-missing"
    if not pxe_hop.ensure_host(host):
        return set(), "pxe-hop-down"
    index = {n[2]: (n[0], n[1]) for n in cred}
    targets = [{"bmc_ip": n[2], "user": n[3] or "ADMIN", "password": n[4]} for n in cred]
    got: set[str] = set()

    def on_node(node: dict[str, Any]) -> None:
        ip = str(node.get("bmc_ip") or "")
        if not ip:
            return
        _ingest_bmc(index, node)
        got.add(ip)

    err = pxe_hop.read_gpu_round(targets, on_node, timeout=30.0, host=host)
    return got, "" if got else err


def _finish_gpu_round(
    *,
    nodes_n: int,
    hopped: bool,
    missing_pw: int,
    bare_n: int,
    last_err: str,
    node_err: str,
    hosts_up: bool,
    direct_n: int,
    query_err: str,
) -> None:
    """Record why a poll added no GPU watts.

    A later round that reaches real BMCs must replace a stale no-bmc-targets.
    Readings already in hand stay until a newer sample replaces them.
    """
    global _LIVE_GPU_ERR, _LIVE_GPU_T
    with _LIVE_GPU_LOCK:
        if hopped:
            if not last_err:
                _LIVE_GPU_ERR = ""
            return
        if nodes_n <= 0:
            reason = query_err or "no-bmc-targets"
        elif last_err:
            reason = last_err
        elif node_err:
            reason = node_err
        elif missing_pw and bare_n <= 0:
            reason = "bmc-password-missing"
        elif not hosts_up and direct_n <= 0:
            reason = "pxe-hop-down"
        else:
            reason = "power-reading-empty"
        if _LIVE_GPU:
            if reason:
                _LIVE_GPU_ERR = reason
            return
        _LIVE_GPU_ERR = reason
        _LIVE_GPU_T = time.time()


def _gpu_watch_forever() -> None:
    while True:
        t0 = time.time()
        had_targets = False
        try:
            from . import pxe_hop

            pxe_hop.ensure_saved()
            nodes, query_err = _query_gpu_targets()
            if not nodes:
                _finish_gpu_round(
                    nodes_n=0,
                    hopped=False,
                    missing_pw=0,
                    bare_n=0,
                    last_err="",
                    node_err="",
                    hosts_up=True,
                    direct_n=0,
                    query_err=query_err,
                )
                _sleep_poll_idle()
                continue
            had_targets = True
            grouped, bare = group_by_pxe(nodes, _rack_pxe_map(), lambda n: n[0])
            missing_pw = 0
            hopped: set[str] = set()
            last_err = ""
            node_err = ""
            for host, group in grouped.items():
                if not any((n[4] or "").strip() for n in group):
                    missing_pw += len(group)
                    continue
                try:
                    got, err = _poll_pxe_gpus(host, group)
                    hopped.update(got)
                    if err and not got:
                        node_err = err
                except Exception as exc:
                    last_err = str(exc)[:180]
            hosts = list(pxe_hop.status().get("hosts") or [])
            if bare and hosts:
                for host in hosts:
                    try:
                        got, err = _poll_pxe_gpus(host, bare)
                        hopped.update(got)
                        if err and not got:
                            node_err = err
                    except Exception as exc:
                        last_err = str(exc)[:180]
            bare_racks = {str(n[0]) for n in bare}
            direct = [n for n in _direct_gpu_targets() if str(n[0]) in bare_racks and n[2] not in hopped]
            if direct:
                hopped.update(_poll_gpus_direct(direct))
            _finish_gpu_round(
                nodes_n=len(nodes),
                hopped=bool(hopped),
                missing_pw=missing_pw,
                bare_n=len(bare),
                last_err=last_err,
                node_err=node_err,
                hosts_up=bool(hosts),
                direct_n=len(direct),
                query_err=query_err,
            )
        except Exception as exc:
            with _LIVE_GPU_LOCK:
                _LIVE_GPU_ERR = str(exc)[:180]
                if not _LIVE_GPU:
                    _LIVE_GPU_T = time.time()
        wait = _gpu_round_wait_s(time.time() - t0, had_targets=had_targets)
        if wait:
            time.sleep(wait)
        if had_targets and LOOP.continuous:
            _schedule_continuous_caps()


_WATCH_THREAD: threading.Thread | None = None
_WATCH_LOCK = threading.Lock()


def _ensure_gpu_watch() -> None:
    global _WATCH_THREAD
    with _WATCH_LOCK:
        t = _WATCH_THREAD
        if t is not None and t.is_alive():
            return
        t = threading.Thread(target=_gpu_watch_forever, daemon=True, name="maxlps-gpu-watch")
        _WATCH_THREAD = t
        t.start()


def _kick_live_gpu_poll(*, force: bool = False) -> None:
    _ensure_gpu_watch()


def force_live_gpu_poll() -> None:
    _ensure_gpu_watch()
    _ensure_shelf_watch()


def _live_gpu_readings() -> tuple[dict[str, dict[str, Any]], str]:
    _ensure_gpu_watch()
    _ensure_shelf_watch()
    with _LIVE_GPU_LOCK:
        return dict(_LIVE_GPU), _LIVE_GPU_SRC


def live_ranking() -> dict[str, Any]:
    """Current GPU watts in rank order. Memory only, so the table can poll it."""
    with _LIVE_GPU_LOCK:
        items = list(_LIVE_GPU.items())
        src = _LIVE_GPU_SRC
        stamped = _LIVE_GPU_T
    rows: list[tuple[float, str, dict[str, Any]]] = []
    for gid, rec in items:
        if not isinstance(rec, dict) or rec.get("watts") is None:
            continue
        rows.append((float(rec["watts"]), str(gid), rec))
    rows.sort(key=lambda row: (-row[0], row[1]))
    gpus: list[dict[str, Any]] = []
    for i, (watts, gid, rec) in enumerate(rows, start=1):
        gpus.append(
            {
                "id": gid,
                "watts": round(watts, 1),
                "setpoint_w": rec.get("setpoint_w"),
                "min_w": rec.get("min_w"),
                "max_w": rec.get("max_w"),
                "rank": i,
            }
        )
    return {
        "source": src,
        "gpu_poll_age_s": round(max(0.0, time.time() - stamped), 3) if stamped else None,
        "gpus": gpus,
    }


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
_CAP_FOLLOW = False
_CAP_FOLLOW_THREAD: threading.Thread | None = None
_CAP_FOLLOW_LOCK = threading.Lock()
_SNAP_LOCK = threading.Lock()
_LAST_POWER_SNAP: dict[str, Any] | None = None


def live_read_ms(gpu_id: str) -> float | None:
    """Latest Redfish power-read response for this GPU, in milliseconds."""
    with _LIVE_GPU_LOCK:
        rec = _LIVE_GPU.get(gpu_id) or {}
        ms = rec.get("read_ms")
    if isinstance(ms, (int, float)) and float(ms) >= 0:
        return round(float(ms), 1)
    return None


def cap_post_stats(gpu_id: str) -> dict[str, int | float | None]:
    """Cap PATCH attempts for one GPU since this API process started."""
    with _LIVE_GPU_LOCK:
        rec = LOOP.cap_result.get(gpu_id) or {}
        posts = int(rec.get("n") or 0)
        fails = int(rec.get("fail") or 0)
        ms = rec.get("ms")
    pct = round(100.0 * fails / posts, 1) if posts else 0.0
    cap_ms = round(float(ms), 1) if isinstance(ms, (int, float)) else None
    return {"cap_posts": posts, "cap_fails": fails, "cap_fail_pct": pct, "cap_ms": cap_ms}


def _remember_caps(patches: list[dict[str, Any]], results: list[dict[str, Any]]) -> None:
    ok = {
        (r.get("bmc_ip"), r.get("path"))
        for r in results
        if isinstance(r, dict) and 200 <= int(r.get("status") or 0) < 400
    }
    timed: dict[tuple[Any, Any], float] = {}
    for r in results:
        if not isinstance(r, dict) or not isinstance(r.get("ms"), (int, float)):
            continue
        timed[(r.get("bmc_ip"), r.get("path"))] = float(r["ms"])
    with _LIVE_GPU_LOCK:
        for p in patches:
            succeeded = (p.get("bmc_ip"), p.get("path")) in ok
            gid = str(p.get("gid") or "")
            if gid:
                slot = LOOP.cap_result.setdefault(gid, {"n": 0, "fail": 0})
                slot["n"] += 1
                if not succeeded:
                    slot["fail"] += 1
                ms = timed.get((p.get("bmc_ip"), p.get("path")))
                if ms is not None and ms >= 0:
                    slot["ms"] = round(ms, 1)
            if not succeeded:
                continue
            sp = float(p.get("setpoint") or 0)
            if gid:
                LOOP.last_posted[gid] = sp
            for rec in _LIVE_GPU.values():
                if rec.get("bmc_ip") == p.get("bmc_ip") and rec.get("path") == p.get("path"):
                    rec["setpoint_w"] = sp


def _apply_gpu_caps(patches: list[dict[str, Any]]) -> None:
    global _CAP_BUSY
    recorded: list[dict[str, Any]] = []

    def settle(group: list[dict[str, Any]], results: list[dict[str, Any]]) -> None:
        _remember_caps(group, results)
        recorded.extend(group)

    try:
        from . import pxe_hop
        from .pxe_servers import pxe_for_address

        if not patches:
            return
        pxe_hop.ensure_saved()
        groups: dict[str, list[dict[str, Any]]] = {}
        bare: list[dict[str, Any]] = []
        for patch in patches:
            pxe = pxe_for_address(str(patch.get("bmc_ip") or ""))
            if pxe:
                groups.setdefault(pxe, []).append(patch)
            else:
                bare.append(patch)
        if bare:
            host = next(iter(pxe_hop.status().get("hosts") or []), "")
            if host:
                groups.setdefault(host, []).extend(bare)
            else:
                settle(bare, [])
        for host, group in groups.items():
            if not pxe_hop.ensure_host(host):
                settle(group, [])
                continue
            try:
                results = pxe_hop.apply_gpu_setpoints(group, host=host)
            except Exception:
                results = []
            settle(group, results)
    except Exception:
        pass
    finally:
        left = [patch for patch in patches if all(patch is not done for done in recorded)]
        if left:
            try:
                _remember_caps(left, [])
            except Exception:
                pass
        global _CAP_FOLLOW
        _CAP_BUSY = False
        if LOOP.continuous:
            _schedule_continuous_caps()
        else:
            _CAP_FOLLOW = False


def _schedule_continuous_caps() -> None:
    """Run one cap check as soon as the previous PowerLimitWatts pass is done.

    A check still running, or a cap post still in flight, does not start a
    second one. The flag asks that in-flight pass to look again when it finishes.
    """
    global _CAP_FOLLOW, _CAP_FOLLOW_THREAD
    if not LOOP.continuous:
        return
    with _CAP_FOLLOW_LOCK:
        if _CAP_BUSY:
            _CAP_FOLLOW = True
            return
        running = _CAP_FOLLOW_THREAD
        if running is not None and running.is_alive() and running is not threading.current_thread():
            _CAP_FOLLOW = True
            return
        _CAP_FOLLOW = False
        nxt = threading.Thread(target=_continuous_cap_pass, daemon=True, name="maxlps-cap-follow")
        _CAP_FOLLOW_THREAD = nxt
        nxt.start()


def _continuous_cap_pass() -> None:
    global _CAP_FOLLOW, _CAP_FOLLOW_THREAD
    try:
        snap = _LAST_POWER_SNAP
        if isinstance(snap, dict) and LOOP.continuous:
            snapshot(snap)
    except Exception:
        pass
    with _CAP_FOLLOW_LOCK:
        if _CAP_BUSY:
            return
        again = _CAP_FOLLOW and LOOP.continuous
        _CAP_FOLLOW = False
        if _CAP_FOLLOW_THREAD is threading.current_thread():
            _CAP_FOLLOW_THREAD = None
    if again:
        _schedule_continuous_caps()


def _kick_cap_patch(patches: list[dict[str, Any]]) -> None:
    global _CAP_BUSY, _CAP_FOLLOW
    if not patches:
        return
    if _CAP_BUSY:
        if LOOP.continuous:
            _CAP_FOLLOW = True
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
    global _LAST_POWER_SNAP
    if isinstance(power_snap, dict):
        _LAST_POWER_SNAP = power_snap
    with _SNAP_LOCK:
        return _snapshot_locked(
            power_snap,
            top=top,
            rack_id=rack_id,
            gpu_id=gpu_id,
            workloads=workloads,
        )


def _snapshot_locked(
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
        round(LOOP.interval_s, 3),
        bool(LOOP.continuous),
        round(_LIVE_GPU_T, 2),
        len(_LIVE_GPU),
        round(sum(float(r.get("watts") or 0) for r in _LIVE_GPU.values()), 1),
        power_snap.get("mode"),
        LOOP.control,
    )
    due = LOOP.force or (now - LOOP.last_step >= LOOP.interval_s)
    # Continuous must not serve a short cache that skips the cap check.
    if (
        not LOOP.continuous
        and not gpu_id
        and not due
        and LOOP.cached_out is not None
        and LOOP.cached_key == cache_key
        and (now - LOOP.cache_t) < min(0.2, LOOP.interval_s)
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
    envelope_w = power_budget_w * grace
    active_racks: list[tuple[str, bool, str]] = []

    records: list[dict[str, Any]] = []
    overhead_total_w = 0.0

    for r in rows:
        rid = r["id"]
        enabled = bool(r.get("enabled"))
        denied = bool(r.get("denied"))
        off = (r.get("power_state") or "on") == "off" or not enabled
        if off or denied:
            continue
        active_racks.append((rid, bool(r.get("extra")), _rack_label(r.get("name") or "", r.get("label") or "")))
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

    max_allowable_w = _gpu_allowable_w(envelope_w, _shown_rack_draw_w(active_racks, envelope_w), gpu_frac)

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
        rec["hw_max"] = _release_cap_w(live)
        rec["path"] = live.get("path") or ""
        rec["bmc_ip"] = live.get("bmc_ip") or ""
        rec["processor"] = live.get("processor") or ""
        live_rows.append(rec)
        _note_usage(rec["id"], watts, now)

    loop_keys = loop_node_keys()
    controlled = [r for r in live_rows if _row_in_loop(r, loop_keys)]
    controlling = (power_snap.get("mode") or "static") == "dynamic"
    if controlling != LOOP.control:
        set_control(controlling)
        due = LOOP.force or (now - LOOP.last_step >= LOOP.interval_s)
    cap_open = _cap_check_open(due=due, busy=_CAP_BUSY)
    if LOOP.continuous and _CAP_BUSY and (controlled or live_rows):
        global _CAP_FOLLOW
        _CAP_FOLLOW = True
    should_post = bool(controlling and controlled) and (
        cap_open or (not LOOP.last_posted and not _CAP_BUSY)
    )
    release_ids = take_loop_release() if controlling else set()
    if not controlling:
        take_loop_release()
    release_patches: list[dict[str, Any]] = []
    if controlling and release_ids and not _CAP_BUSY:
        rel_creds = {ip: (user, pw) for _rid, _idx, ip, user, pw in _gpu_live_targets()}
        for rec in live_rows:
            if rec["id"] not in release_ids or _row_in_loop(rec, loop_keys):
                continue
            cap_w = float(round(float(rec.get("hw_max") or GPU_TDP_W)))
            LOOP.last_cap_by_id[rec["id"]] = cap_w
            prev = LOOP.last_posted.get(rec["id"])
            bmc_sp = rec.get("bmc_sp")
            if not rec.get("path") or not rec.get("bmc_ip"):
                continue
            if prev is not None and abs(prev - cap_w) < 2:
                continue
            if bmc_sp is not None and abs(float(bmc_sp) - cap_w) < 2:
                LOOP.last_posted[rec["id"]] = cap_w
                continue
            user, pw = rel_creds.get(str(rec["bmc_ip"]), ("ADMIN", ""))
            release_patches.append(
                {
                    "gid": rec["id"],
                    "bmc_ip": rec["bmc_ip"],
                    "user": user,
                    "password": pw,
                    "path": rec["path"],
                    "setpoint": int(cap_w),
                }
            )
        # A GPU that is not in this live set has nothing to write. Drop it
        # so a node that never reports does not stay queued.
    elif release_ids:
        note_loop_release(release_ids)
    if due:
        LOOP.last_step = now
        LOOP.force = False
        LOOP.step_n += 1
    best_p = LOOP.last_best_p
    if should_post:
        # Continuous posts without advancing the Frequency clock.
        if not due and not LOOP.continuous:
            LOOP.last_step = now
            LOOP.force = False
            LOOP.step_n += 1
        avgs = [_window_avg(r["id"], float(r["watts"])) for r in controlled]
        bounds = [(float(r["bmc_lo"]), float(r["bmc_hi"])) for r in controlled]
        # Unselected nodes stay in the GPU sum. Cap left holds each of them
        # at its BMC max, then the checked nodes share what remains.
        share_left_w = max(0.0, max_allowable_w - _unselected_hold_w(live_rows, loop_keys))
        new_caps, best_p = _post_caps(avgs, share_left_w, desired_p, bounds)
        LOOP.last_best_p = best_p
        LOOP.last_caps = new_caps
        LOOP.usage_win.clear()
        LOOP.sample_t.clear()
        creds = {ip: (user, pw) for _rid, _idx, ip, user, pw in _gpu_live_targets()}
        patches: list[dict[str, Any]] = []
        for rec, cap in zip(controlled, new_caps):
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
        patches.extend(release_patches)
        release_patches = []
        _kick_cap_patch(patches)
    elif cap_open and not controlling and live_rows:
        creds = {ip: (user, pw) for _rid, _idx, ip, user, pw in _gpu_live_targets()}
        patches = []
        for rec in live_rows:
            cap_w = float(round(float(rec.get("hw_max") or GPU_TDP_W)))
            LOOP.last_cap_by_id[rec["id"]] = cap_w
            prev = LOOP.last_posted.get(rec["id"])
            bmc_sp = rec.get("bmc_sp")
            if not rec.get("path") or not rec.get("bmc_ip"):
                continue
            if prev is not None and abs(prev - cap_w) < 2:
                continue
            if bmc_sp is not None and abs(float(bmc_sp) - cap_w) < 2:
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
    elif release_patches:
        _kick_cap_patch(release_patches)

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
    shelf_source = "none"
    for acc in rack_acc.values():
        gpu_kw = acc["gpu_w"] / 1000.0
        oh_kw = 0.0
        n_on = acc["n_live"] if acc["power_state"] != "off" else 0
        shelves, live_sum, live, src = _merge_shelves(str(acc["id"]))
        if live:
            shelf_kw = live_sum
            if src == "redfish" or shelf_source != "redfish":
                shelf_source = src
            if shelf_kw > gpu_kw + 0.001:
                oh_kw = max(0.0, shelf_kw - gpu_kw)
        else:
            shelf_kw = 0.0
            if src == "down" and shelf_source != "redfish":
                shelf_source = "down"
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
    gpu_committed_w = 0.0
    for i, (watts, gid, rec, sp, lo, hi) in enumerate(gpu_pool, start=1):
        # Selected and unselected live GPUs both count, in dynamic and static.
        # An uncapped node is held at its BMC max so cap left moves when the
        # checkbox changes, before that node's watts catch up.
        gpu_total_w += watts
        cap_total_w += sp
        if _row_in_loop(rec, loop_keys):
            gpu_committed_w += watts
        else:
            ceiling = float(rec.get("hw_max") or hi or GPU_TDP_W)
            gpu_committed_w += max(float(watts), ceiling)
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
            "in_loop": _row_in_loop(rec, loop_keys),
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
            "shelf_source": shelf_source,
            "shelf_error": _LIVE_SHELF_ERR or None,
            "shelf_poll_age_s": round(max(0.0, now - _LIVE_SHELF_T), 1) if _LIVE_SHELF_T else None,
            "gpu_source": "redfish" if live_n else "none",
            "gpu_error": _LIVE_GPU_ERR or None,
            "gpu_live": live_n,
            "gpu_control": "maxlps" if LOOP.control else "monitor",
            "gpu_poll_age_s": round(max(0.0, now - _LIVE_GPU_T), 1) if _LIVE_GPU_T else None,
            "gpu_busy": bool(_WATCH_THREAD is not None and _WATCH_THREAD.is_alive()),
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
            "gpu_left_kw": round((max_allowable_w - gpu_committed_w) / 1000.0, 1),
            "best_cap_percent": round(best_p * 100.0, 2),
        },
        "algo": {
            "control": LOOP.control,
            "continuous": bool(LOOP.continuous),
            "interval_s": round(LOOP.interval_s, 3),
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


def live_rack_draw(rid: str) -> dict[str, Any]:
    """Shelf watts plus whatever the GPU cache already has. Never blocks on Argus.

    Overview and the limiter snapshot call this. Starting the GPU watch here
    would post PowerLimitWatts. Dynamic Power starts that watch itself.
    """
    try:
        _ensure_shelf_watch()
    except Exception:
        pass
    redfish_rows = _read_shelf_cache().get(rid) or []
    with _LIVE_GPU_LOCK:
        gpu_items = list(_LIVE_GPU.items())
        node_map = dict(_LIVE_NODE_W.get(rid) or {})
        node_w = sum(float(v) for v in node_map.values())
    _redfish, total, ok = _rows_from_shelf_map(rid, redfish_rows, "redfish")
    shelf_down = bool(redfish_rows) and not ok
    # Shelf kW is only a shelf that answered this poll. Chassis watts still count as alive,
    # but they are not a stand-in for a PowerShelf that missed total_power_out.
    shelf_kw = total if ok else 0.0
    hw = 0.0 if node_w > 0 or ok else _health_chassis_w(rid)
    if ok:
        src, live = "redfish", True
    elif node_w > 0 or hw > 0:
        src, live = "redfish", True
    elif shelf_down:
        src, live = "down", False
    else:
        src, live = "none", False
    gpu_w = 0.0
    gpu_n = 0
    node_idx: set[int] = set()
    prefix = f"{rid}-"
    for gid, rec in gpu_items:
        if rec.get("watts") is None:
            continue
        if str(gid).startswith(prefix) or rec.get("rack_id") == rid:
            gpu_w += float(rec["watts"])
            gpu_n += 1
            m = re.search(r"-n(\d+)-g", str(gid), re.I)
            if m:
                node_idx.add(int(m.group(1)))
    return {
        "shelf_kw": float(shelf_kw),
        "shelf_down": shelf_down,
        "metered": bool(live),
        "source": src if live or shelf_down else "none",
        "gpu_kw": round(gpu_w / 1000.0, 2),
        "gpu_live": gpu_n,
        "nodes_live": max(len(node_idx), len(node_map)),
    }


def overlay_live_consumed(snap: dict[str, Any]) -> dict[str, Any]:
    """Replace limiter-estimated draw with PowerShelf / chassis HSC / Argus meters."""
    if not snap:
        return snap
    total = 0.0
    metered = 0
    for r in snap.get("racks") or []:
        rid = str(r.get("id") or "")
        live = live_rack_draw(rid)
        src = str(live.get("source") or "none")
        live_sum = float(live.get("shelf_kw") or 0.0)
        r["meter_source"] = src if live_sum > 0 else "none"
        if live_sum > 0:
            r["consumed_kw"] = round(live_sum, 2)
            r["usage_pct"] = power_limit.rack_usage_pct(live_sum)
            total += live_sum
            metered += 1
        else:
            r["consumed_kw"] = 0.0
            r["usage_pct"] = 0.0
    used = round(total, 2) if metered else 0.0
    if not metered:
        for key in ("active", "static", "dynamic"):
            block = dict(snap.get(key) or {})
            block["consumed_kw"] = 0.0
            block["used_kw"] = 0.0
            snap[key] = block
        snap["power_source"] = "none"
        return snap
    for key in ("active", "static", "dynamic"):
        block = dict(snap.get(key) or {})
        block["consumed_kw"] = used
        block["used_kw"] = used
        snap[key] = block
    snap["power_source"] = "redfish"
    return snap
