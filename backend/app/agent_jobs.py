"""Independent Mona test agents that keep running after the chat turn."""

from __future__ import annotations

import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from .models import User, Workload

_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}
_STOP: dict[str, threading.Event] = {}
_MAX_LOG = 80
_MAX_JOBS = 40
_MINIONS = ("Scratch", "Whisk", "Paw", "Claw", "Ember", "Shade", "Ink", "Fang", "Nib", "Pixel")
_CHECK_NAMES = {
    "fw": "firmware",
    "sw": "software",
    "bom": "BOM",
    "psu": "PSU",
    "voltage": "voltage",
    "sel": "SEL",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _copy(job: dict[str, Any]) -> dict[str, Any]:
    log = list(job.get("log") or [])
    chat = [row for row in (job.get("chat") or []) if isinstance(row, dict)]
    return {
        "id": job.get("id"),
        "name": job.get("name"),
        "kind": job.get("kind"),
        "status": job.get("status"),
        "doing": job.get("doing"),
        "test": job.get("test"),
        "rack": job.get("rack"),
        "serial": job.get("serial"),
        "ok": job.get("ok"),
        "error": job.get("error"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "minion": job.get("minion"),
        "mission": job.get("mission"),
        "briefing": job.get("briefing"),
        "debrief": job.get("debrief"),
        "debrief_id": job.get("debrief_id"),
        "log": log[-40:],
        "chat": chat[-40:],
    }


def _touch(job_id: str, **fields: Any) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        job.update(fields)
        job["updated_at"] = _now()


def _say(job_id: str, text: str, kind: str = "say") -> None:
    line = (text or "").strip()
    if not line:
        return
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        chat = [row for row in (job.get("chat") or []) if isinstance(row, dict)]
        last = chat[-1] if chat else None
        if last and str(last.get("text") or "") == line[:400]:
            if kind != "sys":
                job["doing"] = line[:160]
            job["updated_at"] = _now()
            return
        chat.append(
            {
                "id": uuid.uuid4().hex[:10],
                "kind": kind,
                "text": line[:400],
                "at": _now(),
            }
        )
        job["chat"] = chat[-_MAX_LOG:]
        rows = list(job.get("log") or [])
        stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
        rows.append(f"{stamp}  {line[:240]}")
        job["log"] = rows[-_MAX_LOG:]
        if kind != "sys":
            job["doing"] = line[:160]
        job["updated_at"] = _now()


def _log(job_id: str, line: str) -> None:
    _say(job_id, _voice_status(line), "say")


def _doing(job_id: str, doing: str) -> None:
    _say(job_id, _voice_status(doing), "say")


def _stopped(job_id: str) -> bool:
    ev = _STOP.get(job_id)
    return bool(ev and ev.is_set())


def public(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return _copy(job) if job else None


def list_jobs() -> list[dict[str, Any]]:
    with _LOCK:
        rows = [_copy(j) for j in _JOBS.values()]
    rows.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)
    _merge_sanity(rows)
    return rows[:24]


def running_summary() -> str:
    live = [j for j in list_jobs() if j.get("status") == "running"]
    if not live:
        return ""
    bits = [
        f"{j.get('minion') or j.get('name')}: {j.get('doing') or j.get('mission') or j.get('status')}"
        for j in live[:6]
    ]
    return "; ".join(bits)


def _pick_minion() -> str:
    used = {
        str(j.get("minion") or "")
        for j in _JOBS.values()
        if j.get("status") in {"running", "queued"}
    }
    for name in _MINIONS:
        if name not in used:
            return name
    return f"Paw-{uuid.uuid4().hex[:3]}"


def _mission(kind: str, test: str | None, rack: str | None) -> str:
    tag = f" on {rack}" if (rack or "").strip() else ""
    if kind == "sanity":
        return f"L11 sanity{tag}"
    if kind == "catalog":
        return f"{test or 'catalog test'}{tag}"
    return f"Argus {test or 'test'}{tag}"


def _briefing(minion: str, mission: str) -> str:
    lines = (
        f"{minion}. {mission}. Don't come back until it's done.",
        f"Go, {minion}. {mission}. I'll be watching.",
        f"{minion}, you're up. {mission}. Make it clean.",
        f"Send {minion}. {mission}. Radio me when it lands.",
    )
    return lines[sum(ord(c) for c in minion) % len(lines)]


def _voice_status(raw: str) -> str:
    line = (raw or "").strip()
    if not line:
        return line
    hit = re.match(r"^([A-Za-z0-9._-]+):\s+([A-Za-z0-9._-]+)$", line)
    if hit:
        node, check = hit.group(1), hit.group(2)
        pretty = _CHECK_NAMES.get(check.lower(), check)
        return f"Checking {node} {pretty}."
    low = line.lower()
    if low.startswith("starting"):
        return f"On it. {line[0].upper() + line[1:]}" if line else line
    if "waiting" in low:
        return f"Still on station. {line}"
    if "watching" in low:
        return f"Eyes on it. {line}"
    return line


def start(
    db: Session,
    user: User,
    *,
    kind: str | None = None,
    test: str | None = None,
    rack: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    resolved = _resolve_kind(kind, test)
    if not resolved:
        return {
            "ok": False,
            "error": "say what to run: sanity, an Argus test name, or a catalog test like dcgm-diag",
        }
    kind, test = resolved
    rack_tag = (rack or "").strip() or None
    mission = _mission(kind, test, rack_tag)
    job_id = uuid.uuid4().hex[:12]
    with _LOCK:
        minion = _pick_minion()
        briefing = _briefing(minion, mission)
        label = (name or "").strip() or f"{minion} · {mission}"
        job = {
            "id": job_id,
            "name": label[:90],
            "kind": kind,
            "status": "queued",
            "doing": "warming up",
            "test": test,
            "rack": rack_tag,
            "serial": None,
            "ok": None,
            "error": None,
            "user_id": user.id,
            "started_at": _now(),
            "finished_at": None,
            "updated_at": _now(),
            "minion": minion,
            "mission": mission,
            "briefing": briefing,
            "debrief": None,
            "debrief_id": None,
            "log": [],
            "chat": [
                {
                    "id": uuid.uuid4().hex[:10],
                    "kind": "sys",
                    "text": f"Mona: {briefing}",
                    "at": _now(),
                },
                {
                    "id": uuid.uuid4().hex[:10],
                    "kind": "say",
                    "text": f"{minion} reporting. Mission: {mission}.",
                    "at": _now(),
                },
            ],
            "workload_id": None,
        }
        _JOBS[job_id] = job
        _STOP[job_id] = threading.Event()
        _prune_locked()
    thread = threading.Thread(
        target=_run,
        args=(job_id, user.id, kind, test, (rack or "").strip() or None),
        daemon=True,
        name=f"mona-agent-{job_id}",
    )
    thread.start()
    said = f"{minion} is out. {mission}. Radio is AGENTS."
    row = _copy(job)
    row["ok"] = True
    row["said"] = said
    row["choices"] = [
        {
            "label": f"See {minion}",
            "tool": "open_agent",
            "arguments": {"id": job_id},
            "hint": "minion radio",
        }
    ]
    row["ui"] = [
        {"kind": "agents", "id": job_id},
        {"kind": "navigate", "path": "/testing"},
        {"kind": "highlight", "action": "look", "target": "testing", "label": f"{minion} on it"},
    ]
    return {
        "ok": True,
        "minion": minion,
        "mission": mission,
        "id": job_id,
        "said": said,
        "choices": row["choices"],
        **row,
    }


def stop(job_id: str, db: Session | None = None, user: User | None = None) -> dict[str, Any]:
    needle = (job_id or "").strip()
    if not needle:
        return {"ok": False, "error": "no agent id"}
    with _LOCK:
        job = _JOBS.get(needle) or next(
            (
                j
                for j in _JOBS.values()
                if str(j.get("name") or "").lower() == needle.lower()
                or str(j.get("minion") or "").lower() == needle.lower()
            ),
            None,
        )
    if job is None:
        return {"ok": False, "error": "agent not found", "agents": list_jobs()[:8]}
    jid = str(job["id"])
    ev = _STOP.setdefault(jid, threading.Event())
    ev.set()
    kind = str(job.get("kind") or "")
    if kind == "sanity":
        from . import sanity

        sanity.stop_job()
    elif kind == "argus" and job.get("serial"):
        try:
            from . import cluster_controller

            cluster_controller.cancel_test(str(job["serial"]))
        except Exception as exc:
            _log(jid, f"cancel missed: {exc}")
    elif kind == "catalog" and job.get("workload_id") and db is not None and user is not None:
        from . import agent as agent_mod

        try:
            agent_mod.tool_stop_test(db, user, id=str(job["workload_id"]))
        except Exception as exc:
            _log(jid, f"stop missed: {exc}")
    _touch(jid, status="stopped", finished_at=_now(), ok=False, doing="recalled")
    _say(jid, "Mona pulled me off the job.", "sys")
    _kick_review(jid)
    return {"ok": True, **(public(jid) or {})}


def _prune_locked() -> None:
    if len(_JOBS) <= _MAX_JOBS:
        return
    done = [j for j in _JOBS.values() if j.get("status") in {"done", "failed", "stopped"}]
    done.sort(key=lambda j: str(j.get("finished_at") or j.get("started_at") or ""))
    for job in done[: max(0, len(_JOBS) - _MAX_JOBS)]:
        _JOBS.pop(str(job.get("id")), None)
        _STOP.pop(str(job.get("id")), None)


def _resolve_kind(kind: str | None, test: str | None) -> tuple[str, str | None] | None:
    from . import agent as agent_mod

    k = (kind or "").strip().lower()
    t = (test or "").strip()
    if k in {"sanity", "l11", "bom"}:
        return "sanity", t or None
    if k in {"argus", "gpu", "dcgm"}:
        return "argus", t or "dcgm-diag"
    if k in {"catalog", "workload", "mlperf"}:
        return "catalog", t or "dcgm-diag"
    if k:
        return "argus", k if not t else t
    if not t:
        return "sanity", None
    low = t.lower()
    if low in {"sanity", "l11", "bom", "golden"}:
        return "sanity", None
    if agent_mod._match_test(t):
        return "catalog", t
    return "argus", t


def _label(kind: str, test: str | None, rack: str | None) -> str:
    tag = (rack or "").strip()
    if kind == "sanity":
        return f"Sanity{f' on {tag}' if tag else ''}"
    if kind == "catalog":
        return f"{test or 'catalog test'}{f' on {tag}' if tag else ''}"
    return f"{test or 'Argus test'}{f' on {tag}' if tag else ''}"


def _finish(job_id: str, *, ok: bool, doing: str, error: str | None = None) -> None:
    already = False
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        if job.get("status") in {"done", "failed", "stopped"} and job.get("finished_at"):
            already = True
    if already:
        _kick_review(job_id)
        return
    status = "done" if ok else "failed"
    wrap = (
        "Mission complete. Handing this to Mona."
        if ok
        else f"Mission failed. {(error or doing)[:140]}. Mona needs this."
    )
    _touch(
        job_id,
        status=status,
        ok=ok,
        error=error,
        finished_at=_now(),
        doing="Mona is reading it",
    )
    _say(job_id, wrap[:400], "say" if ok else "err")
    _kick_review(job_id)


def _kick_review(job_id: str) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        if job.get("debrief_id") or job.get("reviewing"):
            return
        job["reviewing"] = True
        job["doing"] = "Mona is reading it"
        job["updated_at"] = _now()
    threading.Thread(
        target=_review,
        args=(job_id,),
        daemon=True,
        name=f"mona-review-{job_id}",
    ).start()


def _sanity_summary(st: dict[str, Any]) -> str:
    overall = st.get("overall") or st.get("status") or ""
    nodes = st.get("nodes") if isinstance(st.get("nodes"), dict) else {}
    fails: list[str] = []
    for label, row in nodes.items():
        if not isinstance(row, dict):
            continue
        checks = row.get("checks") if isinstance(row.get("checks"), dict) else {}
        for cid, chk in checks.items():
            blob = chk if isinstance(chk, dict) else {}
            status = str(blob.get("status") or "").upper()
            if status in {"FAIL", "FAILED", "ERROR"}:
                detail = str(blob.get("detail") or blob.get("message") or status)
                fails.append(f"{label} {cid}: {detail[:80]}")
    bits = [f"overall={overall}"]
    if fails:
        bits.append("fails: " + "; ".join(fails[:8]))
    return ". ".join(bits)


def _review_fallback(job: dict[str, Any], extra: str) -> str:
    minion = str(job.get("minion") or "the minion")
    mission = str(job.get("mission") or job.get("name") or "the job")
    status = str(job.get("status") or "")
    err = str(job.get("error") or "").strip()
    if status == "stopped":
        return f"I pulled {minion} off {mission}. Crew's back. Say the word if we send them again."
    if job.get("ok"):
        tail = extra or str(job.get("doing") or "clean")
        return f"Heh. {minion} is back. {mission} came back clean. I read it. {tail[:120]}"
    why = err or extra or str(job.get("doing") or "it went sideways")
    return f"{minion} crawled back. {mission} failed. I read the log. {why[:160]}"


def _mona_review(job: dict[str, Any], extra: str) -> str:
    fallback = _review_fallback(job, extra)
    try:
        from . import agent as agent_mod

        key = agent_mod.current_key()
        if not key:
            return fallback
        log = "\n".join(str(x) for x in (job.get("log") or [])[-12:])
        prompt = (
            f"Minion {job.get('minion')} finished.\n"
            f"Mission: {job.get('mission')}\n"
            f"Status: {job.get('status')} ok={job.get('ok')}\n"
            f"Last line: {job.get('doing')}\n"
            f"Error: {job.get('error') or 'none'}\n"
            f"Log:\n{log}\n"
            f"{extra}\n"
            "Speak 1 or 2 short lines to the operator. You reviewed the minion's report. "
            "Concrete. No tools. No em dashes."
        )
        resp = agent_mod._xai_post(
            {
                "model": agent_mod._FAST_MODEL,
                "instructions": (
                    "You are Mona, a smug talking cat who runs the L12 cluster. "
                    "Your minions do the grunt work. You review their reports and tell the operator. "
                    "Cocky, loyal, short. Never write tool names."
                ),
                "input": [{"role": "user", "content": prompt}],
                "store": False,
                "max_output_tokens": 160,
            },
            key,
        )
        spoken = agent_mod._strip_dashes(agent_mod._text(resp) or "").strip()
        spoken = re.sub(r"\n{3,}", "\n\n", spoken).strip()
        if not spoken or len(spoken) < 8:
            return fallback
        return spoken[:400]
    except Exception:
        return fallback


def _review(job_id: str) -> None:
    job = public(job_id)
    if not job:
        return
    extra = ""
    if job.get("kind") == "sanity":
        try:
            from . import sanity

            extra = _sanity_summary(sanity.load_status(job.get("rack")))
        except Exception:
            extra = ""
    text = _mona_review(job, extra)
    did = uuid.uuid4().hex[:10]
    _touch(job_id, debrief=text, debrief_id=did, doing="reported")
    _say(job_id, f"Mona: {text}", "sys")


def _run(job_id: str, user_id: str, kind: str, test: str | None, rack: str | None) -> None:
    from .db import SessionLocal
    from .models import User as UserModel

    _touch(job_id, status="running", doing="starting")
    db = SessionLocal()
    try:
        user = db.get(UserModel, user_id)
        if user is None:
            _finish(job_id, ok=False, doing="no operator", error="user vanished")
            return
        if kind == "sanity":
            _run_sanity(job_id, db, user, rack)
        elif kind == "catalog":
            _run_catalog(job_id, db, user, test or "dcgm-diag")
        else:
            _run_argus(job_id, db, user, test or "dcgm-diag", rack)
    except Exception as exc:
        _finish(job_id, ok=False, doing="crashed", error=str(exc)[:240])
    finally:
        db.close()


def _run_sanity(job_id: str, db: Session, user: User, rack: str | None) -> None:
    from . import sanity

    _doing(job_id, f"starting sanity{f' on {rack}' if rack else ''}")
    out = sanity.start_sanity(db, rack_serial=rack, rack_name=rack)
    if not out.get("ok"):
        err = str(out.get("error") or "sanity refused")
        if "already running" in err.lower():
            _doing(job_id, "watching the sanity job already in flight")
        else:
            _finish(job_id, ok=False, doing="sanity refused", error=err)
            return
    else:
        _touch(job_id, rack=out.get("rack_label") or rack, serial=out.get("rack_serial"))
        _log(job_id, f"sanity {out.get('job_id')} on {out.get('rack_label') or rack or 'rack'}")
    idle = 0
    while not _stopped(job_id):
        st = sanity.load_status(rack)
        job = st.get("job") or {}
        running = bool(job.get("running")) or str(st.get("status") or "") == "running"
        _doing(job_id, _sanity_doing(st))
        if not running:
            idle += 1
            if idle >= 2:
                overall = str(st.get("overall") or "done")
                ok = overall.upper() in {"PASS", "SKIP", "DONE", "OK"}
                _finish(job_id, ok=ok, doing=f"sanity {overall}")
                return
        else:
            idle = 0
        time.sleep(2)
    _finish(job_id, ok=False, doing="stopped")


def _sanity_doing(st: dict[str, Any]) -> str:
    nodes = st.get("nodes") if isinstance(st.get("nodes"), dict) else {}
    for label, row in nodes.items():
        if not isinstance(row, dict):
            continue
        checks = row.get("checks") if isinstance(row.get("checks"), dict) else {}
        for cid, chk in checks.items():
            status = str((chk or {}).get("status") or "").upper()
            if status in {"RUNNING", "PENDING", ""}:
                return f"{label}: {cid}"
        if str(row.get("overall") or "").upper() in {"RUNNING", "PENDING"}:
            return f"{label}: still running"
    rack = st.get("rack_label") or st.get("rack_serial") or "rack"
    overall = st.get("overall") or st.get("status") or "running"
    return f"sanity {rack} {overall}"


def _run_argus(job_id: str, db: Session, user: User, test: str, rack: str | None) -> None:
    from . import agent as agent_mod
    from . import argus_tests

    _doing(job_id, f"kicking Argus {test}")
    out = agent_mod.tool_run_argus_test(db, user, test=test, rack=rack)
    if not out.get("ok"):
        _finish(job_id, ok=False, doing="Argus refused", error=str(out.get("error") or "launch failed"))
        return
    serial = str(out.get("serial") or "")
    label = str(out.get("rack") or rack or "")
    _touch(job_id, serial=serial or None, rack=label or None, test=test)
    _log(job_id, f"launched {test} on {label or serial or 'rack'}")
    seen = False
    idle = 0
    while not _stopped(job_id):
        runs = argus_tests.active_runs()
        active = _active_hits(runs, test, serial, label)
        if active:
            seen = True
            idle = 0
            _doing(job_id, active[0])
        else:
            idle += 1
            if seen and idle >= 2:
                _finish(job_id, ok=True, doing=f"{test} finished")
                return
            if not seen and idle >= 8:
                _finish(job_id, ok=True, doing=f"{test} launched. Argus is not listing it as active.")
                return
            _doing(job_id, f"waiting on {test}")
        time.sleep(3)
    _finish(job_id, ok=False, doing="stopped")


def _active_hits(runs: dict[str, Any], test: str, serial: str, label: str) -> list[str]:
    rows = runs.get("active_runs")
    if not isinstance(rows, list):
        rows = runs.get("runs") if isinstance(runs.get("runs"), list) else []
    hits: list[str] = []
    needle_t = (test or "").lower()
    needle_s = (serial or "").lower()
    needle_l = (label or "").lower()
    for row in rows:
        if not isinstance(row, dict):
            blob = str(row).lower()
            if needle_t and needle_t in blob:
                hits.append(str(row)[:120])
            continue
        blob = " ".join(str(row.get(k) or "") for k in ("test", "name", "id", "serial", "rack", "status", "state")).lower()
        match_t = (not needle_t) or needle_t in blob
        match_r = (not needle_s and not needle_l) or needle_s in blob or needle_l in blob
        if match_t and match_r:
            status = row.get("status") or row.get("state") or "running"
            name = row.get("test") or row.get("name") or test
            where = row.get("rack") or row.get("serial") or label or serial
            hits.append(f"{name} on {where}: {status}"[:160])
    return hits


def _run_catalog(job_id: str, db: Session, user: User, test: str) -> None:
    from . import agent as agent_mod

    _doing(job_id, f"launching {test}")
    out = agent_mod.tool_launch_test(db, user, name=test)
    if not out.get("ok"):
        _finish(job_id, ok=False, doing="catalog refused", error=str(out.get("error") or "launch failed"))
        return
    wid = str(out.get("id") or "")
    _touch(job_id, workload_id=wid or None, test=out.get("name") or test)
    _doing(job_id, f"{out.get('name') or test} instance running")
    while not _stopped(job_id):
        db.expire_all()
        work = db.get(Workload, wid) if wid else None
        if work is None or work.status != "running":
            status = work.status if work is not None else "gone"
            _finish(job_id, ok=status in {"completed", "done"}, doing=f"{test} {status}")
            return
        _doing(job_id, f"{work.name} still running")
        time.sleep(4)
    _finish(job_id, ok=False, doing="stopped")


def _merge_sanity(rows: list[dict[str, Any]]) -> None:
    try:
        from . import sanity

        st = sanity.load_status()
        job = st.get("job") or {}
    except Exception:
        return
    if not job.get("running"):
        return
    sid = str(job.get("job_id") or "sanity")
    if any(r.get("kind") == "sanity" and r.get("status") == "running" for r in rows):
        return
    doing = _sanity_doing(st)
    rack = job.get("rack_label") or job.get("rack_serial") or "rack"
    mission = f"L11 sanity on {rack}"
    voiced = _voice_status(doing)
    rows.insert(
        0,
        {
            "id": f"sanity-{sid}",
            "name": f"Scratch · {mission}",
            "kind": "sanity",
            "status": "running",
            "doing": voiced,
            "test": "sanity",
            "rack": job.get("rack_label"),
            "serial": job.get("rack_serial"),
            "ok": None,
            "error": None,
            "started_at": job.get("started_at"),
            "finished_at": None,
            "minion": "Scratch",
            "mission": mission,
            "briefing": _briefing("Scratch", mission),
            "debrief": None,
            "debrief_id": None,
            "log": [voiced],
            "chat": [
                {
                    "id": f"sanity-{sid}-do",
                    "kind": "say",
                    "text": voiced,
                    "at": job.get("started_at") or _now(),
                }
            ],
        },
    )
