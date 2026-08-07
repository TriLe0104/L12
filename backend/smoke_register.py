"""Checks that public self-registration is unavailable: python smoke_register.py"""

from smoke_test import call


def main() -> None:
    code, body = call(
        "POST",
        "/api/auth/register",
        {"name": "No Signup", "email": "no-signup@example.com", "password": "shopfloor123"},
    )
    print(f"REGISTER  {code} (expect 404 — route is not exposed) {body}")

    code, config = call("GET", "/api/auth/config")
    print(f"CONFIG    {code} allow_signup={config['allow_signup']} (expect False)")


if __name__ == "__main__":
    main()
