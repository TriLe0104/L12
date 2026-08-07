/* TEMPORARY diagnostic — reproduce the calendar drag snap-back. Delete when done. */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASSWORD = "tvm-temp-2026";

const JOB = process.env.JOB ?? "J-61";
const TARGET_DAY = process.env.TARGET_DAY ?? "2026-08-12";

const login = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { access_token } = await login.json();

const before = await (
  await fetch(`${API}/api/purchase-orders?q=${JOB}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  })
).json();
const po = before.find((p) => p.job_no === JOB);
console.log(`BEFORE  ${po.job_no}  id=${po.id}  due_date=${po.due_date}  locked=${po.locked}`);

mkdirSync("screenshots", { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(
  (token) => window.localStorage.setItem("po_calendar_token", token),
  access_token,
);
const page = await context.newPage();

page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

page.on("request", (r) => {
  if (r.url().includes("/api/purchase-orders") && r.method() !== "GET") {
    console.log(`  --> ${r.method()} ${r.url()}\n      payload: ${r.postData()}`);
  }
});
page.on("response", async (r) => {
  if (r.url().includes("/api/purchase-orders") && r.request().method() !== "GET") {
    let body = "";
    try {
      body = (await r.text()).slice(0, 400);
    } catch {
      body = "<unreadable>";
    }
    console.log(`  <-- ${r.status()} ${r.request().method()} ${r.url()}\n      body: ${body}`);
  }
});
page.on("requestfailed", (r) => {
  console.log(`  !!! FAILED ${r.method()} ${r.url()} — ${r.failure()?.errorText}`);
});

await page.goto(`${WEB}/calendar`, { waitUntil: "networkidle" });

if (process.env.FILTER === "1") {
  // narrow to a single chip so the drag can't grab the wrong one
  await page.fill(".head-tools input.field", JOB);
  await page.waitForTimeout(900);
}

const chips = await page.locator(".fc-event").count();
console.log(`chips on screen: ${chips}`);

const chip = page.locator(`.fc-event:has-text("${JOB} ")`).first();
const cell = page.locator(`td.fc-daygrid-day[data-date="${TARGET_DAY}"]`);
const from = await chip.boundingBox();
const to = await cell.boundingBox();
console.log(`drag from ${JSON.stringify(from)} to cell ${TARGET_DAY} ${JSON.stringify(to)}`);

await page.screenshot({ path: "screenshots/tmp-drag-before.png" });

await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(
    from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / 20,
    from.y + from.height / 2 + ((to.y + 30 - (from.y + from.height / 2)) * i) / 20,
  );
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.waitForTimeout(2500);

await page.screenshot({ path: "screenshots/tmp-drag-after.png" });

const landedOn = await page.evaluate((job) => {
  const el = [...document.querySelectorAll(".fc-event")].find((n) =>
    (n.textContent ?? "").includes(`${job} `),
  );
  if (!el) return "no chip";
  return el.closest("td.fc-daygrid-day")?.getAttribute("data-date") ?? "unknown";
}, JOB);
console.log(`chip is now rendered on: ${landedOn}`);

const after = await (
  await fetch(`${API}/api/purchase-orders?q=${JOB}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  })
).json();
console.log(`AFTER   server due_date=${after.find((p) => p.job_no === JOB).due_date}`);

await browser.close();
