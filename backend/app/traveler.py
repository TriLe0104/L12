"""Fill customer traveler templates and build PDF / Office packets.

  - DOCX from ``Traveler_Template.docx`` via python-docx (table cell rewrite)
  - XLSX from ``Work_Order_Rev_B_F004.xlsx`` sheets ``Part 555`` + ``Program sheet``
    via openpyxl
  - PDF Preview + Download share a fast overlay on three pre-rendered Office
    template pages. Office is used only if that persistent background is absent.
"""

from __future__ import annotations

import io
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from typing import Any

from docx import Document
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .models import Activity, PurchaseOrder, User

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates" / "traveler"
DOCX_TEMPLATE = TEMPLATES_DIR / "Traveler_Template.docx"
XLSX_TEMPLATE = TEMPLATES_DIR / "Work_Order_Rev_B_F004.xlsx"
TEMPLATE_BASE_PDF = TEMPLATES_DIR / "Traveler_Template_Base.pdf"
TEMPLATE_BASE_MANIFEST = TEMPLATES_DIR / "Traveler_Template_Base.json"
PDF_CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache" / "traveler-pdf"

PART_SHEET = "Part 555"
PROGRAM_SHEET = "Program sheet"

# Bump whenever fill_docx / fill_xlsx changes what the blank pages look like.
# The source .docx/.xlsx hashes alone cannot catch our own code changes, so a
# background rendered by older code would otherwise survive on disk forever.
TEMPLATE_BASE_VERSION = 2

# Bump whenever overlay coordinates move. Kept separate from the background
# version so a layout tweak invalidates the cached per-PO PDFs without forcing
# a fresh background render, which only Word/Excel COM can produce.
OVERLAY_VERSION = 2

logger = logging.getLogger(__name__)
_TEMPLATE_BASE_LOCK = threading.Lock()

_MONTH_ABBR = (
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
)

def _sync_local_docx_template() -> None:
    """Opt-in one-time import from ~/Downloads into the shipped template path.

    Disabled by default so committed ``Traveler_Template.docx`` (and its hashed
    ``Traveler_Template_Base.pdf``) stay the source of truth in dev and prod.
    Set ``TRAVELER_IMPORT_FROM_DOWNLOADS=1`` to copy
    ``~/Downloads/Traveler Template.docx`` over the repo template when content
    differs.
    """
    flag = os.environ.get("TRAVELER_IMPORT_FROM_DOWNLOADS", "").strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        return
    downloaded = Path.home() / "Downloads" / "Traveler Template.docx"
    if not downloaded.is_file():
        return
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    if DOCX_TEMPLATE.is_file():
        source_hash = hashlib.sha256(downloaded.read_bytes()).digest()
        repo_hash = hashlib.sha256(DOCX_TEMPLATE.read_bytes()).digest()
        if source_hash == repo_hash:
            return
    shutil.copy2(downloaded, DOCX_TEMPLATE)
    logger.info("Imported traveler Word template from %s (TRAVELER_IMPORT_FROM_DOWNLOADS)", downloaded)

# Actions that appear on the activity trail but must not move dashboard Modified.
NON_MODIFYING_ACTIONS = frozenset({"Traveler generated"})

TRAVELER_FIELD_KEYS = (
    "work_order",
    "due_date",
    "mat_dim",
    "sign",
    "po_number",
    "part_name",
    "part_number",
    "qty",
    "finish",
    "inserts",
    "material",
    "material_spec",
    "inspection",
    "part_marking",
    "certificates",
    "notes",
    "dims",
    "part_of",
    "customer",
    "programmer",
    "program_date",
    "created_by",
    "generated_by",
    "generated_at",
    "status",
)

def _s(value: object | None) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()

def _parse_date(value: object | None) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raw = _s(value)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None

def _traveler_date(value: object | None) -> str:
    parsed = _parse_date(value)
    if parsed is None:
        return _s(value)
    return f"{parsed.day:02d}{_MONTH_ABBR[parsed.month - 1]}{parsed.year % 100:02d}"

def _filename_part(value: object | None, fallback: str) -> str:
    safe = re.sub(r'[\/\\:*?"<>|\s]+', "_", _s(value)).strip("._")
    return safe or fallback

def traveler_filename(
    fields: dict[str, Any],
    extension: str,
    *,
    job_no: str,
    generated_at: datetime | None = None,
) -> str:
    """Build a safe Traveler_{job}_{po}_{DDMMMYY}_{HHMMSS} filename."""
    job = _filename_part(job_no or fields.get("work_order"), "Job")
    po_number = _filename_part(fields.get("po_number"), "PO")
    stamp = generated_at or datetime.now().astimezone()
    generated = f"{_traveler_date(stamp)}_{stamp:%H%M%S}"
    return f"Traveler_{job}_{po_number}_{generated}.{extension}"

