/* TEMP verification: MaterialCombobox filters catalog, commits selections, rejects free text. */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASSWORD = "tvm-temp-2026";

const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) throw new Error(`login failed: ${res.status}`);
const { access_token } = await res.json();

mkdirSync("screenshots", { recursive: true });

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function discardCreateIfPrompted(page) {
  const dialog = page.getByRole("alertdialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Discard new order" }).click();
    await page.waitForTimeout(300);
    return;
  }
  await page.locator(".drawer-head .btn").first().click();
  await page.waitForTimeout(200);
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Discard new order" }).click();
    await page.waitForTimeout(300);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((t) => window.localStorage.setItem("po_calendar_token", t), access_token);
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.localStorage.setItem("po_calendar_task_view", "cards");
  window.localStorage.setItem("po_calendar_task_hide_completed", "0");
  window.localStorage.setItem("po_calendar_task_zoom", "2");
});

await page.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });

// New PO create flow — abandon without saving so PO count stays unchanged.
await page.click("text=+ New PO");
await page.waitForSelector(".jobcard-edit");
await page.waitForTimeout(500);

const combo = page.getByRole("combobox", { name: "Material" });
await combo.waitFor({ state: "visible" });
await page.screenshot({ path: "screenshots/material-combo-01-open.png" });

// Filter: 6061
await combo.click();
await combo.fill("6061");
await page.waitForSelector(".combo-list");
await page.waitForTimeout(200);
const opts6061 = await page.locator(".combo-list .combo-option").allTextContents();
const filtered6061 = opts6061.filter((t) => t.trim() && !t.includes("select material"));
console.log("6061 options:", filtered6061);
assert(filtered6061.length > 0, "expected filtered options for 6061");
assert(
  filtered6061.every((t) => t.toLowerCase().includes("6061")),
  `6061 filter leaked non-matches: ${JSON.stringify(filtered6061)}`,
);
await page.screenshot({ path: "screenshots/material-combo-02-filter-6061.png" });

// Filter: SST (clear first)
await combo.fill("");
await combo.fill("SST");
await page.waitForTimeout(200);
const optsSst = await page.locator(".combo-list .combo-option").allTextContents();
const filteredSst = optsSst.filter((t) => t.trim() && !t.includes("select material"));
console.log("SST options:", filteredSst);
assert(filteredSst.length > 0, "expected filtered options for SST");
assert(
  filteredSst.every((t) => t.toLowerCase().includes("sst")),
  `SST filter leaked non-matches: ${JSON.stringify(filteredSst)}`,
);
await page.screenshot({ path: "screenshots/material-combo-03-filter-sst.png" });

// Select first filtered option via click
const pickLabel = filteredSst[0].trim();
await page.locator(".combo-list .combo-option").filter({ hasText: pickLabel }).first().click();
await page.waitForTimeout(200);
const committed = (await combo.inputValue()).trim();
console.log("committed after click:", committed);
assert(committed === pickLabel, `expected committed ${pickLabel}, got ${committed}`);
await page.screenshot({ path: "screenshots/material-combo-04-selected.png" });

// Unknown free text must not commit — outside mousedown (blur path)
await combo.click();
await combo.fill("NOTAREALMATERIALXYZ");
await page.waitForTimeout(150);
const other = page.locator(".jobcard-edit input.cell-input:not([role=combobox])").first();
await other.click({ force: true });
await page.waitForTimeout(250);
const afterBlur = (await combo.inputValue()).trim();
console.log("after outside-click free-text:", afterBlur);
assert(
  afterBlur === committed || afterBlur === "",
  `outside click should revert previous/empty, got ${afterBlur}`,
);
assert(afterBlur !== "NOTAREALMATERIALXYZ", "outside click must not commit unknown text");

// Unknown free text + Escape — value must not stay as free text.
// Note: Escape may also open the drawer unsaved prompt (bubbles); that is fine.
await combo.click({ force: true });
await combo.fill("NOTAREALMATERIALXYZ");
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const afterEscape = (await combo.inputValue()).trim();
console.log("after Escape free-text:", afterEscape);
assert(afterEscape !== "NOTAREALMATERIALXYZ", "Escape must not leave unknown free text committed");
assert(
  afterEscape === committed || afterEscape === "" || afterEscape === pickLabel,
  `Escape should revert to prior catalog value/empty, got ${afterEscape}`,
);
await page.screenshot({ path: "screenshots/material-combo-05-reject-freetext.png" });

// Abandon create without saving (discard prompt if present)
await discardCreateIfPrompted(page);

await browser.close();
console.log("PASS: MaterialCombobox filter/select/reject-freetext");
process.exit(0);
