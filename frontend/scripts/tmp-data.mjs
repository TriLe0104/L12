/* TEMPORARY data helper. Delete afterwards.
   node scripts/tmp-data.mjs <snapshot|check|touch|cleanup>                     */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const API = "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASSWORD = "tvm-temp-2026";
const SNAP = join(tmpdir(), "po-dash-snapshot-2.json");

const login = async (email, password) => {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()}`);
  return res.json();
};

const call = async (token, path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const FIELDS = [
  "job_no", "po_number", "part_number", "qty", "due_date", "dims", "mat_dim", "material",
  "finish", "inspection", "hardware", "status", "priority", "locked", "customer", "note",
  "thumbnail_url", "model_url", "model_filename", "model_size",
];

const admin = await login(EMAIL, PASSWORD);
const T = admin.access_token;
const mode = process.argv[2] ?? "check";

if (mode === "snapshot") {
  const orders = await call(T, "/api/purchase-orders");
  const users = await call(T, "/api/users");
  writeFileSync(SNAP, JSON.stringify({ orders, users, taken: new Date().toISOString() }, null, 2));
  console.log(`snapshot → ${SNAP}`);
  console.log(`orders: ${orders.length}  users: ${users.length}`);
  const widest = (key) => orders.map((o) => String(o[key])).sort((a, b) => b.length - a.length)[0];
  for (const key of ["job_no", "part_number", "po_number", "qty", "material", "finish", "customer", "status_label"]) {
    const vals = orders.map((o) => String(o[key] ?? ""));
    console.log(
      `  ${key.padEnd(13)} longest="${widest(key)}" (${widest(key).length} chars)` +
        (key === "qty" ? `  max=${Math.max(...orders.map((o) => o.qty))}` : ""),
    );
  }
}

/* One real edit, to prove the activity trail's timestamps read correctly. */
if (mode === "touch") {
  const job = process.argv[3] ?? "J-42";
  if (job === "J-55") throw new Error("refusing to touch J-55");
  const orders = await call(T, "/api/purchase-orders");
  const po = orders.find((o) => o.job_no === job);
  const before = new Date();
  const saved = await call(T, `/api/purchase-orders/${po.id}`, {
    method: "PATCH",
    body: JSON.stringify({ note: po.note }),
  });
  const trail = await call(T, `/api/purchase-orders/${po.id}/activity`);
  console.log(`wall clock now (local) : ${before.toLocaleString()}`);
  console.log(`wall clock now (UTC)   : ${before.toISOString()}`);
  console.log(`newest trail row       : ${trail[0].action} by ${trail[0].actor?.name}`);
  console.log(`  created_at as sent   : ${trail[0].created_at}`);
  console.log(`  parsed to local      : ${new Date(trail[0].created_at).toLocaleString()}`);
  const driftSec = Math.round((Date.now() - Date.parse(trail[0].created_at)) / 1000);
  console.log(`  age per the browser  : ${driftSec}s`);
  console.log(`  verdict              : ${Math.abs(driftSec) < 120 ? "seconds old, as it should be" : `OFF by ${(driftSec / 3600).toFixed(2)}h`}`);
  console.log(`po.updated_at as sent  : ${saved.updated_at}  → ${new Date(saved.updated_at).toLocaleString()}`);
  console.log(`po.created_at as sent  : ${saved.created_at}`);
  console.log(`po.last_modified.at    : ${saved.last_modified?.at}`);
  console.log(`po.due_date as sent    : ${saved.due_date} (was ${po.due_date}) — ${saved.due_date === po.due_date ? "unmoved" : "MOVED"}`);
  const me = await call(T, "/api/users");
  console.log(`user.last_login_at     : ${me[0].last_login_at} → ${new Date(me[0].last_login_at).toLocaleString()}`);
  console.log(`user.created_at        : ${me[0].created_at} → ${new Date(me[0].created_at).toLocaleString()}`);
}

if (mode === "cleanup") {
  const snap = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, "utf8")) : null;
  const users = await call(T, "/api/users");
  const mine = users.filter((u) => u.email.endsWith(".tmp@example.com"));
  const orders = await call(T, "/api/purchase-orders");
  for (const po of orders) {
    if (!mine.some((u) => u.id === po.owner?.id)) continue;
    const was = snap?.orders.find((o) => o.id === po.id)?.owner ?? null;
    await call(T, `/api/purchase-orders/${po.id}`, {
      method: "PATCH",
      body: JSON.stringify({ owner_id: was?.id ?? null }),
    });
    console.log(`${po.job_no}: owner ${po.owner.name} → ${was?.name ?? "Unassigned"} (as snapshotted)`);
  }
  for (const u of mine) {
    await call(T, `/api/users/${u.id}`, { method: "DELETE" });
    console.log(`deleted ${u.email}`);
  }
  if (!mine.length) console.log("no throwaway accounts to remove");
}

if (mode === "check") {
  const orders = await call(T, "/api/purchase-orders");
  const users = await call(T, "/api/users");
  console.log(`orders: ${orders.length}  users: ${users.length}`);
  for (const u of users) console.log(`  user: ${u.name} <${u.email}> ${u.role}`);
  console.log(`J-55 present: ${orders.some((o) => o.job_no === "J-55")}`);
  console.log(`orders with no owner: ${orders.filter((o) => !o.owner).length}`);
  if (existsSync(SNAP)) {
    const snap = JSON.parse(readFileSync(SNAP, "utf8"));
    let drift = 0;
    for (const before of snap.orders) {
      const after = orders.find((o) => o.id === before.id);
      if (!after) {
        console.log(`  MISSING ${before.job_no}`);
        drift++;
        continue;
      }
      for (const f of FIELDS) {
        if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
          console.log(`  DRIFT ${before.job_no}.${f}: ${JSON.stringify(before[f])} → ${JSON.stringify(after[f])}`);
          drift++;
        }
      }
      if ((before.owner?.id ?? null) !== (after.owner?.id ?? null)) {
        console.log(`  DRIFT ${before.job_no}.owner: ${before.owner?.name ?? "—"} → ${after.owner?.name ?? "—"}`);
        drift++;
      }
    }
    for (const o of orders.filter((o) => !snap.orders.some((s) => s.id === o.id))) {
      console.log(`  ADDED ${o.job_no}`);
      drift++;
    }
    console.log(
      drift === 0
        ? `no drift against the snapshot taken ${snap.taken}`
        : `${drift} difference(s) against the snapshot`,
    );
  }
}
