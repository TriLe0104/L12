"""Activity trail: only real changes get logged, and the Modified column follows.

The drawer PATCHes the whole draft on every save, so the question this asks is
whether an *echo* -- a payload identical to what the server already holds -- is
correctly read as "nothing happened": no activity row, no bump to `updated_at`,
and no change to who the dashboard names as last modifier.

Creates one throwaway account and one throwaway order, exercises every logging
path on them, then removes both, so it is safe to re-run and no order on the real
board is touched. The order is raised by the admin and every write after that is
made by the throwaway manager, so a spurious row is visible twice over: as an
extra line in the trail and as the manager wrongly taking over the Modified cell.
"""

import json
import os
import sqlite3
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = os.environ.get("PO_API", "http://127.0.0.1:8000")
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
MGR = ("smoke-activity-mgr@example.com", "smoke-pass-1")
JOB = "J-SMOKE-ACT"
DUE = (date.today() + timedelta(days=21)).isoformat()
LATER = (date.today() + timedelta(days=28)).isoformat()
DB = Path(__file__).with_name("po_calendar.db")

fails = 0


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, _body(r.read())
    except urllib.error.HTTPError as e:
        # a 500 answers in plain text, and a check that trips one still has to report
        return e.code, _body(e.read())


def _body(raw):
    try:
        return json.loads(raw or "null")
    except ValueError:
        return {"detail": (raw or b"").decode(errors="replace")[:120]}


def login(creds):
    _, res = call("POST", "/api/auth/login", {"email": creds[0], "password": creds[1]})
    return res["access_token"], res["user"]


def check(label, ok, note=""):
    global fails
    if not ok:
        fails += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<30} {note}")


admin_tok, admin = login(ADMIN)

# anything left behind by a run that stopped early, so a re-run starts clean and
# the start count below is the board's own
_, page = call("GET", f"/api/purchase-orders?q={JOB}", token=admin_tok)
for stale in [p for p in page if p["job_no"] == JOB]:
    call("PATCH", f"/api/purchase-orders/{stale['id']}", {"locked": False}, admin_tok)
    call("DELETE", f"/api/purchase-orders/{stale['id']}", token=admin_tok)
_, people = call("GET", "/api/users", token=admin_tok)
for stale in [u for u in people if u["email"] == MGR[0]]:
    call("DELETE", f"/api/users/{stale['id']}", token=admin_tok)

_, board = call("GET", "/api/purchase-orders", token=admin_tok)
_, roster = call("GET", "/api/users", token=admin_tok)
print(f"start         {len(board)} orders | {len(roster)} user(s) "
      f"{[u['email'] for u in roster]}")

_, mgr = call("POST", "/api/users", {"name": "Smoke Auditor", "email": MGR[0],
                                     "role": "manager", "password": MGR[1]}, admin_tok)
mgr_tok, _ = login(MGR)
print(f"account       {mgr['name']} ({mgr['role']})")


# --- how the board sees the order --------------------------------------------
def row():
    """The order as the dashboard's own query returns it, Modified cell included."""
    _, page = call("GET", f"/api/purchase-orders?q={JOB}", token=admin_tok)
    return next(po for po in page if po["job_no"] == JOB)


def trail(po_id):
    _, rows = call("GET", f"/api/purchase-orders/{po_id}/activity", token=admin_tok)
    return rows


def modifier(po):
    lm = po.get("last_modified")
    return f"{lm['by']['name']} / {lm['action']}" if lm else "--"


_, po = call("POST", "/api/purchase-orders", {
    "job_no": JOB, "po_number": "SMOKEACT", "part_number": "SMK-ACT", "qty": 3,
    "due_date": DUE, "note": "baseline note", "customer": "Smoke Co",
    "status": "need_material_size", "priority": "normal", "inspection": "standard", "hardware": False,
}, admin_tok)
pid = po["id"]
base = row()
print(f"order         {JOB} raised by {admin['name']} | {len(trail(pid))} row(s) | "
      f"modified: {modifier(base)}")

# --- what the database actually stores, versus what a payload carries --------
with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
    stored = con.execute(
        "SELECT status, priority, inspection FROM purchase_orders WHERE id = ?", (pid,)
    ).fetchone()
print(f"stored as     {stored} -- enum member NAMES, while the API speaks "
      f"({base['status']!r}, {base['priority']!r}, {base['inspection']!r})")
code, _ = call("PATCH", f"/api/purchase-orders/{pid}", {"status": "NEW"}, mgr_tok)
check("name is not valid input", code == 422, f"PATCH status='NEW' -> {code}")


