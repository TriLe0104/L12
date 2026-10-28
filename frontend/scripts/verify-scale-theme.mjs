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

const browser = await chromium.launch({ headless: true });

async function shot(theme, viewport, path, file) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(25000);
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token, theme: t }) => {
      localStorage.setItem("po_calendar_token", token);
      localStorage.setItem("l12-ui-theme", t);
      document.documentElement.setAttribute("data-theme", t);
    },
    { token: access_token, theme },
  );
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
  await page.waitForSelector(".shell", { timeout: 20000 });
  await page.waitForSelector(
    ".pod-card, .pod-empty, .ui-settings, .testing-page, .maxlps-page, .provision-app",
    { timeout: 12000 },
  ).catch(() => {});
  const cancel = page.getByRole("button", { name: /^Cancel$/ });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const html = document.documentElement;
    const shell = document.querySelector(".shell");
    const cs = shell ? getComputedStyle(shell) : null;
    const overflow = [...document.querySelectorAll("main, .cluster-app, .testing-page, .maxlps-page, .rail")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > window.innerWidth + 8 || r.bottom > window.innerHeight + 80;
    }).map((el) => el.className.split(" ")[0]);
    const whiteOnLight = [...document.querySelectorAll(".cluster-tabs button[data-active='true'], .maxlps-inv-tabs button[data-on='true']")].map((el) => getComputedStyle(el).color);
    return {
      theme: html.getAttribute("data-theme"),
      font: getComputedStyle(html).fontSize,
      cols: cs?.gridTemplateColumns,
      rows: cs?.gridTemplateRows,
      overflow,
      tabColors: whiteOnLight,
      navLabels: [...document.querySelectorAll(".nav-label")].filter((el) => getComputedStyle(el).display !== "none").map((el) => el.textContent),
    };
  });
  await page.screenshot({ path: join(outDir, file), fullPage: false });
  await page.close();
  return info;
}

const jobs = [
  ["meow", { width: 1920, height: 1080 }, "/cluster", "scale-meow-1920-cluster.png"],
  ["scc", { width: 1920, height: 1080 }, "/cluster", "scale-scc-1920-cluster.png"],
  ["scc", { width: 1920, height: 1080 }, "/maxlps", "scale-scc-1920-maxlps.png"],
  ["meow", { width: 1920, height: 1080 }, "/testing", "scale-meow-1920-testing.png"],
  ["scc", { width: 1920, height: 1080 }, "/settings", "scale-scc-1920-settings.png"],
  ["meow", { width: 390, height: 844 }, "/cluster", "scale-meow-390-cluster.png"],
  ["scc", { width: 390, height: 844 }, "/cluster", "scale-scc-390-cluster.png"],
  ["meow", { width: 390, height: 844 }, "/testing", "scale-meow-390-testing.png"],
  ["scc", { width: 390, height: 844 }, "/settings", "scale-scc-390-settings.png"],
  ["meow", { width: 2560, height: 1440 }, "/cluster", "scale-meow-2560-cluster.png"],
];

const results = [];
for (const job of jobs) {
  const info = await shot(...job);
  console.log(job[3], JSON.stringify(info));
  results.push({ file: job[3], ...info });
}

const mobileScc = results.find((r) => r.file === "scale-scc-390-cluster.png");
if (mobileScc?.cols && !mobileScc.cols.startsWith("minmax") && mobileScc.cols.includes("16.5")) {
  throw new Error(`SCC mobile still using open-rail columns: ${mobileScc.cols}`);
}
if (mobileScc?.navLabels?.length) {
  throw new Error(`SCC mobile still showing nav labels: ${mobileScc.navLabels.join(",")}`);
}

const meowTab = results.find((r) => r.file === "scale-meow-1920-cluster.png");
const sccTab = results.find((r) => r.file === "scale-scc-1920-cluster.png");
function rgb(s) {
  const m = String(s || "").match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
const sccActive = rgb(sccTab?.tabColors?.[0]);
if (sccActive[0] > 240 && sccActive[1] > 240 && sccActive[2] > 240) {
  throw new Error(`SCC active tab is white-on-light: ${sccTab.tabColors}`);
}

const bigFont = parseFloat(results.find((r) => r.file === "scale-meow-2560-cluster.png")?.font || "0");
const deskFont = parseFloat(meowTab?.font || "0");
if (bigFont < deskFont) throw new Error(`2560 font ${bigFont} smaller than 1920 ${deskFont}`);

await browser.close();
console.log("ok scale+theme");
