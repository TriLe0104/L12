/**
 * Verify dashboard column sync (custom fields hidden by default) + widthRem.
 *
 * Usage (API + Next running):
 *   node scripts/verify-dashboard-columns.mjs
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
const FIELD_KEY = "cf_dash_coat";
const FIELD_LABEL = "Coat Spec";

fs.mkdirSync(SHOTS, { recursive: true });

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
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
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT board ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function listPOs(token) {
  const res = await fetch(`${API}/api/purchase-orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list POs ${res.status}`);
  return res.json();
}

async function patchPO(token, id, body) {
  const res = await fetch(`${API}/api/purchase-orders/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH PO ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|tasks|calendar|users|settings/);
}

function findCol(doc, key) {
  return (doc.dashboardColumns || []).find((c) => c.key === key);
}

async function main() {
  const token = await apiLogin();
  const before = await getBoard(token);
  const baseline = structuredClone(before.document);
  console.log(
    `board version=${baseline.version} dashCols=${baseline.dashboardColumns?.length} customs=${baseline.customFields?.length}`,
  );

  // Expect v6 migration: widthRem present on builtins; optional builtins exist hidden.
  const jobCol = findCol(baseline, "job");
  if (!jobCol || jobCol.widthRem == null) {
    throw new Error(`expected job.widthRem after upgrade, got ${JSON.stringify(jobCol)}`);
  }
  const insp = findCol(baseline, "inspection");
  if (!insp || insp.visible !== false) {
    throw new Error(`expected inspection column hidden by default, got ${JSON.stringify(insp)}`);
  }
  console.log(`ok upgrade widthRem job=${jobCol.widthRem} inspection hidden`);

  // Clean leftover from a prior run, then add the custom field + hidden dash col.
  let doc = structuredClone(baseline);
  doc.customFields = (doc.customFields || []).filter((f) => f.key !== FIELD_KEY);
  doc.cardFields = (doc.cardFields || []).filter((f) => f.key !== FIELD_KEY);
  doc.dashboardColumns = (doc.dashboardColumns || []).filter((c) => c.key !== FIELD_KEY);
  doc.customFields.push({ key: FIELD_KEY, label: FIELD_LABEL, type: "text" });
  doc.cardFields.push({
    key: FIELD_KEY,
    kind: "custom",
    label: FIELD_LABEL,
    visible: true,
  });
  // Intentionally omit dashboardColumns entry — server sync should append hidden.
  let saved = await putBoard(token, doc);
  const hidden = findCol(saved.document, FIELD_KEY);
  if (!hidden) throw new Error("custom field missing from dashboardColumns after PUT");
  if (hidden.visible !== false) throw new Error("new custom dash column should be hidden");
  if (hidden.widthRem != null) throw new Error("new custom dash column should default widthRem null");
  console.log(`ok custom column synced hidden: ${hidden.key}`);

  // Enable + set width, save.
  doc = structuredClone(saved.document);
  for (const c of doc.dashboardColumns) {
    if (c.key === FIELD_KEY) {
      c.visible = true;
      c.widthRem = 7.5;
    }
    if (c.key === "customer") {
      c.widthRem = 9;
    }
  }
  saved = await putBoard(token, doc);
  const enabled = findCol(saved.document, FIELD_KEY);
  const customer = findCol(saved.document, "customer");
  if (!enabled?.visible || enabled.widthRem !== 7.5) {
    throw new Error(`expected enabled 7.5rem col, got ${JSON.stringify(enabled)}`);
  }
  if (customer?.widthRem !== 9) {
    throw new Error(`expected customer widthRem 9, got ${JSON.stringify(customer)}`);
  }
  console.log("ok enabled + widths persisted");

  // Stamp a value on a non-J-55 PO so the dashboard cell is visible.
  const pos = await listPOs(token);
  const target = pos.find((p) => p.job_no !== "J-55" && p.job_no !== "shad38") ?? pos[0];
  if (!target) throw new Error("no POs to patch");
  const prevFields = target.custom_fields || {};
  await patchPO(token, target.id, {
    custom_fields: { ...prevFields, [FIELD_KEY]: "Hardcoat Type III" },
  });
  console.log(`ok patched ${target.job_no} custom_fields.${FIELD_KEY}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await login(page);

    await page.goto(`${BASE}/settings`);
    await page.getByRole("button", { name: /^Dashboard$/i }).click();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SHOTS, "dash-cols-settings.png"),
      fullPage: true,
    });
    const row = page.locator(".settings-list > li", { hasText: FIELD_LABEL });
    await row.waitFor({ state: "visible" });
    const checked = await row.locator('input[type="checkbox"]').isChecked();
    if (!checked) throw new Error("settings: custom column should show as enabled");
    const widthVal = await row.locator(".settings-width-input").inputValue();
    if (widthVal !== "7.5") throw new Error(`settings width expected 7.5 got ${widthVal}`);
    console.log("ok settings UI shows column + width");

    await page.goto(`${BASE}/dashboard`);
    await page.waitForSelector(".dash-table");
    await page.waitForTimeout(500);
    const header = page.locator(`th[data-col="${FIELD_KEY}"]`);
    await header.waitFor({ state: "visible" });
    const headerWidth = await header.evaluate((el) => getComputedStyle(el).width);
    console.log(`dashboard header ${FIELD_KEY} computed width=${headerWidth}`);
    const cell = page.locator(`td[data-col="${FIELD_KEY}"]`).filter({ hasText: "Hardcoat" }).first();
    await cell.waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(SHOTS, "dash-cols-dashboard.png"),
      fullPage: true,
    });
    console.log("ok dashboard shows custom column + value");

    // Reload persistence check
    await page.reload();
    await page.waitForSelector(`th[data-col="${FIELD_KEY}"]`);
    const customerTh = page.locator('th[data-col="customer"]');
    const custW = await customerTh.evaluate((el) => el.style.width || getComputedStyle(el).width);
    console.log(`customer column style/width after reload: ${custW}`);
    await page.screenshot({
      path: path.join(SHOTS, "dash-cols-reload.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }

  // Restore baseline board (drop test field) — keep shop data intact.
  const restore = structuredClone(baseline);
  restore.customFields = (restore.customFields || []).filter((f) => f.key !== FIELD_KEY);
  restore.cardFields = (restore.cardFields || []).filter((f) => f.key !== FIELD_KEY);
  restore.dashboardColumns = (restore.dashboardColumns || []).filter((c) => c.key !== FIELD_KEY);
  // Re-apply widthRem defaults via a no-op PUT that still syncs.
  const restored = await putBoard(token, restore);
  if (findCol(restored.document, FIELD_KEY)) {
    throw new Error("cleanup failed: custom dash column still present");
  }
  // Clear the PO custom field value we wrote.
  const again = await listPOs(token);
  const po = again.find((p) => p.id === target.id);
  if (po) {
    const cf = { ...(po.custom_fields || {}) };
    delete cf[FIELD_KEY];
    await patchPO(token, po.id, { custom_fields: cf });
  }
  console.log("ok restored board settings + cleared PO field");
  console.log("PASS verify-dashboard-columns");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
