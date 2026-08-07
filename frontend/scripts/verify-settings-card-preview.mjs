/**
 * Compare the Settings live card preview against the real drawer card editor.
 *
 * The preview renders the same <CardEditor> at the drawer's own width and scales
 * the whole stage to fit the pane, so every measurement below is divided by that
 * scale before it is compared: the two cards must agree in *layout* terms, not
 * in painted pixels.
 *
 * Usage (API + Next running):
 *   node scripts/verify-settings-card-preview.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SHOTS = path.join(ROOT, "screenshots");
const BASE = process.env.APP_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:8000";
const ADMIN = {
  email: process.env.PO_EMAIL ?? "trile0104@gmail.com",
  password: process.env.PO_PASSWORD ?? "tvm-temp-2026",
};

const WIDTHS = [1440, 1024, 640, 420];
/** rem-relative slack: sub-pixel rounding and one-off borders, nothing more. */
const TOLERANCE = 2;

fs.mkdirSync(SHOTS, { recursive: true });

async function apiLogin() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  return (await res.json()).access_token;
}

async function getBoard(token) {
  const res = await fetch(`${API}/api/settings/board`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET board ${res.status}`);
  return res.json();
}

/** Every rectangle worth comparing, read off one `.jobcard` and normalised by
 *  `scale` so a scaled preview and a full-size drawer are talking about the
 *  same numbers. */
const MEASURE = ({ selector, scale }) => {
  const card = document.querySelector(selector);
  if (!card) return { error: `no ${selector}` };
  const base = card.getBoundingClientRect();
  const at = (sel, root = card) => {
    const el = root.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round((r.width / scale) * 100) / 100,
      h: Math.round((r.height / scale) * 100) / 100,
      x: Math.round(((r.left - base.left) / scale) * 100) / 100,
      y: Math.round(((r.top - base.top) / scale) * 100) / 100,
    };
  };
  const rows = Array.from(card.querySelectorAll(".spec > .spec-pair"));
  const label = rows[0]?.querySelector("dt");
  return {
    card: {
      w: Math.round((base.width / scale) * 100) / 100,
      h: Math.round((base.height / scale) * 100) / 100,
    },
    head: at(".jobcard-head"),
    wells: at(".card-wells"),
    thumb: at(".thumb-drop"),
    model: at(".model-drop"),
    spec: at(".spec"),
    labelTrack: label
      ? {
          w: Math.round((label.getBoundingClientRect().width / scale) * 100) / 100,
        }
      : null,
    footer: at(".jobcard-status"),
    note: at(".jobcard-note"),
    rows: rows.length,
    labels: rows.map((r) => r.querySelector("dt")?.textContent?.trim() ?? ""),
    /** a wrapped label spans more than one line box — the original bug, counted
     *  off the text itself rather than off the padded cell around it */
    wrappedLabels: rows
      .map((r) => r.querySelector("dt"))
      .filter((dt) => {
        if (!dt) return false;
        const range = document.createRange();
        range.selectNodeContents(dt);
        return range.getClientRects().length > 1;
      })
      .map((dt) => dt.textContent.trim()),
    hasImageWell: !!card.querySelector(".thumb-drop"),
    hasModelStrip: !!card.querySelector(".model-drop"),
    modelText: card.querySelector(".model-drop")?.textContent?.trim() ?? null,
  };
};

function compare(width, actual, preview) {
  const checks = [];
  const pair = (name, a, b) => {
    if (a == null || b == null) {
      checks.push({ name, ok: a == null && b == null, actual: a, preview: b });
      return;
    }
    checks.push({
      name,
      ok: Math.abs(a - b) <= TOLERANCE,
      actual: Math.round(a * 100) / 100,
      preview: Math.round(b * 100) / 100,
      delta: Math.round((b - a) * 100) / 100,
    });
  };

  pair("card width", actual.card.w, preview.card.w);
  pair("head height", actual.head?.h, preview.head?.h);
  pair("media column width", actual.wells?.w, preview.wells?.w);
  pair("image well height", actual.thumb?.h, preview.thumb?.h);
  pair("model strip height", actual.model?.h, preview.model?.h);
  pair("spec width", actual.spec?.w, preview.spec?.w);
  pair("spec x", actual.spec?.x, preview.spec?.x);
  pair("label track width", actual.labelTrack?.w, preview.labelTrack?.w);
  pair("footer height", actual.footer?.h, preview.footer?.h);
  pair("row count", actual.rows, preview.rows);

  const failures = checks.filter((c) => !c.ok);
  console.log(`\n=== ${width}px ===`);
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(20)} actual=${String(c.actual).padStart(8)}` +
        ` preview=${String(c.preview).padStart(8)}` +
        (c.delta === undefined ? "" : ` Δ=${c.delta}`),
    );
  }
  console.log(`  preview scale       ${preview.scale}`);
  console.log(`  wells present       image=${preview.hasImageWell} model=${preview.hasModelStrip}`);
  console.log(`  model strip text    ${JSON.stringify(preview.modelText)}`);
  console.log(`  wrapped labels      actual=${JSON.stringify(actual.wrappedLabels)} preview=${JSON.stringify(preview.wrappedLabels)}`);
  if (actual.labels.join("|") !== preview.labels.join("|")) {
    console.log(`  note: label sets differ (sample PO vs sample data) — order still compared`);
    console.log(`        actual=${JSON.stringify(actual.labels)}`);
    console.log(`        preview=${JSON.stringify(preview.labels)}`);
  }
  return failures;
}

