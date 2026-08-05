"""Per-order lock: who may set it, who may work through it, who may clear it.

Any editor (admin / manager) can lock an unlocked order. Once it is locked only an
admin may touch it at all -- edits, stage moves, due dates, deletes and the unlock
itself. A user and a viewer are shut out either way.

Creates three throwaway accounts and removes them again, borrows one real PO and
puts it back exactly as it was, unlocked, so it is safe to re-run.
"""

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
MANAGER = ("smoke-lock-manager@example.com", "smoke-pass-1")
USER = ("smoke-lock-user@example.com", "smoke-pass-1")
VIEWER = ("smoke-lock-viewer@example.com", "smoke-pass-1")

# J-55 was recovered by hand earlier today; leave it alone.
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
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")


def login(creds):
    _, res = call("POST", "/api/auth/login", {"email": creds[0], "password": creds[1]})
    return res["access_token"], res["user"]


def show(label, code, out, want):
    got = out.get("detail") if isinstance(out, dict) and code >= 400 else "ok"
    flag = "PASS" if code == want else "FAIL"
    print(f"{flag} {label:<34} {code} (want {want})  {got}")
    return code == want


tok, me = login(ADMIN)
_, manager = call("POST", "/api/users", {"name": "Lock Manager", "email": MANAGER[0],
                                         "role": "manager", "password": MANAGER[1]}, tok)
_, plain = call("POST", "/api/users", {"name": "Lock User", "email": USER[0],
                                       "role": "user", "password": USER[1]}, tok)
_, viewer = call("POST", "/api/users", {"name": "Lock Viewer", "email": VIEWER[0],
                                        "role": "viewer", "password": VIEWER[1]}, tok)
manager_tok, _ = login(MANAGER)
user_tok, _ = login(USER)
viewer_tok, _ = login(VIEWER)
print(f"accounts      {manager['role']} · {plain['role']} · {viewer['role']}")

_, pos = call("GET", "/api/purchase-orders", token=tok)
target = next(p for p in pos if p["job_no"] not in AVOID and not p["locked"])
before = {k: target[k] for k in ("status", "due_date", "note", "stage")}
pid = target["id"]
print(f"subject       {target['job_no']} · {target['po_number']} "
      f"({before['stage']}, due {before['due_date']}, locked={target['locked']})")

other_stage = "on_hold" if before["stage"] != "on_hold" else "pending"
other_due = "2026-09-30" if before["due_date"] != "2026-09-30" else "2026-10-01"

