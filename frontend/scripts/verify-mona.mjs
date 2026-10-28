import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "docs", "images");
mkdirSync(outDir, { recursive: true });

const base = process.env.L12_URL || "http://127.0.0.1:3001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(25000);

const login = await fetch("http://127.0.0.1:8001/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const { access_token } = await login.json();
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".summary-strip[data-k='health']", { timeout: 20000 });
await page.waitForFunction(() => {
  const t = document.querySelector('.summary-strip[data-k="health"] button[aria-label="Temperature"]');
  return t && /OK\s+\d/.test(t.textContent || "");
}, { timeout: 25000 });

const temp = await page.evaluate(() => {
  const btn = document.querySelector('.summary-strip[data-k="health"] button[aria-label="Temperature"]');
  const cats = [...(btn?.querySelectorAll(".health-cats i") || [])].map((el) => ({
    status: el.getAttribute("data-status"),
    n: el.getAttribute("data-n"),
    text: el.textContent.trim(),
    color: getComputedStyle(el).color,
    hot: el.classList.contains("health-hot"),
    flame: Boolean(el.querySelector(".flame")),
  }));
  return { text: btn?.textContent?.replace(/\s+/g, " ").trim(), cats };
});
console.log("temp", JSON.stringify(temp));
if (!temp.cats.some((c) => c.status === "ok") || !temp.cats.some((c) => c.status === "warning") || !temp.cats.some((c) => c.status === "critical")) {
  throw new Error("temperature tile missing OK/Warn/Hot chips");
}

await page.screenshot({ path: join(outDir, "gb300-telem-temp.png"), fullPage: false });

await page.evaluate(() => {
  const hot = document.querySelector('.summary-strip[data-k="health"] button[aria-label="Temperature"] i[data-status="critical"]');
  if (!hot) return;
  hot.classList.add("health-hot");
  hot.setAttribute("data-n", "1");
  if (!hot.querySelector(".flame")) {
    const f = document.createElement("span");
    f.className = "flame";
    f.innerHTML = "<span></span><span></span><span></span>";
    hot.appendChild(f);
  }
});
await page.waitForTimeout(400);
const flameOn = await page.locator(".health-hot .flame").count();
console.log("flameDemo", flameOn);
await page.screenshot({ path: join(outDir, "gb300-telem-temp-open.png"), fullPage: false });

await page.locator('.summary-strip[data-k="health"] button[aria-label="Power shelf"]').click();
await page.waitForSelector(".telem-list", { timeout: 8000 });
await page.waitForTimeout(400);
const cols = await page.locator(".telem-list-table thead th").allInnerTexts();
console.log("shelfCols", cols);
await page.locator(".telem-exp").first().click();
await page.waitForSelector(".telem-sub", { timeout: 5000 });
const sub = await page.locator(".telem-sub td").allInnerTexts();
console.log("shelfSub", sub.slice(0, 16));
if (!sub.some((t) => /PDB/i.test(t)) || !sub.some((t) => /CBC/i.test(t))) {
  throw new Error("power shelf expand did not show PDB/CBC");
}
await page.screenshot({ path: join(outDir, "gb300-telem-shelf.png"), fullPage: false });
await page.keyboard.press("Escape");

await page.goto(`${base}/settings`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".ui-set-card", { timeout: 15000 });
const headings = await page.locator(".ui-set-card h2").allInnerTexts();
const sopRow = await page.locator(".ui-sop-list li b").allInnerTexts();
const keyInput = await page.locator('input[aria-label="Grok API key"]').count();
const photo = await page.locator(".ui-set-photo").count();
console.log("settings", JSON.stringify({ headings, sopRow, keyInput, photo }));
if (!headings.includes("Grok API key") || !headings.includes("SOP / documents")) {
  throw new Error("settings missing grok/sop sections");
}
await page.screenshot({ path: join(outDir, "p5-settings.png"), fullPage: false });

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".p5-fab", { timeout: 15000 });
await page.waitForSelector(".p5-quip", { timeout: 8000 });
await page.screenshot({ path: join(outDir, "gb300-health-overview-mobile.png"), fullPage: false });

await browser.close();
console.log("ok");
