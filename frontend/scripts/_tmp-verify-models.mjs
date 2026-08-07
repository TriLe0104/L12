/* Temporary: drives the real app through the six reference models and proves
   geometry actually arrived. Deleted once the run is reported.

   Login flow copied from scripts/check-layout.mjs.                            */

import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/* "Did something actually get drawn?" without trusting the loader's own report.
   readPixels comes back blank on a canvas without preserveDrawingBuffer, so the
   evidence is the screenshot itself:
     - edge energy: a mean absolute Laplacian over the stage. The backdrop is a
       smooth radial gradient, so an empty void scores ~0 and a rendered solid
       with silhouette and shading scores orders of magnitude higher.
     - orbit delta: how much the stage changes when the camera is dragged. Only
       real geometry responds to the camera.                                    */
async function stageMetrics(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let energy = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      energy += Math.abs(
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width],
      );
    }
  }
  return { pixels: data, width, height, edgeEnergy: energy / (width * height) };
}

function meanDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let total = 0;
  for (let i = 0; i < a.pixels.length; i++) total += Math.abs(a.pixels[i] - b.pixels[i]);
  return total / a.pixels.length;
}

const WEB = "http://localhost:3000";
const API = "http://127.0.0.1:8000";
const EMAIL = process.env.PO_EMAIL ?? "trile0104@gmail.com";
const PASSWORD = process.env.PO_PASSWORD ?? "tvm-temp-2026";
const SRC = "c:\\Users\\tril\\Downloads\\74-bottle";

const MODELS = [
  "BOTTLE MID POLY.obj",
  "BOTTLE MID POLY.fbx",
  "BOTTLE HIGH POLY.obj",
  "BOTTLE HIGH POLY.fbx",
  "BOTTLE.stp",
  "BOTTLE.3dm",
];

const only = process.argv.slice(2);
const wanted = only.length ? MODELS.filter((m) => only.some((o) => m.includes(o))) : MODELS;

const login = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { access_token } = await login.json();
const authed = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
      ...(init.headers ?? {}),
    },
  });

const pos = await (await authed("/api/purchase-orders")).json();
const target = pos.find((p) => p.job_no !== "J-55" && !p.locked);
if (!target) throw new Error("no unlocked non-J-55 order to borrow");
console.log(`target order: ${target.job_no} · ${target.po_number} (${target.id})`);
console.log(`orders=${pos.length}`);

