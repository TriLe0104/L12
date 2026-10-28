import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "docs", "images");
mkdirSync(outDir, { recursive: true });

const now = Date.now() / 1000;
const series = Array.from({ length: 24 }, (_, i) => {
  const t = now - (23 - i) * 12;
  return {
    t,
    cpu: 42,
    gpu: 68,
    mem: 55,
    power_kw: 840,
    gpu_kw: 720,
    tx_gbps: 180,
    rx_gbps: 140,
    disk_pct: 22,
    disk_read_gbs: 1.2,
    disk_write_gbs: 0.4,
  };
});

const me = {
  id: "u-demo",
  email: "test@test",
  name: "Demo",
  org: "L12",
  role: "admin",
  avatar_url: null,
  is_active: true,
  is_pending: false,
  initials: "DE",
  created_at: "2026-01-01T00:00:00Z",
  last_login_at: "2026-10-02T00:00:00Z",
};

const metrics = {
  name: "Firmus",
  source: "seed",
  sensors: {},
  now: {
    cpu_pct: 42,
    gpu_pct: 68,
    mem_pct: 55,
    power_kw: 840,
    power_pct: 70,
    gpu_kw: 720,
    gpu_tdp_kw: 1008,
    envelope_kw: 960,
    available_kw: 120,
    tx_gbps: 180,
    rx_gbps: 140,
    disk_pct: 22,
    disk_read_gbs: 1.2,
    disk_write_gbs: 0.4,
  },
  series,
  size: {
    halls: 1,
    racks: 1,
    gpus: 72,
    nameplate_kw: 1200,
    cols: 1,
    rows: 1,
    racks_on: 1,
    compute_nodes: 18,
    compute_on: 18,
    gpus_per_node: 4,
    nodes_per_rack: 18,
    spines: 2,
    leaves: 0,
    switches: 9,
    speed: "800G",
  },
  nodes: { total: 18, active: 18, ready: 18, idle: 0, off: 0, compute_total: 18, compute_on: 18 },
  workload: null,
  workloads_running: [],
  gpu_used: 72,
  cpu_cores: 2592,
  mem_tb: 2.3,
  disk_tb: 30,
  disk_used_tb: 4,
  range: "5m",
};

function makePowerRack(col, consumed) {
  const name = `R01C${String(col).padStart(2, "0")}`;
  const pct = Math.round((consumed / 1200) * 100);
  return {
    id: `demo-gb300-${col}`,
    name,
    label: name,
    hall_id: "dh-01",
    power_state: "on",
    run_status: "running",
    demand_kw: consumed,
    consumed_kw: consumed,
    allocated_kw: 960,
    unused_kw: Math.max(0, 1200 - consumed),
    nameplate_kw: 1200,
    min_kw: 40,
    max_kw: 1200,
    usage_pct: pct,
    policy_kw: 960,
    enabled: true,
    denied: false,
    extra: false,
    action: "hold",
    gap_pct: 12,
  };
}

const powerRacks = [480, 660, 840, 1056].map((kw, i) => makePowerRack(i + 1, kw));
const rack = powerRacks[2];

const summary = {
  budget_kw: 3840,
  consumed_kw: 3036,
  allocated_kw: 3840,
  stranded_kw: 480,
  headroom_kw: 480,
  used_kw: 3036,
  available_kw: 480,
  floating_kw: 240,
  placeable_kw: 4800,
  surplus_kw: 0,
  racks_enabled: 4,
  racks_denied: 0,
  racks_extra: 0,
  racks_off: 0,
  racks_hot: 0,
  actions: { reduce: 0, hold: 4, increase: 0, enable: 0 },
};

const power = {
  mode: "dynamic",
  budget_kw: 960,
  auto_budget: false,
  nameplate_kw: 1200,
  tdp_kw: 1200,
  default_budget_kw: 1200,
  max_budget_kw: 1200,
  total_budget_kw: 1200,
  envelope_kw: 960,
  placeable_kw: 1200,
  surplus_kw: 0,
  unplaced_budget_kw: 0,
  max_rack_kw: 1200,
  min_rack_kw: 40,
  stay_under_pct: 80,
  threshold_pct: 80,
  power_source: "demo",
  halls: 1,
  rack_count: 4,
  rack_count_auto: false,
  racks_wanted: 4,
  racks_on: 4,
  racks_pool: 4,
  racks_static_max: 4,
  racks_lps_max: 4,
  racks_lps_gain: 0,
  rack_avg_kw: 840,
  rack_policy_kw: 960,
  rack_share_kw: 960,
  rack_hard_kw: 1200,
  policy: {
    reduce_gap_pct: 20,
    increase_gap_pct: 5,
    target_headroom_pct: 20,
    enable_per_tick: 0,
    min_rack_kw: 40,
    max_rack_kw: 1200,
    stay_under_pct: 80,
    threshold_pct: 80,
    rack_avg_kw: 960,
    rack_count: 1,
    total_budget_kw: 1200,
    envelope_kw: 960,
  },
  tick: 12,
  last_event: "Demo GB300 rack at 70% of 1200 kW",
  static: summary,
  dynamic: summary,
  active: summary,
  showcase: [],
  racks: powerRacks,
  static_racks: powerRacks,
  dynamic_racks: powerRacks,
};

