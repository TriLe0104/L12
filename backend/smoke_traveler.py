"""Traveler packet smoke: in-process template fill plus the live API download.

Run with the backend venv, from backend/ or the repo root:
  .\\.venv\\Scripts\\python.exe smoke_traveler.py

Part 1 fills the Word / Excel templates and the PDF overlay in-process and
guards the packet defects that were fixed by hand, since none of them can be
caught by a byte-size check:

  * no ``#VALUE!`` left by the Excel image-in-cell openpyxl round-trip
  * no sample ``PAUL`` in the Digitize Packet BY column
  * uppercase ``DDMMMYY`` dates on every page (never ``Aug`` or ISO)
  * CAD extension stripped from the part name
  * Material Dims and Sign drawn in their own columns, not one merged cell

Part 2 hits the API on :8000 as admin and asserts the
``{po}_{part}_{mm-dd-yy}.ext`` download filename plus the
activity trail. It only reads one PO (never J-55) and never persists a draft.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from io import BytesIO
from datetime import date, datetime
from pathlib import Path

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from app.traveler import (  # noqa: E402
    DOCX_TEMPLATE,
    PART_SHEET,
    PROGRAM_SHEET,
    TEMPLATE_BASE_PDF,
    XLSX_TEMPLATE,
    _part_name_from_model,
    _part_name_from_stp,
    _prepare_photo,
    build_preview_pdf,
    content_for_format,
    fill_docx,
    fill_xlsx,
    traveler_filename,
)

API = "http://127.0.0.1:8000"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
AVOID_JOBS = {"J-55"}
FORMATS = ("pdf", "docx", "xlsx", "zip")

# Sample data baked into the source work order, plus the openpyxl round-trip
# artifact. Either one reaching a customer packet is a hard failure.
BANNED = (re.compile(r"#VALUE!"), re.compile(r"\bPAUL\b"))
# Title-case or ISO dates mean a _traveler_date call was missed somewhere.
BAD_DATE = re.compile(r"\d{2}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\d{2}|\d{4}-\d{2}-\d{2}")

# Word column divider between the Material Dims and Sign headings, in points
# from the left edge of the page.
SIGN_COLUMN_X = 511.85

FIELDS = {
    "work_order": "260806-01",
    "due_date": date(2026, 8, 20).isoformat(),
    "mat_dim": "1.25 x 1.7 x .500",
    "sign": "Tri Le",
    "po_number": "PO-SMOKE-1",
    "part_name": "SMOKE_PART",
    "part_number": "SMOKE-001",
    "qty": 2,
    "finish": "CLEAR ANODIZE",
    "inserts": "No",
    "material": "AL 6061-T6",
    "material_spec": "Per Drawing",
    "inspection": "Standard Inspection",
    "part_marking": "None",
    "certificates": "",
    "notes": "smoke traveler",
    "dims": "1.0 x 1.0 x 0.5 in",
    "part_of": "Part 1 of 1",
    "customer": "Smoke Test Co",
    "programmer": "Tri Le",
    "program_date": "2026-08-06",
    "created_by": "Tri Le",
    "generated_by": "Tri Le",
    "generated_at": datetime(2026, 8, 6).astimezone().strftime("%Y-%m-%d %H:%M %Z"),
    "status": "Running",
}


def name_pattern(job: str, po_number: str, extension: str) -> re.Pattern[str]:
    """{po}_{part}_{mm-dd-yy}[_(Part x of n)].ext"""
    del job
    return re.compile(
        rf"^{re.escape(po_number)}_.+"
        rf"_\d{{2}}-\d{{2}}-\d{{2}}"
        rf"(?:_\(Part \d+ of \d+\))?"
        rf"\.{re.escape(extension)}$"
    )


def lower_keys(headers) -> dict[str, str]:
    """Header names are case-insensitive and Starlette sends them lowercase."""
    return {key.lower(): value for key, value in headers.items()}


def call(
    method: str,
    path: str,
    body: dict | None = None,
    token: str | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method)
    if data:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            return response.status, response.read(), lower_keys(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), lower_keys(exc.headers)


def pdf_pages_text(payload: bytes) -> list[str]:
    return [page.extract_text() or "" for page in PdfReader(BytesIO(payload)).pages]


def docx_text(payload: bytes) -> str:
    doc = Document(BytesIO(payload))
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


def xlsx_text(payload: bytes) -> str:
    workbook = load_workbook(BytesIO(payload))
    parts: list[str] = []
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows(values_only=True):
            parts.extend(str(value) for value in row if value is not None)
    return "\n".join(parts)


def assert_clean(label: str, text: str) -> None:
    for pattern in BANNED:
        found = pattern.search(text)
        assert not found, f"{label}: banned text {found.group(0)!r}"
    bad_date = BAD_DATE.search(text)
    assert not bad_date, f"{label}: non-DDMMMYY date {bad_date.group(0)!r}"


def check_columns(payload: bytes) -> None:
    """Material Dims and Sign must be separate runs in their own columns.

    The Word template merges the input row beneath the two headings, so a
    regression shows up as one concatenated run instead of two values sitting
    on either side of the column divider.
    """
    runs: list[tuple[float, float, str]] = []

    def visit(text: str, _cm, tm, _font, _size) -> None:
        stripped = text.strip()
        if stripped:
            runs.append((tm[4], tm[5], stripped))

    PdfReader(BytesIO(payload)).pages[0].extract_text(visitor_text=visit)
    dims = [r for r in runs if r[2] == FIELDS["mat_dim"]]
    sign = [r for r in runs if r[2] == FIELDS["sign"]]
    assert dims, "Material Dims value missing from page 1"
    assert sign, "Sign value missing from page 1"
    dims_x, dims_y, _ = dims[0]
    sign_x, sign_y, _ = sign[0]
    assert dims_x < SIGN_COLUMN_X, f"Material Dims spilled into Sign column at x={dims_x:.1f}"
    assert sign_x > SIGN_COLUMN_X, f"Sign sits in the Material Dims column at x={sign_x:.1f}"
    assert abs(dims_y - sign_y) < 1, "Material Dims and Sign are not on the same row"
    print(f"  columns: dims x={dims_x:.1f} sign x={sign_x:.1f} (divider {SIGN_COLUMN_X})")


def check_photos() -> None:
    """Card photo lands under the work-order logo and above Programmer."""
    from PIL import Image as PILImage

    from app.storage import UPLOAD_DIR

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = "smoke_part_photo.png"
    path = UPLOAD_DIR / name
    PILImage.new("RGB", (80, 60), (200, 30, 30)).save(path)
    fields = {**FIELDS, "thumbnail_url": f"/uploads/{name}"}
    xlsx = fill_xlsx(fields)
    workbook = load_workbook(BytesIO(xlsx))
    part, program = workbook[PART_SHEET], workbook[PROGRAM_SHEET]
    assert len(part._images) >= 2, (
        f"work order should keep the TVM logo and add the part photo, got {len(part._images)}"
    )
    assert len(program._images) >= 1, (
        f"program sheet missing the part photo, got {len(program._images)}"
    )
    pdf, _source = build_preview_pdf(fields, po_id="smoke-photo")
    pages = PdfReader(BytesIO(pdf)).pages
    assert len(pages[1].images) >= 2, (
        f"pdf work order should show stretched logo + part photo, got {len(pages[1].images)}"
    )
    assert len(pages[2].images) >= 1, (
        f"pdf program sheet missing the part photo, got {len(pages[2].images)}"
    )
    print(
        f"  photos: xlsx work-order={len(part._images)} program={len(program._images)} "
        f"pdf wo={len(pages[1].images)} prog={len(pages[2].images)}"
    )
    anchor = program._images[0].anchor
    assert getattr(anchor, "to", None) is not None, "program photo is not pinned to A2:A3"
    assert int(anchor.to.row) == 3, f"program photo to.row={anchor.to.row}, expected 3 (end of A3)"
    check_program_photo_clip(fields)
    check_photo_alpha()


def check_program_photo_clip(fields: dict) -> None:
    """A tall photo must stay above the Programmer rule on the program sheet."""
    import pymupdf
    from PIL import Image as PILImage

    from app.storage import UPLOAD_DIR

    name = "smoke_part_photo_tall.png"
    PILImage.new("RGB", (60, 160), (200, 30, 30)).save(UPLOAD_DIR / name)
    tall = {**fields, "thumbnail_url": f"/uploads/{name}"}
    pdf, _source = build_preview_pdf(tall, po_id="smoke-photo-clip")
    page = pymupdf.open(stream=pdf, filetype="pdf")[2]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
    img = PILImage.frombytes("RGB", (pix.width, pix.height), pix.samples)
    # Programmer top rule is y=132.6pt; sample a strip just below it in col A.
    below = img.crop((110, int(134 * 2), 340, int(154 * 2)))
    pixels = list(below.getdata())
    reds = sum(1 for p in pixels if p[0] > 140 and p[1] < 80 and p[2] < 80)
    assert reds / max(len(pixels), 1) < 0.02, (
        f"program-sheet photo spilled into Programmer ({reds}/{len(pixels)} red px)"
    )
    inside = img.crop((110, int(82 * 2), 340, int(130 * 2)))
    inside_px = list(inside.getdata())
    inside_reds = sum(1 for p in inside_px if p[0] > 140 and p[1] < 80 and p[2] < 80)
    assert inside_reds / max(len(inside_px), 1) > 0.05, "program-sheet photo missing from A2:A3"
    print(f"  program clip: inside_red={inside_reds/len(inside_px):.2f} below_red={reds/len(pixels):.2f}")


def _rgba_cutout() -> bytes:
    from PIL import Image as PILImage

    img = PILImage.new("RGBA", (80, 60), (0, 0, 0, 0))
    for x in range(20, 60):
        for y in range(10, 50):
            img.putpixel((x, y), (200, 30, 30, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def check_photo_alpha() -> None:
    """Transparent uploads must stay transparent in Word, Excel, and the helpers."""
    from PIL import Image as PILImage

    from app.storage import UPLOAD_DIR

    raw = _rgba_cutout()
    pil, has_alpha = _prepare_photo(raw)
    assert has_alpha and pil.mode == "RGBA", (has_alpha, pil.mode)
    assert pil.getpixel((0, 0))[3] == 0, "transparent corner was flattened"
    assert pil.getpixel((40, 30))[3] == 255

    opaque = PILImage.new("RGB", (16, 16), (10, 20, 30))
    jpeg = BytesIO()
    opaque.save(jpeg, format="JPEG", quality=90)
    rgb, jpeg_alpha = _prepare_photo(jpeg.getvalue())
    assert not jpeg_alpha and rgb.mode == "RGB", (jpeg_alpha, rgb.mode)

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = "smoke_part_alpha.png"
    (UPLOAD_DIR / name).write_bytes(raw)
    fields = {**FIELDS, "thumbnail_url": f"/uploads/{name}"}

    docx = fill_docx(fields)
    word = Document(BytesIO(docx))
    blobs = [rel.target_part.blob for rel in word.part.rels.values() if "image" in rel.reltype]
    assert any(b.startswith(b"\x89PNG") for b in blobs), "Word flattened the transparent photo to JPEG"

    xlsx = fill_xlsx(fields)
    workbook = load_workbook(BytesIO(xlsx))
    program = workbook[PROGRAM_SHEET]
    assert program._images, "program sheet missing alpha photo"
    embedded = program._images[0]._data()
    if callable(embedded):
        embedded = embedded()
    sheet_photo = PILImage.open(BytesIO(embedded))
    assert "A" in sheet_photo.mode, sheet_photo.mode
    corner = sheet_photo.getpixel((0, 0))
    assert len(corner) == 4 and corner[3] == 0, f"Excel photo lost alpha: {corner}"
    print("  alpha: helper+Word PNG+Excel RGBA ok")


def check_part_names() -> None:
    assert _part_name_from_model("BOTTLE HIGH POLY.SLDPRT") == "BOTTLE HIGH POLY"
    assert _part_name_from_model("SMOKE_PART.stp") == "SMOKE_PART"
    assert _part_name_from_model("BOTTLE HIGH POLY.fbx") == "BOTTLE HIGH POLY"
    # A part number that legitimately contains a dot must survive intact.
    assert _part_name_from_model("PN-1.25-REVB") == "PN-1.25-REVB"
    assert _part_name_from_model("") == ""
    # Traveler Part Name follows the STEP/STP stem only, not FBX/OBJ uploads.
    assert _part_name_from_stp("BOTTLE HIGH POLY.stp") == "BOTTLE HIGH POLY"
    assert _part_name_from_stp("housing.STEP") == "housing"
    assert _part_name_from_stp("BOTTLE HIGH POLY.fbx") == ""
    assert _part_name_from_stp("PN-1.25-REVB") == ""
    assert _part_name_from_stp("") == ""


def check_fill() -> None:
    print("DOCX template:", DOCX_TEMPLATE, "exists=", DOCX_TEMPLATE.is_file())
    print("XLSX template:", XLSX_TEMPLATE, "exists=", XLSX_TEMPLATE.is_file())
    print("Base PDF:", TEMPLATE_BASE_PDF, "exists=", TEMPLATE_BASE_PDF.is_file())
    assert DOCX_TEMPLATE.is_file(), f"copy templates into {DOCX_TEMPLATE.parent}"
    assert XLSX_TEMPLATE.is_file(), f"copy templates into {XLSX_TEMPLATE.parent}"

    check_part_names()

    docx = fill_docx(FIELDS)
    xlsx = fill_xlsx(FIELDS)
    pdf, source = build_preview_pdf(FIELDS, po_id="smoke")
    pages = pdf_pages_text(pdf)
    print(f"docx={len(docx)} xlsx={len(xlsx)} pdf={len(pdf)} pages={len(pages)} source={source}")
    assert len(pages) == 3, f"expected a 3-page packet, got {len(pages)}"
    assert source != "reportlab_fallback", (
        "PDF fell back to the plain reportlab layout; the pre-rendered "
        f"{TEMPLATE_BASE_PDF.name} background is missing or stale"
    )

    workbook = load_workbook(BytesIO(xlsx))
    part, program = workbook[PART_SHEET], workbook[PROGRAM_SHEET]
    for sheet, coord in ((part, "A4"), (part, "Z56"), (program, "A2")):
        value = sheet[coord].value
        assert value in (None, ""), f"{sheet.title}!{coord} should be blank, got {value!r}"
    assert part["W5"].alignment.horizontal == "center"
    assert part["W5"].alignment.vertical == "center"

    assert_clean("docx", docx_text(docx))
    assert_clean("xlsx", xlsx_text(xlsx))
    word = Document(BytesIO(docx))
    dims_cell = word.tables[1].rows[1].cells[2]
    sign_cell = word.tables[1].rows[1].cells[3]
    assert dims_cell._tc is not sign_cell._tc, "Material Dims and Sign are still merged in the Word packet"
    assert FIELDS["mat_dim"] in dims_cell.text, dims_cell.text
    assert FIELDS["sign"] in sign_cell.text, sign_cell.text
    assert FIELDS["mat_dim"] not in sign_cell.text
    for index, text in enumerate(pages, start=1):
        assert_clean(f"pdf page {index}", text)

    assert "08/20/26" in pages[0], "page 1 is missing the mm/dd/yy due date"
    assert "08/20/26" in pages[1], "page 2 is missing the mm/dd/yy due date"
    assert "SMOKE_PART" in pages[0], "page 1 is missing the part name"
    assert "Material Dims" in pages[0], "page 1 is missing the Material Dims header"
    assert re.search(r"\bSign\b", pages[0]), "page 1 is missing the Sign header"
    assert "Material Type" in pages[1], "page 2 is missing the Material Type header"
    assert "Specification" in pages[1], "page 2 is missing the Material Specification header"
    check_columns(pdf)
    check_photos()

    for fmt in FORMATS:
        data, media, name = content_for_format(fmt, FIELDS, job_no="J-SMOKE")
        print(f"  {fmt}: {len(data)} bytes media={media} name={name}")
        assert len(data) > 500, fmt
        assert name_pattern("J-SMOKE", "PO-SMOKE-1", fmt).match(name), name

    # Unsafe path characters collapse to underscores, and the HHMMSS suffix keeps
    # two downloads on the same day from overwriting each other.
    stamp = datetime(2026, 8, 6, 14, 30, 5).astimezone()
    odd = {**FIELDS, "po_number": "PO / 123", "part_of": "Part 2 of 4"}
    assert (
        traveler_filename(odd, "pdf", job_no="J 60", generated_at=stamp)
        == "PO_123_SMOKE-001_08-06-26_(Part 2 of 4).pdf"
    )
    single = traveler_filename(FIELDS, "pdf", job_no="J 60", generated_at=stamp)
    assert single == "PO-SMOKE-1_SMOKE-001_08-06-26.pdf"
    print("OK in-process traveler fill")


def check_api() -> None:
    status, raw, _ = call("POST", "/api/auth/login", {"email": ADMIN[0], "password": ADMIN[1]})
    assert status == 200, f"login failed: {status} {raw[:200]!r}"
    token = json.loads(raw)["access_token"]

    status, raw, _ = call("GET", "/api/purchase-orders", token=token)
    assert status == 200, raw[:200]
    orders = json.loads(raw)
    target = next((p for p in orders if p["job_no"] not in AVOID_JOBS), None)
    assert target, "no purchase order available outside the protected jobs"
    po_id = target["id"]
    before_modified = (target.get("last_modified") or {}).get("action")
    print(f"subject: {target['job_no']} · {target['po_number']} ({po_id})")

    status, raw, _ = call("GET", f"/api/purchase-orders/{po_id}/traveler", token=token)
    assert status == 200, raw[:200]
    fields = json.loads(raw)["fields"]
    assert fields.get("generated_by"), "traveler draft is missing generated_by"
    part_name = fields.get("part_name") or ""
    assert not re.search(r"\.(sldprt|step|stp|iges|igs|x_t|3dm|fbx|obj)$", part_name, re.I), (
        f"part name still carries a CAD extension: {part_name!r}"
    )

    status, raw, headers = call("GET", f"/api/purchase-orders/{po_id}/traveler/pdf", token=token)
    assert status == 200 and len(raw) > 500, (status, raw[:200])
    print(
        f"preview pdf: {len(raw)} bytes source={headers.get('x-traveler-preview-source')} "
        f"ms={headers.get('x-traveler-preview-ms')}"
    )
    for index, text in enumerate(pdf_pages_text(raw), start=1):
        assert_clean(f"api pdf page {index}", text)

    job = re.sub(r'[\/\\:*?"<>|\s]+', "_", target["job_no"]).strip("._")
    po_number = re.sub(r'[\/\\:*?"<>|\s]+', "_", target["po_number"]).strip("._")
    for fmt in FORMATS:
        status, raw, headers = call(
            "POST",
            f"/api/purchase-orders/{po_id}/traveler/{fmt}",
            {"fields": fields, "persist": False},
            token,
        )
        disposition = headers.get("content-disposition", "")
        assert status == 200 and len(raw) > 500, (fmt, status, raw[:200])
        match = re.search(r'filename="([^"]+)"', disposition)
        assert match, f"{fmt}: no plain filename in {disposition!r}"
        filename = match.group(1)
        print(f"  POST {fmt}: {len(raw)} bytes name={filename}")
        assert name_pattern(job, po_number, fmt).match(filename), filename

    status, raw, _ = call("GET", f"/api/purchase-orders/{po_id}", token=token)
    after_modified = (json.loads(raw).get("last_modified") or {}).get("action")
    assert after_modified != "Traveler generated", "Traveler generated moved the Modified column"

    status, raw, _ = call("GET", f"/api/purchase-orders/{po_id}/activity", token=token)
    activity = json.loads(raw)
    assert any(a.get("action") == "Traveler generated" for a in activity), "missing activity row"
    print(f"modified stayed {before_modified!r} -> {after_modified!r}; activity recorded")
    print("OK traveler API")


def main() -> int:
    check_fill()
    print()
    try:
        check_api()
    except urllib.error.URLError as exc:
        print(f"FAIL: API at {API} is unreachable ({exc.reason}); start uvicorn on :8000")
        return 1
    print("\nOK traveler smoke")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
