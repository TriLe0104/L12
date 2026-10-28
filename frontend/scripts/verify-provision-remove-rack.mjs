import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.env.L12_URL || "http://127.0.0.1:3000";
const api = process.env.L12_API || "http://127.0.0.1:8001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";
const outDir = join(process.cwd(), "..", "screenshots");
mkdirSync(outDir, { recursive: true });

const label = `tmp-rm-${Date.now().toString(36)}`;

const login = await fetch(`${api}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

const created = await fetch(`${api}/api/maxlps/racks`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ label, serial: `SN-${label}` }),
});
if (!created.ok) throw new Error(`create rack ${created.status} ${await created.text()}`);
const rack = await created.json();
console.log("created", rack.id, rack.label);

const sync = await fetch(`${api}/api/provision/sync`, { method: "POST", headers: auth });
if (!sync.ok) throw new Error(`sync ${sync.status} ${await sync.text()}`);
const snap = await sync.json();
const shown = (snap.racks || []).some((r) => r.name === label || r.id === rack.id || r.serial === rack.serial);
if (!shown) {
  await fetch(`${api}/api/maxlps/racks/${encodeURIComponent(rack.id)}`, { method: "DELETE", headers: auth });
  throw new Error("created rack missing from provision snapshot");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(90000);
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/provision`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".provision-app", { timeout: 90000 });
await page.getByPlaceholder("Filter").fill(label);
await page.waitForFunction(
  (name) => [...document.querySelectorAll("[data-mona-rack]")].some((el) => (el.getAttribute("data-mona-rack") || "").includes(name)),
  label,
  { timeout: 90000 },
);
const row = page.locator("tr.inv-parent").filter({ hasText: label }).first();
await row.locator(".prov-rack-remove").click();
await page.waitForSelector(".theme-dialog", { timeout: 8000 });
await page.screenshot({ path: join(outDir, "provision-remove-rack.png") });
const delWait = page.waitForResponse(
  (r) => r.url().includes("/api/provision/racks/") && r.request().method() === "DELETE",
  { timeout: 30000 },
);
await page.getByRole("button", { name: "Remove rack" }).click();
const del = await delWait;
if (!del.ok()) throw new Error(`DELETE ${del.status()} ${await del.text()}`);
await page.waitForSelector(".theme-dialog", { state: "detached", timeout: 15000 });
await page.waitForFunction(
  (name) => ![...document.querySelectorAll("[data-mona-rack]")].some((el) => (el.getAttribute("data-mona-rack") || "") === name),
  label,
  { timeout: 20000 },
);
await page.screenshot({ path: join(outDir, "provision-remove-rack-gone.png") });
await browser.close();

const again = await fetch(`${api}/api/provision/sync`, { method: "POST", headers: auth });
if (!again.ok) throw new Error(`resync ${again.status}`);
const after = await again.json();
if ((after.racks || []).some((r) => r.name === label || r.serial === rack.serial)) {
  throw new Error("removed rack came back after Argus sync");
}
console.log("ok", label);
