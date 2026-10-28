import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "docs", "images");
mkdirSync(outDir, { recursive: true });

const base = process.env.L12_URL || "http://127.0.0.1:3001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(25000);

const login = await fetch("http://127.0.0.1:8001/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".summary-strip[data-k='health']", { timeout: 20000 });
await page.waitForFunction(
  () => {
    const hit = document.querySelector(".gb300-photo");
    return Boolean(hit);
  },
  { timeout: 25000 },
);
await page.waitForTimeout(1200);

const geo = await page.evaluate(() => {
  const photo = document.querySelector(".gb300-photo");
  const img = photo?.querySelector("img");
  const live = document.querySelector(".gb300-node-hit[data-status='ok']");
  if (!photo || !img || !live) return { error: "missing photo or live hit", hits: document.querySelectorAll(".gb300-node-hit").length };
  const pr = photo.getBoundingClientRect();
  const ir = img.getBoundingClientRect();
  const hr = live.getBoundingClientRect();
  const slot = live.getAttribute("data-slot");
  return {
    slot,
    photoH: pr.height,
    imgH: ir.height,
    imgTopGap: ir.top - pr.top,
    hitTopPct: ((hr.top - ir.top) / ir.height) * 100,
    hitBottomPct: ((hr.bottom - ir.top) / ir.height) * 100,
    hitHPct: (hr.height / ir.height) * 100,
    hits: document.querySelectorAll(".gb300-node-hit").length,
  };
});
console.log("align", JSON.stringify(geo));

const liveHit = page.locator(".gb300-node-hit[data-status='ok']").first();
if (await liveHit.count()) {
  await liveHit.click();
  await page.waitForTimeout(500);
}
await page.screenshot({ path: join(outDir, "gb300-health-overview.png"), fullPage: false });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

const leakBtn = page.locator(".summary-strip[data-k='health'] button", { hasText: "Leak detection" });
await leakBtn.click();
await page.waitForSelector(".telem-list", { timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, "gb300-telem-leak.png"), fullPage: false });

const leakRows = await page.locator(".telem-list-table tbody tr").count();
console.log("leakRows", leakRows);

await page.locator(".telem-list-table tbody tr").first().click();
await page.waitForSelector(".node-telem-panel:not(.telem-list)", { timeout: 8000 });
await page.waitForTimeout(800);
await page.screenshot({ path: join(outDir, "gb300-health-node.png"), fullPage: false });

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.keyboard.press("Escape");
await page.waitForSelector(".telem-list", { state: "detached", timeout: 8000 }).catch(() => {});
await page.waitForTimeout(200);

async function openTile(label, file) {
  const open = await page.locator(".telem-list").count();
  if (open) {
    await page.locator(".telem-list .icon-btn").click();
    await page.waitForSelector(".telem-list", { state: "detached", timeout: 8000 });
  }
  await page.locator(`.overview-dash button[aria-label="${label}"]`).click();
  await page.waitForSelector(".telem-list", { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, file), fullPage: false });
  const rows = await page.locator(".telem-list-table tbody tr").count();
  const title = await page.locator(".telem-list .rack-panel-tabs button").first().innerText();
  console.log(label, { title, rows });
}

await openTile("Racks", "gb300-telem-racks.png");
await openTile("Compute nodes", "gb300-telem-compute.png");
await openTile("PSU", "gb300-telem-psu.png");
await openTile("Fans", "gb300-telem-fans.png");
const fanText = await page.locator(".telem-list-table tbody").innerText();
console.log("fanRowsText", fanText.slice(0, 800));
await openTile("Temperature", "gb300-telem-temp.png");
const tempText = await page.locator(".telem-list-table tbody").innerText();
console.log("tempRowsText", tempText.slice(0, 1200));
const nicRows = await page.locator(".telem-list-table tbody tr", { hasText: "NIC" }).count();
console.log("nicRows", nicRows);
await openTile("Power shelf", "gb300-telem-shelf.png");

await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, "gb300-telem-leak-mobile.png"), fullPage: true });

await browser.close();
console.log("wrote telem shots");