function makeClusterRack(col, consumed) {
  const name = `R01C${String(col).padStart(2, "0")}`;
  return {
    id: `demo-gb300-${col}`,
    hall_id: "dh-01",
    name,
    x: col,
    y: 2,
    rotation: 0,
    height_u: 48,
    notes: null,
    power_state: "on",
    run_status: "running",
    cpu_pct: 42,
    gpu_pct: 68,
    mem_pct: 55,
    power_pct: Math.round((consumed / 1200) * 100),
    power_kw: consumed,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    devices: [],
  };
}

const clusterRacks = [480, 660, 840, 1056].map((kw, i) => makeClusterRack(i + 1, kw));
const clusterRack = clusterRacks[2];

const hall = {
  id: "dh-01",
  name: "Hall A",
  description: "Demo hall",
  width_tiles: 18,
  depth_tiles: 10,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  rack_count: 4,
  telemetry: { cpu_pct: 42, gpu_pct: 68, mem_pct: 55, power_kw: 3036, racks_on: 4, racks_total: 4 },
  racks: clusterRacks,
};

const campus = {
  name: "Firmus",
  source: "floor",
  telemetry: { cpu_pct: 42, gpu_pct: 68, mem_pct: 55, power_kw: 3036, racks_on: 4, racks_total: 4 },
  halls: [hall],
};

const overview = {
  name: "Firmus",
  halls: 1,
  racks: 4,
  devices: 18,
  occupied_u: 42,
  total_u: 48,
  utilization_pct: 70,
  cpu_pct: 42,
  gpu_pct: 68,
  mem_pct: 55,
  power_kw: 840,
  device_status: { healthy: 18 },
  resources: { gpu: 72, cpu: 2592 },
  rack_power: { on: 1 },
  rack_run: { running: 1 },
  health_checks: [],
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function tag(theme, name) {
  return join(outDir, theme === "scc" ? `${name}-scc.png` : `${name}.png`);
}

const browser = await chromium.launch({ headless: true });
const wrote = [];

for (const theme of ["meow", "scc"]) {
  const page = await browser.newPage({ viewport: { width: 1760, height: 1080 }, deviceScaleFactor: 1 });
  page.on("console", (msg) => console.log(theme, "BROWSER", msg.type(), msg.text()));
  page.on("requestfailed", (req) => console.log(theme, "FAIL", req.method(), req.url(), req.failure()?.errorText));
  page.on("pageerror", (err) => console.log(theme, "PAGEERROR", err.message));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (path === "/api/auth/me") return json(route, me);
    if (path === "/api/auth/config") return json(route, { provider: "local", allow_signup: false });
    if (path === "/api/auth/login") return json(route, { access_token: "demo-token", user: me });
    if (path === "/api/cluster/metrics") return json(route, metrics);
    if (path === "/api/cluster/power") return json(route, power);
    if (path === "/api/cluster/overview") return json(route, overview);
    if (path === "/api/cluster/campus") return json(route, campus);
    if (path === "/api/cluster/halls") return json(route, campus.halls);
    if (path === "/api/cluster/name") return json(route, { name: "Firmus" });
    if (path.startsWith("/api/cluster/racks/")) return json(route, clusterRack);
    console.log(theme, "UNHANDLED", req.method(), path);
    if (path.endsWith("s") || path.includes("list")) return json(route, []);
    return json(route, {});
  });

  await page.addInitScript((t) => {
    localStorage.setItem("po_calendar_token", "demo-token");
    localStorage.setItem("l12-ui-theme", t);
  }, theme);

  await page.goto("http://127.0.0.1:3001/cluster", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction((t) => document.documentElement.getAttribute("data-theme") === t, theme, { timeout: 10000 });
  await page.waitForSelector(".pod-racks .gb300-stencil img", { timeout: 20000 });
  await page.waitForFunction(() => {
    const img = document.querySelector(".pod-racks .gb300-stencil img");
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(600);

  const paths = {
    overview: tag(theme, "gb300-stencil-overview"),
    card: tag(theme, "gb300-stencil-card"),
    infra: tag(theme, "gb300-stencil-infra"),
    floor: tag(theme, "gb300-stencil-floor-hud"),
    hud: tag(theme, "gb300-stencil-hud"),
  };
  await page.screenshot({ path: paths.overview, fullPage: false });
  await page.locator(".pod-racks .gb300-stencil").first().screenshot({ path: paths.card });
  await page.locator(".pod-infra").first().screenshot({ path: paths.infra });

  await page.getByRole("button", { name: "Floor" }).click();
  await page.waitForSelector(".lps-hud .gb300-stencil", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: paths.floor, fullPage: false });
  await page.locator(".lps-hud").first().screenshot({ path: paths.hud });

  await page.close();
  wrote.push(...Object.values(paths));
}

await browser.close();
console.log("wrote");
for (const p of wrote) console.log(p);
