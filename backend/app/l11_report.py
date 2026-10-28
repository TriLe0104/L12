"""L10 (per-node) and L11 (rack) PDF / CSV / JSON reports from sanity results."""

from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    KeepTogether,
)

from . import argus_tests, sanity

REPORTS_DIR = sanity.DATA_DIR / "reports"

PASS = colors.HexColor("#1b7f3a")
FAIL = colors.HexColor("#b42318")
SKIP = colors.HexColor("#6b6b6b")
INK = colors.HexColor("#1a1a1a")
HAIR = colors.HexColor("#d0d0d0")
WASH = colors.HexColor("#f4f4f1")
SIGNAL = colors.HexColor("#c45c26")


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _now_label() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name or "rack")[:48]


def _status_color(status: str) -> colors.Color:
    s = (status or "").upper()
    if s == "PASS":
        return PASS
    if s in {"FAIL", "STOPPED"}:
        return FAIL
    return SKIP


def list_reports() -> dict[str, Any]:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for path in sorted(REPORTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not path.is_file():
            continue
        low = path.suffix.lower()
        kind = {".pdf": "pdf", ".csv": "csv", ".json": "json"}.get(low, low.lstrip(".") or "file")
        rows.append(
            {
                "name": path.name,
                "path": f"l11:{path.name}",
                "type": kind,
                "serial_number": None,
                "date_created": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "test_runs": ["l11-report"],
                "source": "l12",
                "bytes": path.stat().st_size,
            }
        )
    return {"reports": rows, "count": len(rows), "error": None}


def resolve_file(name: str) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    raw = (name or "").strip()
    if raw.startswith("l11:"):
        raw = raw[4:]
    if not raw or "/" in raw or "\\" in raw or ".." in raw:
        raise FileNotFoundError("bad report name")
    path = (REPORTS_DIR / raw).resolve()
    if path.parent != REPORTS_DIR.resolve() or not path.is_file():
        raise FileNotFoundError(raw)
    return path


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("L12Title", parent=base["Title"], fontSize=16, textColor=INK, spaceAfter=4, leading=20),
        "h": ParagraphStyle("L12H", parent=base["Heading2"], fontSize=12, textColor=INK, spaceBefore=10, spaceAfter=6),
        "body": ParagraphStyle("L12Body", parent=base["BodyText"], fontSize=9, textColor=INK, leading=12),
        "muted": ParagraphStyle("L12Muted", parent=base["BodyText"], fontSize=8, textColor=SKIP, leading=11),
        "cell": ParagraphStyle("L12Cell", parent=base["BodyText"], fontSize=7.5, textColor=INK, leading=10),
    }


def _header_footer(title: str):
    def _draw(canvas, doc) -> None:
        canvas.saveState()
        canvas.setFillColor(SIGNAL)
        canvas.rect(0, letter[1] - 8, letter[0], 8, fill=1, stroke=0)
        canvas.setFillColor(INK)
        canvas.setFont("Times-Bold", 8)
        canvas.drawString(0.6 * inch, 0.4 * inch, "L12 Cluster Testing")
        canvas.setFont("Times-Roman", 8)
        canvas.drawRightString(letter[0] - 0.6 * inch, 0.4 * inch, f"{title}  ·  {doc.page}")
        canvas.setStrokeColor(HAIR)
        canvas.line(0.6 * inch, 0.55 * inch, letter[0] - 0.6 * inch, 0.55 * inch)
        canvas.restoreState()

    return _draw


