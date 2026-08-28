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
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));
await page.goto(`${WEB}/cluster`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(1200);
const canvas = page.locator(".cluster-canvas canvas");
const box = await canvas.boundingBox();
const pts = [
  [0.5, 0.45],
  [0.5, 0.5],
  [0.5, 0.55],
  [0.48, 0.48],
  [0.52, 0.48],
  [0.62, 0.42],
  [0.38, 0.42],
];
for (const [fx, fy] of pts) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(350);
  const sw = await page.locator(".switch-panel").count();
  const hall = await page.locator(".hall-panel").count();
  const rack = await page.locator(".rack-panel").count();
  console.log(JSON.stringify({ fx, fy, sw, hall, rack }));
  if (sw) {
    console.log((await page.locator(".switch-panel").innerText()).slice(0, 200));
    await page.screenshot({ path: "test-results/l12-switch-panel-1440.png" });
    break;
  }
}
await browser.close();
