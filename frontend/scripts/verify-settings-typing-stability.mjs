/**
 * Measure how stable the Settings live preview is while typing.
 *
 * For each scenario it records, over the whole typing burst:
 *   - anim         : Element.animate() calls (FLIP slides) started inside the preview
 *   - animAll      : Element.animate() calls anywhere on the page
 *   - movedFrames  : animation frames where a tracked preview node's box moved >0.5px
 *   - maxDelta     : largest single-frame move of a tracked preview node (px)
 *   - detached     : tracked preview nodes that left the DOM (i.e. real remounts)
 *   - added/removed: childList mutations inside the preview
 *
 * Usage (API + Next running):
 *   node scripts/verify-settings-typing-stability.mjs --label before
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
const ADMIN = { email: "trile0104@gmail.com", password: "tvm-temp-2026" };

const labelArg = process.argv.indexOf("--label");
const LABEL = labelArg > -1 ? process.argv[labelArg + 1] : "run";
const TYPE_DELAY = 70;

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

const INSTRUMENT = () => {
  const stab = {
    anim: 0,
    animAll: 0,
    animIds: [],
  };
  window.__stab = stab;
  const original = Element.prototype.animate;
  Element.prototype.animate = function patched(...args) {
    try {
      stab.animAll += 1;
      if (this.closest && this.closest(".settings-preview")) {
        stab.anim += 1;
        stab.animIds.push(this.dataset?.flipId ?? this.tagName);
      }
    } catch {
      /* measurement must never break the app */
    }
    return original.apply(this, args);
  };

  window.__sampleStart = () => {
    const root = document.querySelector(".settings-preview");
    const nodes = Array.from(
      root.querySelectorAll("[data-flip-id], .settings-preview-kcol, .jobcard, h3, dt, dd, span"),
    );
    const read = () =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return [r.top, r.left, r.width];
      });
    const state = {
      nodes,
      running: true,
      frames: 0,
      movedFrames: 0,
      maxDelta: 0,
      prev: read(),
      mut: { added: 0, removed: 0 },
    };
    state.observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type !== "childList") continue;
        state.mut.added += rec.addedNodes.length;
        state.mut.removed += rec.removedNodes.length;
      }
    });
    state.observer.observe(root, { childList: true, subtree: true });

    stab.anim = 0;
    stab.animAll = 0;
    stab.animIds = [];

    const tick = () => {
      if (!state.running) return;
      const current = read();
      state.frames += 1;
      let worst = 0;
      let worstIndex = -1;
      for (let i = 0; i < current.length; i += 1) {
        const a = state.prev[i];
        const b = current[i];
        const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
        if (d > worst) {
          worst = d;
          worstIndex = i;
        }
      }
      if (worst > 0.5) state.movedFrames += 1;
      if (worst > state.maxDelta) {
        state.maxDelta = worst;
        const n = nodes[worstIndex];
        state.worstNode = `${n.tagName.toLowerCase()}.${String(n.className || "").split(" ")[0]}` +
          `[${n.dataset?.flipId ?? ""}] "${(n.textContent || "").trim().slice(0, 24)}"`;
      }
      state.prev = current;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__sample = state;
  };

  window.__sampleStop = () => {
    const state = window.__sample;
    state.running = false;
    state.observer.disconnect();
    return {
      anim: stab.anim,
      animAll: stab.animAll,
      animIds: Array.from(new Set(stab.animIds)).slice(0, 6),
      frames: state.frames,
      movedFrames: state.movedFrames,
      maxDelta: Math.round(state.maxDelta * 100) / 100,
      worstNode: state.worstNode ?? null,
      tracked: state.nodes.length,
      detached: state.nodes.filter((n) => !document.contains(n)).length,
      added: state.mut.added,
      removed: state.mut.removed,
    };
  };
};

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|tasks|calendar|users|settings/);
}

/** Type into `locator` while sampling preview stability. */
async function measureTyping(page, locator, text, { clear = false } = {}) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  if (clear) await locator.fill("");
  await page.evaluate(() => window.__sampleStart());
  await locator.pressSequentially(text, { delay: TYPE_DELAY });
  await page.waitForTimeout(500); // let any late animation / debounce settle
  return page.evaluate(() => window.__sampleStop());
}

