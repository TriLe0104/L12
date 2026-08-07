/* TEMPORARY verification suite for the dashboard column rebalance and the
   timezone fix. Delete afterwards.
     node scripts/tmp-verify-dashboard.mjs [--shots]                            */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = "trile0104@gmail.com";
const PASSWORD = "tvm-temp-2026";
const SHOT_DIR = "C:\\Users\\tril\\Projects\\po-calendar\\frontend\\tmp-shots";
const WIDTHS = [1920, 1600, 1440, 1280, 1152, 1024, 900, 780, 640, 560, 480, 420, 360];
const AWARE = /(Z|[+-]\d\d:\d\d)$/;

let pass = 0;
const fails = [];
const ok = (cond, label, extra = "") => {
  if (cond) pass++;
  else fails.push(`${label}${extra ? ` — ${extra}` : ""}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

mkdirSync(SHOT_DIR, { recursive: true });

/* ---------- API side ---------- */
const login = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());
const T = login.access_token;
const apiGet = (p) => fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${T}` } }).then((r) => r.json());

const orders = await apiGet("/api/purchase-orders");
const users = await apiGet("/api/users");
ok(orders.length === 28, "the API still has 28 orders", `saw ${orders.length}`);

/* every datetime the API emits carries an offset */
for (const key of ["created_at", "updated_at"]) {
  const bad = orders.filter((o) => !AWARE.test(o[key]));
  ok(bad.length === 0, `every purchase order's ${key} carries a UTC offset`, `${bad.length} without one`);
}
ok(
  orders.every((o) => !o.last_modified || AWARE.test(o.last_modified.at)),
  "every last_modified.at carries a UTC offset",
);
ok(
  users.every((u) => AWARE.test(u.created_at) && (!u.last_login_at || AWARE.test(u.last_login_at))),
  "every user timestamp carries a UTC offset",
);
ok(
  orders.every((o) => /^\d{4}-\d\d-\d\d$/.test(o.due_date)),
  "every due date is still a bare date with no time or offset",
);

