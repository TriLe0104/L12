/* TEMPORARY per-column width probe.
   For each viewport: what each column is given, and what its content actually needs
   (measured by letting the table lay itself out automatically with nowrap, so every
   column reports max(heading, widest value) rather than a guess).                 */

import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const WIDTHS = process.argv[2]
  ? process.argv[2].split(",").map(Number)
  : [1920, 1600, 1440, 1280, 1152, 1024, 900, 860, 800, 780, 700, 640, 560, 480, 420, 360];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`);
await page.fill('input[type="email"]', "trile0104@gmail.com");
await page.fill('input[type="password"]', "tvm-temp-2026");
await page.click('button[type="submit"]');
await page.waitForURL(/\/dashboard/);
await page.evaluate(() => {
  localStorage.setItem("po.dash.filter", JSON.stringify("all"));
  localStorage.setItem("po.dash.sort", JSON.stringify({ key: "due", dir: "asc" }));
});
await page.reload();
await page.waitForSelector(".dash-table tbody tr");

const measure = () =>
  page.evaluate(() => {
    const table = document.querySelector(".dash-table");
    const cols = [...table.querySelectorAll("thead th")]
      .map((th) => ({ th, col: th.dataset.col }))
      .filter(({ th }) => getComputedStyle(th).display !== "none");

    const given = {};
    for (const { th, col } of cols) given[col] = Math.round(th.getBoundingClientRect().width * 10) / 10;

    /* what the content wants: automatic layout, one line per cell, no clipping */
    const patch = document.createElement("style");
    patch.id = "probe-natural";
    patch.textContent = `
      .dash-table { table-layout: auto !important; min-width: 0 !important; width: auto !important; }
      .dash-table th, .dash-table td { white-space: nowrap !important; overflow: visible !important; }
      .dash-table [data-col] { width: auto !important; }
      .dash-sort > span { overflow: visible !important; }
      .dash-clamp { display: inline !important; white-space: nowrap !important; overflow: visible !important; }
      .dash-id-job, .dash-id-sub, .dash-when, .dash-person > span { overflow: visible !important; }
    `;
    document.head.append(patch);
    const natural = {};
    for (const { th, col } of cols) natural[col] = Math.ceil(th.getBoundingClientRect().width);

    /* again with the body hidden: now the column reports what the heading alone
       needs, which is the width that actually has to be honoured -- values in a
       free-text column may ellipsize behind a title, a heading may not. */
    const body = document.querySelector(".dash-table tbody");
    const was = body.style.display;
    body.style.display = "none";
    const heading = {};
    for (const { th, col } of cols) heading[col] = Math.ceil(th.getBoundingClientRect().width);
    body.style.display = was;
    patch.remove();

    return {
      container: Math.round(document.querySelector(".dash-scroll").clientWidth),
      tableWidth: Math.round(table.getBoundingClientRect().width),
      minWidth: getComputedStyle(table).minWidth,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      order: cols.map((c) => c.col),
      given,
      natural,
      heading,
    };
  });

for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(320);
  const m = await measure();
  console.log(
    `\n=== viewport ${w}  container ${m.container}px  table ${m.tableWidth}px  ` +
      `min-width ${m.minWidth}  page h-scroll: ${m.hScroll}`,
  );
  console.log(`    col          given   heading   content   slack`);
  let sum = 0;
  for (const col of m.order) {
    sum += m.given[col];
    const slack = Math.round((m.given[col] - m.natural[col]) * 10) / 10;
    console.log(
      `    ${col.padEnd(11)} ${String(m.given[col]).padStart(6)}  ${String(m.heading[col]).padStart(7)}  ` +
        `${String(m.natural[col]).padStart(7)}  ${String(slack).padStart(6)}` +
        (slack < 0 ? "  <-- short" : ""),
    );
  }
  console.log(`    sum of given: ${Math.round(sum)}px`);
}

await browser.close();
