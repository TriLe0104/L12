import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://127.0.0.1:3001";
const API = "http://127.0.0.1:8001";
const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tri@supermicro.com", password: "demo1234" }),
});
if (!res.ok) throw new Error(`login ${res.status}`);
const { access_token } = await res.json();

const powerRes = await fetch(`${API}/api/cluster/power`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (!powerRes.ok) throw new Error(`power ${powerRes.status}`);
const power = await powerRes.json();
if (!power.showcase?.length) throw new Error("power snapshot missing showcase");
if (power.static.racks_denied < 1) throw new Error("static should strand racks");

mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".lps-row", { timeout: 25000 });
await page.waitForTimeout(800);
const panels = await page.locator(".lps-panel").count();
const slots = await page.locator(".lps-slot").count();
const text = (await page.locator(".lps-row").innerText()).toUpperCase();
await page.screenshot({ path: "test-results/l12-power-limiter-1440.png" });

await page.setViewportSize({ width: 640, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: "test-results/l12-power-limiter-640.png" });
await page.setViewportSize({ width: 1440, height: 900 });

await page.getByRole("button", { name: "Floor", exact: true }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 25000 });
await page.waitForSelector(".lps-hud", { timeout: 15000 });
await page.waitForTimeout(1200);
const hud = (await page.locator(".lps-hud").innerText()).toUpperCase();
await page.screenshot({ path: "test-results/l12-power-floor-1440.png" });

await page.locator(".lps-hud-modes button", { hasText: "Replay" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "test-results/l12-power-floor-replay-1440.png" });

await browser.close();
const out = {
  errors,
  panels,
  slots,
  hasStatic: text.includes("STATIC POWER"),
  hasMaxlps: text.includes("MAXLPS"),
  hasStranded: text.includes("STRANDED"),
  hudHasBudget: hud.includes("BUDGET"),
  staticDenied: power.static.racks_denied,
  dynamicExtra: power.dynamic.racks_extra,
};
console.log(JSON.stringify(out, null, 2));
if (errors.length) throw new Error(errors.join("\n"));
if (panels !== 2) throw new Error("expected 2 limiter panels, got " + panels);
if (slots < 8) throw new Error("expected stacked rack bars, got " + slots);
if (!out.hasStatic || !out.hasMaxlps) throw new Error("missing static/maxlps copy");
console.log("ok power limiter dashboard + floor");
