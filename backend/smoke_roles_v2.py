"""The Admin > Manager > User > Viewer hierarchy, end to end.

Proves the three things the role change is really about:

  * Manager is the ordinary editor -- it edits unlocked orders, invites people and
    sets roles, all of which used to be admin-only or pjm/pm-only.
  * Manager cannot climb. It may not assign Admin, may not touch an Admin, and may
    not promote itself. Only a role strictly below its own, on a person strictly
    below its own.
  * A locked order is Admin-only. A Manager may set a lock but is then shut out of
    the order it just locked, unlock included.

  * Uploads are split by purpose, not by one blanket floor. Anyone signed in can
    put an image on their *own* profile via /api/uploads/avatar, which takes no
    user id and so can write nothing else; attaching a photo or a model to a
    purchase order stays at EDITOR_FLOOR.

  * The directory is not public to the signed-in. Listing accounts, reading
    someone else's record or activity, and reading the org roster all sit at
    PEOPLE_FLOOR; reading your *own* record does not. The narrow /assignable
    projection stays at EDITOR_FLOOR and carries no email.

Plus the guards that had to survive: the last usable Admin cannot be demoted or
disabled, and everyone keeps self-service over their own name and photo.

Creates four throwaway accounts and a scratch order and removes them all again,
so it is safe to re-run. Borrowed real orders are restored exactly as found, the
primary account's photo is put back as found, and every uploaded file is deleted
by exact name so nothing else in the uploads directory is touched.
"""

import json
import os
import struct
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

# Override when the shared server on 8000 is one you cannot restart -- point this at
# your own instance instead of running against stale code and believing the result.
BASE = os.environ.get("PO_API_BASE", "http://127.0.0.1:8000").rstrip("/")
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
MANAGER = ("v2-manager@example.com", "smoke-pass-1")
MANAGER2 = ("v2-manager-peer@example.com", "smoke-pass-1")
USER = ("v2-user@example.com", "smoke-pass-1")
VIEWER = ("v2-viewer@example.com", "smoke-pass-1")

# J-55 was recovered by hand from the freelist; never borrow it.
AVOID = {"J-55"}

UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"

results = []
uploaded: list[str] = []   # stored names, removed one by one at the end


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
    if "access_token" not in res:
        raise SystemExit(f"login failed for {creds[0]}: {res}")
    return res["access_token"], res["user"]