/* a real change, then the trail's newest row must be seconds old */
const target = orders.find((o) => o.job_no !== "J-55" && o.job_no === "J-42") ?? orders[0];
const beforeEdit = { ...target };
const editedAt = Date.now();
const saved = await fetch(`${API}/api/purchase-orders/${target.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
  body: JSON.stringify({ note: target.note }),
}).then((r) => r.json());
ok(saved.due_date === beforeEdit.due_date, "the edit left the due date alone", `${beforeEdit.due_date} → ${saved.due_date}`);

const trail = await apiGet(`/api/purchase-orders/${target.id}/activity`);
ok(AWARE.test(trail[0].created_at), "the newest trail row carries a UTC offset", trail[0].created_at);
const ageSec = (Date.now() - Date.parse(trail[0].created_at)) / 1000;
ok(near(ageSec, (Date.now() - editedAt) / 1000, 90), "the trail row parses to seconds ago, not hours", `${ageSec.toFixed(0)}s`);

/* ---------- browser side ---------- */
let browser;
for (let i = 0; i < 6; i++) {
  try {
    browser = await chromium.launch();
    break;
  } catch (e) {
    if (i === 5) throw e;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));

await page.goto(`${BASE}/login`);
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/\/dashboard/, { timeout: 45000 });
ok(true, "signing in lands on the dashboard");

await page.evaluate(() => {
  localStorage.setItem("po.dash.filter", JSON.stringify("all"));
  localStorage.setItem("po.dash.sort", JSON.stringify({ key: "due", dir: "asc" }));
});
await page.reload();
await page.waitForSelector(".dash-table tbody tr");

const rowCount = await page.locator(".dash-table tbody tr").count();
ok(rowCount === 28, "all 28 orders are listed under the All pill", `saw ${rowCount}`);

/* --- layout at every band --- */
const layout = async () =>
  page.evaluate(() => {
    const table = document.querySelector(".dash-table");
    const scroll = document.querySelector(".dash-scroll");
    const vis = (el) => getComputedStyle(el).display !== "none";
    const heads = [...table.querySelectorAll("thead th")].filter(vis);
    const clipped = [];
    /* a heading, a tag, a pill, a date, a number and the job/part lines must fit;
       free text may ellipsize, but only where a title carries the full value */
    const strict = new Set(["job", "po_number", "priority", "stage", "due", "qty"]);
    for (const th of heads) {
      const span = th.querySelector(".dash-sort > span");
      if (span && span.scrollWidth > span.clientWidth + 1) {
        clipped.push(`heading ${th.dataset.col}: ${span.scrollWidth} > ${span.clientWidth}`);
      }
    }
    for (const td of table.querySelectorAll("tbody td")) {
      if (!vis(td)) continue;
      const col = td.dataset.col;
      for (const el of [td, ...td.querySelectorAll("span, div")]) {
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        if (strict.has(col)) clipped.push(`${col}: "${el.textContent.trim()}" ${el.scrollWidth} > ${el.clientWidth}`);
        else if (!td.title) clipped.push(`${col} clipped with no title: "${el.textContent.trim()}"`);
      }
    }
    const widths = {};
    let sum = 0;
    for (const th of heads) {
      const w = th.getBoundingClientRect().width;
      widths[th.dataset.col] = Math.round(w * 10) / 10;
      sum += w;
    }
    return {
      cols: heads.map((th) => th.dataset.col),
      widths,
      sum: Math.round(sum),
      tableWidth: Math.round(table.getBoundingClientRect().width),
      containerWidth: Math.round(scroll.clientWidth),
      minWidth: parseFloat(getComputedStyle(table).minWidth) || 0,
      clipped,
      pageHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      hasSticky: getComputedStyle(table.querySelector("thead th")).position === "sticky",
      paneBounded: scroll.scrollHeight > scroll.clientHeight + 1,
    };
  });

const bands = {};
for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(280);
  const m = await layout();
  bands[w] = m;
  ok(!m.pageHScroll, `no horizontal page scroll at ${w}px`);
  ok(m.clipped.length === 0, `nothing clipped at ${w}px`, m.clipped.slice(0, 4).join(" | "));
  ok(near(m.sum, m.tableWidth, 2), `the columns sum to the table width at ${w}px`, `${m.sum} vs ${m.tableWidth}`);
  ok(
    m.tableWidth >= Math.min(m.containerWidth, m.minWidth) - 1,
    `the table honours its band's min-width at ${w}px`,
    `${m.tableWidth} < ${m.minWidth}`,
  );
}

/* the qty column is sized to its content, not to a share of the table */
const qtyWide = bands[1920].widths.qty;
const qtyMid = bands[1280].widths.qty;
ok(qtyWide <= 60, "qty is content-sized at 1920", `${qtyWide}px`);
ok(near(qtyWide, qtyMid, 1), "qty does not grow with the window", `${qtyMid}px at 1280 vs ${qtyWide}px at 1920`);
ok(
  bands[1920].widths.material > bands[1920].widths.qty * 3,
  "the width reclaimed went to material",
  `material ${bands[1920].widths.material}px`,
);
ok(bands[1920].widths.finish >= 237, "finish fits its longest value on one line at 1920", `${bands[1920].widths.finish}px`);

/* the drop order is unchanged */
ok(bands[1920].cols.length === 12, "twelve columns at 1920", bands[1920].cols.join(","));
ok(!bands[1152].cols.includes("finish"), "finish is the first column to leave");
ok(
  !bands[1024].cols.includes("po_number") &&
    !bands[1024].cols.includes("material") &&
    !bands[1024].cols.includes("modified"),
  "po, material and modified leave next",
);
ok(!bands[560].cols.includes("stage") && !bands[560].cols.includes("owner"), "stage and owner leave next");
ok(!bands[480].cols.includes("customer"), "customer leaves next");
ok(bands[420].cols.join(",") === "job,priority,status,due,qty", "420px keeps what, how urgent, when, how many", bands[420].cols.join(","));
ok(bands[360].cols.join(",") === "job,priority,due,qty", "status is the last to leave", bands[360].cols.join(","));

