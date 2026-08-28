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
mkdirSync("test-results", { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".overview-dash", { timeout: 25000 });
await page.waitForTimeout(700);
const gauges = await page.locator(".gauge").count();
const text = (await page.locator(".overview-dash").innerText()).toUpperCase();
await page.screenshot({ path: "test-results/l12-overview-gauges-1440.png" });

const rail = page.locator(".rail");
const w1 = (await rail.boundingBox()).width;
await rail.hover();
await page.waitForTimeout(280);
const w2 = (await rail.boundingBox()).width;
await page.screenshot({ path: "test-results/l12-rail-open-1440.png" });

await page.goto(`${WEB}/network`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Port Mapping" }).click();
await page.waitForSelector(".faceplate-grid", { timeout: 20000 });
const cages = await page.locator(".cage").count();
await page.screenshot({ path: "test-results/l12-ports-faceplate-1440.png" });

await page.goto(`${WEB}/provision`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".provision-app .network-table tbody tr", { timeout: 25000 });
const inv = await page.locator(".provision-col").first().locator("tbody tr").count();
await page.getByRole("button", { name: "ARP scan", exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "test-results/l12-provision-1440.png" });
await page.getByRole("button", { name: "KVM / SOL" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "test-results/l12-provision-sol-1440.png" });

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".brand-hero-mark", { timeout: 15000 });
await page.screenshot({ path: "test-results/l12-login-cat.png" });

await browser.close();
const out = { errors, gauges, cages, inv, railCollapsed: Math.round(w1), railOpen: Math.round(w2), hasGpu: text.includes("GPU"), hasNet: text.includes("NETWORK") };
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
if (gauges !== 4) throw new Error("expected 4 gauges, got " + gauges);
if (cages !== 64) throw new Error("expected 64 cages, got " + cages);
if (w2 <= w1 + 20) throw new Error("rail did not expand");
console.log("ok overview + rail + ports + provision");