def _set_cell_text(cell, text: str) -> None:
    """Replace a Word table cell's visible text, keeping the first paragraph."""
    text = text if text is not None else ""
    paragraphs = cell.paragraphs
    if not paragraphs:
        cell.text = text
        return
    first = paragraphs[0]
    if first.runs:
        first.runs[0].text = text
        for run in first.runs[1:]:
            run.text = ""
    else:
        first.text = text
    for para in paragraphs[1:]:
        para.text = ""

def _set_paragraph_text(paragraph, text: str) -> None:
    text = text if text is not None else ""
    if paragraph.runs:
        paragraph.runs[0].text = text
        for run in paragraph.runs[1:]:
            run.text = ""
    else:
        paragraph.text = text

def resolve_created_by(db: Session, po: PurchaseOrder) -> str:
    """Order creator for traveler stamps.

    Prefer the current owner name. If the order is unassigned, fall back to the
    actor on the earliest ``PO created`` activity row. Documented choice so the
    Sign / created_by fields stay stable even after owner reassignment when we
    still have ownership.
    """
    if po.owner is not None and po.owner.name:
        return po.owner.name
    if po.owner_id:
        owner = db.get(User, po.owner_id)
        if owner and owner.name:
            return owner.name
    row = db.scalars(
        select(Activity)
        .options(selectinload(Activity.actor))
        .where(
            Activity.entity_type == "purchase_order",
            Activity.entity_id == po.id,
            Activity.action == "PO created",
            Activity.actor_id.is_not(None),
        )
        .order_by(Activity.created_at.asc(), Activity.id.asc())
        .limit(1)
    ).first()
    if row and row.actor and row.actor.name:
        return row.actor.name
    return ""

MODEL_FILE_SUFFIXES = frozenset(
    {
        ".3dxml", ".3mf", ".asm", ".catpart", ".catproduct", ".dwg", ".dxf",
        ".iges", ".igs", ".ipt", ".jt", ".obj", ".par", ".prt", ".sat",
        ".sldasm", ".sldprt", ".step", ".stl", ".stp", ".x_b", ".x_t",
    }
)

def _part_name_from_model(filename: object | None) -> str:
    """Part name from the uploaded 3D model file, minus the CAD extension.

    PurchaseOrder has no dedicated part-name column, so the model filename is
    the only source. Only known CAD suffixes are stripped, otherwise a part
    number that legitimately contains a dot would be truncated. The traveler
    draft stays editable, so a different name can still be typed per PO.
    """
    raw = _s(filename)
    stem, dot, suffix = raw.rpartition(".")
    if dot and f".{suffix.lower()}" in MODEL_FILE_SUFFIXES:
        return stem.strip()
    return raw

def _inspection_label(value: object) -> str:
    raw = _s(value).lower()
    if "." in raw:
        raw = raw.rsplit(".", 1)[-1]
    return {
        "formal": "Formal Inspection with / Dimensional Report",
        "standard": "Standard Inspection",
        "source": "Source Inspection",
        "none": "None",
    }.get(raw, _s(value) or "Standard Inspection")

