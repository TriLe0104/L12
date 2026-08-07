/**
 * Verify builtin + custom select options in Settings (Material, Inspection,
 * Hardware, Priority) after selectionLists migration.
 *
 * Usage (API + Next running):
 *   node scripts/verify-select-options-settings.mjs
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
const SKIP_JOB = "J-55";

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

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|tasks|calendar|users|settings/);
}

function assertSeeded(lists, key, expectedSome) {
  const opts = lists?.[key] || [];
  if (!opts.length) throw new Error(`selectionLists.${key} empty`);
  for (const v of expectedSome) {
    if (!opts.some((o) => String(o).toLowerCase() === v.toLowerCase())) {
      throw new Error(`selectionLists.${key} missing ${v}: ${JSON.stringify(opts)}`);
    }
  }
  return opts;
}

async function main() {
  const token = await apiLogin();
  const before = await getBoard(token);
  const doc = before.document;
  const lists = doc.selectionLists || {};
  console.log(`board version=${doc.version} keys=${Object.keys(lists).join(",")}`);

  assertSeeded(lists, "material", []);
  if ((lists.material || []).length < 10) throw new Error("material options too short");
  // soft check: catalog mentions aluminum somewhere
  if (!(lists.material || []).some((o) => /al\b|aluminum|6061/i.test(String(o)))) {
    console.warn("WARN: material list looks unusual");
  }
  assertSeeded(lists, "inspection", ["formal", "standard", "source", "none"]);
  assertSeeded(lists, "hardware", ["yes", "no"]);
  assertSeeded(lists, "priority", ["hot", "high", "normal", "low"]);
  if ("materialTypes" in doc) throw new Error("legacy materialTypes still present");
  console.log("PASS migration seeds Material/Inspection/Hardware/Priority");

  // API rejects unknown material / inspection / priority
  const posRes = await fetch(`${API}/api/purchase-orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pos = await posRes.json();
  const target = pos.find((p) => p.job_no !== SKIP_JOB);
  if (!target) throw new Error("no PO available");

  for (const [body, label] of [
    [{ material: "__not_a_real_material__" }, "material"],
    [{ inspection: "__nope__" }, "inspection"],
    [{ priority: "__nope__" }, "priority"],
  ]) {
    const bad = await fetch(`${API}/api/purchase-orders/${target.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (bad.status !== 400) {
      throw new Error(`expected 400 for unknown ${label}, got ${bad.status}`);
    }
  }
  console.log("PASS API rejects unknown material/inspection/priority");

  // Removing an option that POs still reference must come back 400 (no state change).
  async function expectRemoveBlocked(fieldKey, option) {
    const doc = structuredClone(before.document);
    doc.selectionLists[fieldKey] = doc.selectionLists[fieldKey].filter(
      (o) => o.toLowerCase() !== option.toLowerCase(),
    );
    const res = await fetch(`${API}/api/settings/board`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document: doc }),
    });
    const text = await res.text();
    if (res.status !== 400 || !/still in use/i.test(text)) {
      throw new Error(
        `expected 400 "still in use" removing ${fieldKey} ${option}, got ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }

  const usedPriority = pos.map((p) => p.priority).find(Boolean);
  if (!usedPriority) throw new Error("no PO priority to test in-use removal");
  await expectRemoveBlocked("priority", usedPriority);

  const materialSet = new Set((lists.material || []).map((o) => o.toLowerCase()));
  const usedMaterial = pos
    .map((p) => p.material)
    .find((m) => m && materialSet.has(String(m).toLowerCase()));
  if (usedMaterial) {
    await expectRemoveBlocked("material", usedMaterial);
  } else {
    console.warn("WARN: no PO material matched the catalog; skipped material in-use check");
  }
  console.log("PASS removing an in-use option is blocked");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);
  await page.goto(`${BASE}/settings`);
  await page.getByRole("heading", { name: "Board settings" }).waitFor();

  if (await page.getByRole("button", { name: "Materials", exact: true }).count()) {
    throw new Error("Materials tab should be removed");
  }

  for (const name of ["Material options", "Inspection options", "Hardware options", "Priority options"]) {
    const btn = page.getByRole("button", { name: new RegExp(name, "i") });
    await btn.waitFor();
  }
  console.log("PASS Settings shows collapsible options for all builtin selects");

  await page.getByRole("button", { name: /Inspection options/i }).click();
  await page.screenshot({
    path: path.join(SHOTS, "select-options-inspection.png"),
    fullPage: true,
  });

  // Add a temporary inspection option, save, confirm API, then remove (if unused)
  const probe = `verify_insp_${Date.now().toString().slice(-6)}`;
  const addInput = page.locator(".settings-options-editor .settings-add input.cell-input").first();
  await addInput.fill(probe);
  await page.locator(".settings-options-editor .settings-add button.btn-primary").first().click();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(900);

  const after = await getBoard(token);
  const insp = after.document.selectionLists?.inspection || [];
  if (!insp.some((o) => o.toLowerCase() === probe.toLowerCase())) {
    throw new Error("inspection probe did not persist");
  }
  console.log("PASS add Inspection option persists");

  // Remove unused probe
  const cleaned = structuredClone(after.document);
  cleaned.selectionLists.inspection = cleaned.selectionLists.inspection.filter(
    (o) => o.toLowerCase() !== probe.toLowerCase(),
  );
  await putBoard(token, cleaned);
  console.log("PASS removed unused Inspection probe");

  // Priority options expand screenshot
  await page.goto(`${BASE}/settings`);
  await page.getByRole("button", { name: /Priority options/i }).click();
  await page.screenshot({
    path: path.join(SHOTS, "select-options-priority.png"),
    fullPage: true,
  });

  // Custom select Coatings (scope to custom-attribute add row — Priority options
  // also exposes an Add button while expanded).
  const coatLabel = `Coatings ${Date.now().toString().slice(-4)}`;
  const customAdd = page
    .locator(".settings-add")
    .filter({ has: page.getByRole("heading", { name: "Add custom attribute" }) });
  await customAdd.locator("input[placeholder='Label']").fill(coatLabel);
  await customAdd.locator("select").selectOption("select");
  await customAdd.getByRole("button", { name: "Add", exact: true }).click();
  const coatEditor = page
    .locator("li.settings-field-with-options")
    .filter({
      has: page.getByRole("button", { name: new RegExp(`${coatLabel} options`, "i") }),
    })
    .locator(".settings-options-editor");
  await coatEditor.waitFor();
  await coatEditor.locator(".settings-add input.cell-input").fill("Anodize");
  await coatEditor.locator(".settings-add button.btn-primary").click();
  await page.screenshot({
    path: path.join(SHOTS, "select-options-coatings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(900);

  const withCoat = await getBoard(token);
  const coatField = withCoat.document.customFields.find(
    (f) => f.label === coatLabel && f.type === "select",
  );
  if (!coatField) throw new Error("Coatings field missing");
  // Cleanup
  const wipe = structuredClone(withCoat.document);
  wipe.customFields = wipe.customFields.filter((f) => f.key !== coatField.key);
  wipe.cardFields = wipe.cardFields.filter((f) => f.key !== coatField.key);
  if (wipe.selectionLists) delete wipe.selectionLists[coatField.key];
  wipe.dashboardColumns = (wipe.dashboardColumns || []).filter(
    (c) => c.key !== coatField.key,
  );
  await putBoard(token, wipe);
  console.log("PASS Coatings custom select + cleanup");

  await page.goto(`${BASE}/settings`);
  await page.getByRole("heading", { name: "Board settings" }).waitFor();
  await page.screenshot({
    path: path.join(SHOTS, "select-options-final.png"),
    fullPage: true,
  });
  await browser.close();

  console.log(`PO count=${pos.length} (left ${SKIP_JOB} alone)`);
  console.log("ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
