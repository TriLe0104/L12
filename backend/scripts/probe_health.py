import json
import time
import urllib.request

base = "http://127.0.0.1:8001"
t0 = time.time()
req = urllib.request.Request(
    f"{base}/api/auth/login",
    data=b'{"email":"test@test","password":"test"}',
    headers={"Content-Type": "application/json"},
    method="POST",
)
token = json.loads(urllib.request.urlopen(req, timeout=8).read())["access_token"]
print("login", round(time.time() - t0, 2))
hdr = {"Authorization": f"Bearer {token}"}
for path in ("/api/cluster/metrics?range=5m", "/api/cluster/power", "/api/cluster/health"):
    t1 = time.time()
    try:
        body = json.loads(urllib.request.urlopen(urllib.request.Request(base + path, headers=hdr), timeout=15).read())
        extra = ""
        if "metrics" in path:
            extra = f" src={body.get('source')} racks={(body.get('size') or {}).get('racks')} leak={((body.get('health') or {}).get('leak') or {}).get('value')}"
        if path.endswith("health"):
            extra = f" nodes={body.get('node_count')} leak={(body.get('leak') or {}).get('value')}"
        print(path, round(time.time() - t1, 2), "ok", extra)
    except Exception as exc:
        print(path, round(time.time() - t1, 2), "FAIL", exc)