def draft_from_po(
    db: Session,
    po: PurchaseOrder,
    *,
    actor: User | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build the editable traveler field map from PO + saved draft overrides."""
    stamp = now or datetime.now().astimezone()
    created_by = resolve_created_by(db, po)
    generated_by = actor.name if actor else ""
    generated_at = stamp.strftime("%Y-%m-%d %H:%M %Z").strip() or stamp.isoformat(timespec="minutes")

    base: dict[str, Any] = {
        "work_order": po.job_no,
        "due_date": po.due_date.isoformat() if po.due_date else "",
        "mat_dim": po.mat_dim or "",
        "sign": created_by,
        "po_number": po.po_number,
        "part_name": _part_name_from_model(po.model_filename) or po.part_number,
        "part_number": po.part_number,
        "qty": po.qty,
        "finish": po.finish or "",
        "inserts": "Yes" if po.hardware else "No",
        "material": po.material or "",
        "material_spec": "Per Drawing",
        "inspection": _inspection_label(po.inspection),
        "part_marking": "None",
        "certificates": "",
        "notes": po.note or "",
        "dims": po.dims or "",
        "part_of": "Part 1 of 1",
        "customer": po.customer or "",
        "programmer": generated_by,
        "program_date": stamp.strftime("%Y-%m-%d"),
        "created_by": created_by,
        "generated_by": generated_by,
        "generated_at": generated_at,
        "status": getattr(po, "status_label", None) or _s(po.status),
    }

    saved = po.traveler_draft if isinstance(getattr(po, "traveler_draft", None), dict) else {}
    # Saved edits win for user-editable fields; generation metadata always refreshes
    # on download/preview unless the client posts explicit overrides.
    editable = {k: v for k, v in saved.items() if k in TRAVELER_FIELD_KEYS and k not in {
        "generated_by",
        "generated_at",
        "created_by",
    }}
    merged = {**base, **editable}
    # Drafts saved before part names were cleaned still hold the raw upload name,
    # so strip the CAD extension on the merged value rather than only the base.
    merged["part_name"] = _part_name_from_model(merged.get("part_name")) or base["part_name"]
    merged["created_by"] = created_by
    merged["sign"] = merged.get("sign") or created_by
    merged["generated_by"] = generated_by
    merged["generated_at"] = generated_at
    if not merged.get("programmer"):
        merged["programmer"] = generated_by
    if not merged.get("program_date"):
        merged["program_date"] = stamp.strftime("%Y-%m-%d")
    return merged

def normalize_draft(raw: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in TRAVELER_FIELD_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if key == "qty":
            try:
                out[key] = int(val)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                out[key] = _s(val)
        else:
            out[key] = _s(val)
    return out

def apply_draft_overrides(base: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in normalize_draft(overrides).items():
        merged[key] = value
    return merged

def fill_docx(fields: dict[str, Any]) -> bytes:
    _sync_local_docx_template()
    if not DOCX_TEMPLATE.is_file():
        raise FileNotFoundError(f"Missing traveler Word template: {DOCX_TEMPLATE}")
    doc = Document(str(DOCX_TEMPLATE))
    tables = doc.tables
    if len(tables) < 6:
        raise RuntimeError("Traveler Word template missing expected tables")

    _set_cell_text(tables[0].rows[0].cells[0], f"           Part ID: {_s(fields.get('part_number'))}")

    t1 = tables[1]
    _set_cell_text(t1.rows[1].cells[0], _s(fields.get("work_order")))
    due = _traveler_date(fields.get("due_date"))
    _set_cell_text(t1.rows[1].cells[1], due)
    material_dims = _s(fields.get("mat_dim"))
    sign = _s(fields.get("sign") or fields.get("created_by"))
    if t1.rows[1].cells[2]._tc is t1.rows[1].cells[3]._tc:
        # The template intentionally merges the input area below Material Dims
        # and Sign. Keep both values visible instead of letting Sign overwrite
        # the dimensions in the shared XML cell.
        shared_value = f"{material_dims}    {sign}".strip()
        _set_cell_text(t1.rows[1].cells[2], shared_value)
    else:
        _set_cell_text(t1.rows[1].cells[2], material_dims)
        _set_cell_text(t1.rows[1].cells[3], sign)

    t2 = tables[2]
    _set_cell_text(t2.rows[1].cells[0], _s(fields.get("po_number")))
    _set_cell_text(t2.rows[1].cells[1], _s(fields.get("part_name") or fields.get("part_number")))
    _set_cell_text(t2.rows[1].cells[2], _s(fields.get("qty")))

    t3 = tables[3]
    _set_cell_text(t3.rows[1].cells[0], _s(fields.get("finish")))
    _set_cell_text(t3.rows[1].cells[1], _s(fields.get("inserts")) or "No")
    _set_cell_text(t3.rows[1].cells[2], _s(fields.get("material")))

    t4 = tables[4]
    _set_cell_text(t4.rows[1].cells[0], _inspection_label(fields.get("inspection")))
    _set_cell_text(t4.rows[1].cells[1], _s(fields.get("part_marking")) or "None")
    _set_cell_text(t4.rows[1].cells[2], _s(fields.get("certificates")))

    # Generation metadata belongs to the activity trail, not the customer's
    # visible Notes box.
    _set_cell_text(tables[5].rows[1].cells[0], _s(fields.get("notes")) or "None")

    # Body lines under the drawings (part-of + stock dims).
    paras = [p for p in doc.paragraphs if p.text.strip()]
    if len(paras) >= 1:
        _set_paragraph_text(paras[0], f"\t{_s(fields.get('part_of')) or 'Part 1 of 1'}")
    if len(paras) >= 2:
        _set_paragraph_text(paras[1], f"\t{_s(fields.get('dims'))}")

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()

def _xlsx_set(ws, coord: str, value: object) -> None:
    ws[coord] = value if value is not None and value != "" else None

def _clear_workbook_artifacts(part, prog) -> None:
    """Blank template cells that cannot survive an openpyxl round-trip.

    ``Part 555!A4`` (merged A4:O8, under the TVM logo) holds an Excel
    image-in-cell rich value, stored in the file as an ``#VALUE!`` error plus
    a value-metadata pointer. openpyxl drops the rich-value parts, so the raw
    error is all that is left and Excel renders a literal ``#VALUE!``.
    ``Program sheet!A2`` mirrors that cell and inherits the error. Both are
    cleared so the packet shows an empty block instead.

    ``Part 555!Z56`` ships with a hardcoded ``PAUL`` in the Digitize Packet
    BY column — sample data from the source work order, not boilerplate, since
    every other BY cell in that column is blank.
    """
    for coord in ("A4", "Z56"):
        part[coord] = None
    prog["A2"] = None

def fill_xlsx(fields: dict[str, Any]) -> bytes:
    if not XLSX_TEMPLATE.is_file():
        raise FileNotFoundError(f"Missing traveler Excel template: {XLSX_TEMPLATE}")
    wb = load_workbook(str(XLSX_TEMPLATE))
    if PART_SHEET not in wb.sheetnames:
        raise RuntimeError(f"Excel template missing sheet {PART_SHEET!r}")
    if PROGRAM_SHEET not in wb.sheetnames:
        raise RuntimeError(f"Excel template missing sheet {PROGRAM_SHEET!r}")

    part = wb[PART_SHEET]
    _xlsx_set(part, "X1", _s(fields.get("work_order")))
    _xlsx_set(part, "T2", _s(fields.get("po_number")))
    # Dates go in as DDMMMYY text rather than serial + number format: Excel's
    # MMM token renders "Aug", and the traveler convention (Word page, download
    # filenames) is uppercase, so text keeps every page of the packet identical.
    _xlsx_set(part, "AB2", _traveler_date(fields.get("due_date")))
    _xlsx_set(part, "T3", _s(fields.get("part_number")))
    qty = fields.get("qty")
    try:
        _xlsx_set(part, "AE3", int(qty))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        _xlsx_set(part, "AE3", _s(qty))
    _xlsx_set(part, "W5", _s(fields.get("material")))
    _xlsx_set(part, "W6", _s(fields.get("material_spec")) or "Per Drawing")
    # Order release BY + date. AC13 ships as =TODAY(); a live formula would bake
    # the render day into the cached background forever, so it is replaced.
    _xlsx_set(part, "Z13", _s(fields.get("created_by") or fields.get("sign")))
    _xlsx_set(
        part,
        "AC13",
        _traveler_date(fields.get("program_date") or fields.get("generated_at")),
    )
    finish = _s(fields.get("finish"))
    _xlsx_set(part, "D44", finish.lower() if finish.lower() in {"none", ""} else finish or "none")

    prog = wb[PROGRAM_SHEET]
    # Labels live in A4 / E4; values go beside them.
    _xlsx_set(prog, "B4", _s(fields.get("programmer") or fields.get("generated_by")))
    _xlsx_set(
        prog,
        "F4",
        _traveler_date(fields.get("program_date") or fields.get("generated_at")),
    )
    _clear_workbook_artifacts(part, prog)

    # Excel otherwise tiles the wide shop form across multiple PDF pages even
    # though each template sheet is designed as one printed packet page.
    for sheet in (part, prog):
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 1

    # Drop non-packet sheets from the download to keep the packet focused.
    for name in list(wb.sheetnames):
        if name not in {PART_SHEET, PROGRAM_SHEET, "Mat types"}:
            wb.remove(wb[name])
    if "Mat types" in wb.sheetnames:
        wb["Mat types"].sheet_state = "hidden"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

def _build_reportlab_pdf(fields: dict[str, Any]) -> bytes:
    """Fast 3-page traveler PDF used for both Preview and Download."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.6 * inch,
        rightMargin=0.6 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title=f"Traveler {_s(fields.get('work_order'))}",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "TravTitle",
        parent=styles["Heading1"],
        fontSize=16,
        spaceAfter=8,
        textColor=colors.HexColor("#1a2332"),
    )
    h2 = ParagraphStyle(
        "TravH2",
        parent=styles["Heading2"],
        fontSize=12,
        spaceBefore=10,
        spaceAfter=6,
        textColor=colors.HexColor("#243447"),
    )
    body = ParagraphStyle("TravBody", parent=styles["Normal"], fontSize=9, leading=12)
    small = ParagraphStyle("TravSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    def kv_table(rows: list[tuple[str, str]]) -> Table:
        data = [[Paragraph(f"<b>{k}</b>", body), Paragraph(v or "—", body)] for k, v in rows]
        t = Table(data, colWidths=[2.1 * inch, 5.0 * inch])
        t.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#c5ced8")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#dce3ea")),
                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f3f6f9")),
                ]
            )
        )
        return t

    story: list[Any] = []
    story.append(Paragraph("Traveler — Page 1", title))
    story.append(
        Paragraph(
            f"Generated {_s(fields.get('generated_at'))} by {_s(fields.get('generated_by'))}"
            f" · Order created by {_s(fields.get('created_by'))}",
            small,
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        kv_table(
            [
                ("Part ID", _s(fields.get("part_number"))),
                ("Work Order #", _s(fields.get("work_order"))),
                ("Due Date", _traveler_date(fields.get("due_date"))),
                ("Material Dims", _s(fields.get("mat_dim"))),
                ("Sign / Created by", _s(fields.get("sign") or fields.get("created_by"))),
                ("Customer PO #", _s(fields.get("po_number"))),
                ("Part Name", _s(fields.get("part_name"))),
                ("Quantity", _s(fields.get("qty"))),
                ("Finish", _s(fields.get("finish"))),
                ("Inserts", _s(fields.get("inserts"))),
                ("Material", _s(fields.get("material"))),
                ("Inspection", _s(fields.get("inspection"))),
                ("Part Marking", _s(fields.get("part_marking"))),
                ("Certificates", _s(fields.get("certificates"))),
                ("Stock dims", _s(fields.get("dims"))),
                ("Part of", _s(fields.get("part_of"))),
                ("Customer", _s(fields.get("customer"))),
                ("Status", _s(fields.get("status"))),
                ("Notes", _s(fields.get("notes"))),
            ]
        )
    )

    story.append(PageBreak())
    story.append(Paragraph("Work Order — Part 555", title))
    story.append(Paragraph("Traveler Part 555 summary (Excel packet fields).", small))
    story.append(Spacer(1, 8))
    story.append(
        kv_table(
            [
                ("WORK ORDER #", _s(fields.get("work_order"))),
                ("PO #", _s(fields.get("po_number"))),
                ("Due", _traveler_date(fields.get("due_date"))),
                ("Part #", _s(fields.get("part_number"))),
                ("QTY", _s(fields.get("qty"))),
                ("Material Type", _s(fields.get("material"))),
                ("Material Specification", _s(fields.get("material_spec"))),
                ("Order release BY", _s(fields.get("created_by"))),
                ("Finishing", _s(fields.get("finish"))),
            ]
        )
    )
    story.append(Paragraph("Operations (full layout in .xlsx download)", h2))
    ops = [
        "01 Order release",
        "02 SAW, RECEIVING MATERIAL",
        "03 MILL OP1",
        "04 MILL OP2",
        "05 MILL OP3",
        "06 DEBURRING",
        "07 PRE PLATING QC INSPECTION",
        "08 FINISHING",
        "09 QC- FINAL INSPECTION",
        "10 PACKING & SHIPPING",
        "11 Digitize Packet",
    ]
    for op in ops:
        story.append(Paragraph(f"• {op}", body))

    story.append(PageBreak())
    story.append(Paragraph("Program sheet", title))
    story.append(Paragraph("Traveler Program sheet summary (Excel packet fields).", small))
    story.append(Spacer(1, 8))
    story.append(
        kv_table(
            [
                ("PO #", _s(fields.get("po_number"))),
                ("PART #", _s(fields.get("part_number"))),
                ("QTY", _s(fields.get("qty"))),
                ("Programmer", _s(fields.get("programmer"))),
                (
                    "Date",
                    _traveler_date(
                        fields.get("program_date") or fields.get("generated_at")
                    ),
                ),
            ]
        )
    )
    story.append(Spacer(1, 14))
    story.append(
        Paragraph(
            "Download Word or Excel for the original shop templates.",
            small,
        )
    )

    doc.build(story)
    return buf.getvalue()

def _source_template_hashes() -> dict[str, str]:
    hashes: dict[str, str] = {}
    for path in (DOCX_TEMPLATE, XLSX_TEMPLATE):
        if not path.is_file():
            raise FileNotFoundError(f"Missing traveler template: {path}")
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def _template_base_is_current() -> bool:
    if not TEMPLATE_BASE_PDF.is_file() or not TEMPLATE_BASE_MANIFEST.is_file():
        return False
    try:
        manifest = json.loads(TEMPLATE_BASE_MANIFEST.read_text(encoding="utf-8"))
        return (
            manifest.get("layout_version") == TEMPLATE_BASE_VERSION
            and manifest.get("source_sha256") == _source_template_hashes()
            and manifest.get("base_pdf_sha256")
            == hashlib.sha256(TEMPLATE_BASE_PDF.read_bytes()).hexdigest()
        )
    except (OSError, json.JSONDecodeError):
        return False


def _convert_office_once(source: Path, output: Path) -> None:
    """One-time canonical background conversion; never used per PDF request."""
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise RuntimeError("PowerShell is unavailable for traveler template background")
    if source.suffix.lower() == ".docx":
        script = r"""
$ErrorActionPreference = 'Stop'
$app = $null
$document = $null
try {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  $app.DisplayAlerts = 0
  $document = $app.Documents.Open($env:TRAVELER_SOURCE)
  $document.ExportAsFixedFormat($env:TRAVELER_OUTPUT, 17)
} finally {
  if ($document) { $document.Close(0) }
  if ($app) { $app.Quit() }
  if ($document) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
}
"""
    elif source.suffix.lower() == ".xlsx":
        script = r"""
$ErrorActionPreference = 'Stop'
$app = $null
$workbook = $null
try {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $workbook = $app.Workbooks.Open($env:TRAVELER_SOURCE)
  $app.CalculateFull()
  $workbook.ExportAsFixedFormat(0, $env:TRAVELER_OUTPUT, 0, $true, $false)
} finally {
  if ($workbook) { $workbook.Close($false) }
  if ($app) { $app.Quit() }
  if ($workbook) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) }
  if ($app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
}
"""
    else:
        raise ValueError(f"Unsupported Office template: {source}")
    env = os.environ.copy()
    env["TRAVELER_SOURCE"] = str(source.resolve())
    env["TRAVELER_OUTPUT"] = str(output.resolve())
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        capture_output=True,
        check=False,
        env=env,
        timeout=60,
        creationflags=0x08000000,
    )
    if result.returncode != 0 or not output.is_file() or output.stat().st_size < 500:
        error = result.stderr.decode(errors="replace").strip()
        raise RuntimeError(f"Office template background conversion failed: {error}")


