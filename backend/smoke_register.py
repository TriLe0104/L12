"""Checks the self-service sign-up path: python smoke_register.py"""

import uuid

from smoke_test import call


def main() -> None:
    email = f"tri.{uuid.uuid4().hex[:6]}@gmail.com"
    code, res = call("POST", "/api/auth/register", {"name": "Tri Le", "email": email, "password": "shopfloor123"})
    print(f"REGISTER  {code} {res['user']['name']} <{res['user']['email']}> role={res['user']['role']}")

    token = res["access_token"]
    _, me = call("GET", "/api/auth/me", None, token)
    print(f"SESSION   {me['email']} active={me['is_active']} pending={me['is_pending']}")

    code, _ = call("POST", "/api/auth/register", {"name": "Dupe", "email": email, "password": "shopfloor123"})
    print(f"DUPLICATE {code} (expect 409)")

    code, _ = call("POST", "/api/auth/register", {"name": "Shorty", "email": f"x{email}", "password": "short"})
    print(f"SHORT PW  {code} (expect 422)")

    _, login = call("POST", "/api/auth/login", {"email": email, "password": "shopfloor123"})
    print(f"LOGIN     {login['user']['email']} ok")

    _, acts = call("GET", f"/api/users/{me['id']}/activity", None, token)
    print("ACTIVITY  " + " | ".join(a["action"] for a in acts))

    _, pos = call("GET", "/api/purchase-orders", None, token)
    print(f"BOARD     {len(pos)} POs visible to the new account")


if __name__ == "__main__":
    main()