ok = []
print("\n-- user + viewer, order still unlocked")
ok.append(show("user edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                  {"note": "user was here"}, user_tok), 403))
ok.append(show("user lock", *call("PATCH", f"/api/purchase-orders/{pid}",
                                  {"locked": True}, user_tok), 403))
ok.append(show("viewer edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                    {"note": "viewer was here"}, viewer_tok), 403))
ok.append(show("viewer lock", *call("PATCH", f"/api/purchase-orders/{pid}",
                                    {"locked": True}, viewer_tok), 403))
ok.append(show("viewer delete", *call("DELETE", f"/api/purchase-orders/{pid}",
                                      token=viewer_tok), 403))

print("\n-- manager locks it, then finds itself shut out")
code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"locked": True}, manager_tok)
ok.append(show("manager locks", code, out, 200))
print(f"     locked={out.get('locked')}")
ok.append(show("manager edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                     {"note": "manager edit"}, manager_tok), 403))
ok.append(show("manager stage move", *call("PATCH", f"/api/purchase-orders/{pid}",
                                           {"stage": other_stage}, manager_tok), 403))
ok.append(show("manager due date move", *call("PATCH", f"/api/purchase-orders/{pid}",
                                              {"due_date": other_due}, manager_tok), 403))
ok.append(show("manager image attach", *call("PATCH", f"/api/purchase-orders/{pid}",
                                             {"thumbnail_url": "/uploads/x.png"}, manager_tok), 403))
ok.append(show("manager delete", *call("DELETE", f"/api/purchase-orders/{pid}",
                                       token=manager_tok), 403))
ok.append(show("manager unlock", *call("PATCH", f"/api/purchase-orders/{pid}",
                                       {"locked": False}, manager_tok), 403))

print("\n-- viewer, order now locked")
ok.append(show("viewer edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                    {"note": "viewer again"}, viewer_tok), 403))
ok.append(show("viewer unlock", *call("PATCH", f"/api/purchase-orders/{pid}",
                                      {"locked": False}, viewer_tok), 403))
ok.append(show("viewer delete", *call("DELETE", f"/api/purchase-orders/{pid}",
                                      token=viewer_tok), 403))

print("\n-- admin works through the lock and clears it")
ok.append(show("admin edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                   {"note": "admin edit"}, tok), 200))
ok.append(show("admin stage move", *call("PATCH", f"/api/purchase-orders/{pid}",
                                         {"stage": other_stage}, tok), 200))
ok.append(show("admin due date move", *call("PATCH", f"/api/purchase-orders/{pid}",
                                            {"due_date": other_due}, tok), 200))
code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"locked": False}, tok)
ok.append(show("admin unlocks", code, out, 200))
print(f"     locked={out.get('locked')}")

print("\n-- unlocked again: the manager is an editor once more")
ok.append(show("manager edit", *call("PATCH", f"/api/purchase-orders/{pid}",
                                     {"note": "manager back in"}, manager_tok), 200))

# deletion of a locked order, on a scratch PO so nothing real is at risk
print("\n-- delete, on a scratch order")
_, scratch = call("POST", "/api/purchase-orders", {"job_no": "J-LOCK", "po_number": "SMOKE1",
                                                   "part_number": "SMOKE1", "qty": 1,
                                                   "due_date": "2026-12-31"}, tok)
sid = scratch["id"]
ok.append(show("manager locks scratch", *call("PATCH", f"/api/purchase-orders/{sid}",
                                              {"locked": True}, manager_tok), 200))
ok.append(show("manager deletes locked", *call("DELETE", f"/api/purchase-orders/{sid}",
                                               token=manager_tok), 403))
ok.append(show("viewer deletes locked", *call("DELETE", f"/api/purchase-orders/{sid}",
                                              token=viewer_tok), 403))
ok.append(show("admin deletes locked", *call("DELETE", f"/api/purchase-orders/{sid}",
                                             token=tok), 204))

_, trail = call("GET", f"/api/purchase-orders/{pid}/activity", token=tok)
locks = [f"{a['action']} ({a['actor']['name'] if a['actor'] else '?'})"
         for a in trail if a["action"] in ("PO locked", "PO unlocked")]
print(f"\nactivity      {' | '.join(locks[:6])}")

# put the borrowed PO back exactly as it was
call("PATCH", f"/api/purchase-orders/{pid}", before | {"locked": False}, tok)
_, final = call("GET", f"/api/purchase-orders/{pid}", token=tok)
restored = all(final[k] == before[k] for k in ("status", "due_date", "note"))
print(f"restored      {final['job_no']} {final['stage']} due {final['due_date']} "
      f"locked={final['locked']} note={final['note']!r} -> {'ok' if restored else 'MISMATCH'}")

for u in (manager, plain, viewer):
    call("DELETE", f"/api/users/{u['id']}", token=tok)
_, users = call("GET", "/api/users", token=tok)
_, pos = call("GET", "/api/purchase-orders", token=tok)
print(f"cleanup       {len(users)} user(s): {[u['email'] for u in users]}")
print(f"database      {len(pos)} PO(s), {sum(1 for p in pos if p['locked'])} locked")
print(f"\n{sum(ok)}/{len(ok)} checks passed"
      f"{'' if all(ok) and restored else '  <-- SOMETHING FAILED'}")