def _generate_template_base() -> None:
    """Render blank Word + Excel templates once and persist their three pages."""
    from pypdf import PdfReader, PdfWriter

    blank = {key: "\u200b" for key in TRAVELER_FIELD_KEYS}
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="traveler-base-") as temp_name:
        temp = Path(temp_name)
        docx = temp / "blank.docx"
        xlsx = temp / "blank.xlsx"
        word_pdf = temp / "word.pdf"
        excel_pdf = temp / "excel.pdf"
        docx.write_bytes(fill_docx(blank))
        xlsx.write_bytes(fill_xlsx(blank))
        _convert_office_once(docx, word_pdf)
        _convert_office_once(xlsx, excel_pdf)
        writer = PdfWriter()
        for path in (word_pdf, excel_pdf):
            reader = PdfReader(str(path))
            for page in reader.pages:
                writer.add_page(page)
        if len(writer.pages) != 3:
            raise RuntimeError(
                f"Traveler template background must have 3 pages; got {len(writer.pages)}"
            )
        temp_base = temp / TEMPLATE_BASE_PDF.name
        with temp_base.open("wb") as stream:
            writer.write(stream)
        payload = temp_base.read_bytes()
        manifest = {
            "renderer": "Microsoft Word and Excel COM (one-time background)",
            "layout_version": TEMPLATE_BASE_VERSION,
            "source_sha256": _source_template_hashes(),
            "base_pdf_sha256": hashlib.sha256(payload).hexdigest(),
            "pages": ["Traveler", PART_SHEET, PROGRAM_SHEET],
        }
        temp_manifest = temp / TEMPLATE_BASE_MANIFEST.name
        temp_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        temp_base.replace(TEMPLATE_BASE_PDF)
        temp_manifest.replace(TEMPLATE_BASE_MANIFEST)
        logger.info("Generated persistent 3-page traveler template background")


