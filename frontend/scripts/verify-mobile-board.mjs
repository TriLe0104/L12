/* Phone-sized task board: the columns are a sliding window, a swipe pans it, and
   a card still moves between columns on a hold. Run with the dev server up:
     node scripts/verify-mobile-board.mjs                                      */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = process.env.PO_EMAIL ?? "trile0104@gmail.com";
const PASSWORD = process.env.PO_PASSWORD ?? "tvm-temp-2026";

const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) throw new Error(`login failed: ${res.status}`);
const { access_token } = await res.json();

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
await context.addInitScript(
  (token) => window.localStorage.setItem("po_calendar_token", token),
  access_token,
);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 14, radiusY: 14, force: 1 }],
  });

const swipe = async (fromX, fromY, toX, toY, steps = 10, holdMs = 0) => {
  await touch("touchStart", fromX, fromY);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let i = 1; i <= steps; i++) {
    await touch("touchMove", fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", toX, toY);
};

await page.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
await page.waitForSelector(".kanban .kcard");

const geometry = await page.evaluate(() => {
  const board = document.querySelector(".kanban");
  const cols = [...board.querySelectorAll(".kcol")];
  const pad = getComputedStyle(board);
  return {
    scrollWidth: board.scrollWidth,
    clientWidth: board.clientWidth,
    // the width columns actually get, once the track's own gutters are paid for
    trackWidth:
      board.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
    boardLeft: board.getBoundingClientRect().left,
    boardRight: board.getBoundingClientRect().right,
    columns: cols.length,
    colWidth: Math.round(cols[0].getBoundingClientRect().width),
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
  };
});

check(
  "board scrolls sideways instead of folding",
  geometry.scrollWidth > geometry.clientWidth + 1,
  `${geometry.scrollWidth}/${geometry.clientWidth} across ${geometry.columns} columns`,
);
/* The window shows one column and a slice of the next: enough of the screen that
   a card reads, not so much that nothing hints the board carries on. */
const share = geometry.colWidth / geometry.trackWidth;
check(
  "one column all but fills the window",
  share > 0.75 && share < 0.95,
  `${geometry.colWidth}px of ${Math.round(geometry.trackWidth)}px (${Math.round(share * 100)}%)`,
);
check(
  "board goes full-bleed without spilling the page",
  geometry.boardLeft <= 1 && geometry.docScroll <= geometry.docClient + 1,
  `left=${Math.round(geometry.boardLeft)} page=${geometry.docScroll}/${geometry.docClient}`,
);

mkdirSync("screenshots", { recursive: true });
await page.screenshot({ path: "screenshots/tasks-mobile-390.png" });

/* A swipe that starts on a card belongs to the track, not to the card. */
const card = await page.evaluate(() => {
  const el = document.querySelector(".kcol .kcard");
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40), id: el.dataset.flipId };
});

await swipe(card.x, card.y, card.x - 240, card.y);
await page.waitForTimeout(700);
const afterSwipe = await page.evaluate(() => ({
  scrollLeft: Math.round(document.querySelector(".kanban").scrollLeft),
  moved: document.querySelector(".card-ghost") === null,
}));
check("swipe pans the board", afterSwipe.scrollLeft > 40, `scrollLeft=${afterSwipe.scrollLeft}`);
check("swipe leaves no card in the air", afterSwipe.moved);

/* A hold, then the same movement, is a drag. */
await page.evaluate(() => {
  document.querySelector(".kanban").scrollLeft = 0;
});
await page.waitForTimeout(400);

const before = await page.evaluate(() => {
  const cols = [...document.querySelectorAll(".kcol")];
  const el = cols[0].querySelector(".kcard");
  const r = el.getBoundingClientRect();
  const second = cols[1].getBoundingClientRect();
  return {
    id: el.dataset.flipId,
    from: cols[0].dataset.stage,
    to: cols[1].dataset.stage,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + 40),
    dropX: Math.round(Math.min(second.right - 8, second.left + 20)),
    dropY: Math.round(r.top + 40),
    firstCount: cols[0].querySelectorAll(".kcard").length,
  };
});

await touch("touchStart", before.x, before.y);
await page.waitForTimeout(450);
const lifted = (await page.$(".card-ghost")) !== null;
check("a hold lifts the card", lifted);

for (let i = 1; i <= 10; i++) {
  await touch(
    "touchMove",
    before.x + ((before.dropX - before.x) * i) / 10,
    before.y + ((before.dropY - before.y) * i) / 10,
  );
  await page.waitForTimeout(16);
}
const overTarget = await page.evaluate(
  (stage) =>
    document.querySelector(`.kcol[data-stage="${stage}"]`)?.dataset.dragover === "true",
  before.to,
);
check("the column under the card highlights", overTarget, `target=${before.to}`);

await touch("touchEnd", before.dropX, before.dropY);
await page.waitForTimeout(1200);

const after = await page.evaluate(
  ({ id, to }) => {
    const el = document.querySelector(`[data-flip-id="${CSS.escape(id)}"]`);
    return {
      landedIn: el?.closest(".kcol")?.dataset.stage ?? null,
      ghostGone: document.querySelector(".card-ghost") === null,
      target: to,
    };
  },
  { id: before.id, to: before.to },
);
check(
  "the card lands in the column it was dropped on",
  after.landedIn === before.to,
  `${before.from} -> ${after.landedIn ?? "gone"} (wanted ${before.to})`,
);
check("the clone is cleaned up", after.ghostGone);

/* put it back so the board is where it was found */
await page.evaluate(
  async ({ id, from, token }) => {
    await fetch(`http://127.0.0.1:8000/api/purchase-orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ stage: from }),
    });
  },
  { id: before.id, from: before.from, token: access_token },
);

await browser.close();
console.log(failures === 0 ? "\nAll clean." : `\n${failures} check(s) need work.`);
process.exit(failures === 0 ? 0 : 1);
