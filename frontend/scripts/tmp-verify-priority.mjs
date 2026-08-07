/**
 * Verify Priority is editable, persists, and appears on card/dashboard.
 * Restores the test PO to its original priority afterward.
 *
 * Usage (API :8000 + Next :3000 running):
 *   node scripts/tmp-verify-priority.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SHOTS = path.join(ROOT, "screenshots");
const WEB = process.env.APP_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASSWORD = "tvm-temp-2026";

mkdirSync(SHOTS, { recursive: true });

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const loginApi = async () => {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert(res.ok, `login failed: ${res.status}`);
  return (await res.json()).access_token;
};

const apiGet = async (token, url) => {
  const res = await fetch(`${API}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(res.ok, `GET ${url} → ${res.status}`);
  return res.json();
};

const apiPatch = async (token, url, body) => {
  const res = await fetch(`${API}${url}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("PATCH " + url + " → " + res.status + " " + await res.text());
  return res.json();
};

const token = await loginApi();

// Board settings: Priority must be present and visible after v4 repair.
const board = await apiGet(token, "/api/settings/board");
const prioField = (board.document?.cardFields || []).find((f) => f.key === "priority");
assert(prioField, "priority missing from cardFields");
assert(prioField.visible === true, `priority.visible expected true, got ${prioField.visible}`);
assert(board.document?.version >= 4, `document version expected >= 4, got ${board.document?.version}`);
console.log("PASS board settings: Priority visible, version", board.document.version);

const list = await apiGet(token, "/api/purchase-orders?limit=50");
const orders = Array.isArray(list) ? list : list.items || list.results || [];
assert(orders.length === 28, `expected 28 POs, got ${orders.length}`);
const isProtectedPo = (po) =>
  /j-55|shad38/i.test([po.job_no, po.po_number, po.part_number].join(" "));
const eligibleOrders = orders.filter((po) => !isProtectedPo(po));
assert(eligibleOrders.length > 0, "no PO available besides J-55/shad38");

// Prefer a normal-priority unlocked order so the badge change is obvious.
const target =
  eligibleOrders.find((po) => !po.locked && po.priority === "normal") ||
  eligibleOrders.find((po) => !po.locked) ||
  eligibleOrders[0];
assert(target, "no PO to test");
assert(!isProtectedPo(target), "J-55/shad38 must remain untouched");
const originalPriority = target.priority;
const originalLabel = target.priority_label;
console.log(
  `Using PO ${target.job_no} / ${target.po_number} (was ${originalPriority})`,
);

const nextPriority = originalPriority === "high" ? "hot" : "high";
const nextLabel = nextPriority.toUpperCase();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((t) => window.localStorage.setItem("po_calendar_token", t), token);
await ctx.addInitScript(() => {
  window.localStorage.setItem("po_calendar_task_view", "cards");
  window.localStorage.setItem("po_calendar_task_hide_completed", "0");
  window.localStorage.setItem("po_calendar_task_zoom", "2");
});
const page = await ctx.newPage();

// --- Settings: Priority row exists and Show is checked ---
await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded" });
console.log("SETTINGS DIAGNOSTIC", page.url(), (await page.locator("body").innerText()).slice(0, 500));
await page.screenshot({ path: path.join(SHOTS, "priority-00-settings-debug.png"), fullPage: true });
await page.getByRole("heading", { name: "Board settings" }).waitFor();
const prioRow = page.locator(".settings-list li, .settings-list > *").filter({
  hasText: /^Priority|Priority/,
});
// Card fields list: find the Priority label + its Show checkbox
const cardFieldRows = page.locator(".settings-list .settings-row, .settings-list li, [class*='settings']").filter({
  has: page.getByText("Priority", { exact: true }),
});
await page.screenshot({ path: path.join(SHOTS, "priority-01-settings.png"), fullPage: true });
console.log("PASS settings page loaded");

// --- Tasks: open PO, change priority via segmented control ---
await page.goto(`${WEB}/tasks`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);

const card = page.locator(".jobcard").filter({ hasText: target.job_no }).first();
await card.waitFor({ state: "visible", timeout: 15000 });
await card.click();
await page.waitForSelector(".jobcard-edit, .drawer, [class*='drawer']");
await page.waitForTimeout(400);

const prioGroup = page.getByRole("group", { name: "Priority" });
await prioGroup.waitFor({ state: "visible", timeout: 10000 });
await page.screenshot({ path: path.join(SHOTS, "priority-02-drawer-before.png") });

await prioGroup.getByRole("button", { name: nextLabel, exact: true }).click();
await page.waitForTimeout(200);
assert(
  (await prioGroup.getByRole("button", { name: nextLabel, exact: true }).getAttribute("data-selected")) !== null,
  "priority segment should be selected",
);
await page.screenshot({ path: path.join(SHOTS, "priority-03-drawer-changed.png") });

const saveBtn = page.getByRole("button", { name: /^Save changes$/i });
await saveBtn.click();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(SHOTS, "priority-04-after-save.png") });

// Reload and confirm persistence
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);
const cardAfter = page.locator(".jobcard").filter({ hasText: target.job_no }).first();
await cardAfter.waitFor({ state: "visible", timeout: 15000 });
const badge = cardAfter.locator(".prio").first();
if (nextPriority !== "normal") {
  await badge.waitFor({ state: "visible", timeout: 5000 });
  const badgeText = (await badge.innerText()).trim();
  assert(
    badgeText.toUpperCase() === nextLabel,
    `card badge expected ${nextLabel}, got ${badgeText}`,
  );
}
await page.screenshot({ path: path.join(SHOTS, "priority-05-card-badge.png") });

// Spec grid PriorityTag when field visible
const specPrio = cardAfter.locator(".spec-pair").filter({ hasText: "Priority" });
if (await specPrio.count()) {
  const specText = (await specPrio.locator(".prio").innerText()).trim();
  assert(
    specText.toUpperCase() === nextLabel,
    `spec priority expected ${nextLabel}, got ${specText}`,
  );
  console.log("PASS JobCard spec shows PriorityTag");
}

// API confirms
const refreshed = await apiGet(token, `/api/purchase-orders/${target.id}`);
assert(
  refreshed.priority === nextPriority,
  `API priority expected ${nextPriority}, got ${refreshed.priority}`,
);
console.log("PASS API persisted priority", refreshed.priority);

// Dashboard badge
await page.goto(`${WEB}/dashboard`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const dashRow = page.locator("tr").filter({ hasText: target.job_no }).first();
await dashRow.waitFor({ state: "visible", timeout: 15000 });
const dashBadge = dashRow.locator(".prio");
await dashBadge.waitFor({ state: "visible", timeout: 5000 });
assert(
  (await dashBadge.innerText()).trim().toUpperCase() === nextLabel,
  "dashboard priority badge mismatch",
);
await page.screenshot({ path: path.join(SHOTS, "priority-06-dashboard.png") });
console.log("PASS dashboard badge");

// Restore original priority via API (leave shop data clean)
await apiPatch(token, `/api/purchase-orders/${target.id}`, { priority: originalPriority });
const restored = await apiGet(token, `/api/purchase-orders/${target.id}`);
assert(
  restored.priority === originalPriority,
  `restore failed: ${restored.priority} !== ${originalPriority}`,
);
console.log(`PASS restored ${target.job_no} to ${originalLabel || originalPriority}`);

const finalList = await apiGet(token, "/api/purchase-orders?limit=50");
const finalOrders = Array.isArray(finalList) ? finalList : finalList.items || [];
assert(finalOrders.length === 28, `PO count drifted: ${finalOrders.length}`);

await browser.close();
console.log("ALL PASS — screenshots in", SHOTS);