mkdirSync("screenshots", { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(
  (token) => window.localStorage.setItem("po_calendar_token", token),
  access_token,
);
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

/* Every network request the page makes, so "was the WASM fetched before it was
   needed?" is answerable from evidence rather than from assertion. */
const requests = [];
page.on("request", (r) => requests.push({ url: r.url(), at: Date.now() }));

/* Everything the *page* uploads, so the tidy-up can name those files too. */
const goodUploads = [];
page.on("response", async (res) => {
  if (!res.url().endsWith("/api/uploads/model") || res.status() !== 201) return;
  try {
    goodUploads.push((await res.json()).url);
  } catch {
    /* body already consumed */
  }
});

const openDrawer = async () => {
  await page.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
  await page.click(`.jobcard:has(.jobcard-job:text-is("${target.job_no}"))`);
  await page.waitForSelector(".drawer .model-drop");
};

const results = [];

console.log("\n=== per-format load ===");
for (const name of wanted) {
  const t0 = Date.now();
  await openDrawer();

  /* Wait for the *name* to land, not just for data-filled: the order already
     carries the previous iteration's model, so data-filled is true before this
     upload has even started. */
  await page.setInputFiles('.drawer .model-drop input[type="file"]', join(SRC, name));
  await page.waitForSelector(`.drawer .model-drop-name:text-is("${name}")`, { timeout: 120_000 });
  const uploadedMs = Date.now() - t0;

  await page.click('.drawer button:has-text("Save changes")');
  await page.waitForSelector('.drawer [role="status"]:text-is("Saved.")', { timeout: 30_000 });
  const savedName = await page
    .locator(".drawer .model-drop-name")
    .innerText()
    .catch(() => "(gone)");
  if (savedName !== name) console.log(`     WARN: card shows "${savedName}" after saving ${name}`);

  const beforeOpen = requests.length;
  await page.click(".drawer .model-expand");
  await page.waitForSelector(".model-viewer-frame", { timeout: 10_000 });
  await page.waitForSelector(
    '.model-viewer-frame[data-model-state="ready"], .model-viewer-frame[data-model-state="error"]',
    { timeout: 240_000 },
  );

  const frame = page.locator(".model-viewer-frame");
  const read = async (attr) => frame.getAttribute(attr);
  const state = await read("data-model-state");
  const triangles = Number(await read("data-triangles"));
  const vertices = Number(await read("data-vertices"));
  const bbox = ((await read("data-bbox")) || "").split(",").map(Number);
  const elapsedMs = Number(await read("data-elapsed-ms"));

  // Not "did it throw" — did geometry actually arrive and does it occupy space?
  const boxVolumeOk = bbox.length === 3 && bbox.every((n) => Number.isFinite(n) && n > 0);
  const ok = state === "ready" && triangles > 0 && vertices > 0 && boxVolumeOk;

  await page.waitForTimeout(700);
  const stage = page.locator(".model-viewer-stage");
  const shot = `screenshots/model-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  await page.screenshot({ path: shot });
  const before = await stageMetrics(await stage.screenshot());

  // orbit by hand: proves the interaction works and that what is on screen is
  // geometry rather than a static backdrop
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 170, box.y + box.height / 2 + 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await stageMetrics(await stage.screenshot());
  const orbitDelta = meanDifference(before, after);
  await page.screenshot({
    path: `screenshots/model-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-orbited.png`,
  });

  const newRequests = requests.slice(beforeOpen).map((r) => r.url);
  const rendered = before.edgeEnergy > 0.5 && orbitDelta > 1;
  results.push({
    name,
    state,
    triangles,
    vertices,
    bbox,
    elapsedMs,
    uploadedMs,
    edgeEnergy: before.edgeEnergy,
    orbitDelta,
    rendered,
    ok: ok && rendered,
    shot,
    wasm: newRequests.filter((u) => /\.wasm|occt-import-js\.js|rhino3dm\.js/.test(u)),
    error: state === "error" ? await frame.locator(".model-viewer-overlay span").innerText() : null,
  });

  console.log(
    `${ok && rendered ? "OK  " : "FAIL"} ${name.padEnd(22)} ${state.padEnd(6)} ` +
      `tris=${triangles.toLocaleString().padStart(9)} verts=${vertices.toLocaleString().padStart(9)} ` +
      `bbox=${bbox.map((n) => n.toPrecision(4)).join("×")} ${elapsedMs}ms ` +
      `edge=${before.edgeEnergy.toFixed(2)} orbitΔ=${orbitDelta.toFixed(2)}`,
  );
  if (results.at(-1).error) console.log(`     error: ${results.at(-1).error}`);
  if (results.at(-1).wasm.length) {
    console.log(`     runtime assets: ${results.at(-1).wasm.map((u) => u.split("/").pop()).join(", ")}`);
  }

  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-viewer-frame", { state: "detached" });
  const drawerStillOpen = await page.locator(".drawer").count();
  if (drawerStillOpen !== 1) console.log("     FAIL: Escape closed the drawer as well");
}

/* ---- lazy loading: nothing 3D on a cold page load ---- */
console.log("\n=== initial page load ===");
{
  const cold = await context.newPage();
  const seen = [];
  cold.on("request", (r) => seen.push(r.url()));
  await cold.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
  await cold.waitForTimeout(1500);
  const suspicious = seen.filter((u) => /three|occt|rhino3dm|\.wasm/i.test(u));
  console.log(
    suspicious.length
      ? `FAIL: cold load fetched ${suspicious.join(", ")}`
      : `OK   cold load of /tasks fetched no three.js, no loader and no wasm (${seen.length} requests)`,
  );
  await cold.close();
}

/* ---- read-only card badge opens the viewer ---- */
console.log("\n=== read-only card ===");
{
  // re-attach the last model so the board card carries a badge
  await openDrawer();
  await page.setInputFiles('.drawer .model-drop input[type="file"]', join(SRC, "BOTTLE MID POLY.fbx"));
  await page.waitForSelector('.drawer .model-drop-name:text-is("BOTTLE MID POLY.fbx")');
  await page.click('.drawer button:has-text("Save changes")');
  await page.waitForSelector('.drawer [role="status"]:text-is("Saved.")');
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawer", { state: "detached" });

  const badge = page.locator(
    `.jobcard:has(.jobcard-job:text-is("${target.job_no}")) .model-tag-button`,
  );
  console.log(`badge on card: ${(await badge.count()) === 1 ? "OK" : "FAIL"} "${await badge.innerText()}"`);
  await page.screenshot({ path: "screenshots/model-card-badge.png" });

  await badge.click();
  await page.waitForSelector('.model-viewer-frame[data-model-state="ready"]', { timeout: 120_000 });
  console.log(`opened from board card: OK (drawer opened too? ${await page.locator(".drawer").count()})`);
  await page.screenshot({ path: "screenshots/model-from-board-card.png" });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-viewer-frame", { state: "detached" });
  console.log(`after Escape: viewer closed, drawer count=${await page.locator(".drawer").count()}`);
}

/* ---- Escape over the drawer closes only the viewer ---- */
console.log("\n=== escape layering ===");
{
  await openDrawer();
  await page.click(".drawer .model-expand");
  await page.waitForSelector('.model-viewer-frame[data-model-state="ready"]', { timeout: 120_000 });
  await page.screenshot({ path: "screenshots/model-viewer-over-drawer.png" });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-viewer-frame", { state: "detached" });
  const drawers = await page.locator(".drawer").count();
  console.log(`${drawers === 1 ? "OK  " : "FAIL"} viewer closed, drawer still open (count=${drawers})`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawer", { state: "detached" });
  console.log("OK   second Escape closes the drawer");
}

/* ---- WebGL context churn ---- */
console.log("\n=== open/close cycles ===");
{
  await openDrawer();
  let lost = 0;
  page.on("console", (m) => /context lost|CONTEXT_LOST/i.test(m.text()) && lost++);
  for (let i = 0; i < 12; i++) {
    await page.click(".drawer .model-expand");
    await page.waitForSelector('.model-viewer-frame[data-model-state="ready"]', { timeout: 120_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".model-viewer-frame", { state: "detached" });
  }
  const leftovers = await page.locator("canvas").count();
  await page.click(".drawer .model-expand");
  const survived = await page
    .waitForSelector('.model-viewer-frame[data-model-state="ready"]', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  const stats = await page.locator(".model-viewer-frame").getAttribute("data-triangles");
  console.log(
    `${survived && lost === 0 ? "OK  " : "FAIL"} 13 open/close cycles: ` +
      `context-lost events=${lost}, stray canvases after close=${leftovers}, ` +
      `13th render tris=${stats}`,
  );
  await page.screenshot({ path: "screenshots/model-after-13-cycles.png" });
  await page.keyboard.press("Escape");
}

/* ---- corrupt file ---- */
console.log("\n=== corrupt file ===");
{
  // A file that clears the server's sniff (real FBX magic) but is garbage after
  // it, so the failure has to be caught in the viewer rather than at upload.
  const head = Buffer.from("Kaydara FBX Binary  \x00\x1a\x00", "binary");
  const corrupt = Buffer.concat([head, Buffer.alloc(4096, 0x41)]);
  const up = await fetch(`${API}/api/uploads/model`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: (() => {
      const form = new FormData();
      form.append("file", new Blob([corrupt]), "CORRUPT.fbx");
      return form;
    })(),
  });
  const body = await up.json();
  console.log(`upload of a truncated-but-plausible FBX: ${up.status} ${JSON.stringify(body)}`);
  if (up.ok) {
    await authed(`/api/purchase-orders/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        model_url: body.url,
        model_filename: body.filename,
        model_size: body.size,
      }),
    });
    await openDrawer();
    await page.click(".drawer .model-expand");
    const settled = await page
      .waitForSelector('.model-viewer-frame[data-model-state="error"]', { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const message = settled
      ? await page.locator(".model-viewer-overlay.error span").innerText()
      : "(still spinning after 60s)";
    console.log(`${settled ? "OK  " : "FAIL"} viewer shows an error state: "${message}"`);
    await page.screenshot({ path: "screenshots/model-corrupt-error.png" });
    await page.keyboard.press("Escape");
    globalThis.__corruptUrl = body.url;
  }
}

