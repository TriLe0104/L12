"""Temporary: exercise /api/uploads/model accept + reject paths. Deleted after use."""

from __future__ import annotations

import json
import pathlib
import urllib.error
import urllib.request
import uuid

API = "http://127.0.0.1:8000"
SRC = pathlib.Path(r"c:\Users\tril\Downloads\74-bottle")
UPLOADS = pathlib.Path(__file__).resolve().parent / "uploads"
FILES = [
    "BOTTLE MID POLY.fbx",
    "BOTTLE MID POLY.obj",
    "BOTTLE HIGH POLY.fbx",
    "BOTTLE HIGH POLY.obj",
    "BOTTLE.stp",
    "BOTTLE.3dm",
]


def call(path: str, data=None, headers=None, method=None, raw=False):
    req = urllib.request.Request(
        f"{API}{path}" if path.startswith("/") else path,
        data=data,
        headers=headers or {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return r.status, (body if raw else json.loads(body or b"null")), dict(r.headers)
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, body.decode("utf-8", "replace"), dict(e.headers)


def multipart(filename: str, payload: bytes, content_type: str) -> tuple[bytes, str]:
    boundary = f"----{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    return head + payload + f"\r\n--{boundary}--\r\n".encode(), boundary


def post_model(filename: str, payload: bytes, content_type: str = "image/png"):
    body, boundary = multipart(filename, payload, content_type)
    return call(
        "/api/uploads/model",
        data=body,
        headers={**AUTH, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )


_, login, _ = call(
    "/api/auth/login",
    data=json.dumps({"email": "trile0104@gmail.com", "password": "tvm-temp-2026"}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
AUTH = {"Authorization": f"Bearer {login['access_token']}"}

created: list[str] = []
print("--- the six reference files (declared MIME deliberately wrong) ---")
for name in FILES:
    data = (SRC / name).read_bytes()
    code, out, _ = post_model(name, data)
    print(f"{name:22} {code} {json.dumps(out)[:150]}")
    assert code == 201, out
    created.append(out["url"])
    back_code, back, back_headers = call(f"{API}{out['url']}", raw=True)
    print(
        f"{'':22} refetch {back_code} ct={back_headers.get('Content-Type')!r} "
        f"bytes={len(back)} identical={back == data} "
        f"filename_roundtrip={out['filename'] == name} format={out['format']}"
    )
    assert back == data, "bytes differ after round-trip"

print("\n--- rejections (detail must be a plain string) ---")
cases = [
    ("png renamed .obj", "part.obj", b"\x89PNG\r\n\x1a\n" + b"\x00" * 200),
    ("unsupported ext", "part.gltf", b"{}"),
    ("garbage .fbx", "broken.fbx", b"not an fbx at all " * 20),
    ("empty .stp", "empty.stp", b""),
    ("truncated fbx header", "part.fbx", b"Kaydara FBX Binar"),
]
for label, name, data in cases:
    code, out, _ = post_model(name, data)
    detail = out.get("detail") if isinstance(out, dict) else out
    print(f"{label:22} {code} str={isinstance(detail, str)} {detail!r}")

print("\n--- oversize ---")
big = b"# oversize\n" + b"v 0 0 0\n" * 9_000_000
print(f"sending {len(big) / 1024 / 1024:.1f} MB")
code, out, _ = post_model("huge.obj", big)
print(f"oversize {code} {out.get('detail')!r}")

print("\n--- cleanup of files this script created ---")
for url in created:
    p = UPLOADS / url.rsplit("/", 1)[-1]
    p.unlink(missing_ok=True)
print("remaining uploads:", len(list(UPLOADS.iterdir())))
