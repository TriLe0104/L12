/* Admin delete-user UI verification.
     node scripts/tmp-verify-delete-user.mjs
   Requires frontend :3000 and API :8000. Writes screenshots under frontend/tmp-shots. */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = process.env.PO_EMAIL ?? "trile0104@gmail.com";
const PASSWORD = process.env.PO_PASSWORD ?? "tvm-temp-2026";
const SHOT = "C:\\Users\\tril\\Projects\\po-calendar\\frontend\\tmp-shots";

mkdirSync(SHOT, { recursive: true });

let pass = 0;
const fails = [];
const ok = (cond, label, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  OK  ${label}`);
  } else {
    fails.push(`${label}${extra ? ` — ${extra}` : ""}`);
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const api = async (method, path, body, token) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
ok(login.status === 200 && login.data.user.role === "admin", "admin API login");
const T = login.data.access_token;

/* throwaway accounts for UI */
const victim = await api(
  "POST",
  "/api/users",
  {
    name: "UI Delete Victim",
    email: "ui-delete-victim@tmp.invalid",
    role: "user",
    password: "ui-delete-pass-1",
  },
  T,
);
ok(victim.status === 201, "create UI victim", String(victim.status));
const victimId = victim.data?.id;

const mgr = await api(
  "POST",
  "/api/users",
  {
    name: "UI Delete Manager",
    email: "ui-delete-mgr@tmp.invalid",
    role: "manager",
    password: "ui-delete-pass-1",
  },
  T,
);
ok(mgr.status === 201, "create UI manager", String(mgr.status));

let browser;
for (let i = 0; i < 6; i++) {
  try {
    browser = await chromium.launch();
    break;
  } catch (e) {
    if (i === 5) throw e;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const signIn = async (page, email, password) => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|users|tasks|calendar)/, { timeout: 45000 });
};

/* ---------- Admin: sees Delete, cancel, then confirm ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`${BASE}/users`, { waitUntil: "networkidle" });

  const row = page.locator(".user-row", { hasText: "UI Delete Victim" });
  await row.click();
  await page.waitForSelector(`button[aria-label="Delete UI Delete Victim"]`);
  ok(true, "Admin sees Delete on another account");

  await page.screenshot({ path: `${SHOT}/delete-user-admin-ready.png`, fullPage: true });

  page.once("dialog", async (d) => {
    ok(d.message().includes("UI Delete Victim"), "confirm names the user", d.message());
    ok(d.message().toLowerCase().includes("cannot be undone") || d.message().toLowerCase().includes("permanently"), "confirm warns permanent", d.message());
    await d.dismiss();
  });
  await page.click('button[aria-label="Delete UI Delete Victim"]');
  await page.waitForTimeout(400);
  ok(await row.count() === 1, "cancel leaves the row in the list");

  page.once("dialog", async (d) => {
    await d.accept();
  });
  await page.click('button[aria-label="Delete UI Delete Victim"]');
  await page.waitForTimeout(800);
  ok((await row.count()) === 0, "successful delete removes the row");
  await page.screenshot({ path: `${SHOT}/delete-user-admin-after.png`, fullPage: true });

  /* own account: no Delete control */
  const meRow = page.locator(".user-row", { hasText: EMAIL });
  if ((await meRow.count()) > 0) {
    await meRow.click();
    await page.waitForTimeout(300);
  }
  ok((await page.locator('button[aria-label^="Delete "]').count()) === 0, "Admin has no Delete on own account");
  await page.screenshot({ path: `${SHOT}/delete-user-admin-self.png`, fullPage: true });

  await ctx.close();
}

/* ---------- Manager: no Delete control ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, "ui-delete-mgr@tmp.invalid", "ui-delete-pass-1");
  await page.goto(`${BASE}/users`, { waitUntil: "networkidle" });

  const anyDelete = await page.locator('button[aria-label^="Delete "], button:has-text("Delete user")').count();
  ok(anyDelete === 0, "Manager does not see Delete control");
  await page.screenshot({ path: `${SHOT}/delete-user-manager.png`, fullPage: true });
  await ctx.close();
}

await browser.close();

/* cleanup temps (victim already deleted on success) */
const roster = await api("GET", "/api/users", null, T);
for (const u of roster.data ?? []) {
  if (String(u.email).includes("tmp.invalid") || String(u.email).startsWith("ui-delete")) {
    await api("DELETE", `/api/users/${u.id}`, null, T);
  }
}
const finalRoster = await api("GET", "/api/users", null, T);
const emails = (finalRoster.data ?? []).map((u) => u.email);
ok(emails.includes(EMAIL), "Tri Le still present after UI cleanup");
ok(!emails.some((e) => e.includes("tmp.invalid")), "UI temp users cleaned");

const pos = await api("GET", "/api/purchase-orders", null, T);
ok((pos.data ?? []).length === 28, "28 POs after UI verify", String((pos.data ?? []).length));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  - ${f}`);
if (fails.length) process.exit(1);
