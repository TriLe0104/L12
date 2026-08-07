"""User may change status/stage on unlocked orders; nothing else.

Creates throwaway User / Viewer / Manager accounts, borrows one unlocked PO
(never J-55), restores it, and deletes the accounts. Safe to re-run.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
USER = ("smoke-status-user@example.com", "smoke-pass-1")
VIEWER = ("smoke-status-viewer@example.com", "smoke-pass-1")
MANAGER = ("smoke-status-manager@example.com", "smoke-pass-1")
AVOID = {"J-55"}


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, {"detail": raw.decode(errors="replace")}


def login(creds):
    _, res = call("POST", "/api/auth/login", {"email": creds[0], "password": creds[1]})
    return res["access_token"], res["user"]


def show(label, code, out, want):
    got = out.get("detail") if isinstance(out, dict) and code >= 400 else "ok"
    flag = "PASS" if code == want else "FAIL"
    print(f"{flag} {label:<36} {code} (want {want})  {got}")
    return code == want


tok, _ = login(ADMIN)
_, plain = call(
    "POST",
    "/api/users",
    {"name": "Status User", "email": USER[0], "role": "user", "password": USER[1]},
    tok,
)
_, viewer = call(
    "POST",
    "/api/users",
    {"name": "Status Viewer", "email": VIEWER[0], "role": "viewer", "password": VIEWER[1]},
    tok,
)
_, manager = call(
    "POST",
    "/api/users",
    {"name": "Status Manager", "email": MANAGER[0], "role": "manager", "password": MANAGER[1]},
    tok,
)
user_tok, _ = login(USER)
viewer_tok, _ = login(VIEWER)
manager_tok, _ = login(MANAGER)
print(f"accounts      {plain['role']} · {viewer['role']} · {manager['role']}")

_, pos = call("GET", "/api/purchase-orders", token=tok)
target = next(p for p in pos if p["job_no"] not in AVOID and not p["locked"])
before = {k: target[k] for k in ("status", "due_date", "note", "stage", "material")}
pid = target["id"]
print(
    f"subject       {target['job_no']} · {target['po_number']} "
    f"({before['status']}/{before['stage']}, locked={target['locked']})"
)

# Pick a different status that also implies a different stage when possible
_, statuses = call("GET", "/api/meta/statuses", token=tok)
alt_status = next(s["value"] for s in statuses if s["value"] != before["status"])
other_stage = "on_hold" if before["stage"] != "on_hold" else "in_progress"
other_due = "2026-09-30" if before["due_date"] != "2026-09-30" else "2026-10-01"

ok = []

print("\n-- User on unlocked order")
code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"status": alt_status}, user_tok)
ok.append(show("user status", code, out if isinstance(out, dict) else {}, 200))
if code == 200:
    print(f"     status={out.get('status')} stage={out.get('stage')}")
    # put status back before stage test so stage move is meaningful
    call("PATCH", f"/api/purchase-orders/{pid}", {"status": before["status"]}, tok)

code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"stage": other_stage}, user_tok)
ok.append(show("user stage", code, out if isinstance(out, dict) else {}, 200))
if code == 200:
    print(f"     status={out.get('status')} stage={out.get('stage')}")
    call("PATCH", f"/api/purchase-orders/{pid}", before, tok)

ok.append(
    show(
        "user note refused",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"note": "user was here"}, user_tok),
        403,
    )
)
ok.append(
    show(
        "user due_date refused",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"due_date": other_due}, user_tok),
        403,
    )
)
ok.append(
    show(
        "user material refused",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"material": "NOPE"}, user_tok),
        403,
    )
)
ok.append(
    show(
        "user create refused",
        *call(
            "POST",
            "/api/purchase-orders",
            {
                "job_no": "J-SMOKE",
                "po_number": "SMOKEU",
                "part_number": "SMOKEU",
                "qty": 1,
                "due_date": "2026-12-31",
            },
            user_tok,
        ),
        403,
    )
)

print("\n-- Viewer still read-only")
ok.append(
    show(
        "viewer status refused",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"status": alt_status}, viewer_tok),
        403,
    )
)

print("\n-- Locked: User cannot change status either")
call("PATCH", f"/api/purchase-orders/{pid}", {"locked": True}, tok)
ok.append(
    show(
        "user status on locked",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"status": alt_status}, user_tok),
        403,
    )
)
ok.append(
    show(
        "user stage on locked",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"stage": other_stage}, user_tok),
        403,
    )
)
call("PATCH", f"/api/purchase-orders/{pid}", {"locked": False}, tok)

print("\n-- Manager keeps full edit")
ok.append(
    show(
        "manager note",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"note": before["note"] or ""}, manager_tok),
        200,
    )
)
ok.append(
    show(
        "manager status",
        *call("PATCH", f"/api/purchase-orders/{pid}", {"status": alt_status}, manager_tok),
        200,
    )
)

# restore borrowed PO
call("PATCH", f"/api/purchase-orders/{pid}", {**before, "locked": False}, tok)
_, final = call("GET", f"/api/purchase-orders/{pid}", token=tok)
restored = all(final[k] == before[k] for k in before)
print(
    f"\nrestored      {final['job_no']} {final['status']}/{final['stage']} "
    f"locked={final['locked']} -> {'ok' if restored else 'MISMATCH'}"
)

for u in (plain, viewer, manager):
    call("DELETE", f"/api/users/{u['id']}", token=tok)
_, users = call("GET", "/api/users", token=tok)
_, pos = call("GET", "/api/purchase-orders", token=tok)
shad = [u["email"] for u in users if "shad38" in (u.get("email") or "")]
print(f"cleanup       {len(users)} user(s); shad38 invite={'yes' if shad else 'absent'}")
print(f"database      {len(pos)} PO(s)")
print(
    f"\n{sum(ok)}/{len(ok)} checks passed"
    f"{'' if all(ok) and restored else '  <-- SOMETHING FAILED'}"
)
