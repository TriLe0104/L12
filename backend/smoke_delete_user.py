"""Admin-only user delete: permissions, self/last-admin, owned-order block, cleanup."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = os.environ.get("PO_API", "http://127.0.0.1:8000")
EMAIL = os.environ.get("PO_EMAIL", "trile0104@gmail.com")
PASSWORD = os.environ.get("PO_PASSWORD", "tvm-temp-2026")
KEEP_INVITE = "shad38@gmail.com"
DUE = (date.today() + timedelta(days=14)).isoformat()

ok = 0
fails: list[str] = []


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
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
            return e.code, parsed.get("detail", raw) if isinstance(parsed, dict) else raw
        except json.JSONDecodeError:
            return e.code, raw


def check(cond: bool, label: str, extra: str = "") -> None:
    global ok
    if cond:
        ok += 1
        print(f"  OK  {label}")
    else:
        fails.append(f"{label}{f' — {extra}' if extra else ''}")
        print(f"FAIL  {label}{f' — {extra}' if extra else ''}")


def main() -> int:
    code, login = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    check(code == 200 and login["user"]["role"] == "admin", "admin login", str(code))
    if code != 200:
        print("\n".join(fails))
        return 1
    admin_tok = login["access_token"]
    admin_id = login["user"]["id"]

    code, board = call("GET", "/api/purchase-orders", token=admin_tok)
    check(code == 200 and len(board) == 28, "28 purchase orders untouched", f"saw {len(board) if code == 200 else code}")
    j55 = [p for p in (board or []) if p["job_no"] == "J-55"]
    check(len(j55) == 1, "J-55 still present", f"count={len(j55)}")

    # --- throwaway User: Admin deletes → 204 ---
    code, throwaway = call(
        "POST",
        "/api/users",
        {
            "name": "Delete Smoke User",
            "email": "delete-smoke-user@tmp.invalid",
            "role": "user",
            "password": "delete-smoke-pass-1",
        },
        admin_tok,
    )
    check(code == 201, "create throwaway User", str(code))
    tid = throwaway["id"] if code == 201 else None

    code, mgr = call(
        "POST",
        "/api/users",
        {
            "name": "Delete Smoke Mgr",
            "email": "delete-smoke-mgr@tmp.invalid",
            "role": "manager",
            "password": "delete-smoke-pass-1",
        },
        admin_tok,
    )
    check(code == 201, "create throwaway Manager", str(code))
    mid = mgr["id"] if code == 201 else None
    code, mlogin = call(
        "POST", "/api/auth/login", {"email": "delete-smoke-mgr@tmp.invalid", "password": "delete-smoke-pass-1"}
    )
    mgr_tok = mlogin["access_token"] if code == 200 else None
    check(code == 200, "manager login", str(code))

    if tid and mgr_tok:
        code, detail = call("DELETE", f"/api/users/{tid}", token=mgr_tok)
        check(code == 403, "Manager cannot delete User", f"{code} {detail}")

    if tid:
        code, detail = call("DELETE", f"/api/users/{tid}", token=admin_tok)
        check(code == 204, "Admin deletes throwaway User -> 204", f"{code} {detail}")
        _, users = call("GET", "/api/users", token=admin_tok)
        check(all(u["id"] != tid for u in users), "throwaway gone from directory")

    # --- self-delete blocked ---
    code, detail = call("DELETE", f"/api/users/{admin_id}", token=admin_tok)
    check(code == 400 and "own account" in str(detail).lower(), "self-delete blocked", f"{code} {detail}")

    # --- owned-order target blocked ---
    code, owner = call(
        "POST",
        "/api/users",
        {
            "name": "Delete Smoke Owner",
            "email": "delete-smoke-owner@tmp.invalid",
            "role": "user",
            "password": "delete-smoke-pass-1",
        },
        admin_tok,
    )
    check(code == 201, "create owner throwaway", str(code))
    oid = owner["id"] if code == 201 else None
    po_id = None
    if oid:
        code, po = call(
            "POST",
            "/api/purchase-orders",
            {
                "job_no": "J-DEL",
                "po_number": "DEL-SMOKE",
                "part_number": "DEL1",
                "qty": 1,
                "due_date": DUE,
                "owner_id": oid,
            },
            admin_tok,
        )
        check(code == 201, "create scratch PO owned by throwaway", str(code))
        po_id = po["id"] if code == 201 else None

        code, detail = call("DELETE", f"/api/users/{oid}", token=admin_tok)
        check(
            code == 400 and "reassign" in str(detail).lower(),
            "owned-order delete blocked with readable error",
            f"{code} {detail}",
        )
        _, pos = call("GET", "/api/purchase-orders", token=admin_tok)
        still = [p for p in pos if p["id"] == po_id]
        check(len(still) == 1 and still[0]["owner"] and still[0]["owner"]["id"] == oid, "owner still attached (no orphan)")

        if po_id:
            call("DELETE", f"/api/purchase-orders/{po_id}", token=admin_tok)
        code, detail = call("DELETE", f"/api/users/{oid}", token=admin_tok)
        check(code == 204, "delete owner after reassign/delete PO", f"{code} {detail}")

    # --- cleanup temps; keep Tri Le + pending invite ---
    if mid:
        call("DELETE", f"/api/users/{mid}", token=admin_tok)

    _, users = call("GET", "/api/users", token=admin_tok)
    temps = [u for u in users if "tmp.invalid" in u["email"] or u["email"].startswith("delete-smoke")]
    for u in temps:
        call("DELETE", f"/api/users/{u['id']}", token=admin_tok)

    _, users = call("GET", "/api/users", token=admin_tok)
    emails = {u["email"] for u in users}
    check(EMAIL in emails, "Tri Le admin still present")
    if KEEP_INVITE in emails:
        check(True, f"pending invite {KEEP_INVITE} preserved")
    else:
        print(f"  ..  note: {KEEP_INVITE} not in directory (may not have been invited yet)")

    check(not any("tmp.invalid" in e for e in emails), "no temp users left", str(emails))

    _, board = call("GET", "/api/purchase-orders", token=admin_tok)
    check(len(board) == 28, "still 28 POs after cleanup", f"saw {len(board)}")
    check(any(p["job_no"] == "J-55" for p in board), "J-55 untouched")
    dangling = []
    user_ids = {u["id"] for u in users}
    for p in board:
        if p.get("owner") and p["owner"]["id"] not in user_ids:
            dangling.append(p["job_no"])
    check(not dangling, "no dangling owners", str(dangling))

    print(f"\n{ok} passed, {len(fails)} failed")
    for f in fails:
        print(f"  - {f}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
