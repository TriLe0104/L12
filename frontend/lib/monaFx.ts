export type ScenePt = { x: number; y: number };

export const PAW_INNER = `
  <ellipse cx="0" cy="5.2" rx="5.4" ry="4.3"/>
  <ellipse cx="-5.4" cy="-1" rx="2.15" ry="2.55"/>
  <ellipse cx="-1.85" cy="-4.5" rx="2.25" ry="2.75"/>
  <ellipse cx="1.85" cy="-4.5" rx="2.25" ry="2.75"/>
  <ellipse cx="5.4" cy="-1" rx="2.15" ry="2.55"/>
`;

export const HUNT: Record<string, { target: string; label: string }> = {
  add_racks: { target: "racks", label: "adding racks…" },
  remove_rack: { target: "racks", label: "yeeting a rack…" },
  set_cluster_name: { target: "cluster-name", label: "renaming the cluster…" },
  set_power_cap: { target: "maxlps", label: "setting the cap…" },
  patch_rack: { target: "racks", label: "patching a rack…" },
  patch_node: { target: "provision", label: "rewiring a node…" },
  add_node: { target: "provision", label: "adding a node…" },
  get_health: { target: "health", label: "sniffing health…" },
  get_cluster_status: { target: "overview", label: "checking the floor…" },
  get_configuration: { target: "racks", label: "reading the roster…" },
  sync_inventory: { target: "racks", label: "syncing Argus…" },
  launch_test: { target: "testing", label: "launching a test…" },
  run_argus_test: { target: "testing", label: "kicking Argus…" },
  stop_test: { target: "testing", label: "pulling the plug…" },
  list_tests: { target: "catalog", label: "browsing tests…" },
  list_test_reports: { target: "reports", label: "digging reports…" },
  list_sanity: { target: "sanity", label: "reading sanity…" },
  run_sanity_check: { target: "sanity", label: "running sanity…" },
  capture_golden: { target: "golden", label: "capturing golden…" },
  generate_l11_report: { target: "reports", label: "building a report…" },
  open_page: { target: "overview", label: "padding over…" },
  ui_click: { target: "", label: "tapping…" },
  ui_fill: { target: "", label: "typing…" },
  bmc_reset: { target: "health", label: "poking the BMC…" },
  bmc_get: { target: "health", label: "peeking Redfish…" },
  highlight_ui: { target: "", label: "look here…" },
  start_test_agent: { target: "agents", label: "sending a minion…" },
  list_agents: { target: "agents", label: "checking the crew…" },
  stop_agent: { target: "agents", label: "recalling a minion…" },
  open_agent: { target: "agents", label: "tuning the radio…" },
};

const ALIAS: Record<string, string> = {
  health: '[data-mona="health"], .summary-strip[data-k="health"]',
  racks: 'table[data-mona="racks"], .rack-board table.network-table',
  register: '[data-mona="register"], .cluster-register',
  "cluster-name": '[data-mona="cluster-name"]',
  overview: '[data-mona="overview"], .overview-dash, .cluster-overview',
  floor: '[data-mona="floor"], .cluster-floor',
  limiter: '[data-mona="maxlps"] [data-mona="limiter"], .maxlps-loop, .maxlps-page',
  testing: '[data-mona="catalog"], [data-mona="testing"], .testing-page',
  catalog: '[data-mona="catalog"], .test-pick',
  sanity: '[data-mona="sanity"], .sanity-panel',
  bom: '[data-mona="sanity"], .sanity-panel',
  golden: '[data-mona="golden"], .golden-row',
  reports: '[data-mona="reports"], .test-reports',
  provision: '[data-mona="provision"], .provision-page',
  maxlps: '[data-mona="maxlps"], .maxlps-page',
  power: '[data-mona="maxlps"], .maxlps-page',
  lps: '[data-mona="maxlps"], .maxlps-page',
  "dynamic power": '[data-mona="maxlps"], .maxlps-page',
  "power limiter": '[data-mona="maxlps"] [data-mona="limiter"], .maxlps-loop, .maxlps-page',
  "power limitter": '[data-mona="maxlps"] [data-mona="limiter"], .maxlps-loop, .maxlps-page',
  limitter: '[data-mona="maxlps"] [data-mona="limiter"], .maxlps-loop, .maxlps-page',
  network: '[data-mona="network"], .network-page',
  settings: '[data-mona="settings"], .settings-page',
  users: '[data-mona="users"], .users-page',
  agents: '[data-mona="agents"], .p5-agent-tab, .p5-agents-drawer',
};

