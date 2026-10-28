"""Argus test catalog, reports, logs, launches, plus L11 sanity / BOM / reports."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import argus_tests, l11_report, maxlps_inventory, sanity
from ..db import get_db
from ..models import User
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/tests", tags=["tests"])


class RunIn(BaseModel):
    tests: list[str] = Field(min_length=1)
    rack_serial: str | None = None
    rack_name: str | None = None
    node_macs: list[str] | None = None
    l10_subtests: dict[str, list[str]] | None = None


class SanityRunIn(BaseModel):
    rack_serial: str | None = None
    rack_name: str | None = None
    node_macs: list[str] | None = None
    checks: list[str] | None = None


class GoldenIn(BaseModel):
    content: Any


class CaptureIn(BaseModel):
    rack_serial: str | None = None
    rack_name: str | None = None
    node: str | None = None


class ReportIn(BaseModel):
    level: str = "L11"
    rack_serial: str | None = None
    node_serial: str | None = None


class ScriptRunIn(BaseModel):
    rack_serial: str | None = None
    rack_name: str | None = None
    node: str | None = None
    timeout: int = Field(default=90, ge=10, le=600)


@router.get("/catalog")
def test_catalog(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    cat = argus_tests.catalog()
    tests = list(cat.get("tests") or [])
    by_comp: dict[str, int] = {}
    for t in tests:
        cid = str(t.get("component") or "system")
        by_comp[cid] = by_comp.get(cid, 0) + 1
    for spec in sanity.script_catalog().get("scripts") or []:
        cid = str(spec.get("component") or "system")
        tests.append(
            {
                "id": spec["id"],
                "name": spec["id"],
                "label": spec["label"],
                "detail": spec.get("detail") or "",
                "classifier": "l11",
                "component": cid,
                "timeout_seconds": None,
                "parent_test_id": None,
                "subtests": [],
                "source": "l11",
                "kind": cid,
                "gpu_request": 0,
                "gpu_mem_gb_request": 0,
                "pods_requested": 1,
                "present": spec.get("present"),
            }
        )
        by_comp[cid] = by_comp.get(cid, 0) + 1
    components = [{**c, "count": by_comp.get(c["id"], 0)} for c in (cat.get("components") or argus_tests.COMPONENTS)]
    return {
        "source": cat.get("source") or "l11",
        "components": components,
        "tests": tests,
        "error": cat.get("error"),
    }


@router.get("/runs")
def test_runs(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    return argus_tests.active_runs()


@router.get("/reports")
def test_reports(
    serial: str | None = Query(default=None),
    name: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    bundle = argus_tests.list_reports(serial, name)
    local = l11_report.list_reports()
    rows = list(local.get("reports") or []) + list(bundle.get("reports") or [])
    err = bundle.get("error")
    return {"reports": rows, "count": len(rows), "error": err}


@router.get("/preview")
def test_preview(
    path: str = Query(...),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    loc = (path or "").strip()
    if not loc or len(loc) > 800 or "\x00" in loc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad path")
    try:
        if loc.startswith("l11:"):
            data, mime, name = _l11_file(loc)
            return argus_tests.preview_bytes(data, name, mime)
        return argus_tests.preview_file(loc)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)[:240]) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc


@router.get("/results")
def test_results(
    serial: str = Query(...),
    name: str = Query(...),
    _user: User = Depends(get_current_user),
) -> Any:
    try:
        return argus_tests.rack_results(serial, name)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc


@router.get("/report")
def latest_report(
    serial: str = Query(...),
    name: str = Query(...),
    _user: User = Depends(get_current_user),
) -> Any:
    try:
        return argus_tests.latest_report(serial, name)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc


def _l11_file(loc: str) -> tuple[bytes, str, str]:
    path = l11_report.resolve_file(loc)
    data = path.read_bytes()
    mime = argus_tests._guess_mime(path.name, data)
    return data, mime, path.name


@router.get("/file")
def test_file(
    path: str = Query(...),
    _user: User = Depends(get_current_user),
) -> Response:
    loc = (path or "").strip()
    if not loc or len(loc) > 800 or "\x00" in loc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad path")
    try:
        if loc.startswith("l11:"):
            data, mime, name = _l11_file(loc)
        else:
            data, mime, name = argus_tests.read_file(loc)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)[:240]) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc
    safe = name.replace('"', "")
    return Response(
        content=data,
        media_type=mime or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{safe}"'},
    )


@router.get("/logs")
def test_logs(
    bmc_mac: str | None = Query(default=None),
    path: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
) -> Any:
    try:
        if path:
            return argus_tests.read_log(path)
        if bmc_mac:
            return argus_tests.node_logs(bmc_mac)
        return argus_tests.logs_index()
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc


@router.post("/run")
def run_tests(
    body: RunIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> Any:
    chosen = sanity.pick_rack(db, body.rack_serial, body.rack_name)
    if chosen is None or not (chosen.serial or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No Argus rack to run against")
    picked = sanity._pick_nodes(chosen, body.node_macs)
    if body.node_macs and not picked:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "node not found on this rack")
    nodes = []
    for n in picked:
        mac = (n.bmc_mac or "").strip()
        if not mac and not body.node_macs:
            continue
        nodes.append({"bmc_mac": mac, "bmc_ip": n.bmc_ip, "hostname": n.hostname, "location_index": str(n.index)})
    payload = [
        {
            "rack_id": chosen.serial,
            "rack_name": chosen.label,
            "nodes": nodes,
        }
    ]
    try:
        return {"ok": True, "result": argus_tests.launch(body.tests, payload, body.l10_subtests)}
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)[:240]) from exc


@router.get("/sanity")
def sanity_status(
    serial: str | None = Query(default=None),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return sanity.load_status(serial)


@router.post("/sanity/run")
def sanity_run(
    body: SanityRunIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    out = sanity.start_sanity(
        db,
        rack_serial=body.rack_serial,
        rack_name=body.rack_name,
        node_macs=body.node_macs,
        checks=body.checks,
    )
    if not out.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, out.get("error") or "could not start sanity")
    return out


@router.post("/sanity/stop")
def sanity_stop(_user: User = Depends(require_editor)) -> dict[str, Any]:
    return sanity.stop_job()


@router.get("/golden")
def golden_list(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    return sanity.golden_status()


@router.get("/golden/{kind}")
def golden_get(kind: str, _user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        content = sanity.load_golden(kind)
    except KeyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    info = sanity.golden_status().get(kind) or {}
    if not info.get("exists"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no {kind} golden")
    return {"kind": kind, "content": content, **info}


@router.put("/golden/{kind}")
def golden_put(
    kind: str,
    body: GoldenIn,
    _user: User = Depends(require_editor),
) -> dict[str, Any]:
    try:
        info = sanity.save_golden(kind, body.content)
    except KeyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)[:240]) from exc
    return {"ok": True, "kind": kind, **info}


@router.post("/golden/capture")
def golden_capture(
    body: CaptureIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    out = sanity.capture_golden(db, rack_serial=body.rack_serial, rack_name=body.rack_name, node=body.node)
    if not out.get("ok"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, out.get("error") or "capture failed")
    return out


@router.get("/l11-scripts")
def l11_scripts(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    return sanity.script_catalog()


@router.get("/l11-scripts/{script_id}")
def l11_script(script_id: str, _user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        name, text = sanity.read_script(script_id)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return {"id": script_id, "filename": name, "content": text}


@router.post("/l11-scripts/{script_id}/run")
def l11_script_run(
    script_id: str,
    body: ScriptRunIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rack = sanity.pick_rack(db, body.rack_serial, body.rack_name)
    if rack is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no rack in inventory")
    node = None
    needle = (body.node or "").strip().lower()
    for n in rack.nodes:
        if not needle or needle in {
            (n.serial or "").strip().lower(),
            (n.hostname or "").strip().lower(),
            (n.bmc_mac or "").strip().lower(),
            n.id.lower(),
            f"n{int(n.index) + 1}",
        }:
            node = n
            if needle:
                break
    if node is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "node not found")
    return sanity.run_script_ssh(node, script_id, timeout=body.timeout)


@router.post("/l11-report")
def l11_report_generate(
    body: ReportIn,
    _user: User = Depends(require_editor),
) -> dict[str, Any]:
    try:
        return l11_report.generate(level=body.level, rack_serial=body.rack_serial, node_serial=body.node_serial)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.get("/l11-reports")
def l11_reports(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    return l11_report.list_reports()

