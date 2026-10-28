import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = process.env.L12_WEB_URL || "http://127.0.0.1:3000";
const API = process.env.L12_API_URL || "http://127.0.0.1:8001";

const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "test@test", password: "test" }),
});
const body = await res.json();
const token = body.token || body.access_token;
if (!token) throw new Error(`login failed: ${JSON.stringify(body)}`);

mkdirSync("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((t) => localStorage.setItem("po_calendar_token", t), token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/testing`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".test-panes", { timeout: 20000 });
await page.waitForSelector(".test-cats", { timeout: 20000 });
const panes = await page.locator(".test-panes button").allTextContents();
await page.screenshot({ path: "test-results/l12-testing-tests.png" });

await page.getByRole("button", { name: "Sanity", exact: true }).click();
await page.waitForSelector(".sanity-panel", { timeout: 15000 });
await page.waitForSelector(".sanity-table", { timeout: 10000 });
const golden = await page.locator(".golden-chip").allTextContents();
const matrix = await page.locator(".sanity-table tbody tr").count();
const overall = (await page.locator(".sanity-overall").innerText()).trim();
await page.screenshot({ path: "test-results/l12-testing-sanity.png" });

await page.getByRole("button", { name: "Reports", exact: true }).click();
await page.waitForSelector(".test-reports", { timeout: 10000 });
await page.getByRole("button", { name: /Generate L11/ }).waitFor({ timeout: 8000 });
const smoke = page.locator(".test-rep-row").filter({ hasText: "L11_SMOKE-RACK" }).filter({ hasText: "PDF" }).first();
await smoke.waitFor({ timeout: 10000 });
await smoke.getByRole("button", { name: "Open" }).click();
await page.waitForSelector(".report-preview-dialog", { timeout: 15000 });
const previewTitle = await page.locator(".report-preview-dialog strong").innerText();
const head = await page.evaluate(() => {
  const el = document.querySelector(".report-preview-dialog .traveler-preview-head strong");
  const css = el ? getComputedStyle(el) : null;
  return { color: css?.color || "", text: (el?.textContent || "").trim() };
});
console.log("reportHead", JSON.stringify(head));
const rgb = head.color.match(/\d+/g)?.map(Number) || [];
if (rgb.length >= 3 && rgb[0] + rgb[1] + rgb[2] > 500) throw new Error(`report header too light: ${head.color}`);
await page.screenshot({ path: "test-results/l12-testing-report.png" });
await page.locator(".image-viewer-close").click();

await page.getByRole("button", { name: "Tests", exact: true }).click();
await page.waitForSelector(".test-cats", { timeout: 8000 });
const gpu = page.locator(".test-cats button").filter({ hasText: "GPU" });
if (await gpu.count()) {
  await gpu.first().click();
  await page.waitForTimeout(300);
}
const dcgm = await page.getByText("DCGM", { exact: false }).count();
await page.screenshot({ path: "test-results/l12-testing-gpu.png" });

await browser.close();
const out = { errors, panes, golden, matrix, overall, previewTitle, dcgm };
console.log(JSON.stringify(out, null, 2));
if (errors.length) process.exit(1);
if (!panes.includes("Sanity") || !panes.includes("Reports")) throw new Error("missing panes");
if (matrix < 1) throw new Error("sanity matrix empty");
if (!/L11/i.test(previewTitle)) throw new Error("did not open L11 report");
console.log("ok l11 testing panes");
