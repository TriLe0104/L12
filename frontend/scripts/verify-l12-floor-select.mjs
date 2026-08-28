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
await page.waitForSelector(".cluster-app", { timeout: 20000 });
await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(1000);

const toolbar = page.locator(".cluster-toolbar");
const rail = page.locator(".rail");
const x1 = (await toolbar.boundingBox()).x;
await rail.hover();
await page.waitForTimeout(280);
const x2 = (await toolbar.boundingBox()).x;
const toolsVisible = await page.getByRole("button", { name: "Add racks" }).isVisible();
await page.screenshot({ path: "test-results/l12-floor-rail-push-1440.png" });
await page.mouse.move(900, 200);
await page.waitForTimeout(200);

await page.getByRole("button", { name: "Add racks" }).click();
await page.waitForSelector(".theme-dialog");
const dialogText = await page.locator(".theme-dialog").innerText();
await page.screenshot({ path: "test-results/l12-add-racks-dialog.png" });
await page.getByRole("button", { name: "Cancel" }).click();

const canvas = page.locator(".cluster-canvas canvas");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.48);
await page.waitForTimeout(700);
const hallPanel = await page.locator(".hall-panel").count();
await page.screenshot({ path: "test-results/l12-hall-overview-1440.png" });

await page.mouse.wheel(0, -400);
await page.waitForTimeout(500);
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.52);
await page.waitForTimeout(400);
await page.keyboard.down("Control");
await page.mouse.click(box.x + box.width * 0.54, box.y + box.height * 0.52);
await page.keyboard.up("Control");
await page.waitForTimeout(400);
const bulk = await page.locator(".bulk-bar").count();
const rackPanel = await page.locator(".rack-panel").count();
await page.screenshot({ path: "test-results/l12-floor-select-1440.png" });

await browser.close();
const out = { errors, railPushed: x2 > x1 + 40, x1: Math.round(x1), x2: Math.round(x2), toolsVisible, dialogText: dialogText.includes("16") && dialogText.includes("4"), hallPanel, bulk, rackPanel };
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
if (!out.railPushed) throw new Error("rail did not push toolbar");
if (!out.toolsVisible) throw new Error("Add racks hidden under rail");
if (!out.dialogText) throw new Error("add racks dialog missing 16x4");
console.log("ok floor select + rail push + 16x4");
