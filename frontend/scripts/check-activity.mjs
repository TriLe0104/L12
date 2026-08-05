/* Presses Save on an untouched order in the real UI and checks that nothing
   happened: the activity trail gains no line and the dashboard's Modified cell
   still names whoever last really changed the order. Then makes an edit it does
   *not* save, to see the unsaved-changes prompt, and leaves the record byte for
   byte as it found it.

   Run with the dev server and the API up:
     node scripts/check-activity.mjs                                            */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = process.env.PO_EMAIL ?? "trile0104@gmail.com";
const PASSWORD = process.env.PO_PASSWORD ?? "tvm-temp-2026";
const SHOTS = join(dirname(dirname(fileURLToPath(import.meta.url))), "screenshots");

let fails = 0;
const check = (label, ok, note = "") => {
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${note}`);
};

const login = async () => {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).access_token;
};

const token = await login();
const auth = { Authorization: `Bearer ${token}` };
const board = await (await fetch(`${API}/api/purchase-orders`, { headers: auth })).json();
// never J-55, and nothing another agent has locked
const target = board
  .filter((po) => po.job_no !== "J-55" && !po.locked)
  .sort((a, b) => a.job_no.localeCompare(b.job_no, undefined, { numeric: true }))[0];
const record = (id) => fetch(`${API}/api/purchase-orders/${id}`, { headers: auth }).then((r) => r.json());
const trail = (id) =>
  fetch(`${API}/api/purchase-orders/${id}/activity`, { headers: auth }).then((r) => r.json());

const before = await record(target.id);
const trailBefore = await trail(target.id);
console.log(`board         ${board.length} orders`);
console.log(`target        ${before.job_no} · ${before.po_number} | ${trailBefore.length} trail row(s) | ` +
  `modified: ${before.last_modified ? `${before.last_modified.by.name} / ${before.last_modified.action}` : "--"}`);

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await context.addInitScript((t) => {
  window.localStorage.setItem("po_calendar_token", t);
  window.localStorage.setItem("po_calendar_dashboard_filter", "all");
}, token);
const page = await context.newPage();

const row = () => page.locator(`tr[data-job="${before.job_no}"]`);
const modifiedCell = () => row().locator('td[data-col="modified"]');
const drawer = () => page.locator("aside.drawer");
const trailRows = () => drawer().locator("ul.timeline li");

const openDashboard = async () => {
  await page.goto(`${WEB}/dashboard`, { waitUntil: "networkidle" });
  await row().waitFor();
};

await openDashboard();
const modifiedBefore = (await modifiedCell().innerText()).replace(/\s+/g, " ").trim();
console.log(`modified cell "${modifiedBefore}"`);

// --- open, and Save without touching anything --------------------------------
await row().click();
await drawer().waitFor();
await page.waitForTimeout(700);
const linesBefore = await trailRows().count();
const topBefore = linesBefore ? (await trailRows().first().innerText()).replace(/\s+/g, " ") : "(empty)";
check("drawer opened", await drawer().isVisible(), `${linesBefore} trail line(s): ${topBefore}`);

await page.getByRole("button", { name: "Save changes" }).click();
await drawer().getByText("Saved.").waitFor({ timeout: 15000 });
await page.waitForTimeout(900);
check("save keeps the drawer open", await drawer().isVisible(), 'and says "Saved."');
const linesAfter = await trailRows().count();
check("trail gained nothing", linesAfter === linesBefore, `${linesBefore} -> ${linesAfter} line(s)`);
const topAfter = linesAfter ? (await trailRows().first().innerText()).replace(/\s+/g, " ") : "(empty)";
check("newest line unchanged", topAfter === topBefore, topAfter);
await page.screenshot({ path: join(SHOTS, "activity-noop-save.png") });

// an untouched drawer closes without asking
await page.getByRole("button", { name: "Close" }).click();
await page.waitForTimeout(500);
check("no prompt on a clean close", await page.locator(".confirm-frame").count() === 0,
  `drawer visible: ${await drawer().count() > 0}`);

await openDashboard();
const modifiedAfter = (await modifiedCell().innerText()).replace(/\s+/g, " ").trim();
check("modified cell unchanged", modifiedAfter === modifiedBefore, `"${modifiedAfter}"`);
await page.screenshot({ path: join(SHOTS, "activity-modified-cell.png") });

// --- an edit that is never saved still has to be noticed ----------------------
await row().click();
await drawer().waitFor();
await page.waitForTimeout(500);
const note = drawer().locator('input[placeholder^="Note"]');
await note.fill(`${before.note ?? ""} smoke edit`);
await page.getByRole("button", { name: "Close" }).click();
const prompt = page.locator(".confirm-frame");
await prompt.waitFor({ timeout: 5000 });
check("edit then close asks first", await prompt.isVisible(),
  (await prompt.locator(".confirm-title").innerText()).trim());
await page.screenshot({ path: join(SHOTS, "activity-unsaved-prompt.png") });
await page.getByRole("button", { name: "Keep editing" }).click();
await page.waitForTimeout(400);
check("keep editing stays put", await drawer().isVisible() && await prompt.count() === 0);
await page.getByRole("button", { name: "Close" }).click();
await prompt.waitFor();
await page.getByRole("button", { name: "Discard changes" }).click();
await page.waitForTimeout(600);
check("discard closes the drawer", await drawer().count() === 0);

await browser.close();

// --- nothing may have moved ---------------------------------------------------
const after = await record(target.id);
const trailAfter = await trail(target.id);
const skip = new Set(["last_modified"]);
const drifted = Object.keys(before).filter(
  (k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
);
check("record identical", drifted.length === 0, drifted.length ? `moved: ${drifted}` : "field by field");
// by id, not by length: the endpoint caps at 50, so a new row could arrive
// without the count moving at all
const ids = (rows) => rows.map((a) => a.id).join(",");
check("trail identical", ids(trailAfter) === ids(trailBefore),
  `${trailBefore.length} row(s), same ids`);
check("last modifier identical",
  JSON.stringify(before.last_modified) === JSON.stringify(after.last_modified),
  after.last_modified ? `${after.last_modified.by.name} / ${after.last_modified.action}` : "--");

console.log(fails === 0 ? "\nAll clean." : `\n${fails} check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