function visible(el: HTMLElement) {
  const box = el.getBoundingClientRect();
  return box.width > 2 && box.height > 2;
}

const POWER_EXACT = new Set([
  "limiter",
  "limitter",
  "maxlps",
  "power",
  "lps",
  "watts",
  "dynamic power",
  "power limiter",
  "power limitter",
  "power cap",
  "power budget",
  "power limit",
  "gpu power",
]);

export function isPowerTarget(target: string) {
  const n = (target || "").trim().toLowerCase().replace(/[_/-]+/g, " ");
  if (!n) return false;
  if (POWER_EXACT.has(n)) return true;
  return /limiter|limitter|maxlps|dynamic\s*power|power\s*(cap|limit|budget|limiter|limitter)/.test(n);
}

function powerScene(): HTMLElement | null {
  const page = document.querySelector<HTMLElement>('[data-mona="maxlps"], .maxlps-page');
  if (!page || !visible(page)) return null;
  const loop = page.querySelector<HTMLElement>('[data-mona="limiter"], .maxlps-loop');
  if (loop && visible(loop)) return loop;
  return page;
}

export function findScene(target: string): HTMLElement | null {
  const raw = (target || "").trim();
  if (!raw) return null;
  const n = raw.toLowerCase();
  if (n === "testing" || n === "catalog" || n === "tests") {
    const catalog = document.querySelector<HTMLElement>('[data-mona="catalog"], .test-pick');
    if (catalog && visible(catalog)) return catalog;
  }
  if (isPowerTarget(n)) {
    const power = powerScene();
    if (power) return power;
    return null;
  }
  const rack = document.querySelector<HTMLElement>(`[data-mona-rack="${cssEscape(raw)}"]`);
  if (rack && visible(rack)) return rack;
  const nodeExact = [...document.querySelectorAll<HTMLElement>("[data-mona-node]")].find((el) => {
    const tokens = [
      el.getAttribute("data-mona-node"),
      el.getAttribute("data-mona-rack"),
      el.getAttribute("data-bmc-ip"),
      el.getAttribute("data-os-ip"),
      el.getAttribute("data-serial"),
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    return tokens.includes(n);
  });
  if (nodeExact && visible(nodeExact)) return nodeExact;
  const rackLoose = [...document.querySelectorAll<HTMLElement>("[data-mona-rack]")].find((el) => {
    const v = (el.getAttribute("data-mona-rack") || "").toLowerCase();
    return v === n || v.includes(n) || n.includes(v);
  });
  if (rackLoose && visible(rackLoose)) return rackLoose;
  const mona = document.querySelector<HTMLElement>(`[data-mona="${cssEscape(raw)}"]`);
  if (mona && visible(mona)) return mona;
  const sel = ALIAS[n];
  if (sel) {
    const hit = document.querySelector<HTMLElement>(sel);
    if (hit && visible(hit)) return hit;
  }
  return null;
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

export function originPoint(): ScenePt {
  const dock = document.querySelector(".p5-dock") as HTMLElement | null;
  if (dock) {
    const b = dock.getBoundingClientRect();
    return { x: b.left + 16, y: b.top + b.height * 0.52 };
  }
  const fab = document.querySelector(".p5-fab") as HTMLElement | null;
  if (fab) {
    const b = fab.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return { x: window.innerWidth - 88, y: window.innerHeight - 88 };
}

export function catWalkPath(from: ScenePt, to: ScenePt): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const wobble = Math.min(42, Math.max(14, len * 0.08));
  const c1x = from.x + dx * 0.28 + px * wobble;
  const c1y = from.y + dy * 0.18 + py * wobble;
  const c2x = from.x + dx * 0.7 - px * wobble * 0.85;
  const c2y = from.y + dy * 0.78 - py * wobble * 0.85;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export type PawMark = { x: number; y: number; rot: number; i: number };

export function pawsAlong(d: string, spacing = 56): PawMark[] {
  if (typeof document === "undefined" || !d) return [];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
  document.body.appendChild(svg);
  const total = path.getTotalLength();
  const out: PawMark[] = [];
  if (total > 8) {
    const step = Math.max(28, Math.min(spacing, total / 8));
    let i = 0;
    for (let at = step; at < total - 10; at += step) {
      const pt = path.getPointAtLength(at);
      const back = path.getPointAtLength(Math.max(0, at - 10));
      const ang = (Math.atan2(pt.y - back.y, pt.x - back.x) * 180) / Math.PI;
      const nx = -(pt.y - back.y);
      const ny = pt.x - back.x;
      const nl = Math.hypot(nx, ny) || 1;
      const side = i % 2 === 0 ? 1 : -1;
      out.push({
        x: pt.x + (nx / nl) * 11 * side,
        y: pt.y + (ny / nl) * 11 * side,
        rot: ang + side * 16,
        i,
      });
      i += 1;
    }
  }
  svg.remove();
  return out;
}

export function unionBox(els: HTMLElement[]): { left: number; top: number; width: number; height: number } | null {
  const vis = els.filter(visible);
  if (!vis.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of vis) {
    const b = el.getBoundingClientRect();
    left = Math.min(left, b.left);
    top = Math.min(top, b.top);
    right = Math.max(right, b.right);
    bottom = Math.max(bottom, b.bottom);
  }
  const pad = 8;
  const width = Math.max(24, right - left + pad * 2);
  const height = Math.max(24, bottom - top + pad * 2);
  const maxH = Math.max(88, Math.min(280, window.innerHeight * 0.42));
  return {
    left: Math.max(10, left - pad),
    top: Math.max(10, top - pad),
    width,
    height: Math.min(height, maxH),
  };
}

const CAT_R = 28;

export function parkPoint(box: { left: number; top: number; width: number; height: number }): ScenePt {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const x = box.left + Math.min(CAT_R + 8, Math.max(CAT_R, box.width * 0.1));
  const y = box.top + Math.min(CAT_R + 8, Math.max(CAT_R, box.height * 0.12));
  return {
    x: Math.max(CAT_R + 4, Math.min(x, vw - CAT_R - 4)),
    y: Math.max(CAT_R + 4, Math.min(y, vh - CAT_R - 4)),
  };
}

export function labelPoint(
  box: { left: number; top: number; width: number; height: number },
  label: string,
  park: ScenePt,
): { left: number; top: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(280, Math.max(120, label.length * 9 + 28));
  const h = 32;
  const above = park.y - CAT_R - h - 10;
  if (above >= 10) {
    return { left: Math.max(12, Math.min(park.x - 8, vw - w - 12)), top: above };
  }
  let left = park.x + CAT_R + 14;
  let top = park.y - h / 2;
  if (left + w > vw - 12) left = Math.max(12, park.x - CAT_R - w - 14);
  return {
    left: Math.max(12, Math.min(left, vw - w - 12)),
    top: Math.max(10, Math.min(top, vh - h - 8)),
  };
}

export function huntFor(tool?: string, args?: Record<string, unknown>) {
  const hit = tool ? HUNT[tool] : undefined;
  const argTarget = String(args?.target || args?.label || args?.rack || args?.path || "").trim();
  let target = argTarget || hit?.target || "";
  if (tool === "set_power_cap" || isPowerTarget(target)) target = "maxlps";
  return {
    target,
    label: hit?.label || (isPowerTarget(target) ? "dynamic power…" : "on it…"),
  };
}
