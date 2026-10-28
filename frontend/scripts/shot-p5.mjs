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
await page.evaluate(() => {
  sessionStorage.removeItem("l12-mona-chat");
  sessionStorage.removeItem("l12-mona-chat-2");
  sessionStorage.removeItem("l12-p5-chat");
  localStorage.removeItem("l12-mona-fab");
});
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector(".p5-fab", { timeout: 20000 });
await page.waitForSelector(".p5-quip", { timeout: 8000 });
await page.waitForTimeout(700);
await page.screenshot({ path: join(outDir, "p5-fab.png"), fullPage: false });

const quip = await page.locator(".p5-quip").innerText();
const fabVisible = await page.locator(".p5-fab").isVisible();
console.log("hover", JSON.stringify({ quip, fabVisible }));

await page.addStyleTag({ content: ".p5-fab,.p5-fab img{animation:none!important}" });
const fabBox = await page.locator(".p5-fab").boundingBox();
if (!fabBox) throw new Error("no fab box");
await page.mouse.move(fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2);
await page.mouse.down();
await page.mouse.move(fabBox.x - 260, fabBox.y - 110, { steps: 12 });
await page.mouse.up();
const dragInfo = await page.locator(".p5-fab").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { placed: el.getAttribute("data-placed"), x: Math.round(r.x), y: Math.round(r.y) };
});
console.log("drag", JSON.stringify(dragInfo));
if (dragInfo.placed !== "true") throw new Error("fab did not relocate");
const edge = page.locator(".p5-fab");
const after = await edge.boundingBox();
if (!after) throw new Error("no fab after drag");
await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
await page.mouse.down();
await page.mouse.move(1400, after.y + after.height / 2, { steps: 10 });
await page.mouse.up();
const quipFit = await page.locator(".p5-quip").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    right: Math.round(r.right),
    top: Math.round(r.top),
    vw: window.innerWidth,
    vh: window.innerHeight,
    text: (el.textContent || "").trim(),
  };
});
console.log("quipFit", JSON.stringify(quipFit));
if (quipFit.right > quipFit.vw + 1) throw new Error(`quip cropped right: ${JSON.stringify(quipFit)}`);
if (quipFit.left < -1) throw new Error(`quip cropped left: ${JSON.stringify(quipFit)}`);
if (quipFit.top < -1) throw new Error(`quip cropped top: ${JSON.stringify(quipFit)}`);
await page.screenshot({ path: join(outDir, "p5-fab-moved.png"), fullPage: false });
await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.waitForSelector(".p5-spine-draw", { timeout: 8000 });
await page.waitForTimeout(180);
await page.screenshot({ path: join(outDir, "p5-trail.png"), fullPage: false });
await page.waitForSelector('.p5-spine[data-trail="done"]', { timeout: 8000 });
await page.waitForTimeout(200);
await page.screenshot({ path: join(outDir, "p5-open.png"), fullPage: false });

const prompts = await page.locator(".p5-prompts button").count();
const welcome = await page.locator(".p5-row--assistant").count();
const header = await page.locator(".p5-who strong").innerText();
const sub = await page.locator(".p5-who small").innerText();
const catStillUp = await page.locator(".p5-fab").isVisible();
if (catStillUp) throw new Error("cat FAB should hide while chat is open");
const quipHidden = (await page.locator(".p5-quip").count()) === 0;
const asstFace = await page.locator(".p5-row--assistant .p5-face img").first().getAttribute("src");
const panel = await page.locator(".p5-im").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), w: Math.round(r.width), vw: window.innerWidth };
});
console.log("open", JSON.stringify({ prompts, welcome, header, sub, catStillUp, quipHidden, asstFace, panel }));
if (/grok-4\.7|grok/i.test(sub)) throw new Error(`model shown in header: ${sub}`);
if (!/^(online|offline)$/i.test(sub.trim())) throw new Error(`status not online/offline: ${sub}`);
if (panel.w > 420) throw new Error(`panel too wide: ${panel.w}`);
if (panel.x < panel.vw * 0.4) throw new Error(`panel not on the right: ${JSON.stringify(panel)}`);

await page.locator(".p5-compose input").fill("What's the cluster health?");
await page.locator(".p5-compose button").click();
await page.waitForSelector(".p5-row--user", { timeout: 8000 });
await page.waitForFunction(
  () =>
    [...document.querySelectorAll(".p5-row--assistant p")].some((p) =>
      /Grok key|Settings|cluster|health|Heh|Mona/i.test(p.textContent || ""),
    ) && !document.querySelector(".p5-row--typing"),
  { timeout: 60000 },
);
await page.waitForSelector('.p5-spine[data-trail="done"]', { timeout: 8000 });
await page.waitForSelector(".p5-choice", { timeout: 15000 });
await page.waitForTimeout(200);
await page.screenshot({ path: join(outDir, "p5-reply.png"), fullPage: false });
const last = await page.locator(".p5-row--assistant p").last().innerText();
const userFace = await page.locator(".p5-row--user .p5-face").first().innerHTML();
const choiceLabels = await page.locator(".p5-choice").allInnerTexts();
console.log("reply", last);
console.log("userFace", userFace.slice(0, 180));
console.log("choices", JSON.stringify(choiceLabels));
const safe = page.locator(".p5-choice").filter({ hasText: /list tests|health|nodes|logs|read bmc/i }).first();
if (await safe.count()) {
  await safe.click();
  await page.waitForFunction(() => !document.querySelector(".p5-row--typing"), { timeout: 60000 });
  await page.waitForSelector(".p5-choice", { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "p5-choice.png"), fullPage: false });
  const after = await page.locator(".p5-row--assistant p").last().innerText();
  console.log("choiceReply", after);
}