/* --- sticky header --- */
await page.setViewportSize({ width: 1920, height: 1000 });
await page.waitForTimeout(250);
const sticky = await page.evaluate(async () => {
  const scroll = document.querySelector(".dash-scroll");
  const th = document.querySelector(".dash-table thead th");
  const before = th.getBoundingClientRect().top;
  scroll.scrollTop = 400;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const after = th.getBoundingClientRect().top;
  const style = getComputedStyle(th);
  return {
    scrolled: scroll.scrollTop,
    stayed: Math.abs(after - before) < 2,
    onScreen: after >= 0 && after < window.innerHeight,
    opaque: style.backgroundColor !== "rgba(0, 0, 0, 0)",
    hairline: style.boxShadow !== "none",
  };
});
ok(sticky.scrolled > 0, "the table pane scrolls vertically at 1920");
ok(sticky.stayed && sticky.onScreen, "the heading row stays put while the rows scroll");
ok(sticky.opaque, "the sticky heading row is opaque");
ok(sticky.hairline, "the sticky heading keeps its hairline");

await page.setViewportSize({ width: 420, height: 780 });
await page.waitForTimeout(250);
const narrow = await page.evaluate(() => ({
  sticky: getComputedStyle(document.querySelector(".dash-table thead th")).position === "sticky",
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
ok(!narrow.sticky, "the pane is not bounded below the rail's fold");
ok(!narrow.hScroll, "no horizontal page scroll at 420px with the header change");

/* --- sorting --- */
await page.setViewportSize({ width: 1920, height: 1000 });
await page.waitForTimeout(250);
const sortBy = async (col, dir) => {
  const th = page.locator(`.dash-table thead th[data-col="${col}"]`);
  for (let i = 0; i < 3; i++) {
    if ((await th.getAttribute("aria-sort")) === dir) break;
    await th.locator("button").click();
    await page.waitForTimeout(160);
  }
  return th.getAttribute("aria-sort");
};
const colText = (col) => page.locator(`.dash-table tbody td[data-col="${col}"]`).allInnerTexts();

ok((await sortBy("QTY", "ascending")) === "ascending", "the qty heading sorts ascending");
let qtys = (await colText("qty")).map(Number);
ok(
  qtys.every((v, i) => i === 0 || qtys[i - 1] <= v),
  "qty sorts numerically ascending",
  qtys.slice(0, 6).join(","),
);
ok(Math.max(...qtys) === 50, "the largest quantity in the data is 50", `${Math.max(...qtys)}`);
ok((await sortBy("QTY", "descending")) === "descending", "the qty heading sorts descending");
qtys = (await colText("qty")).map(Number);
ok(
  qtys.every((v, i) => i === 0 || qtys[i - 1] >= v),
  "qty sorts numerically descending",
  qtys.slice(0, 6).join(","),
);

ok((await sortBy("MODIFIED", "descending")) === "descending", "the modified heading sorts descending");
const modifiedTimes = await page.evaluate(() =>
  [...document.querySelectorAll('.dash-table tbody td[data-col="modified"]')].map((td) => td.title),
);
const parsed = modifiedTimes.map((t) => Date.parse(t.split(" · ")[1] ?? ""));
ok(
  parsed.every((v, i) => i === 0 || Number.isNaN(v) || Number.isNaN(parsed[i - 1]) || parsed[i - 1] >= v),
  "modified sorts by time, newest first",
);
const firstRowJob = (await page.locator('.dash-table tbody tr td[data-col="job"] .dash-id-job').first().innerText()).trim();
ok(firstRowJob === target.job_no, "the order just edited is at the top of a newest-first sort", firstRowJob);

/* --- the timezone fix as the browser sees it --- */
const modifiedCell = await page.evaluate(() => {
  const td = document.querySelector('.dash-table tbody tr td[data-col="modified"]');
  return { title: td.title, when: td.querySelector(".dash-when")?.textContent ?? "" };
});
const stampFromTitle = Date.parse(modifiedCell.title.split(" · ")[1]);
ok(
  near(stampFromTitle, Date.now(), 5 * 60 * 1000),
  "the Modified tooltip's absolute time matches the wall clock",
  `${modifiedCell.title} vs ${new Date().toLocaleString()}`,
);
const nowLocal = new Date();
ok(
  modifiedCell.when.startsWith(`${nowLocal.getMonth() + 1}/${nowLocal.getDate()} `),
  "the Modified cell shows today's local date",
  `${modifiedCell.when} vs ${nowLocal.getMonth() + 1}/${nowLocal.getDate()}`,
);
const cellClock = modifiedCell.when.split(" ")[1] ?? "";
const [ch, cm] = cellClock.split(":").map(Number);
ok(
  near(ch * 60 + cm, nowLocal.getHours() * 60 + nowLocal.getMinutes(), 5),
  "the Modified cell's clock reads local time, not UTC",
  `cell ${cellClock} vs local ${nowLocal.getHours()}:${String(nowLocal.getMinutes()).padStart(2, "0")}`,
);

/* due dates must not move a day: compare every rendered cell against the API */
const dueRendered = await page.evaluate(() =>
  Object.fromEntries(
    [...document.querySelectorAll(".dash-table tbody tr")].map((tr) => [
      tr.querySelector('td[data-col="job"] .dash-id-job').textContent.trim(),
      tr.querySelector('td[data-col="due"] .dash-mono').textContent.trim(),
    ]),
  ),
);
const expectDue = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
};
const shifted = orders.filter((o) => dueRendered[o.job_no] && dueRendered[o.job_no] !== expectDue(o.due_date));
ok(shifted.length === 0, "no due date shifts a day in the table", shifted.map((o) => `${o.job_no} ${o.due_date}→${dueRendered[o.job_no]}`).join(", "));

/* the same value in the drawer, and the trail in the drawer */
await page.locator(".dash-table tbody tr").first().click();
await page.waitForSelector(".timeline li");
const drawer = await page.evaluate(() => {
  const li = document.querySelector(".timeline li");
  const small = li.querySelector("small");
  const due = document.querySelector('input[type="date"]');
  return { relative: small.textContent.trim(), absolute: small.title, due: due?.value ?? null };
});
ok(
  /just now|^[1-9]m ago$/.test(drawer.relative),
  "the drawer's newest trail entry reads as seconds or minutes ago",
  drawer.relative,
);
ok(
  near(Date.parse(drawer.absolute), Date.now(), 5 * 60 * 1000),
  "the trail entry's absolute time matches the wall clock",
  `${drawer.absolute} vs ${new Date().toLocaleString()}`,
);
ok(drawer.due === target.due_date, "the drawer's due date field is unshifted", `${drawer.due} vs ${target.due_date}`);
const trailShots = { path: `${SHOT_DIR}\\activity-trail.png` };
await page.locator(".timeline").first().screenshot(trailShots);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

/* the users page renders a last-login in local time */
await page.goto(`${BASE}/users`);
await page.waitForSelector("text=Tri Le");
await page.locator("text=Tri Le").first().click();
await page.waitForTimeout(500);
const lastLogin = await page.evaluate(() => document.body.innerText);
const me = users.find((u) => u.email === EMAIL);
const expectLogin = new Date(me.last_login_at).toLocaleString();
ok(
  lastLogin.includes(expectLogin) || lastLogin.includes(expectLogin.replace(/:\d\d /, " ")),
  "the users page renders last sign-in in local time",
  `expected ${expectLogin}`,
);

/* --- filters and search still work --- */
await page.goto(`${BASE}/dashboard`);
await page.waitForSelector(".dash-table tbody tr");
await page.locator(".dash-pill", { hasText: "On hold" }).click();
await page.waitForTimeout(300);
const onHold = await colText("status");
ok(onHold.length > 0 && onHold.every((s) => /ON HOLD/i.test(s)), "the On hold pill filters to on-hold orders", onHold.join("|"));
await page.locator(".dash-pill", { hasText: "All" }).click();
await page.fill(".dash-search input, input.dash-search, .dash-search", "").catch(() => {});
const search = page.locator('input[type="search"], .dash-search input').first();
await search.fill(target.job_no);
await page.waitForTimeout(350);
const found = await page.locator(".dash-table tbody tr").count();
ok(found === 1, `searching ${target.job_no} narrows to one row`, `${found} rows`);
await search.fill("");
await page.waitForTimeout(300);

/* --- screenshots --- */
if (process.argv.includes("--shots")) {
  for (const w of [1920, 1024, 420]) {
    await page.setViewportSize({ width: w, height: w === 420 ? 900 : 1000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}\\dashboard-${w}.png`, fullPage: w === 420 });
    console.log(`shot: ${SHOT_DIR}\\dashboard-${w}.png`);
  }
  console.log(`shot: ${trailShots.path}`);
}

ok(consoleErrors.length === 0, "no uncaught page errors", consoleErrors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
