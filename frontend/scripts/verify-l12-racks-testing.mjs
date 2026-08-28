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
await page.waitForSelector(".cluster-app", { timeout: 20000 });
await page.getByRole("button", { name: "Racks" }).click();
await page.waitForSelector(".rack-board tbody tr", { timeout: 20000 });
const rackRows = await page.locator(".rack-board tbody tr").count();
await page.locator(".rack-board tbody tr").first().click();
await page.waitForSelector(".node-drop", { timeout: 5000 });
const drop = await page.locator(".node-drop").innerText();
await page.screenshot({ path: "test-results/l12-racks-dash-1440.png" });

await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(900);
const hud = await page.locator(".zoom-hud").innerText();
await page.screenshot({ path: "test-results/l12-floor-cluster-1440.png" });

await page.goto(`${WEB}/testing`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".test-cats", { timeout: 15000 });
await page.locator(".test-cats button").filter({ hasText: "Network" }).click();
await page.waitForSelector("text=IB_WRITE_BW");
await page.locator(".test-cats button").filter({ hasText: "NCCL" }).click();
await page.waitForSelector("text=DCGM");
await page.screenshot({ path: "test-results/l12-testing-nccl-1440.png" });
await page.locator(".test-cats button").filter({ hasText: "MLPerf" }).click();
await page.waitForSelector("text=GPT-3");
await page.screenshot({ path: "test-results/l12-testing-mlperf-1440.png" });

const login = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lp = await login.newPage();
await lp.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await lp.waitForSelector(".brand-hero");
const loginText = await lp.locator(".login-art").innerText();
await lp.screenshot({ path: "test-results/l12-login-cat.png" });
await login.close();
await browser.close();

const out = {
  errors,
  rackRows,
  hasNodes: drop.toUpperCase().includes("GB300"),
  hasBmc: drop.toUpperCase().includes("BMC"),
  clusterHud: hud.toUpperCase().includes("FIRMUS") || hud.toUpperCase().includes("CLUSTER") || hud.includes("MW"),
  loginHasSubtitle: loginText.includes("Firmus GB300"),
};
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
if (rackRows < 4) throw new Error("too few rack rows");
if (!out.hasNodes) throw new Error("node dropdown missing GB300");
if (out.loginHasSubtitle) throw new Error("login subtitle still present");
console.log("ok racks + testing + floor + login");
