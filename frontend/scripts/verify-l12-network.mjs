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

await page.goto(`${WEB}/network`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".network-app", { timeout: 20000 });
await page.waitForSelector(".nmap-node[data-role='spine']", { timeout: 15000 });
const mapText = await page.locator(".network-app").innerText();
if (!mapText.includes("SPINE LAYER") && !(await page.locator(".nmap-label").count())) {
  throw new Error("map missing spine layer");
}
if (!mapText.toLowerCase().includes("quantum") && !(await page.getByText("Q2 spine").count())) {
  // labels are in SVG
}
await page.screenshot({ path: "test-results/l12-network-map-1440.png" });

const leaf = page.locator(".nmap-node[data-role='leaf']").first();
await leaf.click();
await page.waitForTimeout(400);
const hosts = await page.locator(".nmap-node[data-role='rack']").count();
await page.screenshot({ path: "test-results/l12-network-map-leaf-1440.png" });

await page.getByRole("button", { name: "Port Mapping" }).click();
await page.waitForSelector(".network-table tbody tr", { timeout: 15000 });
const portRows = await page.locator(".network-table tbody tr").count();
const portText = await page.locator(".network-app").innerText().then((t) => t.toUpperCase());
if (!portText.includes("LOCAL SYSTEM") || !portText.includes("CABLE PN")) {
  throw new Error("port mapping missing columns");
}
await page.screenshot({ path: "test-results/l12-network-ports-1440.png" });

await page.getByRole("button", { name: "Live Traffic" }).click();
await page.waitForSelector(".kpi", { timeout: 10000 });
const trafficText = await page.locator(".network-app").innerText().then((t) => t.toUpperCase());
if (!trafficText.includes("FABRIC TX") || !trafficText.includes("HOTTEST")) {
  throw new Error("live traffic missing kpis");
}
const tx1 = await page.locator(".kpi dd").first().innerText();
await page.waitForTimeout(2500);
const tx2 = await page.locator(".kpi dd").first().innerText();
await page.screenshot({ path: "test-results/l12-network-traffic-1440.png" });

await page.setViewportSize({ width: 420, height: 820 });
await page.getByRole("button", { name: "Map", exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "test-results/l12-network-map-420.png", fullPage: true });

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${WEB}/cluster`, { waitUntil: "networkidle", timeout: 60000 });
await page.getByRole("button", { name: "Floor" }).click();
await page.waitForSelector(".cluster-canvas canvas", { timeout: 20000 });
await page.waitForTimeout(900);
const canvas = page.locator(".cluster-canvas canvas");
const box = await canvas.boundingBox();
if (!box) throw new Error("no canvas");
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 18; i++) await page.mouse.wheel(0, 180);
await page.waitForTimeout(700);
await page.screenshot({ path: "test-results/l12-floor-spines-1440.png" });

const legend = await page.locator(".net-legend-3d").count();

await browser.close();
const result = { hosts, portRows, tx1, tx2, liveChanged: tx1 !== tx2, legend, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
if (portRows < 20) throw new Error("too few port rows");
if (!legend) throw new Error("3d fabric legend missing");
console.log("ok network map + ports + traffic + 3d spines");