function report(name, m) {
  console.log(
    `${name.padEnd(26)} anim=${String(m.anim).padStart(4)} animAll=${String(m.animAll).padStart(4)}` +
      ` movedFrames=${String(m.movedFrames).padStart(3)}/${String(m.frames).padStart(3)}` +
      ` maxDelta=${String(m.maxDelta).padStart(6)}px detached=${m.detached}/${m.tracked}` +
      ` dom+${m.added}/-${m.removed}`,
  );
  if (m.maxDelta > 0) console.log(`   worst mover: ${m.worstNode}`);
}

/**
 * Card-field rows carry their name in an editable input, so Playwright's
 * `hasText` never sees it. Match on the input's live value, falling back to
 * row text for any row that still renders its name as plain text.
 */
async function fieldRow(page, name) {
  const rows = page.locator(".settings-editors > .settings-panel > ul.settings-list > li");
  const total = await rows.count();
  for (let i = 0; i < total; i += 1) {
    const row = rows.nth(i);
    const hit = await row.evaluate((el, wanted) => {
      const input = el.querySelector(".settings-list-label input, input.settings-field-name");
      if (input) return input.value.trim().toLowerCase() === wanted;
      const label = el.querySelector(".settings-list-label") ?? el;
      return (label.textContent ?? "").trim().toLowerCase().includes(wanted);
    }, name.toLowerCase());
    if (hit) return row;
  }
  throw new Error(`no settings field row named "${name}" (scanned ${total})`);
}

async function cancel(page) {
  const btn = page.getByRole("button", { name: "Cancel", exact: true });
  if (await btn.isEnabled()) await btn.click();
  await page.waitForTimeout(400);
}

