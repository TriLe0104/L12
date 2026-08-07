/**
 * Verify dashboard column `filterable` persists and drives the live filter bar.
 * Usage: node scripts/verify-dashboard-filterable.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.API_URL || "http://127.0.0.1:8000";
const FE = process.env.FE_URL || "http://127.0.0.1:3000";
const EMAIL = process.env.VERIFY_EMAIL || "trile0104@gmail.com";
const PASSWORD = process.env.VERIFY_PASSWORD || "tvm-temp-2026";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shotDir = path.resolve(__dirname, "../../screenshots");
fs.mkdirSync(shotDir, { recursive: true });

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = data.access_token || data.token;
  if (!token) throw new Error("no token in login response");
  return token;
}

async function getBoard(token) {
  const res = await fetch(`${API}/api/settings/board`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET board-settings ${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`PUT board-settings ${res.status}: ${await res.text()}`);
  return res.json();
}

function col(doc, key) {
  return (doc.dashboardColumns || []).find((c) => c.key === key);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const token = await apiLogin();
const before = await getBoard(token);
const doc = structuredClone(before.document);
console.log(
  `baseline version=${doc.version} stage.filterable=${col(doc, "stage")?.filterable} status=${col(doc, "status")?.filterable} priority=${col(doc, "priority")?.filterable} customer=${col(doc, "customer")?.filterable}`,
);

assert(col(doc, "stage")?.filterable === true, "stage should default filterable");
assert(col(doc, "status")?.filterable === true, "status should default filterable");
assert(col(doc, "priority")?.filterable === true, "priority should default filterable");
assert(col(doc, "customer")?.filterable === false, "customer should default off");

// Toggle: turn off status, turn on customer
for (const c of doc.dashboardColumns) {
  if (c.key === "status") c.filterable = false;
  if (c.key === "customer") c.filterable = true;
}
const saved = await putBoard(token, doc);
const after = saved.document;
assert(col(after, "status")?.filterable === false, "status filterable should persist false");
assert(col(after, "customer")?.filterable === true, "customer filterable should persist true");
assert(after.version >= 8, `version should be >= 8, got ${after.version}`);
console.log("API persist OK");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(`${FE}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/\/(dashboard|tasks|calendar)/, { timeout: 20000 });

await page.goto(`${FE}/dashboard`, { waitUntil: "networkidle" });
await page.waitForSelector(".dash-filters", { timeout: 15000 });
const hasStatus = await page.locator('.dash-filter-select[aria-label="Filter by status"]').count();
const hasPriority = await page.locator('.dash-filter-select[aria-label="Filter by priority"]').count();
const hasCustomer = await page.locator('input[role="combobox"][aria-label="Filter by customer"]').count();
const hasStage = await page.locator(".dash-pill").count();
assert(hasStatus === 0, "status select should be hidden");
assert(hasPriority === 1, "priority select should show");
assert(hasCustomer === 1, "customer combobox should show");
assert(hasStage > 0, "stage pills should show");
console.log("Dashboard filter UI matches config");

await page.goto(`${FE}/settings`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Dashboard" }).click();
await page.waitForSelector(".settings-list", { timeout: 10000 });

// Preview should show Priority + Stage + Customer (not Status)
const previewPills = page.locator(".settings-preview-filter-pill");
await previewPills.first().waitFor({ timeout: 5000 });
const previewLabels = (await previewPills.allTextContents()).map((t) => t.trim());
console.log("preview filter pills:", previewLabels.join(", "));
assert(previewLabels.includes("Priority"), "preview missing Priority");
assert(previewLabels.includes("Stage"), "preview missing Stage");
assert(previewLabels.includes("Customer"), "preview missing Customer");
assert(!previewLabels.includes("Status"), "preview should not show Status");

const shotPath = path.join(shotDir, "dashboard-settings-filterable.png");
await page.locator(".settings-page").screenshot({ path: shotPath });
console.log(`screenshot: ${shotPath}`);

// Restore defaults
for (const c of after.dashboardColumns) {
  if (c.key === "status") c.filterable = true;
  if (c.key === "customer") c.filterable = false;
}
await putBoard(token, after);
console.log("restored defaults");

await browser.close();
console.log("PASS verify-dashboard-filterable");