async function main() {
  const token = await apiLogin();
  const before = await getBoard(token);
  const originalJson = JSON.stringify(before.document);

  const browser = await chromium.launch({ headless: true });
  const results = {};
  let failed = 0;

  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(
      (t) => window.localStorage.setItem("po_calendar_token", t),
      token,
    );
    const page = await context.newPage();

    // --- the real thing: the drawer's card editor ------------------------
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    // a cold dev server can spend a while compiling before the rows arrive
    await page.locator(".dash-row").first().waitFor({ timeout: 60_000 });
    await page.locator(".dash-row").first().click();
    await page.locator(".drawer .jobcard-edit").waitFor();
    await page.waitForTimeout(600);
    const actual = await page.evaluate(MEASURE, {
      selector: ".drawer .jobcard-edit",
      scale: 1,
    });
    if (actual.error) throw new Error(`drawer: ${actual.error}`);
    await page
      .locator(".drawer")
      .screenshot({ path: path.join(SHOTS, `card-preview-${width}-actual.png`) });
    await page.keyboard.press("Escape");

    // --- the preview ----------------------------------------------------
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await page.locator(".settings-preview .card-stage .jobcard-edit").waitFor();
    await page.waitForTimeout(600);
    const scale = await page.evaluate(() => {
      const stage = document.querySelector(".settings-preview .card-stage");
      return Number(getComputedStyle(stage).getPropertyValue("--card-stage-scale")) || 1;
    });
    const preview = await page.evaluate(MEASURE, {
      selector: ".settings-preview .jobcard-edit",
      scale,
    });
    if (preview.error) throw new Error(`preview: ${preview.error}`);
    preview.scale = Math.round(scale * 1000) / 1000;
    await page
      .locator(".settings-preview")
      .screenshot({ path: path.join(SHOTS, `card-preview-${width}-preview.png`) });
    await page.screenshot({
      path: path.join(SHOTS, `card-preview-${width}-settings.png`),
      fullPage: true,
    });

    // --- overflow: the stage must not push the page sideways -------------
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stage: (() => {
        const s = document.querySelector(".settings-preview .card-stage");
        return s ? s.scrollWidth - s.clientWidth : 0;
      })(),
      pane: (() => {
        const p = document.querySelector(".settings-preview");
        return p ? p.scrollWidth - p.clientWidth : 0;
      })(),
    }));

    const failures = compare(width, actual, preview);
    console.log(
      `  overflow            page=${overflow.doc}px pane=${overflow.pane}px stage=${overflow.stage}px`,
    );
    if (overflow.doc > 1) {
      failures.push({ name: "page overflow", actual: 0, preview: overflow.doc });
      console.log(`  FAIL page overflows horizontally by ${overflow.doc}px`);
    }
    if (!preview.hasImageWell || !preview.hasModelStrip) {
      failures.push({ name: "media wells", actual: "both", preview: "missing" });
    }
    failed += failures.length;
    results[width] = { actual, preview, overflow, failures };

    await context.close();
  }

  // --- one image with both cards in it, for reading at a glance ------------
  const sideBySide = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  const asData = (file) =>
    `data:image/png;base64,${fs.readFileSync(path.join(SHOTS, file)).toString("base64")}`;
  await sideBySide.setContent(`
    <body style="margin:0;font:13px system-ui;background:#e9edf0;display:flex;gap:16px;padding:16px">
      <figure style="margin:0;flex:1 1 0;min-width:0">
        <figcaption style="font-weight:700;margin-bottom:6px">Actual drawer</figcaption>
        <img src="${asData(`card-preview-${WIDTHS[0]}-actual.png`)}" style="width:100%">
      </figure>
      <figure style="margin:0;flex:1 1 0;min-width:0">
        <figcaption style="font-weight:700;margin-bottom:6px">Settings preview</figcaption>
        <img src="${asData(`card-preview-${WIDTHS[0]}-preview.png`)}" style="width:100%">
      </figure>
    </body>`);
  await sideBySide.waitForTimeout(300);
  await sideBySide.screenshot({ path: path.join(SHOTS, "card-preview-sidebyside.png") });

  await browser.close();

  const after = await getBoard(token);
  if (JSON.stringify(after.document) !== originalJson) {
    throw new Error("board settings changed — expected untouched (nothing was saved)");
  }
  console.log("\nboard settings unchanged (nothing saved)");

  fs.writeFileSync(
    path.join(SHOTS, "card-preview-parity.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`wrote screenshots/card-preview-parity.json`);
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
