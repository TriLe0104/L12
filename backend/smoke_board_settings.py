"""Board settings GET/PUT validation matrix.

Admin can read/write; Manager cannot PUT; removing an in-use status is refused;
seeded defaults match the day-one catalog. Restores the published document.
Never touches J-55.
"""

from __future__ import annotations

import copy
import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:8000")
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
MANAGER = ("smoke-board-mgr@example.com", "smoke-pass-1")
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
    print(f"{flag} {label:<42} {code} (want {want})  {got}")
    return code == want


ok = True
atok, admin = login(ADMIN)
print(f"admin         {admin['email']} · {admin['role']}")

# Ensure manager account exists
code, mgr = call(
    "POST",
    "/api/users",
    {"name": "Board Mgr", "email": MANAGER[0], "role": "manager", "password": MANAGER[1]},
    atok,
)
if code not in (200, 201):
    # may already exist
    mtok, muser = login(MANAGER)
else:
    mtok, muser = login(MANAGER)
print(f"manager       {muser['email']} · {muser['role']}")

code, settings = call("GET", "/api/settings/board", token=atok)
ok &= show("GET board (admin)", code, settings, 200)
doc = settings["document"]
assert doc["statuses"], "statuses seeded"
assert doc["kanbanColumns"], "kanban seeded"
assert {s["key"] for s in doc["statuses"]} >= {
    "need_material_size",
    "running",
    "waiting_setup",
    "ready_to_ship",
}
print(f"seeded        {len(doc['statuses'])} statuses · {len(doc['kanbanColumns'])} columns")

baseline = copy.deepcopy(doc)

code, _ = call("GET", "/api/settings/board", token=mtok)
ok &= show("GET board (manager)", code, _, 200)

code, refused = call("PUT", "/api/settings/board", {"document": doc}, mtok)
ok &= show("PUT board (manager) forbidden", code, refused, 403)

# Hide a dashboard column
draft = copy.deepcopy(doc)
for col in draft["dashboardColumns"]:
    if col["key"] == "finish":
        col["visible"] = False
code, saved = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT hide finish column", code, saved, 200)
assert any(
    c["key"] == "finish" and not c["visible"] for c in saved["document"]["dashboardColumns"]
)

# Add custom field + status + map into pending
draft = copy.deepcopy(saved["document"])
draft["customFields"].append({"key": "cf_vendor", "label": "Vendor", "type": "text"})
draft["cardFields"].append(
    {"key": "cf_vendor", "kind": "custom", "label": "Vendor", "visible": True}
)
draft["statuses"].append({"key": "st_expedite", "label": "EXPEDITE", "tone": "#c81e2b"})
for col in draft["kanbanColumns"]:
    if col["key"] == "pending":
        col["statusKeys"].append("st_expedite")
code, saved = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT add custom + status", code, saved, 200)
if code != 200:
    print("abort after add custom + status:", saved)
    raise SystemExit(1)
expedite = next(s for s in saved["document"]["statuses"] if s["key"] == "st_expedite")
assert expedite["tone"] == "#c81e2b", expedite["tone"]

# Legacy named tone still accepted and normalised to hex
draft = copy.deepcopy(saved["document"])
draft["statuses"].append({"key": "st_legacy", "label": "LEGACY", "tone": "teal"})
for col in draft["kanbanColumns"]:
    if col["key"] == "pending":
        col["statusKeys"].append("st_legacy")
code, saved = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT legacy tone name", code, saved, 200)
legacy = next(s for s in saved["document"]["statuses"] if s["key"] == "st_legacy")
assert legacy["tone"] == "#0f766e", legacy["tone"]
draft = copy.deepcopy(saved["document"])
draft["statuses"] = [s for s in draft["statuses"] if s["key"] != "st_legacy"]
for col in draft["kanbanColumns"]:
    col["statusKeys"] = [k for k in col["statusKeys"] if k != "st_legacy"]
code, saved = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT remove legacy status", code, saved, 200)

# Bad tone rejected
draft = copy.deepcopy(saved["document"])
draft["statuses"][0] = {**draft["statuses"][0], "tone": "not-a-color"}
code, bad_tone = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT bad tone rejected", code, bad_tone, 400)
assert "hex" in str(bad_tone.get("detail", "")).lower()

# Meta endpoints reflect catalog
code, meta_st = call("GET", "/api/meta/statuses")
ok &= show("GET meta statuses", code, meta_st if isinstance(meta_st, list) else {}, 200)
assert any(s["value"] == "st_expedite" for s in meta_st)

# Try remove an in-use status
_, pos = call("GET", "/api/purchase-orders", token=atok)
in_use = next(p["status"] for p in pos if p["job_no"] not in AVOID)
draft = copy.deepcopy(saved["document"])
draft["statuses"] = [s for s in draft["statuses"] if s["key"] != in_use]
for col in draft["kanbanColumns"]:
    col["statusKeys"] = [k for k in col["statusKeys"] if k != in_use]
code, blocked = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show(f"PUT remove in-use {in_use}", code, blocked, 400)
assert "in use" in str(blocked.get("detail", "")).lower()

# Remove unused custom status
draft = copy.deepcopy(saved["document"])
draft["statuses"] = [s for s in draft["statuses"] if s["key"] != "st_expedite"]
for col in draft["kanbanColumns"]:
    col["statusKeys"] = [k for k in col["statusKeys"] if k != "st_expedite"]
code, saved = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT remove unused status", code, saved, 200)

# Unassigned status refused
draft = copy.deepcopy(saved["document"])
draft["statuses"].append({"key": "st_orphan", "label": "ORPHAN", "tone": "#64748b"})
code, bad = call("PUT", "/api/settings/board", {"document": draft}, atok)
ok &= show("PUT unassigned status refused", code, bad, 400)

# Restore baseline (drop custom field too)
code, restored = call("PUT", "/api/settings/board", {"document": baseline}, atok)
ok &= show("PUT restore baseline", code, restored, 200)

# Cleanup manager if we created them this run
call("DELETE", f"/api/users/{muser['id']}", token=atok)

print("ALL PASS" if ok else "SOME FAILED")
raise SystemExit(0 if ok else 1)
