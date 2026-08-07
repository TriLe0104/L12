"""PO comments: any signed-in rank can note, lock/Modified stay untouched.

Creates throwaway Viewer + Manager accounts, posts on a real non-J-55 order
(and a locked one), asserts list order / empty-body 400 / comment_count /
last_modified stability, then deletes the comments and the throwaway users.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("PO_API", "http://127.0.0.1:8000")
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
VIEWER = ("smoke-comment-viewer@example.com", "smoke-pass-1")
MGR = ("smoke-comment-mgr@example.com", "smoke-pass-1")

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
        return e.code, _body(e.read())


def _body(raw):
    try:
        return json.loads(raw.decode() or "null")
    except json.JSONDecodeError:
        return raw.decode(errors="replace")


def _plain_detail(body):
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        d = body.get("detail")
        if isinstance(d, str):
            return d
    return None


def check(cond, msg):
    global fails
    if cond:
        print(f"  ok  {msg}")
    else:
        fails += 1
        print(f" FAIL {msg}")


def login(email, password):
    code, body = call("POST", "/api/auth/login", {"email": email, "password": password})
    check(code == 200, f"login {email}")
    return body["access_token"] if code == 200 else None


def ensure_user(admin_tok, email, name, role, password):
    code, users = call("GET", "/api/users", token=admin_tok)
    check(code == 200, "list users")
    for u in users or []:
        if u["email"] == email:
            call(
                "PATCH",
                f"/api/users/{u['id']}",
                {"role": role, "password": password, "is_active": True, "is_pending": False},
                token=admin_tok,
            )
            return u["id"]
    code, created = call(
        "POST",
        "/api/users",
        {
            "email": email,
            "name": name,
            "role": role,
            "password": password,
            "org": "Smoke",
        },
        token=admin_tok,
    )
    check(code in (200, 201), f"create {role} {email} -> {code}")
    return created["id"] if isinstance(created, dict) else None


def main():
    print("smoke_comments")
    admin = login(*ADMIN)
    if not admin:
        return 1

    viewer_id = ensure_user(admin, VIEWER[0], "Smoke Comment Viewer", "viewer", VIEWER[1])
    mgr_id = ensure_user(admin, MGR[0], "Smoke Comment Manager", "manager", MGR[1])
    viewer = login(*VIEWER)
    mgr = login(*MGR)
    if not all([viewer_id, mgr_id, viewer, mgr]):
        return 1

    code, pos = call("GET", "/api/purchase-orders", token=admin)
    check(code == 200 and isinstance(pos, list), f"list POs ({len(pos) if isinstance(pos, list) else '?'})")
    target = next((p for p in pos if p.get("job_no") != "J-55" and not p.get("locked")), None)
    check(target is not None, "found unlocked non-J-55 PO")
    if not target:
        return 1

    po_id = target["id"]
    before_lm = target.get("last_modified")
    before_count = target.get("comment_count", 0)
    print(f"  using {target['job_no']} ({po_id[:8]}…) count={before_count}")

    code, empty = call("POST", f"/api/purchase-orders/{po_id}/comments", {"body": "   "}, token=viewer)
    check(code == 400 and _plain_detail(empty) == "Comment cannot be empty", f"empty body 400: {empty!r}")

    code, c1 = call(
        "POST",
        f"/api/purchase-orders/{po_id}/comments",
        {"body": "Viewer note from smoke_comments"},
        token=viewer,
    )
    check(code == 201 and c1.get("actor", {}).get("name"), f"viewer post -> {code}")

    code, c2 = call(
        "POST",
        f"/api/purchase-orders/{po_id}/comments",
        {"body": "Manager note from smoke_comments"},
        token=mgr,
    )
    check(code == 201 and c2.get("actor", {}).get("name"), f"manager post -> {code}")

    code, thread = call("GET", f"/api/purchase-orders/{po_id}/comments", token=viewer)
    check(code == 200 and len(thread) >= 2, f"list len={len(thread) if isinstance(thread, list) else '?'}")
    if isinstance(thread, list) and len(thread) >= 2:
        ids = [c["id"] for c in thread]
        check(c1["id"] in ids and c2["id"] in ids, "both comments present")
        i1, i2 = ids.index(c1["id"]), ids.index(c2["id"])
        check(i1 < i2, "oldest->newest chat order")
        check(bool(thread[i1].get("created_at")), "has created_at")
        check(thread[i1]["actor"]["name"], f"actor={thread[i1]['actor']['name']}")

    code, one = call("GET", f"/api/purchase-orders/{po_id}", token=admin)
    check(code == 200, "get PO after comments")
    check(
        one.get("comment_count", 0) >= before_count + 2,
        f"comment_count {one.get('comment_count')} >= {before_count + 2}",
    )
    check(one.get("last_modified") == before_lm, "last_modified unchanged by comments")

    # Locked order still accepts comments
    locked = next((p for p in pos if p.get("locked") and p.get("job_no") != "J-55"), None)
    locked_id = None
    we_locked = False
    if locked is None:
        code, _ = call("PATCH", f"/api/purchase-orders/{po_id}", {"locked": True}, token=admin)
        check(code == 200, "temp-lock target for comment test")
        locked_id = po_id
        we_locked = True
    else:
        locked_id = locked["id"]
        print(f"  using existing locked {locked['job_no']}")

    code, c3 = call(
        "POST",
        f"/api/purchase-orders/{locked_id}/comments",
        {"body": "Note on locked order"},
        token=viewer,
    )
    check(code == 201, f"viewer comments on locked -> {code}")

    # Cleanup comments
    to_wipe = []
    if isinstance(c1, dict) and c1.get("id"):
        to_wipe.append((po_id, c1["id"], viewer))
    if isinstance(c2, dict) and c2.get("id"):
        to_wipe.append((po_id, c2["id"], mgr))
    if isinstance(c3, dict) and c3.get("id"):
        to_wipe.append((locked_id, c3["id"], viewer))

    for oid, cid, tok in to_wipe:
        code, _ = call("DELETE", f"/api/purchase-orders/{oid}/comments/{cid}", token=tok)
        if code != 204:
            code, _ = call("DELETE", f"/api/purchase-orders/{oid}/comments/{cid}", token=admin)
        check(code == 204, f"delete comment {cid[:8]}… -> {code}")

    if we_locked:
        call("PATCH", f"/api/purchase-orders/{po_id}", {"locked": False}, token=admin)

    # Remove throwaway users (admin)
    for uid, email in ((viewer_id, VIEWER[0]), (mgr_id, MGR[0])):
        code, _ = call("DELETE", f"/api/users/{uid}", token=admin)
        check(code == 204, f"delete user {email} -> {code}")

    code, pos_end = call("GET", "/api/purchase-orders", token=admin)
    print(f"  POs end: {len(pos_end) if isinstance(pos_end, list) else '?'}")
    print("PASS" if fails == 0 else f"FAILED ({fails})")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
