import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const base = process.env.L12_URL || "http://127.0.0.1:3000";
const api = process.env.L12_API || "http://127.0.0.1:8001";
const email = process.env.L12_EMAIL || "test@test";
const password = process.env.L12_PASSWORD || "test";
const outDir = join(process.cwd(), "..", "screenshots");
mkdirSync(outDir, { recursive: true });

const scratch = {
  id: "job-scratch",
  name: "Scratch · L11 sanity on GB300-01",
  kind: "sanity",
  status: "running",
  doing: "Checking N1 firmware.",
  rack: "GB300-01",
  minion: "Scratch",
  mission: "L11 sanity on GB300-01",
  briefing: "Scratch. L11 sanity on GB300-01. Don't come back until it's done.",
  log: ["12:01:02  Scratch reporting. Mission: L11 sanity on GB300-01", "12:01:08  Checking N1 firmware."],
  chat: [
    {
      id: "c1",
      kind: "sys",
      text: "Mona: Scratch. L11 sanity on GB300-01. Don't come back until it's done.",
      at: "2026-10-16T12:01:00Z",
    },
    { id: "c2", kind: "say", text: "Scratch reporting. Mission: L11 sanity on GB300-01.", at: "2026-10-16T12:01:02Z" },
    { id: "c3", kind: "say", text: "Checking N1 firmware.", at: "2026-10-16T12:01:08Z" },
  ],
};

const whisk = {
  id: "job-whisk",
  name: "Whisk · Argus dcgm-diag",
  kind: "argus",
  status: "done",
  doing: "reported",
  minion: "Whisk",
  mission: "Argus dcgm-diag",
  briefing: "Go, Whisk. Argus dcgm-diag. I'll be watching.",
  debrief: null,
  debrief_id: null,
  log: ["launched dcgm-diag", "Mission complete. Handing this to Mona."],
  chat: [
    { id: "w1", kind: "sys", text: "Mona: Go, Whisk. Argus dcgm-diag. I'll be watching.", at: "2026-10-16T12:00:00Z" },
    { id: "w2", kind: "say", text: "Whisk reporting. Mission: Argus dcgm-diag.", at: "2026-10-16T12:00:01Z" },
    { id: "w3", kind: "say", text: "Mission complete. Handing this to Mona.", at: "2026-10-16T12:04:00Z" },
  ],
};

const pack = {
  jobs: [scratch, whisk],
  running: 1,
};

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

await page.route("**/api/agent/jobs", async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pack) });
    return;
  }
  await route.continue();
});

await page.route("**/api/agent/chat", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      reply: `Limiter 404. Try one of these.
highlight_ui
target="overview"
label="cluster health"
action="look"`,
      choices: [
        {
          label: "Retry 2.0 kW cap",
          tool: "set_power_cap",
          arguments: { budget_kw: 2 },
          hint: "PATCH /api/cluster/power",
        },
      ],
      ui: [
        { kind: "highlight", action: "look", target: "overview", label: "cluster health" },
        { kind: "agents" },
      ],
      mutated: false,
    }),
  });
});

await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((token) => localStorage.setItem("po_calendar_token", token), access_token);
await page.goto(`${base}/cluster`, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: "nextjs-portal,#__next-build-watcher{display:none!important}" });
await page.waitForSelector('[data-mona="health"]', { timeout: 20000 });

await page.locator(".p5-fab").click({ force: true });
await page.waitForSelector(".p5-im", { timeout: 8000 });
await page.waitForSelector(".p5-agent-tab", { timeout: 4000 });

await page.locator('.p5-compose input[aria-label="Message"]').fill("show cluster health");
await page.getByRole("button", { name: "SEND" }).click();
await page.waitForFunction(() => !document.querySelector(".p5-row--typing"), { timeout: 12000 });

const leak = await page.evaluate(() => {
  const bubbles = [...document.querySelectorAll(".p5-row--assistant .p5-bubble-in p")].map((el) => el.textContent || "");
  return {
    bubbles,
    leaked: bubbles.some((t) => /highlight_ui|target="overview"|action="look"/.test(t)),
  };
});
console.log("bubbles", JSON.stringify(leak));
if (leak.leaked) throw new Error("leaked highlight_ui still showing in the chat bubble");

