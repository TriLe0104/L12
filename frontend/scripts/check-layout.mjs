/* Walks every page at a range of window widths and reports any element whose
   content spills past the viewport. Run with the dev server up:
     node scripts/check-layout.mjs                                              */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = process.env.PO_EMAIL ?? "trile0104@gmail.com";
const PASSWORD = process.env.PO_PASSWORD ?? "tvm-temp-2026";

const WIDTHS = [1920, 1440, 1280, 1024, 820, 640, 420];
/* "#year" means: load /calendar, then switch to the multi-month year view.
   "#cards-min" / "#cards-max" mean: load /tasks in its all-cards view at the
   extreme zoom steps. "#stored" means: load /dashboard with a filter and a
   sort already chosen; "#modified" sorts it by the widest column it has, the
   one carrying a name and a timestamp. Those write a stored preference, so they
   come last and leave the plain entries to cover each page's default state. */
const PAGES = [
  "/dashboard",
  "/tasks",
  "/calendar",
  "/calendar#year",
  "/users",
  "/tasks#cards-min",
  "/tasks#cards-max",
  "/dashboard#stored",
  "/dashboard#modified",
];

const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) throw new Error(`login failed: ${res.status}`);
const { access_token } = await res.json();

mkdirSync("screenshots", { recursive: true });

const browser = await chromium.launch();
let problems = 0;

for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(
    (token) => window.localStorage.setItem("po_calendar_token", token),
    access_token,
  );
  const page = await context.newPage();

  for (const spec of PAGES) {
    const [path, mode] = spec.split("#");
    await page.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
    if (mode === "year") {
      await page.click(".fc-multiMonthYear-button");
      await page.waitForSelector(".fc-multimonth-month");
      await page.waitForTimeout(500);
    }
    if (mode?.startsWith("cards-")) {
      await page.evaluate((zoom) => {
        window.localStorage.setItem("po_calendar_task_view", "cards");
        window.localStorage.setItem("po_calendar_task_zoom", zoom);
      }, mode === "cards-min" ? "0" : "4");
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".board-all");
      await page.waitForTimeout(400);
    }
    if (mode === "stored") {
      await page.evaluate(() => {
        window.localStorage.setItem("po_calendar_dashboard_filter", "completed");
        window.localStorage.setItem("po_calendar_dashboard_sort", "qty:desc");
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('th[data-col="qty"][aria-sort="descending"]');
      await page.waitForTimeout(400);
    }
    if (mode === "modified") {
      await page.evaluate(() => {
        window.localStorage.setItem("po_calendar_dashboard_filter", "all");
        window.localStorage.setItem("po_calendar_dashboard_sort", "modified:desc");
      });
      await page.reload({ waitUntil: "networkidle" });
      // attached, not visible: the column drops out of the narrower bands, and
      // the stored sort still has to be the one in force when it does
      await page.waitForSelector('th[data-col="modified"][aria-sort="descending"]', {
        state: "attached",
      });
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(400);

    const report = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const spills = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > docWidth + 1 || r.left < -1) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed") continue;
          spills.push(
            `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "-"} ` +
              `right=${Math.round(r.right)}`,
          );
        }
        // text wider than its own box = clipped or overflowing copy
        if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 1) {
          const cs = getComputedStyle(el);
          const handled =
            cs.textOverflow === "ellipsis" ||
            cs.overflow !== "visible" ||
            el.tagName === "INPUT" ||
            el.tagName === "SELECT";
          if (!handled) {
            spills.push(
              `TEXT ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "-"}: ` +
                `"${(el.textContent ?? "").trim().slice(0, 34)}"`,
            );
          }
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: docWidth,
        spills: [...new Set(spills)].slice(0, 6),
      };
    });

    const horizontal = report.scrollWidth > report.clientWidth + 1;
    const bad = horizontal || report.spills.length > 0;
    if (bad) problems++;
    const flag = bad ? "FAIL" : "ok  ";
    console.log(
      `${flag} ${String(width).padStart(4)}px ${spec.padEnd(15)} ` +
        `scroll=${report.scrollWidth}/${report.clientWidth}` +
        (report.spills.length ? `\n       ${report.spills.join("\n       ")}` : ""),
    );

    if (width === 1440 || width === 640) {
      await page.screenshot({
        path: `screenshots/${spec.slice(1).replace("#", "-")}-${width}.png`,
        fullPage: false,
      });
    }
  }
  await context.close();
}

await browser.close();
console.log(problems === 0 ? "\nAll clean." : `\n${problems} page/width combos need work.`);