await page.keyboard.press("Escape");
await page.waitForSelector(".p5-im", { state: "hidden", timeout: 5000 }).catch(() => {});
const closed = await page.locator(".p5-im").count();
console.log("escaped", closed === 0);

const seeded = [
  { id: "s1", role: "assistant", text: "Heh. One rack, and it's fine. Leave it to me!", at: Date.now() - 40000 },
  {
    id: "s2",
    role: "assistant",
    text: "**GB300-Temp** in hall Live. Cluster name is Tri-Test. Model GB300-NVL72, one node, BMC 10.43.143.98, power on.",
    at: Date.now() - 30000,
  },
  {
    id: "s3",
    role: "assistant",
    text: "Leak dry, 4/4 detectors. Hottest GPU inlet 47°C (GPU 3). Board hottest is BF3 Slot 1 at 63°C. Fans 8/8, avg 17.1k RPM. PSU 1.39 kW. Power shelf 1/1 OK, 4/4 CBC.",
    at: Date.now() - 20000,
  },
  { id: "s4", role: "assistant", text: "Nothing crying for help. Want a test launched?", at: Date.now() - 10000 },
  { id: "s5", role: "user", text: "What's the cluster health?", at: Date.now() - 5000 },
  {
    id: "s6",
    role: "assistant",
    text: "Still dry. Hottest inlet 47°C. Fans 8/8. Pulling 1.39 kW. Leave it to me!",
    at: Date.now() - 1000,
  },
];
await page.evaluate((lines) => {
  sessionStorage.setItem("l12-mona-chat-2", JSON.stringify(lines));
}, seeded);
await page.reload({ waitUntil: "domcontentloaded" });
await page.addStyleTag({
  content: "nextjs-portal,#__next-build-watcher{display:none!important}.p5-fab,.p5-fab img{animation:none!important}",
});
await page.waitForSelector(".p5-fab", { timeout: 15000 });
await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.waitForSelector(".p5-spine-draw", { timeout: 8000 });
await page.waitForSelector('.p5-spine[data-trail="done"]', { timeout: 8000 });
await page.waitForTimeout(200);
const railInfo = await page.evaluate(() => {
  const thread = document.querySelector(".p5-thread");
  const rail = document.querySelector(".p5-rail");
  const spine = document.querySelector(".p5-spine");
  const draw = document.querySelector(".p5-spine-draw");
  const texts = [...document.querySelectorAll(".p5-bubble p")].map((p) => p.textContent || "");
  const d = draw?.getAttribute("d") || "";
  let len = 0;
  try {
    len = draw && "getTotalLength" in draw ? draw.getTotalLength() : 0;
  } catch {
    len = 0;
  }
  return {
    threadH: thread ? thread.clientHeight : 0,
    railH: rail ? rail.scrollHeight : 0,
    spineH: spine ? spine.getBoundingClientRect().height : 0,
    trail: spine?.getAttribute("data-trail") || "",
    pathLen: Math.round(len),
    pathBits: d.length,
    hasMarkdown: texts.some((t) => t.includes("**")),
    gb300: texts.find((t) => /GB300/i.test(t)) || "",
    rows: document.querySelectorAll(".p5-row").length,
  };
});
console.log("rail", JSON.stringify(railInfo));
if (railInfo.hasMarkdown) throw new Error("markdown asterisks still visible");
if (railInfo.spineH < 80) throw new Error(`spine too short: ${railInfo.spineH}`);
if (railInfo.pathLen < 80) throw new Error(`trail path too short: ${railInfo.pathLen}`);
if (railInfo.trail !== "done") throw new Error(`trail not finished: ${railInfo.trail}`);
await page.locator(".p5-thread").evaluate((el) => {
  el.scrollTop = Math.max(0, el.scrollHeight / 2);
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(outDir, "p5-rail.png"), fullPage: false });
await page.locator(".p5-x").click();
await page.waitForTimeout(300);

await page.goto(`${base}/cluster?tab=racks`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".cluster-tabs button[data-active='true']", { timeout: 15000 });
const activeTab = await page.locator(".cluster-tabs button[data-active='true']").innerText();
console.log("racksTab", activeTab.trim());
if (!/racks/i.test(activeTab)) throw new Error(`expected Racks tab, got ${activeTab}`);
if ((await page.locator("[data-mona='os-ip']").count()) === 0) {
  await page.locator(".cluster-register header button").click();
}
await page.waitForSelector("[data-mona='os-ip']", { timeout: 8000 });
await page.locator("[data-mona='os-ip']").fill("10.20.0.10");
const osVal = await page.locator("[data-mona='os-ip']").inputValue();
console.log("osFill", osVal);
await page.screenshot({ path: join(outDir, "p5-racks-ui.png"), fullPage: false });

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}.p5-fab,.p5-fab img{animation:none!important}" });
await page.waitForSelector(".p5-fab", { timeout: 15000 });
await page.waitForSelector(".p5-quip", { timeout: 8000 });
await page.screenshot({ path: join(outDir, "p5-mobile.png"), fullPage: false });
await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.waitForSelector('.p5-spine[data-trail="done"]', { timeout: 8000 });
await page.waitForTimeout(200);
await page.screenshot({ path: join(outDir, "p5-mobile-open.png"), fullPage: false });

await page.goto(`${base}/maxlps`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: ".p5-fab,.p5-fab img{animation:none!important}" });
await page.waitForSelector(".p5-fab", { timeout: 15000 });
await page.waitForSelector(".p5-quip", { timeout: 8000 });
const maxlpsQuip = await page.locator(".p5-quip").innerText();
console.log("maxlpsQuip", maxlpsQuip);

await browser.close();
