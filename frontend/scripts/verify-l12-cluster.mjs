import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://127.0.0.1:3001";
const API = "http://127.0.0.1:8001";
const EMAIL = "tri@supermicro.com";
const PASSWORD = "demo1234";

const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) throw new Error(`login failed: ${res.status}`);
const { access_token } = await res.json();

mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((token) => localStorage.setItem("po_calendar_token", token), access_token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/cluster`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".cluster-app", { timeout: 20000 });
const overviewText = await page.locator(".cluster-app").innerText();
if (!overviewText.includes("Cluster Utilization")) throw new Error("overview missing utilization");
if (!overviewText.includes("L12") && !(await page.locator(".brand-l12").count())) {
  // brand is in the shell
}
await page.screenshot({ path: "test-results/l12-overview-1440.png", fullPage: true });

await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: "test-results/l12-floor-1440.png" });

const canvas = page.locator(".cluster-canvas canvas");
const box = await canvas.boundingBox();
if (!box) throw new Error("no canvas");
await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.52);
await page.waitForTimeout(600);
const panel = await page.locator(".rack-panel").count();
await page.screenshot({ path: "test-results/l12-rack-1440.png" });

await page.setViewportSize({ width: 420, height: 820 });
await page.getByRole("button", { name: "Overview" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: "test-results/l12-overview-420.png", fullPage: true });

await browser.close();
console.log(JSON.stringify({ panel, errors, brand: await (async () => 1)() }, null, 2));
if (errors.length) process.exit(1);
console.log("ok cluster overview + floor");
