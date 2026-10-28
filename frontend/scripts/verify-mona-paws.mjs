import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.env.L12_URL || "http://127.0.0.1:3000";
const api = process.env.L12_API || "http://127.0.0.1:8001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";
const outDir = join(process.cwd(), "..", "screenshots");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(25000);

const login = await fetch(`${api}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();
await page.route("**/api/agent/jobs", async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], running: 0 }) });
    return;
  }
  await route.continue();
});

await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector('[data-mona="health"], .summary-strip[data-k="health"]', { timeout: 20000 });
await page.waitForSelector('[data-mona="overview"]', { timeout: 20000 });

const tags = await page.evaluate(() => ({
  health: Boolean(document.querySelector('[data-mona="health"]')),
  overview: Boolean(document.querySelector('[data-mona="overview"]')),
  tabRacks: Boolean(document.querySelector('[data-mona="tab-racks"]')),
}));
console.log("tags", JSON.stringify(tags));
if (!tags.health || !tags.overview || !tags.tabRacks) throw new Error("missing data-mona hooks");

await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.waitForTimeout(1400);
const spine = await page.evaluate(() => {
  const paws = [...document.querySelectorAll(".p5-spine-paws .p5-spine-paw")];
  const trail = document.querySelector(".p5-spine-draw");
  const opacities = paws.map((g) => Number(g.getAttribute("opacity") || getComputedStyle(g).opacity || "0"));
  return {
    paws: paws.length,
    opacities,
    d: trail?.getAttribute("d")?.length || 0,
    max: Math.max(0, ...opacities),
    min: Math.min(1, ...opacities),
  };
});
console.log("spine", JSON.stringify(spine));
if (spine.paws < 2) throw new Error(`spine paws missing (${spine.paws})`);
if (spine.max < 0.5) throw new Error(`spine paws invisible: ${spine.opacities}`);
await page.waitForTimeout(320);
const spine2 = await page.evaluate(() => {
  const paws = [...document.querySelectorAll(".p5-spine-paws .p5-spine-paw")];
  return paws.map((g) => Number(g.getAttribute("opacity") || "0"));
});
const moved = spine.opacities.some((o, i) => Math.abs((spine2[i] ?? o) - o) > 0.04);
const spread = Math.max(...spine2) - Math.min(...spine2) > 0.08;
console.log("spineWalk", JSON.stringify({ moved, spread, later: spine2 }));
if (!moved && !spread) throw new Error("spine paws are static");
await page.screenshot({ path: join(outDir, "mona-spine-walk.png") });

await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "health", action: "look", label: "sniffing health" } }));
});
await page.waitForSelector(".mona-stage", { timeout: 4000 });
await page.waitForTimeout(500);
const healthStage = await page.evaluate(() => {
  const stage = document.querySelector(".mona-stage");
  const paws = document.querySelectorAll(".mona-stage g.mona-paw");
  const labelEl = document.querySelector(".mona-spot-label");
  const labelCss = labelEl ? getComputedStyle(labelEl) : null;
  const walker = document.querySelector(".mona-walker");
  const walkerBox = walker?.getBoundingClientRect();
  return {
    action: stage?.getAttribute("data-action"),
    label: labelEl?.textContent,
    labelColor: labelCss?.color,
    labelBg: labelCss?.backgroundColor,
    paws: paws.length,
    walker: Boolean(walker),
    spot: Boolean(document.querySelector(".mona-spot")),
    walkerTop: walkerBox ? Math.round(walkerBox.top) : null,
    walkerLeft: walkerBox ? Math.round(walkerBox.left) : null,
    walkerBottom: walkerBox ? Math.round(walkerBox.bottom) : null,
    walkerRight: walkerBox ? Math.round(walkerBox.right) : null,
  };
});
console.log("healthStage", JSON.stringify(healthStage));
if (!healthStage.spot || healthStage.paws < 2) throw new Error("health highlight did not walk");
if (!/building|sniffing|health/i.test(healthStage.label || "")) throw new Error("highlight label missing");
if (healthStage.walkerTop != null && healthStage.walkerTop < -1) {
  throw new Error(`walker clipped at top ${healthStage.walkerTop}`);
}
if (healthStage.walkerLeft != null && healthStage.walkerLeft < -1) {
  throw new Error(`walker clipped at left ${healthStage.walkerLeft}`);
}
const rgb = (healthStage.labelColor || "").match(/\d+/g)?.map(Number) || [];
if (rgb.length >= 3 && rgb[0] + rgb[1] + rgb[2] < 500) throw new Error(`label text too dark: ${healthStage.labelColor}`);
await page.screenshot({ path: join(outDir, "mona-paws-health.png") });

await page.locator('[data-mona="tab-racks"]').click();
await page.waitForSelector('[data-mona="racks"]', { timeout: 8000 });
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "racks", action: "add", label: "adding racks…" } }));
});
await page.waitForSelector('.mona-stage[data-action="add"]', { timeout: 4000 });
await page.waitForTimeout(500);
const addStage = await page.evaluate(() => ({
  action: document.querySelector(".mona-stage")?.getAttribute("data-action"),
  label: document.querySelector(".mona-spot-label")?.textContent,
  typing: Boolean(document.querySelector(".p5-dots-paws")),
}));
console.log("addStage", JSON.stringify(addStage));
if (addStage.action !== "add") throw new Error("add highlight missing");
await page.screenshot({ path: join(outDir, "mona-paws-racks.png") });

await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "racks", action: "remove", label: "yeeting a rack" } }));
});
await page.waitForSelector(".mona-claw", { timeout: 4000 });
await page.waitForTimeout(400);
const claw = await page.locator(".mona-claw").count();
console.log("claw", claw);
if (!claw) throw new Error("remove slash missing");
await page.screenshot({ path: join(outDir, "mona-paws-remove.png") });

await page.goto(`${base}/testing`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-mona="catalog"], .test-pick', { timeout: 12000 });
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "testing", action: "look", label: "browsing tests…" } }));
});
await page.waitForSelector(".mona-stage", { timeout: 4000 });
await page.waitForTimeout(700);
const catalog = await page.evaluate(() => {
  const walker = document.querySelector(".mona-walker")?.getBoundingClientRect();
  const label = document.querySelector(".mona-spot-label")?.getBoundingClientRect();
  const overlap =
    walker && label
      ? !(walker.right < label.left || walker.left > label.right || walker.bottom < label.top || walker.top > label.bottom)
      : false;
  return {
    label: document.querySelector(".mona-spot-label")?.textContent || "",
    walkerTop: walker ? Math.round(walker.top) : null,
    walkerLeft: walker ? Math.round(walker.left) : null,
    walkerBottom: walker ? Math.round(walker.bottom) : null,
    walkerHeight: walker ? Math.round(walker.height) : null,
    labelLeft: label ? Math.round(label.left) : null,
    labelTop: label ? Math.round(label.top) : null,
    overlap,
  };
});
console.log("catalog", JSON.stringify(catalog));
if (catalog.walkerTop == null || catalog.walkerTop < 0) {
  throw new Error(`catalog walker clipped at top ${catalog.walkerTop}`);
}
if (catalog.walkerHeight != null && catalog.walkerHeight < 28) {
  throw new Error(`catalog walker squashed ${catalog.walkerHeight}`);
}
if (catalog.overlap) throw new Error("browsing-tests label covers the hunt cat");
await page.screenshot({ path: join(outDir, "mona-paws-testing.png") });

await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-mona="overview"], .overview-dash', { timeout: 20000 });
await page.waitForTimeout(400);
const clusterLimiter = await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "power limiter", action: "look", label: "dynamic power" } }));
  return {
    path: location.pathname,
    stage: Boolean(document.querySelector(".mona-stage")),
    page: Boolean(document.querySelector(".maxlps-page, [data-mona='maxlps']")),
  };
});
console.log("clusterLimiter", JSON.stringify(clusterLimiter));
if (clusterLimiter.page) throw new Error("limiter hunt stayed on a maxlps node that is not mounted on cluster");
await page.waitForTimeout(500);
const clusterStage = await page.evaluate(() => Boolean(document.querySelector(".mona-stage")));
if (clusterStage) throw new Error("power limiter highlighted cluster instead of waiting for Dynamic Power");

await page.goto(`${base}/maxlps`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-mona="maxlps"], .maxlps-page', { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("l12-mona-point", { detail: { target: "power limiter", action: "look", label: "dynamic power" } }));
});
await page.waitForSelector(".mona-stage", { timeout: 4000 });
await page.waitForTimeout(700);
const maxlpsHunt = await page.evaluate(() => {
  const walker = document.querySelector(".mona-walker")?.getBoundingClientRect();
  const page = document.querySelector("[data-mona='maxlps'], .maxlps-page");
  const loop = document.querySelector(".maxlps-loop, [data-mona='limiter']");
  const spot = document.querySelector(".mona-spot")?.getBoundingClientRect();
  const pageBox = page?.getBoundingClientRect();
  const inside =
    spot && pageBox
      ? spot.left >= pageBox.left - 8 &&
        spot.right <= pageBox.right + 8 &&
        spot.top >= pageBox.top - 8 &&
        spot.bottom <= pageBox.bottom + 8
      : false;
  return {
    path: location.pathname,
    label: document.querySelector(".mona-spot-label")?.textContent || "",
    onLoop: Boolean(loop && document.querySelector(".mona-spot")),
    walkerTop: walker ? Math.round(walker.top) : null,
    inside,
    page: Boolean(page),
  };
});
console.log("maxlpsHunt", JSON.stringify(maxlpsHunt));
if (maxlpsHunt.path !== "/maxlps") throw new Error(`power limiter left Dynamic Power (${maxlpsHunt.path})`);
if (!maxlpsHunt.page || !maxlpsHunt.inside) throw new Error("power limiter did not hunt Dynamic Power");
if (maxlpsHunt.walkerTop == null || maxlpsHunt.walkerTop < 0) {
  throw new Error(`maxlps walker clipped at top ${maxlpsHunt.walkerTop}`);
}
await page.screenshot({ path: join(outDir, "mona-paws-maxlps.png") });

await browser.close();
console.log("ok");
