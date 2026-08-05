"""Role + org administration: self-service role changes, org assignment, last-admin guard.

Creates two throwaway accounts and removes them again, so it is safe to re-run.
The primary admin is demoted and restored along the way; the restore goes through
the second admin, since a demoted account can no longer administer anything.
"""

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
SECOND = ("smoke-admin@example.com", "smoke-pass-1")
HAND = ("smoke-hand@example.com", "smoke-pass-1")


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


tok, me = login(ADMIN)

_, boss = call("POST", "/api/users", {"name": "Second Admin", "email": SECOND[0],
                                      "role": "admin", "password": SECOND[1]}, tok)
_, hand = call("POST", "/api/users", {"name": "Shop Hand", "email": HAND[0],
                                      "role": "viewer", "password": HAND[1], "org": "Rack"}, tok)
print(f"created       {boss['name']} ({boss['role']}) · {hand['name']} ({hand['role']}, org={hand['org']})")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"role": "manager"}, tok)
print(f"other role    {code} -> {out['role']}")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"org": "GB300 Rack"}, tok)
print(f"assign org    {code} -> {out['org']}")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"org": "  "}, tok)
print(f"blank org     {code} -> {out['org']!r} (want None)")

code, out = call("GET", "/api/users/orgs", token=tok)
print(f"known orgs    {code} -> {out}")

# demote self while another admin exists, then confirm the lost rank really bites:
# hand is a manager too, and a manager may not act on a peer
code, out = call("PATCH", f"/api/users/{me['id']}", {"role": "manager"}, tok)
print(f"demote self   {code} -> {out.get('role')}")
code, _ = call("PATCH", f"/api/users/{hand['id']}", {"role": "viewer"}, tok)
print(f"peer refused  {code} (want 403)")

boss_tok, _ = login(SECOND)
code, out = call("PATCH", f"/api/users/{me['id']}", {"role": "admin"}, boss_tok)
print(f"promoted back {code} -> {out.get('role')}")

tok, me = login(ADMIN)
call("DELETE", f"/api/users/{boss['id']}", token=tok)

# sole admin now: the guard should refuse both ways of losing the last one
code, out = call("PATCH", f"/api/users/{me['id']}", {"role": "viewer"}, tok)
print(f"last admin    {code} -> {out.get('detail')}")
code, out = call("PATCH", f"/api/users/{me['id']}", {"is_active": False}, tok)
print(f"self disable  {code} -> {out.get('detail')}")

_, check = call("GET", f"/api/users/{me['id']}", token=tok)
print(f"intact        {check['role']} active={check['is_active']}")

call("DELETE", f"/api/users/{hand['id']}", token=tok)
_, users = call("GET", "/api/users", token=tok)
print(f"cleanup       {len(users)} user(s) left: {[u['email'] for u in users]}")
