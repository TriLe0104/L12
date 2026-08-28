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
await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(800);
await page.getByLabel("Data hall").selectOption({ index: 1 });
await page.waitForTimeout(600);
await page.getByRole("button", { name: "Select all racks" }).click();
await page.waitForSelector(".bulk-bar", { timeout: 8000 });
const bulkText = await page.locator(".bulk-bar").innerText();
await page.screenshot({ path: "test-results/l12-bulk-select-1440.png" });
await browser.close();
console.log(JSON.stringify({ errors, bulkText }));
if (errors.length) process.exit(1);
if (!/\d+\s+racks/i.test(bulkText)) throw new Error(bulkText);
console.log("ok bulk select");