await page.waitForSelector('.mona-stage[data-action="look"]', { timeout: 12000 });
await page.waitForSelector(".p5-agents-drawer[data-open='true']", { timeout: 8000 });
const menu = await page.evaluate(() => {
  const drawer = document.querySelector(".p5-agents-drawer");
  const running = document.querySelector('.p5-agent[data-status="running"]');
  return {
    open: drawer?.getAttribute("data-open") === "true",
    name: running?.querySelector("strong")?.textContent || "",
    doing: running?.querySelector("span")?.textContent || "",
    live: document.querySelector(".p5-agent-tab")?.getAttribute("data-live"),
    idle: document.querySelector(".p5-agents-drawer .p5-con-head small")?.textContent || "",
  };
});
console.log("agents", JSON.stringify(menu));
if (!menu.open) throw new Error("AGENTS drawer did not open");
if (!/Scratch/.test(menu.name)) throw new Error(`expected Scratch, got ${menu.name}`);
if (!/Checking N1 firmware/.test(menu.doing)) throw new Error(`expected doing line, got ${menu.doing}`);
if (menu.live !== "true") throw new Error("AGENTS tab missing live badge");
if (!/on a job/.test(menu.idle)) throw new Error(`expected crew on a job, got ${menu.idle}`);

await page.screenshot({ path: join(outDir, "mona-agents-roster.png") });
await page.locator(".p5-agent-hit").first().click();
await page.waitForSelector(".p5-agent-thread .p5-row--assistant", { timeout: 4000 });
await page.waitForTimeout(500);
const chat = await page.evaluate(() => {
  const head = document.querySelector(".p5-agent-chat-head")?.getBoundingClientRect();
  const thread = document.querySelector(".p5-agent-thread")?.getBoundingClientRect();
  const rail = document.querySelector(".p5-agent-thread .p5-rail")?.getBoundingClientRect();
  const who = document.querySelector(".p5-agent-who strong")?.textContent || "";
  const rows = [...document.querySelectorAll(".p5-agent-thread .p5-row--assistant")].map((el) => {
    const bubble = el.querySelector(".p5-bubble")?.getBoundingClientRect();
    return {
      text: (el.querySelector(".p5-bubble-in p")?.textContent || "").trim(),
      top: bubble ? Math.round(bubble.top) : null,
      visible: bubble ? bubble.top >= (head?.bottom || 0) - 8 && bubble.height > 8 : false,
    };
  });
  return {
    chat: document.querySelector(".p5-agents-drawer")?.getAttribute("data-chat") === "true",
    who,
    rows: rows.map((r) => r.text),
    layout: rows,
    headBottom: head ? Math.round(head.bottom) : null,
    threadTop: thread ? Math.round(thread.top) : null,
    railTop: rail ? Math.round(rail.top) : null,
    typing: Boolean(document.querySelector(".p5-agent-thread .p5-row--typing")),
    logDump: Boolean(document.querySelector(".p5-agent-log")),
    face: document.querySelectorAll(".p5-agent-thread .p5-face").length,
  };
});
console.log("agentChat", JSON.stringify(chat));
if (!chat.chat) throw new Error("agent console did not pop up");
if (chat.logDump) throw new Error("old log dump still showing");
if (!/Scratch/.test(chat.who)) throw new Error(`expected Scratch on the radio, got ${chat.who}`);
if (!chat.rows.some((t) => /Mona:.*Scratch/.test(t))) {
  throw new Error(`expected Mona briefing, got ${chat.rows.join(" | ")}`);
}
if (!chat.rows.some((t) => /Checking N1 firmware/.test(t))) {
  throw new Error(`expected firmware bubble, got ${chat.rows.join(" | ")}`);
}
if (!chat.layout?.some((r) => /Checking N1 firmware|Scratch reporting/.test(r.text) && r.visible)) {
  throw new Error(`live radio bubble clipped ${JSON.stringify(chat.layout)}`);
}
if (!chat.typing) throw new Error("running agent missing thinking dots");
if (chat.face < 2) throw new Error("agent chat missing Mona faces");

