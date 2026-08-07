import { chromium } from "playwright";

const API = "http://127.0.0.1:8000";
const { access_token } = await (
  await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "trile0104@gmail.com", password: "tvm-temp-2026" }),
  })
).json();
const pos = await (
  await fetch(`${API}/api/purchase-orders`, { headers: { Authorization: `Bearer ${access_token}` } })
).json();
const withModel = pos.find((p) => p.model_url && p.model_filename?.endsWith(".3dm"));
if (!withModel) throw new Error("no order currently carries a .3dm — run the attach step first");
const url = `${API}${withModel.model_url}`;
console.log("model:", url, withModel.model_filename);

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const context = await browser.newContext();
await context.addInitScript(
  (t) => window.localStorage.setItem("po_calendar_token", t),
  access_token,
);
const page = await context.newPage();
page.on("console", (m) => console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:3000/tmp3dm?url=${encodeURIComponent(url)}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForFunction(() => document.querySelector("#out")?.textContent !== "running…", {
  timeout: 120_000,
});
await page.waitForTimeout(1000);
console.log("\n" + (await page.locator("#out").innerText()));
await browser.close();
