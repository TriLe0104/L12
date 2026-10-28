import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.env.L12_URL || "http://127.0.0.1:3000";
const api = process.env.L12_API || "http://127.0.0.1:8001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";
const outDir = join(process.cwd(), "..", "screenshots");
mkdirSync(outDir, { recursive: true });
const tag = `tmp-rack-${Date.now().toString(36)}`;

const login = await fetch(`${api}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` };

async function addNode(body) {
  const res = await fetch(`${api}/api/provision/nodes`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`add ${res.status} ${await res.text()}`);
  return res.json();
}

async function cleanup() {
  for (const name of [tag, `${tag}-solo`]) {
    const gone = await fetch(`${api}/api/provision/racks/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers,
    });
    if (!gone.ok && gone.status !== 404) {
      console.error("cleanup", name, gone.status, await gone.text());
    }
  }
}

try {
  const a = await addNode({
    bmc_ip: "10.99.1.1",
    bmc_user: "ADMIN",
    bmc_password: "x",
    name: `${tag}-a`,
    hall_name: tag,
  });
  const b = await addNode({
    bmc_ip: "10.99.1.2",
    bmc_user: "ADMIN",
    bmc_password: "x",
    name: `${tag}-b`,
    hall_name: tag,
  });
  const c = await addNode({
    bmc_ip: "10.99.1.3",
    bmc_user: "ADMIN",
    bmc_password: "x",
    name: `${tag}-solo`,
  });
  const idC = c.added?.id;
  if (!a.added?.id || !b.added?.id || !idC) throw new Error("missing added ids");
  if (a.added.hall_name !== tag || b.added.hall_name !== tag) throw new Error("shared rack name not saved");
  if (c.added.hall_name !== `${tag}-solo`) throw new Error(`solo rack ${c.added.hall_name}`);

  const trees = c.racks || [];
  const shared = trees.filter((r) => (r.name || "").toLowerCase() === tag.toLowerCase());
  if (shared.length !== 1) throw new Error(`expected 1 shared rack, got ${JSON.stringify(trees.map((r) => r.name))}`);
  if ((shared[0].counts?.nodes ?? 0) < 2) throw new Error(`shared rack count ${shared[0].counts?.nodes}`);
  const solo = trees.find((r) => (r.name || "").toLowerCase() === `${tag}-solo`.toLowerCase());
  if (!solo || (solo.counts?.nodes ?? 0) !== 1) throw new Error(`solo rack ${solo?.name} ${solo?.counts?.nodes}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(25000);
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
  await page.goto(`${base}/provision`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
  await page.waitForSelector(".provision-app", { timeout: 20000 });
  await page.locator(".inv-parent").filter({ hasText: tag }).first().waitFor({ timeout: 15000 });
  await page.locator(".inv-leaf").filter({ hasText: `${tag}-a` }).first().waitFor({ timeout: 8000 });
  await page.locator(".inv-leaf").filter({ hasText: `${tag}-b` }).first().waitFor({ timeout: 8000 });
  await page.locator(".inv-leaf").filter({ hasText: `${tag}-solo` }).first().click();
  await page.waitForSelector(".prov-edit", { timeout: 8000 });
  const rackInput = page.locator(".prov-edit label").filter({ hasText: "Rack" }).locator("input");
  await rackInput.fill(tag);
  const save = page.locator(".prov-edit button[type='submit']");
  await save.waitFor({ state: "visible" });
  if (await save.isDisabled()) throw new Error("Save stayed disabled after rack rename");
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/api/provision/nodes/${idC}`) && r.request().method() === "PATCH",
      { timeout: 15000 },
    ),
    save.click(),
  ]);
  if (!res.ok()) throw new Error(`patch ${res.status()} ${await res.text()}`);
  const body = await res.json();
  if (body.added?.hall_name !== tag) throw new Error(`ui move hall ${body.added?.hall_name}`);
  const grouped = (body.racks || []).find((r) => (r.name || "").toLowerCase() === tag.toLowerCase());
  if ((grouped?.counts?.nodes ?? 0) < 3) throw new Error(`ui grouped ${grouped?.counts?.nodes}`);
  await page.screenshot({ path: join(outDir, "provision-rack-group.png") });
  await browser.close();
  console.log("ok", tag);
} finally {
  await cleanup();
}
