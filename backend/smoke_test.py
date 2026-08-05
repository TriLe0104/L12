"""End-to-end smoke test against a running API: python smoke_test.py"""

import json
import os
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = "http://127.0.0.1:8000"
# the seed demo account, overridable for a DB whose primary account was renamed
EMAIL = os.environ.get("PO_EMAIL", "tri@supermicro.com")
PASSWORD = os.environ.get("PO_PASSWORD", "demo1234")
# creates are rejected with a past due date, so keep these relative to today
DUE = (date.today() + timedelta(days=8)).isoformat()
DUE_MOVED = (date.today() + timedelta(days=16)).isoformat()


def call(method: str, path: str, body: dict | None = None, token: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> None:
    _, login = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    token = login["access_token"]
    print(f"LOGIN     {login['user']['name']} ({login['user']['role']})")

    _, created = call(
        "POST",
        "/api/purchase-orders",
        {
            "job_no": "J-99",
            "po_number": "J03CE6AA",
            "part_number": "0A44DD1",
            "qty": 8,
            "due_date": DUE,
            "dims": "0.905 x 0.870 x 0.345in",
            "mat_dim": "1.25 x 1.7 x .500",
            "material": "AL 6061-T651, Plate",
            "finish": "CLEAR ANODIZE; CHEM FILM GOLD",
            "inspection": "formal",
            "hardware": False,
            "status": "wait_vqc",
            "note": "no dim change, just censoring",
        },
        token,
    )
    print(f"CREATE    {created['job_no']} {created['po_number']} -> {created['status_label']}")

    _, moved = call(
        "PATCH",
        f"/api/purchase-orders/{created['id']}",
        {"due_date": DUE_MOVED, "status": "shipped"},
        token,
    )
    print(f"PATCH     due {created['due_date']} -> {moved['due_date']}, status {moved['status_label']}")

    _, acts = call("GET", f"/api/purchase-orders/{created['id']}/activity", None, token)
    print("ACTIVITY  " + " | ".join(a["action"] for a in acts))

    status, _ = call("DELETE", f"/api/purchase-orders/{created['id']}", None, token)
    print(f"DELETE    {status}")

    _, pos = call("GET", "/api/purchase-orders?q=6061", None, token)
    _, users = call("GET", "/api/users", None, token)
    _, statuses = call("GET", "/api/meta/statuses", None, token)
    print(f"SEARCH    {len(pos)} POs matching '6061'")
    print(f"USERS     {len(users)}   STATUSES {len(statuses)}")

    code, _ = call("GET", "/api/purchase-orders")
    print(f"NO-AUTH   {code} (expect 401)")


if __name__ == "__main__":
    main()
