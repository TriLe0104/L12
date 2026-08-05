"""Shows the current roster, that nothing was orphaned, and that password change works."""

from smoke_test import call

EMAIL = "trile0104@gmail.com"
PASSWORD = "tvm-temp-2026"


def main() -> None:
    code, l = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    print(f"LOGIN     {code} {l['user']['name']} <{l['user']['email']}> {l['user']['role']}")
    token = l["access_token"]

    _, users = call("GET", "/api/users", None, token)
    for u in users:
        print(f"USER      {u['name']:<12} {u['email']:<26} {u['role']}")
    print(f"TOTAL     {len(users)} user(s)")

    _, pos = call("GET", "/api/purchase-orders", None, token)
    ownerless = [p for p in pos if not p["owner"]]
    owners = {p["owner"]["name"] for p in pos if p["owner"]}
    print(f"POS       {len(pos)} total · {len(ownerless)} ownerless · owners: {owners}")

    code, _ = call("POST", "/api/auth/login", {"email": "tri@supermicro.com", "password": "demo1234"})
    print(f"OLD LOGIN {code} (expect 401 — that address is gone)")

    # password change round-trip, then set it back
    call("PATCH", f"/api/users/{l['user']['id']}", {"password": "rotated-pass-1"}, token)
    code, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": "rotated-pass-1"})
    print(f"ROTATE    {code} login with new password")
    call("PATCH", f"/api/users/{l['user']['id']}", {"password": PASSWORD}, token)
    code, _ = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
    print(f"RESTORE   {code} back to the temporary password")


if __name__ == "__main__":
    main()
