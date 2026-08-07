"""API-level verify for dashboard column sync + widthRem (no browser)."""
from __future__ import annotations

import copy
import json
import urllib.error
import urllib.request

API = "http://127.0.0.1:8000"
ADMIN = {"email": "trile0104@gmail.com", "password": "tvm-temp-2026"}
FIELD_KEY = "cf_dash_coat"
FIELD_LABEL = "Coat Spec"


def call(method: str, path: str, body=None, token: str | None = None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read().decode()
            return res.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"detail": raw}
        return e.code, payload


def find_col(doc, key):
    return next((c for c in doc.get("dashboardColumns") or [] if c.get("key") == key), None)


def main() -> None:
    code, login = call("POST", "/api/auth/login", ADMIN)
    assert code == 200, login
    token = login["access_token"]

    code, board = call("GET", "/api/settings/board", token=token)
    assert code == 200, board
    baseline = copy.deepcopy(board["document"])
    print(
        f"version={baseline.get('version')} cols={len(baseline.get('dashboardColumns') or [])} "
        f"customs={len(baseline.get('customFields') or [])}"
    )

    job = find_col(baseline, "job")
    assert job and job.get("widthRem") is not None, job
    insp = find_col(baseline, "inspection")
    assert insp and insp.get("visible") is False, insp
    print(f"ok upgrade job.widthRem={job['widthRem']} inspection hidden")

    doc = copy.deepcopy(baseline)
    doc["customFields"] = [f for f in doc.get("customFields") or [] if f.get("key") != FIELD_KEY]
    doc["cardFields"] = [f for f in doc.get("cardFields") or [] if f.get("key") != FIELD_KEY]
    doc["dashboardColumns"] = [
        c for c in doc.get("dashboardColumns") or [] if c.get("key") != FIELD_KEY
    ]
    doc["customFields"].append({"key": FIELD_KEY, "label": FIELD_LABEL, "type": "text"})
    doc["cardFields"].append(
        {"key": FIELD_KEY, "kind": "custom", "label": FIELD_LABEL, "visible": True}
    )
    code, saved = call("PUT", "/api/settings/board", {"document": doc}, token)
    assert code == 200, saved
    hidden = find_col(saved["document"], FIELD_KEY)
    assert hidden and hidden["visible"] is False and hidden.get("widthRem") is None, hidden
    print("ok custom column synced hidden")

    doc = copy.deepcopy(saved["document"])
    for c in doc["dashboardColumns"]:
        if c["key"] == FIELD_KEY:
            c["visible"] = True
            c["widthRem"] = 7.5
        if c["key"] == "customer":
            c["widthRem"] = 9
    code, saved = call("PUT", "/api/settings/board", {"document": doc}, token)
    assert code == 200, saved
    enabled = find_col(saved["document"], FIELD_KEY)
    customer = find_col(saved["document"], "customer")
    assert enabled and enabled["visible"] and enabled["widthRem"] == 7.5, enabled
    assert customer and customer["widthRem"] == 9, customer
    print("ok enabled + widths persisted")

    # Reload GET — survive round-trip
    code, again = call("GET", "/api/settings/board", token=token)
    assert code == 200, again
    enabled2 = find_col(again["document"], FIELD_KEY)
    assert enabled2 and enabled2["widthRem"] == 7.5 and enabled2["visible"], enabled2
    print("ok survives reload")

    # Restore baseline without the test field
    restore = copy.deepcopy(baseline)
    restore["customFields"] = [f for f in restore.get("customFields") or [] if f.get("key") != FIELD_KEY]
    restore["cardFields"] = [f for f in restore.get("cardFields") or [] if f.get("key") != FIELD_KEY]
    restore["dashboardColumns"] = [
        c for c in restore.get("dashboardColumns") or [] if c.get("key") != FIELD_KEY
    ]
    code, restored = call("PUT", "/api/settings/board", {"document": restore}, token)
    assert code == 200, restored
    assert find_col(restored["document"], FIELD_KEY) is None
    print("ok restored")
    print("PASS api verify-dashboard-columns")


if __name__ == "__main__":
    main()
