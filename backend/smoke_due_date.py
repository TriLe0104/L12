"""Checks that creating a PO refuses a past due date but accepts today and later,
and that existing overdue POs can still be patched: python smoke_due_date.py"""

import json
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = "http://127.0.0.1:8000"
EMAIL = "trile0104@gmail.com"
PASSWORD = "tvm-temp-2026"


def call(method, path, body=None, token=None):
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
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode()


def po(job_no, due):
    return {
        "job_no": job_no,
        "po_number": f"DUE{job_no[-2:]}",
        "part_number": "0A44DD1",
        "qty": 1,
        "due_date": due,
        "material": "AL 6061-T651, Plate",
        "status": "new",
    }


def main() -> None:
    _, login = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    token = login["access_token"]
    today = date.today()
    print(f"LOGIN     {login['user']['name']} ({login['user']['role']})  today={today}")

    created = []
    cases = [
        ("yesterday", (today - timedelta(days=1)).isoformat(), 400),
        ("last month", (today - timedelta(days=30)).isoformat(), 400),
        ("today", today.isoformat(), 201),
        ("next week", (today + timedelta(days=7)).isoformat(), 201),
    ]
    for label, due, want in cases:
        code, body = call("POST", "/api/purchase-orders", po(f"J-D{len(created)}", due), token)
        ok = "ok  " if code == want else "FAIL"
        note = body["detail"] if code >= 400 else f"id={body['id'][:8]} due={body['due_date']}"
        print(f"CREATE    {ok} {label:<11} {due}  {code} (want {want})  {note}")
        if code == 201:
            created.append(body["id"])

    # an already-overdue PO must stay patchable, including on its due date
    _, pos = call("GET", "/api/purchase-orders?sort=due_asc", None, token)
    overdue = next((p for p in pos if p["due_date"] < today.isoformat()), None)
    if overdue is None:
        print("PATCH     skip  no overdue PO on the board")
    else:
        past = (today - timedelta(days=45)).isoformat()
        code, moved = call(
            "PATCH", f"/api/purchase-orders/{overdue['id']}", {"due_date": past}, token
        )
        print(f"PATCH     {'ok  ' if code == 200 else 'FAIL'} overdue {overdue['job_no']} "
              f"{overdue['due_date']} -> {moved['due_date']} ({code})")
        call("PATCH", f"/api/purchase-orders/{overdue['id']}", {"due_date": overdue["due_date"]}, token)
        print(f"RESTORE   {overdue['job_no']} back to {overdue['due_date']}")

    for po_id in created:
        code, _ = call("DELETE", f"/api/purchase-orders/{po_id}", None, token)
        print(f"CLEANUP   {po_id[:8]} deleted ({code})")

    _, pos = call("GET", "/api/purchase-orders", None, token)
    print(f"COUNT     {len(pos)} POs remain")


if __name__ == "__main__":
    main()