async function main() {
  const token = await apiLogin();
  const before = await getBoard(token);
  const originalJson = JSON.stringify(before.document);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript(INSTRUMENT);
  await login(page);
  await page.goto(`${BASE}/settings`);
  await page.getByRole("heading", { name: "Board settings" }).waitFor();
  await page.waitForTimeout(600);

  const results = {};

  // --- A. status label -------------------------------------------------
  await page.getByRole("button", { name: "Statuses", exact: true }).click();
  const statusInput = page.locator(".settings-list input.cell-input").first();
  const statusOriginal = await statusInput.inputValue();
  results.statusLabel = await measureTyping(page, statusInput, "Zephyrous", { clear: true });
  report("A status label", results.statusLabel);
  const chipText = await page.locator(".settings-preview-chips").innerText();
  results.statusLabelLive = chipText.includes("Zephyrous");
  console.log(`   preview shows typed label: ${results.statusLabelLive}`);
  await page.screenshot({
    path: path.join(SHOTS, `typing-stability-${LABEL}-status.png`),
    fullPage: true,
  });
  await cancel(page);
  const restored = await statusInput.inputValue();
  if (restored !== statusOriginal) throw new Error("Cancel did not revert status label");

  // --- B. select option text -------------------------------------------
  await page.getByRole("button", { name: "Card fields", exact: true }).click();
  await page.getByRole("button", { name: /Inspection options/i }).click();
  await page.waitForTimeout(350);
  const optionInput = page
    .locator("li.settings-field-with-options")
    .filter({ has: page.getByRole("button", { name: /Inspection options/i }) })
    .locator(".settings-options-list input.cell-input")
    .first();
  results.optionText = await measureTyping(page, optionInput, "Quaternion", { clear: true });
  report("B select option text", results.optionText);
  await page.screenshot({
    path: path.join(SHOTS, `typing-stability-${LABEL}-option.png`),
    fullPage: true,
  });
  await cancel(page);

  // --- C. dashboard width ----------------------------------------------
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.waitForTimeout(250);
  const widthInput = page.locator("input.settings-width-input").nth(1);
  const widthOriginal = await widthInput.inputValue();
  results.width = await measureTyping(page, widthInput, "14.5", { clear: true });
  report("C dashboard width", results.width);
  results.widthValue = await widthInput.inputValue();
  console.log(`   width input kept typed text: ${results.widthValue === "14.5"} (${results.widthValue})`);
  await page.screenshot({
    path: path.join(SHOTS, `typing-stability-${LABEL}-width.png`),
    fullPage: true,
  });
  await cancel(page);
  if ((await widthInput.inputValue()) !== widthOriginal) {
    throw new Error("Cancel did not revert dashboard width");
  }

  // --- D. tone hex ------------------------------------------------------
  await page.getByRole("button", { name: "Statuses", exact: true }).click();
  await page.waitForTimeout(250);
  const hexInput = page.locator("input.settings-tone-hex").first();
  results.hex = await measureTyping(page, hexInput, "#3366cc", { clear: true });
  report("D tone hex", results.hex);
  results.hexValue = await hexInput.inputValue();
  console.log(`   hex input kept typed text: ${results.hexValue === "#3366cc"} (${results.hexValue})`);
  await cancel(page);

  // --- E. reorder must still animate -----------------------------------
  await page.getByRole("button", { name: "Card fields", exact: true }).click();
  await page.waitForTimeout(300);
  const rows = page.locator(".settings-editors > .settings-panel > ul.settings-list > li");
  const firstKeyBefore = await rows.nth(0).getAttribute("data-reorder-id");
  const handle = rows.nth(0).locator(".settings-drag-handle");
  const from = await handle.boundingBox();
  const target = await rows.nth(2).boundingBox();
  await page.evaluate(() => window.__sampleStart());
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(
      from.x + from.width / 2,
      from.y + from.height / 2 + ((target.y + target.height / 2 - from.y - from.height / 2) * i) / 8,
    );
    await page.waitForTimeout(35);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  results.reorder = await page.evaluate(() => window.__sampleStop());
  report("E drag reorder", results.reorder);
  const firstKeyAfter = await rows.nth(0).getAttribute("data-reorder-id");
  results.reorderMoved = firstKeyBefore !== firstKeyAfter;
  console.log(`   order changed: ${results.reorderMoved} (${firstKeyBefore} -> ${firstKeyAfter})`);
  await page.screenshot({
    path: path.join(SHOTS, `typing-stability-${LABEL}-reorder.png`),
    fullPage: true,
  });
  await cancel(page);

  // --- F0. structural + colour edits must not wait for the text debounce
  await page.getByRole("button", { name: "Card fields", exact: true }).click();
  await page.waitForTimeout(300);
  const previewRows = page.locator(".settings-preview .spec .spec-pair");
  const rowsBefore = await previewRows.count();
  const qtyRow = await fieldRow(page, "Qty");
  await qtyRow.locator("input[type=checkbox]").click();
  await page.waitForTimeout(60);
  results.toggleImmediate = (await previewRows.count()) !== rowsBefore;
  console.log(`F0 hide-field reaches preview within 60ms: ${results.toggleImmediate}`);
  await cancel(page);

  await page.getByRole("button", { name: "Statuses", exact: true }).click();
  await page.waitForTimeout(250);
  const firstChip = page.locator(".settings-preview-chips .settings-status-chip").first();
  const toneBefore = await firstChip.evaluate((el) => getComputedStyle(el).color);
  await hexInput.click();
  await hexInput.fill("#ff00aa");
  await page.waitForTimeout(60);
  const toneAfter = await firstChip.evaluate((el) => getComputedStyle(el).color);
  results.colorImmediate = toneBefore !== toneAfter;
  console.log(`   colour reaches preview within 60ms: ${results.colorImmediate} (${toneAfter})`);
  await cancel(page);

  // --- F. dirty tracking + unsaved prompt still work --------------------
  await page.getByRole("button", { name: "Statuses", exact: true }).click();
  await statusInput.click();
  await statusInput.pressSequentially("X", { delay: 40 });
  await page.waitForTimeout(300);
  results.dirtyFlag = await page
    .locator(".settings-dirty")
    .getAttribute("data-dirty");
  results.saveEnabled = await page.getByRole("button", { name: "Save" }).isEnabled();
  await page.getByRole("button", { name: /Leave without saving/i }).click();
  await page.waitForTimeout(300);
  results.promptShown = await page.locator(".confirm-frame[role='alertdialog']").count();
  console.log(
    `F dirty=${results.dirtyFlag} saveEnabled=${results.saveEnabled} unsavedPrompt=${results.promptShown > 0}`,
  );
  if (!results.promptShown) throw new Error("unsaved-changes prompt did not open");
  await page.getByRole("button", { name: /Keep editing/i }).click();
  await page.waitForTimeout(300);
  await cancel(page);
  results.dirtyAfterCancel = await page.locator(".settings-dirty").getAttribute("data-dirty");
  console.log(`   prompt closed, dirty after Cancel: ${results.dirtyAfterCancel}`);

  await browser.close();

  const after = await getBoard(token);
  if (JSON.stringify(after.document) !== originalJson) {
    throw new Error("board settings changed — expected untouched (nothing was saved)");
  }
  console.log("board settings unchanged (nothing saved)");

  fs.writeFileSync(
    path.join(SHOTS, `typing-stability-${LABEL}.json`),
    JSON.stringify(results, null, 2),
  );
  console.log(`\nwrote screenshots/typing-stability-${LABEL}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