/* ---- locked order refuses a model change ---- */
/* An admin clears LOCKED_PO_FLOOR, so proving the guard bites needs an account
   that can edit but is not an admin. One Manager is created here and deleted at
   the end of this block. */
console.log("\n=== locked order ===");
{
  // the corrupt-file block above left a deliberately broken model attached;
  // put a good one back before locking, so "still viewable" means something
  const good = await fetch(`${API}/api/uploads/model`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: (() => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([readFileSync(join(SRC, "BOTTLE MID POLY.fbx"))]),
        "BOTTLE MID POLY.fbx",
      );
      return form;
    })(),
  });
  const goodBody = await good.json();
  goodUploads.push(goodBody.url);
  await authed(`/api/purchase-orders/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      model_url: goodBody.url,
      model_filename: goodBody.filename,
      model_size: goodBody.size,
    }),
  });

  await authed(`/api/purchase-orders/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ locked: true }),
  });

  const created = await authed("/api/users", {
    method: "POST",
    body: JSON.stringify({
      email: "model-lock-probe@tmp.invalid",
      name: "Model Lock Probe",
      role: "manager",
      password: "probe-temp-2026",
    }),
  });
  const probe = await created.json();
  console.log(`temporary Manager created: ${created.status} ${probe.email ?? JSON.stringify(probe)}`);

  const probeLogin = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "model-lock-probe@tmp.invalid", password: "probe-temp-2026" }),
  });
  const probeToken = (await probeLogin.json()).access_token;

  const attach = await fetch(`${API}/api/purchase-orders/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${probeToken}` },
    body: JSON.stringify({ model_url: "/uploads/whatever.obj", model_filename: "x.obj" }),
  });
  const attachBody = await attach.json();
  console.log(
    `${attach.status === 403 ? "OK  " : "FAIL"} Manager attaching a model to a locked order: ` +
      `${attach.status} ${JSON.stringify(attachBody.detail)}`,
  );

  const clear = await fetch(`${API}/api/purchase-orders/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${probeToken}` },
    body: JSON.stringify({ model_url: null, model_filename: null, model_size: null }),
  });
  console.log(
    `${clear.status === 403 ? "OK  " : "FAIL"} Manager clearing it: ${clear.status} ` +
      `${JSON.stringify((await clear.json()).detail)}`,
  );

  // and the UI meets them with a disabled well rather than a 403
  const probeContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await probeContext.addInitScript(
    (t) => window.localStorage.setItem("po_calendar_token", t),
    probeToken,
  );
  const probePage = await probeContext.newPage();
  await probePage.goto(`${WEB}/tasks`, { waitUntil: "networkidle" });
  await probePage.click(`.jobcard:has(.jobcard-job:text-is("${target.job_no}"))`);
  await probePage.waitForSelector(".drawer .model-drop");
  const tabindex = await probePage.locator(".drawer .model-drop").getAttribute("tabindex");
  const clearControls = await probePage.locator(".drawer .model-clear").count();
  const note = await probePage.locator(".lock-note").innerText();
  console.log(
    `${tabindex === "-1" && clearControls === 0 ? "OK  " : "FAIL"} drawer for a Manager: ` +
      `well tabindex=${tabindex}, remove control present=${clearControls}, note="${note.trim()}"`,
  );
  await probePage.screenshot({ path: "screenshots/model-locked-order.png" });
  // the badge still opens the viewer: locking freezes edits, not viewing
  await probePage.keyboard.press("Escape");
  await probePage.waitForSelector(".drawer", { state: "detached" });
  await probePage
    .locator(`.jobcard:has(.jobcard-job:text-is("${target.job_no}")) .model-tag-button`)
    .click();
  const stillViewable = await probePage
    .waitForSelector('.model-viewer-frame[data-model-state="ready"]', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`${stillViewable ? "OK  " : "FAIL"} a locked order's model is still viewable`);
  await probePage.screenshot({ path: "screenshots/model-locked-still-viewable.png" });
  await probeContext.close();

  await authed(`/api/purchase-orders/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ locked: false }),
  });
  const removed = await authed(`/api/users/${probe.id}`, { method: "DELETE" });
  console.log(`temporary Manager deleted: ${removed.status}`);
}

/* ---- oversize + wrong-type refusal, through the UI ---- */
console.log("\n=== refusals in the UI ===");
{
  // Playwright caps in-memory uploads at 50 MB, so the oversize case goes via disk.
  const huge = join(process.env.TEMP ?? ".", "TOO BIG.obj");
  writeFileSync(huge, "# oversize\n" + "v 0 0 0\n".repeat(9_000_000));

  await openDrawer();
  await page.setInputFiles('.drawer .model-drop input[type="file"]', huge);
  await page.waitForSelector(".jobcard-note.error", { timeout: 240_000 });
  console.log(`oversize (68.7 MB): "${await page.locator(".jobcard-note.error").innerText()}"`);
  await page.screenshot({ path: "screenshots/model-oversize-refused.png" });
  rmSync(huge, { force: true });

  await page.setInputFiles('.drawer .model-drop input[type="file"]', {
    name: "NOT A MODEL.obj",
    mimeType: "model/obj",
    buffer: Buffer.from("\x89PNG\r\n\x1a\n" + "\x00".repeat(400), "binary"),
  });
  await page.waitForTimeout(2000);
  console.log(`renamed png: "${await page.locator(".jobcard-note.error").innerText()}"`);
  await page.screenshot({ path: "screenshots/model-wrong-type-refused.png" });
  await page.keyboard.press("Escape");
}

console.log("\n=== console errors ===");
const noisy = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
console.log(noisy.length ? noisy.slice(0, 12).join("\n") : "none");

console.log("\n=== summary ===");
for (const r of results) {
  console.log(
    `${r.ok ? "OK  " : "FAIL"} ${r.name.padEnd(22)} tris=${String(r.triangles).padStart(8)} ` +
      `verts=${String(r.vertices).padStart(8)} bbox=${r.bbox.map((n) => n.toPrecision(4)).join("×")} ` +
      `load=${r.elapsedMs}ms edge=${r.edgeEnergy.toFixed(2)} orbitΔ=${r.orbitDelta.toFixed(2)} ${r.shot}`,
  );
}
/* Detach the model and hand back the exact list of files this run wrote, so they
   can be removed by name from the uploads directory. */
await authed(`/api/purchase-orders/${target.id}`, {
  method: "PATCH",
  body: JSON.stringify({ model_url: null, model_filename: null, model_size: null }),
});
const finalPos = await (await authed("/api/purchase-orders")).json();
const stillAttached = finalPos.filter((p) => p.model_url);
console.log(
  `\ndetached: orders=${finalPos.length}, orders still carrying a model=${stillAttached.length}`,
);

console.log("\n--- files this run created (delete by exact name) ---");
for (const u of [...new Set(goodUploads)]) console.log(u);
if (globalThis.__corruptUrl) console.log(globalThis.__corruptUrl);

await browser.close();
