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
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector('[data-mona="health"]', { timeout: 20000 });

await page.route("**/api/agent/chat", async (route) => {
  await new Promise((r) => setTimeout(r, 2800));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      reply: "Health looks fine from here.",
      choices: [],
      ui: [{ kind: "highlight", action: "look", target: "health", label: "sniffing health" }],
      mutated: false,
    }),
  });
});

await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.locator('.p5-compose input[aria-label="Message"]').fill("check health");
await page.getByRole("button", { name: "SEND" }).click();

await page.waitForSelector(".p5-row--typing .p5-dots i", { timeout: 4000 });
const thinking = await page.evaluate(() => {
  const dots = document.querySelectorAll(".p5-row--typing .p5-dots i");
  const bubble = document.querySelector(".p5-row--typing .p5-bubble-in");
  const box = bubble?.getBoundingClientRect();
  const paws = document.querySelectorAll(".p5-row--typing .p5-mini-paw, .p5-dots-paws");
  let inside = true;
  dots.forEach((el) => {
    const b = el.getBoundingClientRect();
    if (!box) return;
    if (b.left < box.left - 2 || b.right > box.right + 2 || b.top < box.top - 6 || b.bottom > box.bottom + 6) {
      inside = false;
    }
  });
  return { dots: dots.length, inside, strayPaws: paws.length, blank: (bubble?.textContent || "").trim() };
});
console.log("thinking", JSON.stringify(thinking));
if (thinking.dots !== 3) throw new Error(`expected 3 thinking dots, got ${thinking.dots}`);
if (!thinking.inside) throw new Error("thinking dots escaped the bubble");
if (thinking.strayPaws) throw new Error("old paw thinking animation still in the bubble");
await page.screenshot({ path: join(outDir, "mona-thinking-dots.png") });

await page.waitForSelector('.mona-stage[data-action="look"]', { timeout: 12000 });
await page.waitForTimeout(2200);
const held = await page.evaluate(() => ({
  stage: Boolean(document.querySelector(".mona-stage")),
  settled: document.querySelector(".mona-stage")?.getAttribute("data-settled"),
  spot: Boolean(document.querySelector(".mona-spot")),
  typing: Boolean(document.querySelector(".p5-row--typing")),
}));
console.log("held", JSON.stringify(held));
if (!held.stage || !held.spot) throw new Error("highlight vanished before click/prompt");
if (held.settled !== "true") throw new Error("walk never settled");
if (held.typing) throw new Error("thinking row stuck after reply");
await page.screenshot({ path: join(outDir, "mona-highlight-held.png") });

await page.locator('[data-mona="health"]').click({ force: true });
await page.waitForFunction(() => !document.querySelector(".mona-stage"), { timeout: 4000 });
console.log("dismissed after app click");

await page.locator('.p5-compose input[aria-label="Message"]').fill("again");
await page.getByRole("button", { name: "SEND" }).click();
await page.waitForSelector(".p5-row--typing .p5-dots i", { timeout: 4000 });
await page.waitForSelector('.mona-stage[data-action="look"]', { timeout: 12000 });
await page.waitForFunction(() => !document.querySelector(".p5-row--typing"), { timeout: 12000 });
const beforeNext = await page.evaluate(() => Boolean(document.querySelector(".mona-stage")));
if (!beforeNext) throw new Error("highlight gone before the next prompt");
await page.locator('.p5-compose input[aria-label="Message"]').fill("next prompt");
await page.getByRole("button", { name: "SEND" }).click();
const afterPrompt = await page.evaluate(() => Boolean(document.querySelector(".mona-stage")));
console.log("afterPromptStage", afterPrompt);
if (afterPrompt) throw new Error("highlight survived the next prompt");

await browser.close();
console.log("ok mona think + hold");
