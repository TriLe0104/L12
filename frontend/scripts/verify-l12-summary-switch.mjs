import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://127.0.0.1:3001";
const API = "http://127.0.0.1:8001";
const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "tri@supermicro.com", password: "demo1234" }),
});
const { access_token } = await res.json();
mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".summary-strip", { timeout: 25000 });
await page.waitForTimeout(500);
const strip = (await page.locator(".summary-strip").innerText()).toUpperCase();
await page.screenshot({ path: "test-results/l12-overview-gauges-1440.png" });

await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(1100);
const canvas = page.locator(".cluster-canvas canvas");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
await page.waitForSelector(".switch-panel", { timeout: 8000 });
await page.waitForTimeout(1200);
const switchPanel = await page.locator(".switch-panel").count();
const panelText = await page.locator(".switch-panel").innerText();
await page.screenshot({ path: "test-results/l12-switch-panel-1440.png" });

await browser.close();
const out = {
  errors,
  stripHasRacks: strip.includes("RACKS"),
  stripHasNodes: strip.includes("COMPUTE") || strip.includes("1024"),
  stripHasSwitches: strip.includes("SWITCH"),
  switchPanel,
  panelHasPorts: panelText.toUpperCase().includes("PORT"),
  panelHasTx: panelText.toUpperCase().includes("TX"),
};
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
if (!out.stripHasRacks || !out.stripHasNodes) throw new Error("summary missing racks/nodes");
if (!switchPanel) throw new Error("switch panel did not open");
console.log("ok summary + switch panel");