def patch(label, body, token=mgr_tok, expect=0, action=None, detail=None, code_want=200):
    """PATCH, then assert on what the trail and the Modified cell did about it."""
    before, before_row = trail(pid), row()
    code, res = call("PATCH", f"/api/purchase-orders/{pid}", body, token)
    after, after_row = trail(pid), row()
    fresh = after[: len(after) - len(before)]
    ok = code == code_want and len(fresh) == expect
    # sorted, because two rows written by one request carry near-identical stamps
    if action is not None:
        ok = ok and sorted(a["action"] for a in fresh) == sorted(action)
    if detail is not None:
        ok = ok and sorted(a["detail"] for a in fresh) == sorted(detail)
    if expect == 0:
        # the whole point: nothing logged means nothing moved, stamp included
        ok = ok and after_row["updated_at"] == before_row["updated_at"]
        ok = ok and modifier(after_row) == modifier(before_row)
        note = f"{code} | +0 rows | updated_at held | modified: {modifier(after_row)}"
        if len(fresh) or after_row["updated_at"] != before_row["updated_at"]:
            note = (f"{code} | +{len(fresh)} {[(a['action'], a['detail']) for a in fresh]}"
                    f" | updated_at {'moved' if after_row['updated_at'] != before_row['updated_at'] else 'held'}"
                    f" | modified: {modifier(after_row)}")
    else:
        note = f"{code} | " + " ; ".join(f"{a['action']}: {a['detail']}" for a in fresh)
        if len(fresh) != expect:
            note += f"  (wanted {expect} row(s))"
    check(label, ok, note)
    return res


print("\nno-op saves -- an echo of what is already stored")
echo = {**base, "qty": int(base["qty"])}          # exactly what the drawer PATCHes
patch("whole drawer draft", echo)
patch("empty payload", {})
patch("whitespace around a string", {"note": "  baseline note  "})
patch("null vs empty string", {"material": "", "dims": None, "finish": ""})
patch("number back as a string", {"qty": "3"})
patch("enum by value not member", {"status": "need_material_size", "priority": "normal",
                                   "inspection": "standard"})
patch("date as a timestamp", {"due_date": f"{DUE}T00:00:00"})
patch("derived stage re-sent", {"stage": "pending"})
patch("absent boolean", {"hardware": False, "locked": None})
patch("null for a NOT NULL column", {"qty": None, "status": None, "priority": None})
patch("same owner", {"owner_id": admin["id"]})
patch("same lock state", {"locked": False})
held = row()
check("trail untouched by all of it", len(trail(pid)) == 1,
      f"{len(trail(pid))} row(s), still just the create")
check("modified cell untouched", modifier(held) == modifier(base)
      and held["updated_at"] == base["updated_at"],
      f"modified: {modifier(held)} | updated_at {held['updated_at']}")

print("\nreal changes -- exactly the fields that moved")
patch("one field", {"customer": "Acme Aero"}, expect=1,
      action=["PO updated"], detail=["customer"])
patch("several fields", {"material": "AL 6061-T651", "finish": "CLEAR ANODIZE",
                         "note": "second note"}, expect=1, action=["PO updated"],
      detail=["finish, material, note"])
patch("one moved, two echoed", {"customer": "Acme Aero", "material": "AL 6061-T651",
                                "qty": 4}, expect=1, action=["PO updated"], detail=["qty"])
moved = row()
check("modified follows a real edit", modifier(moved).startswith("Smoke Auditor"),
      f"modified: {modifier(moved)} | updated_at {moved['updated_at']} vs "
      f"{base['updated_at']} at create")

print("\ndedicated lines -- one each, and none on an echo")
patch("status changed", {"status": "running"}, expect=1,
      action=["Status changed"], detail=["need_material_size -> running"])
patch("  same status again", {"status": "running"})
patch("stage moved", {"stage": "completed"}, expect=1, action=["Status changed"],
      detail=["running -> ready_to_ship"])
patch("  same stage again", {"stage": "completed"})
patch("due date moved", {"due_date": LATER}, expect=1, action=["Due date moved"],
      detail=[f"{DUE} -> {LATER}"])
patch("  same due date again", {"due_date": LATER})
patch("owner changed", {"owner_id": mgr["id"]}, expect=1, action=["Owner changed"],
      detail=[f"{JOB}: {admin['name']} -> {mgr['name']}"])
patch("  same owner again", {"owner_id": mgr["id"]})
patch("owner cleared", {"owner_id": None}, expect=1, action=["Owner changed"],
      detail=[f"{JOB}: {mgr['name']} -> Unassigned"])
patch("  cleared again", {"owner_id": None})
# the lock narrows the order to admin, so its own echo has to be tried as one
patch("locked", {"locked": True}, token=admin_tok, expect=1, action=["PO locked"],
      detail=[f"{JOB}: unlocked -> locked"])
patch("  same lock again", {"locked": True}, token=admin_tok)
patch("  null lock while locked", {"locked": None}, token=admin_tok)
patch("unlocked", {"locked": False}, token=admin_tok, expect=1, action=["PO unlocked"],
      detail=[f"{JOB}: locked -> unlocked"])
patch("  same unlock again", {"locked": False}, token=admin_tok)
patch("dedicated plus generic", {"status": "finishing", "note": "third note"}, expect=2,
      action=["PO updated", "Status changed"],
      detail=["note", "ready_to_ship -> finishing"])

print("\ntrail as written")
for a in trail(pid):
    print(f"  {a['action']:<15} {str(a['detail'])[:48]:<50} {a['actor']['name']}")

# --- put everything back ------------------------------------------------------
call("DELETE", f"/api/purchase-orders/{pid}", token=admin_tok)
call("DELETE", f"/api/users/{mgr['id']}", token=admin_tok)
_, board = call("GET", "/api/purchase-orders", token=admin_tok)
_, roster = call("GET", "/api/users", token=admin_tok)
print(f"\nfinish        {len(board)} orders | {len(roster)} user(s) "
      f"{[u['email'] for u in roster]}")
print("all clean." if fails == 0 else f"{fails} check(s) failed.")
