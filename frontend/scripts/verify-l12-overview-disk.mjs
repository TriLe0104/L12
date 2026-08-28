import { chromium } from "playwright";
const WEB = "http://127.0.0.1:3001";
const API = "http://127.0.0.1:8001";
const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tri@supermicro.com", password: "demo1234" }),
});
const { access_token } = await res.json();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".overview-dash", { timeout: 25000 });
await page.waitForSelector(".chart-row", { timeout: 10000 });
await page.waitForTimeout(700);
const text = (await page.locator(".overview-dash").innerText()).toUpperCase();
const gauges = await page.locator(".gauge").count();
const charts = await page.locator(".net-panel").count();
await page.screenshot({ path: "test-results/l12-overview-gauges-1440.png" });
await browser.close();
console.log(JSON.stringify({ errors, gauges, charts, hasDisk: text.includes("DISK"), hasNet: text.includes("NETWORK"), hasReady: text.includes("READY") }));
if (errors.length) process.exit(1);
if (charts < 2) throw new Error("expected 2 charts");
