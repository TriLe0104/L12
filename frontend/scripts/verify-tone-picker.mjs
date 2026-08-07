/**
 * Playwright: Admin changes a status color via the Settings color picker.
 * Routes browser API traffic from :8000 → live code server (default :8010).
 * Auth via injected token (avoids flaky login against rewritten API).
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "screenshots");
const BASE = process.env.APP_BASE || "http://127.0.0.1:3000";
const API = process.env.API_BASE || process.env.SMOKE_BASE || "http://127.0.0.1:8010";
const STALE = "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASS = "tvm-temp-2026";
const NEW_HEX = "#ff00aa";

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!res.ok) throw new Error(`login ${res.status} ${await res.text()}`);
  return res.json();
}

async function getBoard(token) {
  const res = await fetch(`${API}/api/settings/board`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET board ${res.status}`);
  return res.json();
}

async function putBoard(token, document) {
  const res = await fetch(`${API}/api/settings/board`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ document }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PUT board ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const { access_token: token } = await apiLogin();
  const before = await getBoard(token);
  const baseline = structuredClone(before.document);
  const targetKey = baseline.statuses[0]?.key;
  if (!targetKey) throw new Error("no statuses");
  const originalTone = baseline.statuses[0].tone;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  await context.addInitScript((t) => {
    localStorage.setItem("po_calendar_token", t);
  }, token);

  const page = await context.newPage();

  await page.route(/http:\/\/127\.0\.0\.1:8000\/api\/.*/, async (route) => {
    const req = route.request();
    const url = req.url().replace(STALE, API);
    const res = await route.fetch({ url });
    await route.fulfill({ response: res });
  });

  try {
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.getByRole("heading", { name: "Board settings" }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: /^Statuses$/i }).click();
    await page.waitForSelector(".settings-tone-swatch", { timeout: 15000 });

    const row = page.locator(".settings-list > li").first();
    const hexInput = row.locator(".settings-tone-hex");
    await hexInput.click({ clickCount: 3 });
    await hexInput.fill(NEW_HEX);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    const previewChip = page.locator(".settings-status-chip").first();
    const previewTone = await previewChip.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--tone").trim().toLowerCase(),
    );
    if (!previewTone.includes("ff00aa")) {
      const swatch = await row.locator(".settings-tone-swatch").inputValue();
      throw new Error(`preview --tone expected ${NEW_HEX}, got ${previewTone}; swatch=${swatch}`);
    }
    console.log("PASS preview tone", previewTone);

    await page.screenshot({
      path: path.join(SHOTS, "settings-tone-picker.png"),
      fullPage: true,
    });
    await page.locator(".settings-preview").screenshot({
      path: path.join(SHOTS, "settings-preview-tone.png"),
    });

    await page.getByRole("button", { name: /^Save$/i }).click();
    await page.waitForTimeout(1200);

    const after = await getBoard(token);
    const saved = after.document.statuses.find((s) => s.key === targetKey);
    if (saved?.tone?.toLowerCase() !== NEW_HEX) {
      throw new Error(`expected saved tone ${NEW_HEX}, got ${saved?.tone}`);
    }
    console.log("PASS saved tone", saved.tone);

    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    const statusCell = page.locator(".dash-status").first();
    if (await statusCell.count()) {
      const dashTone = await statusCell.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--tone").trim().toLowerCase(),
      );
      console.log("dashboard first status --tone", dashTone);
    }
    await page.screenshot({
      path: path.join(SHOTS, "dashboard-status-tone.png"),
      fullPage: true,
    });
    console.log("screenshots →", SHOTS);
    console.log("ALL PASS");
  } finally {
    await putBoard(token, baseline);
    console.log("restored baseline tone", originalTone);
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
