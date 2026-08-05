"""Check that priority round-trips and every sort order comes back ordered."""

import urllib.parse
import urllib.request
import json

BASE = "http://127.0.0.1:8000"
RANK = {"hot": 0, "high": 1, "normal": 2, "low": 3}


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or "null")


token = call("POST", "/api/auth/login", {"email": "trile0104@gmail.com", "password": "tvm-temp-2026"})[
    "access_token"
]

for sort in ("due_asc", "due_desc", "priority_desc", "priority_asc"):
    pos = call("GET", f"/api/purchase-orders?sort={sort}", token=token)
    if sort.startswith("due"):
        keys = [p["due_date"] for p in pos]
        ok = keys == sorted(keys, reverse=sort.endswith("desc"))
    else:
        keys = [RANK[p["priority"]] for p in pos]
        ok = keys == sorted(keys, reverse=sort.endswith("asc"))
    print(f"{sort:<14} {'ok' if ok else 'FAIL'}  first={pos[0]['job_no']} {pos[0]['priority']} {pos[0]['due_date']}")

po = call("GET", "/api/purchase-orders?sort=job", token=token)[0]
before = po["priority"]
updated = call("PATCH", f"/api/purchase-orders/{po['id']}", {"priority": "hot"}, token=token)
print(f"patch priority {before} -> {updated['priority']} ({updated['priority_label']})")
call("PATCH", f"/api/purchase-orders/{po['id']}", {"priority": before}, token=token)
print("restored")