const choice = await page.evaluate(() => {
  const btn = document.querySelector(".p5-choice");
  const group = document.querySelector(".p5-choices");
  const compose = document.querySelector(".p5-im .p5-compose");
  const im = document.querySelector(".p5-im");
  const thread = document.querySelector(".p5-im .p5-thread");
  const box = btn?.getBoundingClientRect();
  const wrap = group?.getBoundingClientRect();
  const bar = compose?.getBoundingClientRect();
  const panel = im?.getBoundingClientRect();
  const rail = thread?.getBoundingClientRect();
  const label = (btn?.querySelector("span")?.textContent || "").trim();
  return {
    label,
    kicker: (document.querySelector(".p5-choices-kicker")?.textContent || "").trim(),
    parent: group?.parentElement?.className || "",
    top: box ? Math.round(box.top) : null,
    bottom: box ? Math.round(box.bottom) : null,
    height: box ? Math.round(box.height) : null,
    wrapTop: wrap ? Math.round(wrap.top) : null,
    wrapBottom: wrap ? Math.round(wrap.bottom) : null,
    composeTop: bar ? Math.round(bar.top) : null,
    threadBottom: rail ? Math.round(rail.bottom) : null,
    imLeft: panel ? Math.round(panel.left) : null,
    left: box ? Math.round(box.left) : null,
  };
});
console.log("choice", JSON.stringify(choice));
if (!/Retry 2\.0 kW cap/.test(choice.label)) throw new Error(`choice label clipped: ${choice.label}`);
if (choice.kicker !== "SELECT") throw new Error(`missing SELECT kicker, got ${choice.kicker}`);
if (!choice.height || choice.height < 36) throw new Error(`choice too short ${choice.height}`);
if (choice.bottom && choice.composeTop && choice.bottom > choice.composeTop + 8) {
  throw new Error(`choice overlapping compose ${choice.bottom} > ${choice.composeTop}`);
}
if (choice.left && choice.imLeft && choice.left < choice.imLeft - 2) {
  throw new Error(`choice clipped off the IM left ${choice.left} < ${choice.imLeft}`);
}
const imBox = await page.locator(".p5-im").boundingBox();
if (choice.left && imBox && choice.height) {
  const chip = await page.locator(".p5-choice").first().boundingBox();
  if (chip && chip.width > imBox.width - 12) {
    throw new Error(`choice is a full-width block ${chip.width} >= ${imBox.width}`);
  }
}
await page.locator(".p5-choices-toggle").click();
await page.waitForFunction(() => !document.querySelector(".p5-choice"), { timeout: 3000 });
await page.locator(".p5-choices-toggle").click();
await page.waitForSelector(".p5-choice", { timeout: 3000 });

whisk.debrief = "Whisk is back. Argus dcgm-diag came back clean. I read it.";
whisk.debrief_id = "db-whisk";
whisk.chat = [
  ...whisk.chat,
  { id: "w4", kind: "sys", text: `Mona: ${whisk.debrief}`, at: "2026-10-16T12:04:08Z" },
];

await page.waitForFunction(
  () => [...document.querySelectorAll(".p5-im .p5-bubble-in p")].some((el) => /Whisk is back/.test(el.textContent || "")),
  { timeout: 8000 }
);

const report = await page.evaluate(() => {
  const bubbles = [...document.querySelectorAll(".p5-im .p5-row--assistant .p5-bubble-in p")].map(
    (el) => el.textContent || ""
  );
  const label = (document.querySelector(".p5-choice span")?.textContent || "").trim();
  return { bubbles, label, kicker: (document.querySelector(".p5-choices-kicker")?.textContent || "").trim() };
});
console.log("debrief", JSON.stringify(report));
if (!report.bubbles.some((t) => /Whisk is back/.test(t))) throw new Error("Mona did not report Whisk's result in IM");
if (!/See Whisk/.test(report.label)) throw new Error(`expected See Whisk, got ${report.label}`);

await page.locator(".p5-choice").click();
await page.waitForFunction(
  () => document.querySelector(".p5-agent-who strong")?.textContent?.includes("Whisk"),
  { timeout: 4000 }
);
const radio = await page.evaluate(() => {
  const who = document.querySelector(".p5-agent-who strong")?.textContent || "";
  const status = document.querySelector(".p5-agent-who small")?.textContent || "";
  const rows = [...document.querySelectorAll(".p5-agent-thread .p5-row--assistant .p5-bubble-in p")].map(
    (el) => (el.textContent || "").trim()
  );
  return { who, status, rows, chat: document.querySelector(".p5-agents-drawer")?.getAttribute("data-chat") };
});
console.log("seeMinion", JSON.stringify(radio));
if (radio.chat !== "true") throw new Error("See Whisk did not open the radio");
if (!/Whisk/.test(radio.who)) throw new Error(`expected Whisk, got ${radio.who}`);
if (!radio.rows.some((t) => /Mona:.*Whisk is back/.test(t))) {
  throw new Error(`expected Mona review on Whisk radio, got ${radio.rows.join(" | ")}`);
}

await page.screenshot({ path: join(outDir, "mona-agents-menu.png") });
await browser.close();
console.log("ok mona minions + debrief in IM");
