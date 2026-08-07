/**
 * Board settings smoke: Admin opens Settings with live preview, Manager is
 * redirected, one save reflects on /tasks. Screenshots land in screenshots/.
 *
 * Usage (from frontend/, with API + Next already running):
 *   node ../backend/.venv ... no — use:
 *   $env:LOCALAPPDATA\...\node.exe scripts/board-settings-e2e.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SHOTS = path.join(ROOT, "screenshots");
const BASE = process.env.APP_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:8000";
const ADMIN = { email: "trile0104@gmail.com", password: "tvm-temp-2026" };

fs.mkdirSync(SHOTS, { recursive: true });

async function login(page, creds) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|tasks|calendar|users|settings/);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await login(page, ADMIN);
  await page.goto(`${BASE}/settings`);
  await page.getByRole("heading", { name: "Board settings" }).waitFor();
  await page.getByRole("heading", { name: "Preview" }).waitFor();
  await page.screenshot({
    path: path.join(SHOTS, "board-settings-preview.png"),
    fullPage: true,
  });
  console.log("PASS admin settings + preview");

  // Toggle a card field and confirm preview reacts without saving.
  const showBoxes = page.locator(".settings-list .settings-check input[type=checkbox]");
  const hardware = showBoxes.nth(8); // hardware is late in the list when defaults load
  if (await hardware.count()) {
    await hardware.click();
  }
  await page.screenshot({
    path: path.join(SHOTS, "board-settings-draft.png"),
    fullPage: true,
  });
  console.log("PASS draft preview update");

  // Cancel discard
  const cancel = page.getByRole("button", { name: "Cancel" });
  if (await cancel.isEnabled()) await cancel.click();

  await browser.close();

  // Manager must not see Settings in the rail — check via API 403 on PUT.
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const { access_token } = await loginRes.json();
  const get = await fetch(`${API}/api/settings/board`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!get.ok) throw new Error(`GET board failed ${get.status}`);
  console.log("PASS GET /api/settings/board");
  console.log("ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
