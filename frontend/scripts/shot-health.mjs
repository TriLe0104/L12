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
page.setDefaultTimeout(20000);

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
await page.waitForSelector('.summary-strip[data-k="health"]', { timeout: 20000 });
await page.waitForFunction(
  () => {
    const b = document.querySelector('.summary-strip[data-k="health"] b');
    return b && b.textContent && b.textContent !== "…" && b.textContent !== "—";
  },
  { timeout: 25000 },
);
await page.waitForTimeout(800);
await page.screenshot({ path: join(outDir, "gb300-health-overview.png"), fullPage: false });

const liveHit = page.locator('.gb300-node-hit[data-status="ok"]').first();
if (await liveHit.count()) {
  await liveHit.click();
} else {
  const nodesTab = page.getByRole("button", { name: /Nodes/ });
  if (await nodesTab.count()) {
    await nodesTab.click();
    await page.waitForSelector(".pod-node", { timeout: 15000 });
    const liveNode = page.locator('.pod-node[data-status="ok"]').first();
    if (await liveNode.count()) await liveNode.click();
    else await page.locator(".pod-node").first().click();
  }
}
await page.waitForSelector(".node-telem-panel", { timeout: 15000 });
await page.waitForTimeout(1400);
await page.screenshot({ path: join(outDir, "gb300-health-node.png"), fullPage: false });

await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: join(outDir, "gb300-health-overview-mobile.png"), fullPage: true });

await browser.close();
console.log("wrote", join(outDir, "gb300-health-overview.png"));
