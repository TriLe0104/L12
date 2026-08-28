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

const metrics = await fetch(`${API}/api/cluster/metrics?range=24h`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (!metrics.ok) throw new Error(`metrics ${metrics.status}`);
const payload = await metrics.json();
const span = payload.series.at(-1).t - payload.series[0].t;
if (span < 20 * 3600) throw new Error(`24h series too short: ${span}s`);
if (payload.range !== "24h") throw new Error(`expected range 24h, got ${payload.range}`);

mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".overview-dash .chart-y", { timeout: 25000 });
await page.waitForTimeout(500);

const yText = (await page.locator(".chart-y").allInnerTexts()).join(" | ");
if (yText.toLowerCase().includes("tbps")) throw new Error(`axis still uses Tbps: ${yText}`);
if (!yText.includes("%")) throw new Error(`disk ticks missing %: ${yText}`);

const rangeBtns = page.locator(".range-bar button");
if ((await rangeBtns.count()) < 7) throw new Error("expected range presets");

await page.getByRole("button", { name: "24h", exact: true }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: "test-results/l12-overview-range-24h-1440.png" });
const x24 = await page.locator(".chart-x").first().innerText();
if (!/[A-Za-z]{3}/.test(x24)) throw new Error(`24h x-axis should include dates: ${x24}`);

await page.getByRole("button", { name: "Custom", exact: true }).click();
await page.waitForSelector(".range-custom input", { timeout: 5000 });
const from = page.getByLabel("From");
const to = page.getByLabel("To");
const now = new Date();
const earlier = new Date(now.getTime() - 3 * 3600 * 1000);
const fmt = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
await from.fill(fmt(earlier));
await to.fill(fmt(now));
await page.waitForTimeout(900);
await page.screenshot({ path: "test-results/l12-overview-range-custom-1440.png" });

const mobile = await browser.newContext({ viewport: { width: 420, height: 860 } });
await mobile.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const mpage = await mobile.newPage();
await mpage.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await mpage.waitForSelector(".overview-dash .chart-y", { timeout: 25000 });
await mpage.waitForTimeout(400);
const rangeBox = await mpage.locator(".range-bar").boundingBox();
const statBox = await mpage.locator(".stat-panel").boundingBox();
if (rangeBox && statBox) {
  const overlapY = Math.min(rangeBox.y + rangeBox.height, statBox.y + statBox.height) - Math.max(rangeBox.y, statBox.y);
  if (overlapY > 4) throw new Error(`range bar overlaps cluster panel by ${overlapY.toFixed(0)}px`);
}
await mpage.screenshot({ path: "test-results/l12-overview-range-420.png", fullPage: true });
await mpage.locator(".range-bar").scrollIntoViewIfNeeded();
await mpage.waitForTimeout(200);
await mpage.screenshot({ path: "test-results/l12-overview-range-420-charts.png" });
await mobile.close();

await browser.close();
const out = { errors, yText, x24, seriesPts: payload.series.length, spanHours: +(span / 3600).toFixed(2) };
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
console.log("ok overview range");