def _ensure_template_base() -> bool:
    if _template_base_is_current():
        return True
    with _TEMPLATE_BASE_LOCK:
        if _template_base_is_current():
            return True
        try:
            _generate_template_base()
            return True
        except Exception:
            logger.exception("Traveler template background unavailable; using plain fallback")
            return False


def _build_template_overlay_pdf(fields: dict[str, Any]) -> bytes:
    """Overlay live fields onto the persisted canonical template pages."""
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    if not _ensure_template_base():
        raise RuntimeError("Traveler template background is unavailable")

    regular = "TravelerCalibri"
    bold = "TravelerCalibriBold"
    fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    try:
        pdfmetrics.getFont(regular)
    except KeyError:
        if (fonts / "calibri.ttf").is_file():
            pdfmetrics.registerFont(TTFont(regular, str(fonts / "calibri.ttf")))
            pdfmetrics.registerFont(TTFont(bold, str(fonts / "calibrib.ttf")))
        else:
            regular, bold = "Helvetica", "Helvetica-Bold"

    base_reader = PdfReader(str(TEMPLATE_BASE_PDF))
    if len(base_reader.pages) != 3:
        raise RuntimeError("Traveler template background is not three pages")
    overlay_buf = io.BytesIO()
    c = canvas.Canvas(overlay_buf, pagesize=(612, 792), pageCompression=1)

    def fitted(text: str, font: str, size: float, max_width: float) -> float:
        width = pdfmetrics.stringWidth(text, font, size)
        return max(6.5, min(size, size * max_width / width)) if width else size

    def left(
        value: object,
        x: float,
        y1: float,
        *,
        font: str = regular,
        size: float = 11.04,
        width: float = 999,
    ) -> None:
        text = _s(value)
        if not text:
            return
        actual = fitted(text, font, size, width)
        c.setFont(font, actual)
        c.drawString(x, 792 - y1 + actual * 0.25, text)

    def center(
        value: object,
        x: float,
        y1: float,
        *,
        font: str = regular,
        size: float = 11.04,
        width: float = 999,
    ) -> None:
        text = _s(value)
        if not text:
            return
        actual = fitted(text, font, size, width)
        c.setFont(font, actual)
        c.drawCentredString(x, 792 - y1 + actual * 0.25, text)

    def wrapped(
        value: object,
        x: float,
        y1: float,
        *,
        size: float = 11.04,
        width: float,
        lines: int = 2,
        leading: float = 13.44,
    ) -> None:
        words = _s(value).split()
        rows: list[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if (
                current
                and pdfmetrics.stringWidth(candidate, regular, size) > width
                and len(rows) < lines - 1
            ):
                rows.append(current)
                current = word
            else:
                current = candidate
        if current:
            rows.append(current)
        for index, row in enumerate(rows[:lines]):
            center(row, x, y1 + leading * index, size=size, width=width)

    # Word Traveler. Every table cell in this template is centre-aligned, so the
    # column centres are taken from the rendered headings and every data value
    # sits on the centre of the heading above it. Material Dims and Sign share
    # one merged input cell, hence their own centres rather than the merge's.
    col_left, col_mid, col_right = 126.3, 306.1, 485.9
    col_mat_dims, col_sign = 450.4, 540.3
    # The two lines under the drawing are laid out by a centre tab stop.
    body_tab = 468.1

    c.setFillColorRGB(1, 1, 1)
    c.rect(380, 792 - 52, 170, 22, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    center(f"Part ID: {_s(fields.get('part_number'))}", 449, 49.22, size=12, width=160)
    center(fields.get("part_of") or "Part 1 of 1", body_tab, 178.60, size=12, width=130)
    center(fields.get("dims"), body_tab, 193.24, size=12, width=130)
    center(fields.get("work_order"), col_left, 258.25, width=165)
    center(_traveler_date(fields.get("due_date")), col_mid, 258.25, width=170)
    center(fields.get("mat_dim"), col_mat_dims, 259.48, size=12, width=110)
    center(
        fields.get("sign") or fields.get("created_by"),
        col_sign,
        259.48,
        size=12,
        width=60,
    )
    center(fields.get("po_number"), col_left, 335.68, width=165)
    center(fields.get("part_name") or fields.get("part_number"), col_mid, 335.68, width=175)
    center(fields.get("qty"), col_right, 335.68, width=160)
    center(fields.get("finish"), col_left, 406.48, width=165)
    center(fields.get("inserts") or "No", col_mid, 406.48, width=165)
    center(fields.get("material"), col_right, 406.48, width=160)
    wrapped(_inspection_label(fields.get("inspection")), col_left, 496.74, width=165)
    center(fields.get("part_marking") or "None", col_mid, 496.74, width=165)
    wrapped(fields.get("certificates"), col_right, 496.74, width=155)
    wrapped(
        fields.get("notes") or "None",
        col_mid,
        642.15,
        size=9.96,
        width=500,
        lines=3,
        leading=12.2,
    )
    c.showPage()

    # Excel Part 555. Every input cell here is centre-aligned in the workbook,
    # so values are centred on the merged cell bounded by the printed rules.
    center(fields.get("work_order"), 443.7, 67.94, size=10.56, width=112)
    center(fields.get("po_number"), 391.3, 84.26, font=bold, size=11.52, width=105)
    center(_traveler_date(fields.get("due_date")), 511.0, 84.26, size=11.52, width=68)
    center(fields.get("part_number"), 404.9, 99.02, font=bold, size=11.52, width=132)
    center(fields.get("qty"), 532.4, 99.50, font=bold, size=11.52, width=28)
    center(fields.get("material"), 456.0, 120.74, font=bold, size=10.56, width=176)
    center(fields.get("material_spec") or "Per Drawing", 456.0, 146.54, size=10.56, width=176)
    center(fields.get("created_by") or fields.get("sign"), 447.2, 205.34, size=10.56, width=50)
    center(
        _traveler_date(fields.get("program_date") or fields.get("generated_at")),
        516.4,
        205.34,
        size=10.56,
        width=58,
    )
    center(fields.get("finish") or "none", 172.9, 607.18, font=bold, size=7.68, width=120)
    c.showPage()

    # Excel Program sheet. Unlike Part 555 this sheet left-aligns the PO, part
    # and date cells and centres only QTY and Programer, so the overlay follows
    # each cell's own alignment instead of centring everything.
    left(fields.get("po_number"), 242.7, 99.83, font=bold, size=10.92, width=120)
    left(fields.get("part_number"), 242.7, 125.99, font=bold, size=10.92, width=120)
    center(fields.get("qty"), 491.4, 126.47, font=bold, size=10.92, width=110)
    center(
        fields.get("programmer") or fields.get("generated_by"),
        279.4,
        156.71,
        size=10.92,
        width=190,
    )
    left(
        _traveler_date(fields.get("program_date") or fields.get("generated_at")),
        433.2,
        157.19,
        size=10.92,
        width=80,
    )
    c.save()

    overlay_reader = PdfReader(io.BytesIO(overlay_buf.getvalue()))
    writer = PdfWriter()
    for index, page in enumerate(base_reader.pages):
        page.merge_page(overlay_reader.pages[index])
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _pdf_cache_key(fields: dict[str, Any]) -> str:
    base_hash = (
        hashlib.sha256(TEMPLATE_BASE_PDF.read_bytes()).hexdigest()
        if TEMPLATE_BASE_PDF.is_file()
        else "missing"
    )
    raw = json.dumps(
        {"fields": fields, "base": base_hash, "overlay": OVERLAY_VERSION},
        sort_keys=True,
        default=str,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _build_pdf_with_source(fields: dict[str, Any]) -> tuple[bytes, str]:
    if _ensure_template_base():
        key = _pdf_cache_key(fields)
        path = PDF_CACHE_DIR / f"{key}.pdf"
        if path.is_file() and path.stat().st_size > 500:
            return path.read_bytes(), "template_overlay_cache"
        try:
            payload = _build_template_overlay_pdf(fields)
            PDF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_bytes(payload)
            temp.replace(path)
            return payload, "template_overlay"
        except Exception:
            logger.exception("Traveler template overlay failed; using plain fallback")
    return _build_reportlab_pdf(fields), "reportlab_fallback"


def build_pdf(fields: dict[str, Any], *, po_id: str | None = None) -> bytes:
    """Template-background PDF shared by Preview and Download."""
    del po_id
    return _build_pdf_with_source(fields)[0]

def build_preview_pdf(fields: dict[str, Any], *, po_id: str) -> tuple[bytes, str]:
    """Same template-background PDF as download; returns (bytes, source)."""
    del po_id
    return _build_pdf_with_source(fields)

def build_zip(
    fields: dict[str, Any],
    *,
    job_no: str,
    po_id: str | None = None,
    generated_at: datetime | None = None,
) -> bytes:
    stamp = generated_at or datetime.now().astimezone()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            traveler_filename(fields, "docx", job_no=job_no, generated_at=stamp),
            fill_docx(fields),
        )
        zf.writestr(
            traveler_filename(fields, "xlsx", job_no=job_no, generated_at=stamp),
            fill_xlsx(fields),
        )
        zf.writestr(
            traveler_filename(fields, "pdf", job_no=job_no, generated_at=stamp),
            build_pdf(fields, po_id=po_id),
        )
    return buf.getvalue()

def content_for_format(
    fmt: str,
    fields: dict[str, Any],
    *,
    job_no: str,
    po_id: str | None = None,
) -> tuple[bytes, str, str]:
    """Return (bytes, media_type, filename) for pdf|docx|xlsx|zip."""
    fmt = fmt.lower().strip()
    generated_at = datetime.now().astimezone()
    if fmt == "pdf":
        return (
            build_pdf(fields, po_id=po_id),
            "application/pdf",
            traveler_filename(fields, "pdf", job_no=job_no, generated_at=generated_at),
        )
    if fmt == "docx":
        return (
            fill_docx(fields),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            traveler_filename(fields, "docx", job_no=job_no, generated_at=generated_at),
        )
    if fmt in {"xlsx", "excel"}:
        return (
            fill_xlsx(fields),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            traveler_filename(fields, "xlsx", job_no=job_no, generated_at=generated_at),
        )
    if fmt == "zip":
        return (
            build_zip(fields, job_no=job_no, po_id=po_id, generated_at=generated_at),
            "application/zip",
            traveler_filename(fields, "zip", job_no=job_no, generated_at=generated_at),
        )
    raise ValueError(f"Unknown traveler format {fmt!r}")
