"""Owner assignment: the picker's endpoint, reassignment, clearing, and the guards.

Creates two throwaway accounts and three throwaway orders, then removes all of
them, so it is safe to re-run. Every check runs against an order this script
made: no order on the real board is touched, and nothing it writes to the
activity trail outlives it.
"""

import json
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = "http://127.0.0.1:8000"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
MGR = ("smoke-owner-mgr@example.com", "smoke-pass-1")
HAND = ("smoke-owner-hand@example.com", "smoke-pass-1")
DUE = (date.today() + timedelta(days=21)).isoformat()


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


def owner_of(po_id, token):
    """Read the owner back from a fresh GET, so nothing is proved by the echo alone."""
    _, po = call("GET", f"/api/purchase-orders/{po_id}", token=token)
    return (po["owner"] or {}).get("name", "Unassigned")


admin_tok, admin = login(ADMIN)
_, board = call("GET", "/api/purchase-orders", token=admin_tok)
_, roster = call("GET", "/api/users", token=admin_tok)
print(f"start         {len(board)} orders | {len(roster)} user(s)")

_, mgr = call("POST", "/api/users", {"name": "Smoke Manager", "email": MGR[0],
                                     "role": "manager", "password": MGR[1]}, admin_tok)
_, hand = call("POST", "/api/users", {"name": "Smoke Hand", "email": HAND[0],
                                      "role": "user", "password": HAND[1]}, admin_tok)
mgr_tok, _ = login(MGR)
hand_tok, _ = login(HAND)
print(f"accounts      {mgr['name']} ({mgr['role']}) | {hand['name']} ({hand['role']})")

# --- who the picker may offer -------------------------------------------------
code, people = call("GET", "/api/users/assignable", token=mgr_tok)
print(f"assignable    {code} -> {[p['name'] for p in people]}")
print(f"  projection  {sorted(people[0])} (want no email)")
code, denied = call("GET", "/api/users/assignable", token=hand_tok)
print(f"  no editor   {code} -> {denied.get('detail')}")
call("PATCH", f"/api/users/{hand['id']}", {"is_active": False}, admin_tok)
_, live = call("GET", "/api/users/assignable", token=mgr_tok)
print(f"  disabled    dropped={hand['name'] not in [p['name'] for p in live]}")
call("PATCH", f"/api/users/{hand['id']}", {"is_active": True}, admin_tok)

# --- creating an order for someone else --------------------------------------
def make(job, po_number, part, extra):
    body = {"job_no": job, "po_number": po_number, "part_number": part,
            "qty": 1, "due_date": DUE}
    body.update(extra)
    return call("POST", "/api/purchase-orders", body, mgr_tok)


code, other = make("J-SMOKE1", "SMOKE01", "SMK-1", {"owner_id": hand["id"]})
print(f"create other  {code} -> {other['job_no']} raised by {mgr['name']}, "
      f"owned by {other['owner']['name']}")
code, nobody = make("J-SMOKE2", "SMOKE02", "SMK-2", {"owner_id": None})
print(f"create none   {code} -> {(nobody['owner'] or {}).get('name', 'Unassigned')} "
      f"(an explicit null survives)")
code, subject = make("J-SMOKE3", "SMOKE03", "SMK-3", {})
print(f"create absent {code} -> {subject['owner']['name']} (no field falls back to the creator)")
code, bad = make("J-SMOKE4", "SMOKE04", "SMK-4", {"owner_id": "nobody"})
print(f"create bad    {code} -> {bad.get('detail')!r}")

# --- reassigning, on the order this script raised ----------------------------
sid = subject["id"]
code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": hand["id"]}, mgr_tok)
print(f"reassign      {code} -> {out['owner']['name']} | reads back as {owner_of(sid, admin_tok)}")

# an absent field must not be read as "clear it"
code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"note": "owner smoke"}, mgr_tok)
print(f"untouched     {code} -> still {(out['owner'] or {}).get('name', 'Unassigned')}")

code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": None}, mgr_tok)
print(f"clear         {code} -> {(out['owner'] or {}).get('name', 'Unassigned')} | "
      f"reads back as {owner_of(sid, admin_tok)}")

code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": "no-such-person"}, mgr_tok)
print(f"unknown id    {code} -> {out.get('detail')!r}")
print(f"  unharmed    {owner_of(sid, admin_tok)}")

# --- the lock excludes the manager, not the admin ----------------------------
call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": mgr["id"]}, mgr_tok)
call("PATCH", f"/api/purchase-orders/{sid}", {"locked": True}, mgr_tok)
code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": hand["id"]}, mgr_tok)
print(f"locked        {code} -> {out.get('detail')}")
print(f"  unmoved     {owner_of(sid, admin_tok)}")
code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": hand["id"]}, admin_tok)
print(f"  admin may   {code} -> {out['owner']['name']}")
call("PATCH", f"/api/purchase-orders/{sid}", {"locked": False}, admin_tok)

# --- no edit permission, no reassignment -------------------------------------
code, out = call("PATCH", f"/api/purchase-orders/{sid}", {"owner_id": mgr["id"]}, hand_tok)
print(f"non-editor    {code} -> {out.get('detail')}")
print(f"  unmoved     {owner_of(sid, admin_tok)}")

# --- the trail ----------------------------------------------------------------
_, trail = call("GET", f"/api/purchase-orders/{sid}/activity", token=admin_tok)
for a in reversed(trail):
    print(f"  trail       {a['action']:<14} {a['detail']} -- by {a['actor']['name']}")
noise = [a for a in trail if a["action"] == "PO updated" and "owner" in (a["detail"] or "")]
print(f"  handovers   {len([a for a in trail if a['action'] == 'Owner changed'])} logged | "
      f"{len(noise)} duplicated in 'PO updated'")

# --- put everything back ------------------------------------------------------
for made in (other, nobody, subject):
    if made.get("id"):
        call("DELETE", f"/api/purchase-orders/{made['id']}", token=admin_tok)
call("DELETE", f"/api/users/{mgr['id']}", token=admin_tok)
call("DELETE", f"/api/users/{hand['id']}", token=admin_tok)

_, board = call("GET", "/api/purchase-orders", token=admin_tok)
_, roster = call("GET", "/api/users", token=admin_tok)
print(f"finish        {len(board)} orders | {len(roster)} user(s) {[u['email'] for u in roster]}")
print(f"  owners      {sorted({(po['owner'] or {}).get('name', 'Unassigned') for po in board})}")