def _matrix_table(nodes: dict[str, Any], check_ids: list[str], styles: dict[str, ParagraphStyle]) -> Table:
    head = ["Node", "Serial", "Overall"] + [c.upper() for c in check_ids]
    data = [head]
    style_cmds: list[Any] = [
        ("BACKGROUND", (0, 0), (-1, 0), WASH),
        ("FONTNAME", (0, 0), (-1, 0), "Times-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, HAIR),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for i, (label, row) in enumerate(sorted(nodes.items()), start=1):
        overall = str(row.get("overall") or "—")
        line = [
            Paragraph(str(label), styles["cell"]),
            Paragraph(str(row.get("serial") or "—"), styles["cell"]),
            overall,
        ]
        for cid in check_ids:
            chk = (row.get("checks") or {}).get(cid) or {}
            line.append(str(chk.get("status") or "—"))
        data.append(line)
        style_cmds.append(("TEXTCOLOR", (2, i), (2, i), _status_color(overall)))
        style_cmds.append(("FONTNAME", (2, i), (-1, i), "Times-Bold"))
        for col, cid in enumerate(check_ids, start=3):
            chk = (row.get("checks") or {}).get(cid) or {}
            style_cmds.append(("TEXTCOLOR", (col, i), (col, i), _status_color(str(chk.get("status") or ""))))
    table = Table(data, repeatRows=1)
    table.setStyle(TableStyle(style_cmds))
    return table


def _node_failures(row: dict[str, Any], styles: dict[str, ParagraphStyle]) -> list[Any]:
    bits: list[Any] = []
    for cid, chk in (row.get("checks") or {}).items():
        fails = chk.get("failures") or []
        if not fails:
            continue
        bits.append(Paragraph(f"<b>{cid.upper()}</b> — {chk.get('detail') or ''}", styles["body"]))
        for item in fails[:8]:
            bits.append(Paragraph(f"• {item}", styles["muted"]))
    diffs = ((row.get("checks") or {}).get("bom") or {}).get("diffs") or []
    if diffs and not bits:
        bits.append(Paragraph("<b>BOM diffs</b>", styles["body"]))
        for d in diffs[:12]:
            bits.append(Paragraph(f"• {d.get('label')}: ref {d.get('ref')} vs {d.get('sys')}", styles["muted"]))
    return bits


def _build_pdf(payload: dict[str, Any], level: str, node_key: str | None) -> bytes:
    styles = _styles()
    nodes: dict[str, Any] = dict(payload.get("nodes") or {})
    if level == "L10" and node_key:
        keep = {k: v for k, v in nodes.items() if k == node_key or str(v.get("serial") or "") == node_key}
        nodes = keep or nodes
    check_ids = [c["id"] for c in sanity.CHECKS]
    title = "L10 Node Report" if level == "L10" else "L11 Rack Report"
    rack = payload.get("rack_label") or payload.get("rack_serial") or "rack"
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.6 * inch,
        rightMargin=0.6 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title=f"{title} {rack}",
        author="L12 Cluster Testing",
    )
    story: list[Any] = [
        Paragraph(title, styles["title"]),
        Paragraph(
            f"{rack}  ·  serial {payload.get('rack_serial') or '—'}  ·  overall "
            f"<b>{payload.get('overall') or '—'}</b>",
            styles["body"],
        ),
        Paragraph(
            f"Generated {_now_label()}  ·  sanity job {payload.get('job_id') or payload.get('result_file') or '—'}",
            styles["muted"],
        ),
        Spacer(1, 8),
        Paragraph("Sanity matrix", styles["h"]),
        _matrix_table(nodes, check_ids, styles),
    ]
    golden = payload.get("golden") or sanity.golden_status()
    story.append(Paragraph("Golden references", styles["h"]))
    g_line = []
    for key in ("bom", "fw", "sw"):
        info = golden.get(key) or {}
        state = "present" if info.get("exists") else "missing"
        when = info.get("mtime") or "—"
        g_line.append(f"{key.upper()} {state} ({when})")
    story.append(Paragraph("  ·  ".join(g_line), styles["muted"]))

    argus_rows = []
    try:
        bundle = argus_tests.list_reports(payload.get("rack_serial"), payload.get("rack_label"))
        argus_rows = list(bundle.get("reports") or [])[:12]
    except Exception:
        argus_rows = []
    if argus_rows:
        story.append(Paragraph("Argus reports", styles["h"]))
        for row in argus_rows:
            story.append(
                Paragraph(
                    f"{row.get('name') or row.get('path')}  ·  {row.get('type') or ''}  ·  {row.get('date_created') or ''}",
                    styles["muted"],
                )
            )

    for label, row in sorted(nodes.items()):
        block = [
            Paragraph(f"{label}  ·  {row.get('serial') or '—'}  ·  {row.get('hostname') or ''}", styles["h"]),
            Paragraph(
                f"Overall <b>{row.get('overall')}</b>  ·  {row.get('timestamp') or ''}  ·  BMC {row.get('bmc_ip') or '—'}",
                styles["body"],
            ),
        ]
        fails = _node_failures(row, styles)
        if fails:
            block.extend(fails)
        elif row.get("skip_reason"):
            block.append(Paragraph(f"Skipped: {row.get('skip_reason')}", styles["muted"]))
        else:
            block.append(Paragraph("All selected checks passed or skipped.", styles["muted"]))
        story.append(KeepTogether(block))

    story.append(Spacer(1, 12))
    story.append(
        Paragraph(
            "Firmware, software, and BOM compare against project golden files. "
            "PSU, voltage, and SEL are live Redfish health checks. "
            "Unique serial numbers are ignored in BOM compare, matching L11 trilsanitychk.",
            styles["muted"],
        )
    )
    if level == "L11":
        story.append(PageBreak())
        story.append(Paragraph("Per-node BOM snapshot", styles["h"]))
        for label, row in sorted(nodes.items()):
            bom = row.get("bom") or {}
            sysd = bom.get("system") or {}
            fw = bom.get("firmware") or {}
            mem = bom.get("memory") or {}
            gpu = bom.get("accelerators_gpu") or {}
            story.append(Paragraph(f"{label} {sysd.get('system_pn') or ''}", styles["body"]))
            story.append(
                Paragraph(
                    f"SN {sysd.get('system_sn') or '—'}  ·  BIOS {fw.get('bios_version')}  ·  BMC {fw.get('bmc_version')}  ·  "
                    f"{mem.get('summary') or 'mem ?'}  ·  GPUs {len(gpu.get('devices') or [])}",
                    styles["muted"],
                )
            )

    draw = _header_footer(title)
    doc.build(story, onFirstPage=draw, onLaterPages=draw)
    return buf.getvalue()


def _csv_bytes(payload: dict[str, Any]) -> bytes:
    check_ids = [c["id"] for c in sanity.CHECKS]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["node", "serial", "hostname", "overall", *check_ids, "timestamp", "bmc_ip"])
    for label, row in sorted((payload.get("nodes") or {}).items()):
        checks = row.get("checks") or {}
        writer.writerow(
            [
                label,
                row.get("serial") or "",
                row.get("hostname") or "",
                row.get("overall") or "",
                *[str((checks.get(c) or {}).get("status") or "") for c in check_ids],
                row.get("timestamp") or "",
                row.get("bmc_ip") or "",
            ]
        )
    return buf.getvalue().encode("utf-8")


