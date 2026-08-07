import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(root, "screenshots");
const base = process.env.APP_BASE ?? "http://localhost:3000";
const admin = {
  email: process.env.ADMIN_EMAIL ?? "trile0104@gmail.com",
  password: process.env.ADMIN_PASSWORD ?? "tvm-temp-2026",
};

fs.mkdirSync(shots, { recursive: true });

async function login(page) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).fill(admin.email);
  await page.getByLabel(/password/i).fill(admin.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|tasks|calendar|users|settings/);
}

async function verifyViewport(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await login(page);
  await page.goto(`${base}/settings`);
  await page.getByRole("heading", { name: "Board settings" }).waitFor();

  for (const name of ["Material", "Inspection", "Hardware", "Priority"]) {
    const toggle = page.getByRole("button", { name: new RegExp(`${name} options`, "i") });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }

  const rows = page.locator(".settings-options-list > .settings-option-row");
  await rows.first().waitFor();
  const metrics = await rows.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      const controls = item.querySelector(".settings-option-controls")?.getBoundingClientRect();
      return {
        height: rect.height,
        rowRight: rect.right,
        controlsRight: controls?.right ?? 0,
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: item.scrollWidth,
        clientWidth: item.clientWidth,
      };
    }),
  );

  for (const [index, metric] of metrics.entries()) {
    if (metric.height > 48) throw new Error(`${width}px row ${index} is ${metric.height}px tall`);
    if (metric.scrollWidth > metric.clientWidth + 1) {
      throw new Error(`${width}px row ${index} horizontally overflows`);
    }
    if (metric.controlsRight > metric.rowRight + 1 || metric.controlsRight > metric.viewportWidth + 1) {
      throw new Error(`${width}px row ${index} clips controls`);
    }
  }

  const inspectionToggle = page.getByRole("button", { name: /Inspection options/i });
  const editor = inspectionToggle.locator("xpath=..").locator(".settings-options-editor");
  const inspectionRows = editor.locator(".settings-option-row");
  await inspectionRows.nth(0).scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const before = await inspectionRows.locator(".settings-option-input").evaluateAll((inputs) =>
    inputs.map((input) => input.value),
  );
  const source = await inspectionRows.nth(0).locator(".settings-drag-handle").boundingBox();
  const target = await inspectionRows.nth(1).boundingBox();
  if (!source || !target) throw new Error(`${width}px drag targets unavailable`);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.8, { steps: 8 });
  await page.mouse.up();
  const after = await inspectionRows.locator(".settings-option-input").evaluateAll((inputs) =>
    inputs.map((input) => input.value),
  );
  if (before[0] === after[0]) throw new Error(`${width}px drag did not reorder options`);

  const screenshot = path.join(shots, `settings-compact-options-${width}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.close();
  return {
    width,
    rows: metrics.length,
    minHeight: Math.min(...metrics.map((metric) => metric.height)),
    maxHeight: Math.max(...metrics.map((metric) => metric.height)),
    screenshot,
  };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1024, 420]) {
    console.log(JSON.stringify(await verifyViewport(browser, width)));
  }
} finally {
  await browser.close();
}
