import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.env.L12_URL || "http://127.0.0.1:3000";
const api = process.env.L12_API || "http://127.0.0.1:8001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";
const outDir = join(process.cwd(), "..", "screenshots");
mkdirSync(outDir, { recursive: true });

const login = await fetch(`${api}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();

const mac = "3c:6d:66:aa:bb:cc";
const created = await fetch(`${api}/api/provision/nodes`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
  body: JSON.stringify({ bmc_mac: mac, bmc_user: "ADMIN", bmc_password: "testbmc" }),
});
if (!created.ok) throw new Error(`add node ${created.status} ${await created.text()}`);
const body = await created.json();
const added = body.added;
if (!added?.id) throw new Error("add node missing added.id");
if ((added.bmc_mac || "").toLowerCase() !== mac) throw new Error(`mac ${added.bmc_mac}`);
if (!String(added.serial || "").startsWith("MAC-")) throw new Error(`serial ${added.serial}`);
if (added.source !== "manual") throw new Error(`source ${added.source}`);
console.log("api", JSON.stringify({ id: added.id, serial: added.serial, mac: added.bmc_mac, notes: body.filled?.notes }));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(25000);
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/provision`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".provision-app", { timeout: 20000 });
await page.getByRole("button", { name: "Add node" }).first().click();
await page.waitForSelector(".theme-dialog", { timeout: 8000 });
const labels = await page.locator(".theme-dialog .field-label").allTextContents();
console.log("dialog", JSON.stringify(labels.map((t) => t.split("\n")[0].trim())));
if (!labels.some((t) => /BMC MAC/i.test(t))) throw new Error("BMC MAC field missing");
if (!labels.some((t) => /BMC id/i.test(t))) throw new Error("BMC id field missing");
if (!labels.some((t) => /BMC password/i.test(t))) throw new Error("BMC password field missing");
if (!labels.some((t) => /BMC IP/i.test(t))) throw new Error("BMC IP field missing");
const ipIdx = labels.findIndex((t) => /BMC IP/i.test(t));
const macIdx = labels.findIndex((t) => /BMC MAC/i.test(t));
if (ipIdx < 0 || macIdx < 0 || ipIdx > macIdx) throw new Error("BMC IP should come before optional MAC");
const macPh = await page.locator(".theme-dialog .field-label").filter({ hasText: "BMC MAC" }).locator("input").getAttribute("placeholder");
if (!/optional|auto/i.test(macPh || "")) throw new Error(`MAC placeholder ${macPh}`);
if (!labels.some((t) => /OS IP/i.test(t))) throw new Error("OS IP field missing");
if (!labels.some((t) => /Rack name/i.test(t))) throw new Error("Rack name field missing");
await page.screenshot({ path: join(outDir, "provision-add-node.png") });
await page.locator(".theme-dialog .btn").filter({ hasText: "Cancel" }).click();
await page.locator(".inv-leaf").filter({ hasText: added.serial }).first().click();
await page.waitForSelector(".prov-edit", { timeout: 8000 });
const rackBox = page.locator(".prov-edit label").filter({ hasText: "Rack" }).locator("input");
if (await rackBox.getAttribute("readonly")) throw new Error("Rack field is read-only");
const nameBox = page.locator(".prov-edit label").filter({ hasText: "Name" }).locator("input");
await nameBox.fill("edit-slot");
await page.locator(".prov-edit button[type='submit']").click();
await page.waitForFunction(() => document.querySelector(".provision-pane-head h2")?.textContent === "edit-slot", { timeout: 8000 });
const patched = await fetch(`${api}/api/provision/nodes/${added.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
  body: JSON.stringify({ name: "edit-slot-api" }),
});
if (!patched.ok) throw new Error(`patch ${patched.status} ${await patched.text()}`);
const patchedBody = await patched.json();
if (patchedBody.added?.name !== "edit-slot-api") throw new Error(`patch name ${patchedBody.added?.name}`);
await page.screenshot({ path: join(outDir, "provision-added-node.png") });
await browser.close();
console.log("ok");
