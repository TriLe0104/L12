"""Profile photos: upload, round-trip through the user record, and self-service limits.

Creates one throwaway account and removes it again, clears the admin's photo and
deletes the images it uploaded, so it is safe to re-run and leaves the DB as found.
"""

import json
import struct
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

BASE = "http://127.0.0.1:8000"
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
ADMIN = ("trile0104@gmail.com", "tvm-temp-2026")
HAND = ("smoke-photo@example.com", "smoke-pass-1")


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


def make_png(size=48):
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


def upload(png, token, filename="smoke-avatar.png"):
    boundary = f"----smoke{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode() + png + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/api/uploads", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")


png = make_png()
uploaded = []

tok, me = login(ADMIN)
print(f"admin         {me['name']} ({me['role']}) avatar={me['avatar_url']!r}")

code, shot = upload(png, tok)
uploaded.append(shot["url"])
print(f"upload        {code} -> {shot['url']}")

code, out = call("PATCH", f"/api/users/{me['id']}", {"avatar_url": shot["url"]}, tok)
print(f"set avatar    {code} -> {out.get('avatar_url')}")

code, out = call("GET", "/api/auth/me", token=tok)
print(f"auth/me       {code} -> {out.get('avatar_url')} (want {shot['url']})")

code, out = call("GET", f"/api/users/{me['id']}", token=tok)
print(f"get user      {code} -> {out.get('avatar_url')} (want {shot['url']})")

served = urllib.request.urlopen(BASE + shot["url"])
print(f"served        {served.status} {served.headers['content-type']} {len(served.read())} bytes")

# a non-admin: Manager so /api/uploads (require_editor) lets them post their own image
_, hand = call("POST", "/api/users", {"name": "Smoke Hand", "email": HAND[0],
                                      "role": "manager", "password": HAND[1]}, tok)
print(f"created       {hand['name']} ({hand['role']})")

hand_tok, _ = login(HAND)
code, own = upload(png, hand_tok, "hand.png")
uploaded.append(own["url"])
print(f"self upload   {code} -> {own['url']}")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"avatar_url": own["url"]}, hand_tok)
print(f"self avatar   {code} -> {out.get('avatar_url')} (want 200)")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"name": "Smoke Hand Jr"}, hand_tok)
print(f"self name     {code} -> {out.get('name')} (want 200)")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"role": "admin"}, hand_tok)
print(f"self role     {code} -> {out.get('detail')} (want 403)")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"org": "Rack"}, hand_tok)
print(f"self org      {code} -> {out.get('detail')} (want 403)")

code, out = call("PATCH", f"/api/users/{hand['id']}",
                 {"avatar_url": own["url"], "role": "admin"}, hand_tok)
print(f"mixed payload {code} -> {out.get('detail')} (want 403)")

code, out = call("PATCH", f"/api/users/{me['id']}", {"avatar_url": None}, hand_tok)
print(f"other user    {code} -> {out.get('detail')} (want 403)")

code, out = call("PATCH", f"/api/users/{hand['id']}", {"avatar_url": None}, hand_tok)
print(f"self clear    {code} -> {out.get('avatar_url')!r} (want None)")

_, trail = call("GET", f"/api/users/{hand['id']}/activity", token=hand_tok)
print(f"activity      {[a['action'] for a in trail]}")

# ---- cleanup: throwaway account, admin photo, and the images we wrote ----
call("DELETE", f"/api/users/{hand['id']}", token=tok)
code, out = call("PATCH", f"/api/users/{me['id']}", {"avatar_url": None}, tok)
print(f"admin cleared {code} -> {out.get('avatar_url')!r}")

for url in uploaded:
    (UPLOAD_DIR / url.rsplit("/", 1)[-1]).unlink(missing_ok=True)

_, users = call("GET", "/api/users", token=tok)
print(f"cleanup       {len(users)} user(s) left: {[u['email'] for u in users]}")
