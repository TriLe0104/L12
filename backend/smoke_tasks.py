"""Checks the kanban stage moves and image upload: python smoke_tasks.py"""

import json
import mimetypes
import urllib.request
import uuid
from datetime import date, timedelta
from pathlib import Path

from smoke_test import BASE, EMAIL, PASSWORD, call


def upload(path: Path, token: str) -> tuple[int, dict]:
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
            f"Content-Type: {ctype}\r\n\r\n".encode(),
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    req = urllib.request.Request(f"{BASE}/api/uploads", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as res:
        return res.status, json.loads(res.read())


def main() -> None:
    _, login = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    token = login["access_token"]

    _, stages = call("GET", "/api/meta/stages", None, token)
    print("STAGES    " + " | ".join(f"{s['label']}({len(s['statuses'])})" for s in stages))

    logo = Path(__file__).resolve().parents[1] / "frontend" / "public" / "brand" / "tvm-mark.png"
    code, up = upload(logo, token)
    print(f"UPLOAD    {code} {up['url']}")

    with urllib.request.urlopen(f"{BASE}{up['url']}") as res:
        print(f"SERVED    {res.status} {res.headers['content-type']} {len(res.read())} bytes")

    _, po = call(
        "POST",
        "/api/purchase-orders",
        {
            "job_no": "J-77",
            "po_number": "KANBAN01",
            "part_number": "0A44DD1",
            "qty": 8,
            "due_date": (date.today() + timedelta(days=20)).isoformat(),
            "material": "AL 6061-T651, Plate",
            "status": "new",
            "thumbnail_url": up["url"],
        },
        token,
    )
    print(f"CREATE    {po['job_no']} stage={po['stage']} thumb={bool(po['thumbnail_url'])}")

    for stage in ("in_progress", "on_hold", "completed", "pending"):
        _, moved = call("PATCH", f"/api/purchase-orders/{po['id']}", {"stage": stage}, token)
        print(f"MOVE      -> {stage:<12} status={moved['status_label']:<14} stage={moved['stage']}")

    # a card already in the target column keeps its exact status
    _, moved = call("PATCH", f"/api/purchase-orders/{po['id']}", {"status": "wait_vqc"}, token)
    _, same = call("PATCH", f"/api/purchase-orders/{po['id']}", {"stage": "in_progress"}, token)
    print(f"KEEP      wait_vqc stays {same['status_label']} in {same['stage']}")

    for stage in ("pending", "on_hold", "in_progress", "completed"):
        _, items = call("GET", f"/api/purchase-orders?stage={stage}", None, token)
        print(f"COLUMN    {stage:<12} {len(items)} cards")

    call("DELETE", f"/api/purchase-orders/{po['id']}", None, token)
    print("CLEANUP   ok")


if __name__ == "__main__":
    main()