def generate(
    *,
    level: str = "L11",
    rack_serial: str | None = None,
    node_serial: str | None = None,
) -> dict[str, Any]:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = sanity.latest_result_path(rack_serial)
    if path is None:
        raise FileNotFoundError("no sanity results yet — run a sanity check first")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise FileNotFoundError("sanity result is unreadable")
    payload["golden"] = sanity.golden_status()
    level = "L10" if str(level).upper() == "L10" else "L11"
    node_key = (node_serial or "").strip() or None
    if level == "L10" and not node_key:
        nodes = payload.get("nodes") or {}
        if len(nodes) == 1:
            node_key = next(iter(nodes))
        else:
            raise ValueError("L10 report needs a node serial")
    stamp = _now_stamp()
    rack = _safe(str(payload.get("rack_serial") or payload.get("rack_label") or "rack"))
    if level == "L10":
        stem = f"L10_{_safe(node_key or 'node')}_{stamp}"
    else:
        stem = f"L11_{rack}_{stamp}"
    pdf = _build_pdf(payload, level, node_key)
    pdf_path = REPORTS_DIR / f"{stem}.pdf"
    pdf_path.write_bytes(pdf)
    csv_path = REPORTS_DIR / f"{stem}.csv"
    csv_path.write_bytes(_csv_bytes(payload))
    json_path = REPORTS_DIR / f"{stem}.json"
    json_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return {
        "ok": True,
        "level": level,
        "pdf": pdf_path.name,
        "csv": csv_path.name,
        "json": json_path.name,
        "path": f"l11:{pdf_path.name}",
        "overall": payload.get("overall"),
        "rack_serial": payload.get("rack_serial"),
        "rack_label": payload.get("rack_label"),
    }