def make_png(size=32):
    """A tiny RGB gradient, so the test needs no fixture file and no Pillow."""

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw += bytes((x * 255 // size, y * 255 // size, 130))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


# The smallest thing the model route's sniffer accepts as a Wavefront OBJ.
TINY_OBJ = b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"


def upload(path, payload, token, filename, content_type, fields=None):
    """Multipart POST. `fields` smuggles extra form values alongside the file,
    which is how the "can I aim this at someone else?" checks are written."""
    boundary = f"----v2{uuid.uuid4().hex}"
    body = b""
    for key, value in (fields or {}).items():
        body += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'
        ).encode()
    body += (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + payload + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(BASE + path, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            out = json.loads(r.read() or "null")
            code = r.status
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")
    for url in (out.get("url"), out.get("avatar_url")) if isinstance(out, dict) else ():
        if url and url.startswith("/uploads/"):
            uploaded.append(url.rsplit("/", 1)[-1])
    return code, out


def fetch_status(url):
    """Is the stored file actually being served?"""
    try:
        with urllib.request.urlopen(BASE + url) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0


def show(label, code, out, want):
    detail = out.get("detail") if isinstance(out, dict) and code >= 400 else "ok"
    passed = code == want
    results.append(passed)
    print(f"{'PASS' if passed else 'FAIL'} {label:<38} {code} (want {want})  {detail}")
    return passed


def verify(label, ok, extra=""):
    """An assertion about state rather than about a status code."""
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {label:<38} {extra}")
    return bool(ok)


def section(title):
    print(f"\n-- {title}")


tok, me = login(ADMIN)
admin_photo_before = me["avatar_url"]
print(f"signed in     {me['name']} ({me['role']}) photo={admin_photo_before}")

_, mgr = call("POST", "/api/users", {"name": "V2 Manager", "email": MANAGER[0],
                                     "role": "manager", "password": MANAGER[1]}, tok)
_, peer = call("POST", "/api/users", {"name": "V2 Peer Manager", "email": MANAGER2[0],
                                      "role": "manager", "password": MANAGER2[1]}, tok)
_, usr = call("POST", "/api/users", {"name": "V2 User", "email": USER[0],
                                     "role": "user", "password": USER[1]}, tok)
_, vwr = call("POST", "/api/users", {"name": "V2 Viewer", "email": VIEWER[0],
                                     "role": "viewer", "password": VIEWER[1]}, tok)
mgr_tok, _ = login(MANAGER)
usr_tok, _ = login(USER)
vwr_tok, _ = login(VIEWER)
print(f"accounts      {mgr['role']} · {peer['role']} · {usr['role']} · {vwr['role']}")

_, pos = call("GET", "/api/purchase-orders", token=tok)
target = next(p for p in pos if p["job_no"] not in AVOID and not p["locked"])
pid = target["id"]
before = {k: target[k] for k in ("status", "due_date", "note", "stage")}
print(f"subject       {target['job_no']} · {target['po_number']} "
      f"({before['stage']}, due {before['due_date']}, locked={target['locked']})")
other_stage = "on_hold" if before["stage"] != "on_hold" else "pending"
other_due = "2026-09-30" if before["due_date"] != "2026-09-30" else "2026-10-01"


section("manager is the ordinary editor of an unlocked order")
show("manager edits", *call("PATCH", f"/api/purchase-orders/{pid}",
                            {"note": "manager edit"}, mgr_tok), 200)
show("manager moves stage", *call("PATCH", f"/api/purchase-orders/{pid}",
                                  {"stage": other_stage}, mgr_tok), 200)
show("manager moves due date", *call("PATCH", f"/api/purchase-orders/{pid}",
                                     {"due_date": other_due}, mgr_tok), 200)

section("user and viewer are read-only on orders")
show("user edits", *call("PATCH", f"/api/purchase-orders/{pid}",
                         {"note": "user edit"}, usr_tok), 403)
show("user deletes", *call("DELETE", f"/api/purchase-orders/{pid}", token=usr_tok), 403)
show("user creates", *call("POST", "/api/purchase-orders",
                           {"job_no": "J-NOPE", "po_number": "N1", "part_number": "N1",
                            "qty": 1, "due_date": "2026-12-31"}, usr_tok), 403)
show("viewer edits", *call("PATCH", f"/api/purchase-orders/{pid}",
                           {"note": "viewer edit"}, vwr_tok), 403)
show("viewer deletes", *call("DELETE", f"/api/purchase-orders/{pid}", token=vwr_tok), 403)

section("manager administers people below it")
code, out = call("POST", "/api/users", {"name": "V2 Invitee", "email": "v2-invitee@example.com",
                                        "role": "viewer", "password": "smoke-pass-1"}, mgr_tok)
show("manager invites a viewer", code, out, 201)
invitee = out if code == 201 else None
show("manager sets role -> user", *call("PATCH", f"/api/users/{vwr['id']}",
                                        {"role": "user"}, mgr_tok), 200)
show("manager sets role -> viewer", *call("PATCH", f"/api/users/{usr['id']}",
                                          {"role": "viewer"}, mgr_tok), 200)
# put those two back so later checks read naturally
call("PATCH", f"/api/users/{vwr['id']}", {"role": "viewer"}, tok)
call("PATCH", f"/api/users/{usr['id']}", {"role": "user"}, tok)

section("manager cannot climb")
show("manager assigns admin", *call("PATCH", f"/api/users/{vwr['id']}",
                                    {"role": "admin"}, mgr_tok), 403)
show("manager invites an admin", *call("POST", "/api/users",
                                       {"name": "V2 Sneak", "email": "v2-sneak@example.com",
                                        "role": "admin", "password": "smoke-pass-1"}, mgr_tok), 403)
show("manager invites a manager", *call("POST", "/api/users",
                                        {"name": "V2 Sneak2", "email": "v2-sneak2@example.com",
                                         "role": "manager", "password": "smoke-pass-1"}, mgr_tok), 403)
show("manager promotes itself", *call("PATCH", f"/api/users/{mgr['id']}",
                                      {"role": "admin"}, mgr_tok), 403)
show("manager promotes a peer", *call("PATCH", f"/api/users/{peer['id']}",
                                      {"role": "admin"}, mgr_tok), 403)
show("manager edits a peer", *call("PATCH", f"/api/users/{peer['id']}",
                                   {"org": "Hijacked"}, mgr_tok), 403)
show("manager demotes the admin", *call("PATCH", f"/api/users/{me['id']}",
                                        {"role": "viewer"}, mgr_tok), 403)
show("manager disables the admin", *call("PATCH", f"/api/users/{me['id']}",
                                         {"is_active": False}, mgr_tok), 403)
show("manager renames the admin", *call("PATCH", f"/api/users/{me['id']}",
                                        {"name": "Pwned"}, mgr_tok), 403)
show("manager resets admin password", *call("PATCH", f"/api/users/{me['id']}",
                                            {"password": "hijacked-123"}, mgr_tok), 403)
show("manager deletes the admin", *call("DELETE", f"/api/users/{me['id']}", token=mgr_tok), 403)

section("user and viewer cannot administer anyone")
show("user invites", *call("POST", "/api/users",
                           {"name": "V2 Nope", "email": "v2-nope@example.com",
                            "role": "viewer", "password": "smoke-pass-1"}, usr_tok), 403)
show("user sets a role", *call("PATCH", f"/api/users/{vwr['id']}", {"role": "manager"}, usr_tok), 403)
show("user promotes itself", *call("PATCH", f"/api/users/{usr['id']}",
                                   {"role": "manager"}, usr_tok), 403)
show("viewer invites", *call("POST", "/api/users",
                             {"name": "V2 Nope2", "email": "v2-nope2@example.com",
                              "role": "viewer", "password": "smoke-pass-1"}, vwr_tok), 403)
show("viewer sets a role", *call("PATCH", f"/api/users/{usr['id']}", {"role": "admin"}, vwr_tok), 403)
show("viewer promotes itself", *call("PATCH", f"/api/users/{vwr['id']}",
                                     {"role": "admin"}, vwr_tok), 403)

section("the directory is closed below the people floor")
show("admin lists the directory", *call("GET", "/api/users", token=tok), 200)
show("manager lists the directory", *call("GET", "/api/users", token=mgr_tok), 200)
show("user lists the directory", *call("GET", "/api/users", token=usr_tok), 403)
show("viewer lists the directory", *call("GET", "/api/users", token=vwr_tok), 403)
# Query parameters are not a side door: a filter is still the whole listing.
show("viewer searches by email", *call("GET", f"/api/users?q={ADMIN[0]}", token=vwr_tok), 403)
show("viewer filters by role", *call("GET", "/api/users?role=admin", token=vwr_tok), 403)
show("viewer lists orgs", *call("GET", "/api/users/orgs", token=vwr_tok), 403)
show("manager lists orgs", *call("GET", "/api/users/orgs", token=mgr_tok), 200)

section("the narrow assignable list stays at the editor floor")
code, assignable = call("GET", "/api/users/assignable", token=mgr_tok)
show("manager reads assignable", code, assignable, 200)
show("admin reads assignable", *call("GET", "/api/users/assignable", token=tok), 200)
show("user reads assignable", *call("GET", "/api/users/assignable", token=usr_tok), 403)
show("viewer reads assignable", *call("GET", "/api/users/assignable", token=vwr_tok), 403)
leaked = [k for k in ("email", "is_active", "org") if isinstance(assignable, list)
          and assignable and k in assignable[0]]
verify("assignable carries no email", not leaked,
       f"keys={sorted(assignable[0]) if isinstance(assignable, list) and assignable else '?'}")

section("a by-id read is gated like the list")
show("viewer reads its own record", *call("GET", f"/api/users/{vwr['id']}", token=vwr_tok), 200)
show("user reads its own record", *call("GET", f"/api/users/{usr['id']}", token=usr_tok), 200)
show("viewer reads the admin", *call("GET", f"/api/users/{me['id']}", token=vwr_tok), 403)
show("user reads the viewer", *call("GET", f"/api/users/{vwr['id']}", token=usr_tok), 403)
show("manager reads the user", *call("GET", f"/api/users/{usr['id']}", token=mgr_tok), 200)
show("admin reads the viewer", *call("GET", f"/api/users/{vwr['id']}", token=tok), 200)
# A refusal must not double as an oracle: an id that exists and one that doesn't
# have to look the same to someone with no business reading either.
show("viewer reads a missing id", *call("GET", "/api/users/no-such-id", token=vwr_tok), 403)
show("viewer reads own activity", *call("GET", f"/api/users/{vwr['id']}/activity",
                                        token=vwr_tok), 200)
show("viewer reads admin activity", *call("GET", f"/api/users/{me['id']}/activity",
                                          token=vwr_tok), 403)
show("manager reads user activity", *call("GET", f"/api/users/{usr['id']}/activity",
                                          token=mgr_tok), 200)

section("a locked order is admin-only")
code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"locked": True}, mgr_tok)
show("manager sets the lock", code, out, 200)
show("manager patches locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                     {"note": "through the lock"}, mgr_tok), 403)
show("manager stage on locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                      {"stage": other_stage}, mgr_tok), 403)
show("manager due date on locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                         {"due_date": other_due}, mgr_tok), 403)
show("manager deletes locked", *call("DELETE", f"/api/purchase-orders/{pid}", token=mgr_tok), 403)
show("manager unlocks", *call("PATCH", f"/api/purchase-orders/{pid}",
                              {"locked": False}, mgr_tok), 403)
show("user patches locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                  {"note": "nope"}, usr_tok), 403)
show("viewer patches locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                    {"note": "nope"}, vwr_tok), 403)

show("admin patches locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                   {"note": "admin through the lock"}, tok), 200)
show("admin stage on locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                    {"stage": other_stage}, tok), 200)
show("admin due date on locked", *call("PATCH", f"/api/purchase-orders/{pid}",
                                       {"due_date": other_due}, tok), 200)
code, out = call("PATCH", f"/api/purchase-orders/{pid}", {"locked": False}, tok)
show("admin unlocks", code, out, 200)

# deletion of a locked order, on a scratch card so nothing real is at risk
_, scratch = call("POST", "/api/purchase-orders", {"job_no": "J-V2", "po_number": "V2SMOKE",
                                                   "part_number": "V2SMOKE", "qty": 1,
                                                   "due_date": "2026-12-31"}, tok)
sid = scratch["id"]
show("manager locks scratch", *call("PATCH", f"/api/purchase-orders/{sid}",
                                    {"locked": True}, mgr_tok), 200)
show("manager deletes locked scratch", *call("DELETE", f"/api/purchase-orders/{sid}",
                                             token=mgr_tok), 403)
show("admin deletes locked scratch", *call("DELETE", f"/api/purchase-orders/{sid}",
                                           token=tok), 204)

section("admin keeps its own powers")
show("admin assigns admin", *call("PATCH", f"/api/users/{peer['id']}", {"role": "admin"}, tok), 200)
show("admin edits another admin", *call("PATCH", f"/api/users/{peer['id']}",
                                        {"org": "Rack"}, tok), 200)
# Self-demotion still works while a second admin exists -- but the way back up now
# has to come from that second admin, because the demoted account is only a manager.
show("admin changes own role", *call("PATCH", f"/api/users/{me['id']}",
                                     {"role": "manager"}, tok), 200)
show("demoted admin can't climb back", *call("PATCH", f"/api/users/{me['id']}",
                                             {"role": "admin"}, tok), 403)
peer_tok, _ = login(MANAGER2)
show("second admin restores it", *call("PATCH", f"/api/users/{me['id']}",
                                       {"role": "admin"}, peer_tok), 200)
tok, me = login(ADMIN)
show("admin demotes other admin", *call("PATCH", f"/api/users/{peer['id']}",
                                        {"role": "manager"}, tok), 200)

section("last-admin guard survives")
show("demote the only admin", *call("PATCH", f"/api/users/{me['id']}", {"role": "viewer"}, tok), 400)
show("disable the only admin", *call("PATCH", f"/api/users/{me['id']}",
                                     {"is_active": False}, tok), 400)
_, check = call("GET", f"/api/users/{me['id']}", token=tok)
intact = check["role"] == "admin" and check["is_active"]
results.append(intact)
print(f"{'PASS' if intact else 'FAIL'} {'admin still intact':<38} "
      f"role={check['role']} active={check['is_active']}")

section("self-service survives for every rank")
for label, who, who_tok in (("manager", mgr, mgr_tok), ("user", usr, usr_tok),
                            ("viewer", vwr, vwr_tok)):
    show(f"{label} renames itself", *call("PATCH", f"/api/users/{who['id']}",
                                          {"name": f"V2 {label.title()} Renamed"}, who_tok), 200)
    show(f"{label} sets own photo", *call("PATCH", f"/api/users/{who['id']}",
                                          {"avatar_url": f"/uploads/{label}.png"}, who_tok), 200)
    show(f"{label} clears own photo", *call("PATCH", f"/api/users/{who['id']}",
                                            {"avatar_url": None}, who_tok), 200)
show("admin renames itself", *call("PATCH", f"/api/users/{me['id']}",
                                   {"name": me["name"]}, tok), 200)
show("viewer renames someone else", *call("PATCH", f"/api/users/{usr['id']}",
                                          {"name": "Not Yours"}, vwr_tok), 403)

section("a profile photo is self-service at every rank")
png = make_png()
for label, who, who_tok in (("viewer", vwr, vwr_tok), ("user", usr, usr_tok),
                            ("manager", mgr, mgr_tok), ("admin", me, tok)):
    code, out = upload("/api/uploads/avatar", png, who_tok, f"v2-{label}.png", "image/png")
    show(f"{label} uploads own photo", code, out, 201)
    url = out.get("avatar_url") if isinstance(out, dict) else None
    _, stored = call("GET", f"/api/users/{who['id']}", token=tok)
    verify(f"{label} photo lands on the record",
           bool(url) and stored.get("avatar_url") == url, str(stored.get("avatar_url")))
    served, size = fetch_status(url) if url else (0, 0)
    verify(f"{label} photo is served", served == 200 and size > 0, f"{served}, {size} bytes")

section("attaching files to an order stays at editor floor")
show("viewer uploads an order photo",
     *upload("/api/uploads", png, vwr_tok, "v2.png", "image/png"), 403)
show("user uploads an order photo",
     *upload("/api/uploads", png, usr_tok, "v2.png", "image/png"), 403)
show("viewer uploads a model",
     *upload("/api/uploads/model", TINY_OBJ, vwr_tok, "v2.obj", "application/octet-stream"), 403)
show("user uploads a model",
     *upload("/api/uploads/model", TINY_OBJ, usr_tok, "v2.obj", "application/octet-stream"), 403)
show("manager uploads an order photo",
     *upload("/api/uploads", png, mgr_tok, "v2.png", "image/png"), 201)
show("admin uploads an order photo",
     *upload("/api/uploads", png, tok, "v2.png", "image/png"), 201)
# What the model route makes of a given file belongs to the model feature's own
# tests; all this asserts is that the editor floor is where the two ranks divide.
code, out = upload("/api/uploads/model", TINY_OBJ, mgr_tok, "v2.obj",
                   "application/octet-stream")
verify("manager clears the model gate", code != 403, f"{code}")

section("the avatar route cannot be aimed at anyone else")
_, admin_before_sneak = call("GET", f"/api/users/{me['id']}", token=tok)
code, sneak = upload("/api/uploads/avatar", png, vwr_tok, "v2-sneak.png", "image/png",
                     fields={"user_id": me["id"], "id": me["id"], "email": ADMIN[0]})
show("viewer smuggles an admin id", code, sneak, 201)
_, admin_after_sneak = call("GET", f"/api/users/{me['id']}", token=tok)
verify("the admin's photo is untouched",
       admin_after_sneak["avatar_url"] == admin_before_sneak["avatar_url"],
       str(admin_after_sneak["avatar_url"]))
_, vwr_after_sneak = call("GET", f"/api/users/{vwr['id']}", token=tok)
verify("it wrote the caller's own photo instead",
       vwr_after_sneak["avatar_url"] == sneak.get("avatar_url"),
       str(vwr_after_sneak["avatar_url"]))
show("viewer sets someone else's photo by PATCH",
     *call("PATCH", f"/api/users/{usr['id']}", {"avatar_url": "/uploads/x.png"}, vwr_tok), 403)

# restore the borrowed order and clear every throwaway account
call("PATCH", f"/api/purchase-orders/{pid}", before | {"locked": False}, tok)
_, final = call("GET", f"/api/purchase-orders/{pid}", token=tok)
restored = all(final[k] == before[k] for k in ("status", "due_date", "note")) and not final["locked"]
results.append(restored)
print(f"\n{'PASS' if restored else 'FAIL'} restored {final['job_no']} {final['stage']} "
      f"due {final['due_date']} locked={final['locked']} note={final['note']!r}")

for u in (mgr, peer, usr, vwr, invitee):
    if u:
        call("DELETE", f"/api/users/{u['id']}", token=tok)

# put the primary account's photo back exactly as it was, then remove every file
# this run stored -- by exact name, so nothing else in uploads/ is disturbed
call("PATCH", f"/api/users/{me['id']}", {"avatar_url": admin_photo_before}, tok)
stored_names = list(dict.fromkeys(uploaded))
removed = 0
for name in stored_names:
    path = UPLOAD_DIR / name
    if path.exists():
        path.unlink()
        removed += 1

_, users = call("GET", "/api/users", token=tok)
_, pos = call("GET", "/api/purchase-orders", token=tok)
_, admin_final = call("GET", f"/api/users/{me['id']}", token=tok)
locked = sum(1 for p in pos if p["locked"])
# Only this run's accounts are ours to insist on. Other agents work in the same
# database, and failing on a row they are still using would be a false alarm --
# so name theirs in the output and leave them be.
mine = {MANAGER[0], MANAGER2[0], USER[0], VIEWER[0], "v2-invitee@example.com"}
leftovers = [u["email"] for u in users if u["email"] in mine]
others = [u["email"] for u in users if u["email"] not in mine and u["email"] != ADMIN[0]]
clean = (not leftovers and len(pos) == 28 and locked == 0
         and admin_final["avatar_url"] == admin_photo_before)
results.append(clean)
print(f"{'PASS' if clean else 'FAIL'} cleanup  {len(users)} user(s), none of ours left"
      f"{'' if not leftovers else ' EXCEPT ' + str(leftovers)}, "
      f"{len(pos)} PO(s), {locked} locked, admin photo={admin_final['avatar_url']}")
if others:
    print(f"     note: not ours, left alone -> {others}")
verify(f"removed {removed} uploaded file(s) by exact name",
       removed == len(stored_names), f"{len(stored_names)} stored this run")

print(f"\n{sum(results)}/{len(results)} checks passed"
      f"{'' if all(results) else '   <-- SOMETHING FAILED'}")
