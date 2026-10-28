"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";

import { ApiError, api, assetUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PAW_INNER, catWalkPath, findScene, huntFor, isPowerTarget, labelPoint, originPoint, parkPoint, pawsAlong, unionBox } from "@/lib/monaFx";

import "./P5Messenger.css";

type Role = "user" | "assistant";
type Choice = {
  label: string;
  tool: string;
  arguments?: Record<string, unknown>;
  hint?: string | null;
  mutating?: boolean;
};
type ChatFile = { name: string; kind?: string };
type Line = { id: string; role: Role; text: string; at: number; choices?: Choice[]; files?: ChatFile[]; debriefId?: string };
type Status = {
  enabled: boolean;
  online?: boolean;
  model: string | null;
  can_edit: boolean;
  hint?: string | null;
};

const STORE = "l12-mona-chat-2";
const FAB_STORE = "l12-mona-fab";
const IM_STORE = "l12-mona-im";
const CON_OPEN_STORE = "l12-mona-con-open";
const AGENTS_OPEN_STORE = "l12-mona-agents-open";
const FAB_HIDE_STORE = "l12-mona-fab-hidden";
type AgentJob = {
  id: string;
  name: string;
  kind: string;
  status: string;
  doing: string | null;
  test?: string | null;
  rack?: string | null;
  serial?: string | null;
  ok?: boolean | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  log?: string[];
  chat?: { id: string; kind?: string; text: string; at?: string }[];
  minion?: string | null;
  mission?: string | null;
  briefing?: string | null;
  debrief?: string | null;
  debrief_id?: string | null;
};
type JobLine = { id: string; text: string; at: number; kind: string };
const CAT = "/p5/cat.jpg?v=2";
const CAT_HOVER = "/p5/cat-hover.jpg?v=2";
type UiCmd = {
  kind: string;
  path?: string;
  target?: string;
  value?: string;
  submit?: boolean;
  action?: string;
  label?: string;
  id?: string;
  ids?: string[];
  rack?: string;
  serial?: string;
  refresh?: string;
  node?: string;
  host?: string;
  user?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exit?: number | null;
  error?: string | null;
  ok?: boolean;
};
type StageShow = {
  id: string;
  action: string;
  label: string;
  d: string;
  box: { left: number; top: number; width: number; height: number } | null;
  paws: { x: number; y: number; rot: number; i: number }[];
  hold: boolean;
  ms: number;
  settled?: boolean;
};
type FabPos = { left: number; top: number };
type TermLine = { id: string; kind: "sys" | "cmd" | "out" | "err"; text: string };
type ConsoleSess = { node: string; host: string; user: string; lines: TermLine[] };
const WELCOME: Line[] = [
  {
    id: "w1",
    role: "assistant",
    text: "Heh. About time you showed up!",
    at: Date.now(),
  },
  {
    id: "w2",
    role: "assistant",
    text: "I'm Mona. Not just a cat, by the way.",
    at: Date.now(),
  },
];
const PROMPTS = ["What's the cluster health?", "Add 6 racks GB300 cluster name", "List tests I can run"];
const ATTACH_ACCEPT =
  ".txt,.md,.csv,.log,.json,.xml,.yaml,.yml,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.py,.sh,.conf,.ini";
const ATTACH_MAX = 4;
const ATTACH_BYTES = 8 * 1024 * 1024;

const QUIPS: { prefix: string; lines: string[] }[] = [
  {
    prefix: "/cluster",
    lines: [
      "Cluster overview. Leave the health to me!",
      "Those tiles better stay green. I'll be watching.",
      "Hot nodes get fire. Cute AND useful.",
    ],
  },
  {
    prefix: "/maxlps",
    lines: [
      "Dynamic power. Don't fry the shelves, okay?",
      "Watts, watts, watts. I could do this in my sleep.",
      "I'll keep an eye on the envelope. You tap the buttons.",
    ],
  },
  {
    prefix: "/provision",
    lines: [
      "Provisioning. Try not to brick anything.",
      "PXE, Redfish, serials. Leave it to me!",
      "Register the boxes first. I'm not a magician. Well. Almost.",
    ],
  },
  {
    prefix: "/testing",
    lines: [
      "Tests. I'll watch the logs. You watch the pretty charts.",
      "MLPerf, NCCL, IB. Say the word and I'll launch one.",
      "A test without logs is just hope. I read the logs.",
    ],
  },
  {
    prefix: "/settings",
    lines: [
      "Settings. Stick a Grok key here if you want me actually talking.",
      "SOPs go here. I read them. Then I look smart.",
      "Theme, key, documents. I'm not just a cat, by the way.",
    ],
  },
  {
    prefix: "/users",
    lines: [
      "People page. Your photo goes in the chat, you know.",
      "Upload a face. I'm not talking to a blank circle forever.",
      "Roles and photos. Don't make me Admin. Tempting, though.",
    ],
  },
  {
    prefix: "/network",
    lines: [
      "Network. Boring. Necessary. Fine.",
      "Switches. I'll pretend to be impressed.",
      "If the fabric flaps, I will say I told you so.",
    ],
  },
];
const FALLBACK_QUIPS = ["Heh. Need something?", "Leave it to me!", "I'm not just a cat. Obviously."];
const CRASH_QUIPS = [
  "Heh. The API just face-planted. Not me. Hit send again.",
  "I coughed up a hairball on the server. One more time.",
  "That wasn't a leak. That was a 500. Try me again.",
  "The rack hid under the desk. Ping me again.",
];

function chatFailLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : "";
  const status = err instanceof ApiError ? err.status : 0;
  const low = raw.toLowerCase();
  const generic =
    status >= 500 ||
    !raw.trim() ||
    /internal server error|server error|bad gateway|service unavailable|failed to fetch|networkerror|load failed|econnreset|timed out|timeout|http error/i.test(
      low,
    );
  if (generic) {
    return CRASH_QUIPS[Math.floor(Math.random() * CRASH_QUIPS.length)];
  }
  if (status === 401) return "Who are you. Sign in and I'll talk.";
  if (status === 403) return "Cute. You don't get to do that.";
  return raw.slice(0, 240);
}
const AFK_QUIPS = [
  "AFK. Stick a Grok key in Settings if you want me talking.",
  "Away. Not ignoring you. No key, no voice.",
  "Mona is out. Settings, Grok key, then I'm back.",
];

function nid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function loadLines(): Line[] {
  if (typeof window === "undefined") return WELCOME;
  try {
    const raw = window.sessionStorage.getItem(STORE);
    if (!raw) return WELCOME;
    const parsed = JSON.parse(raw) as Line[];
    if (!Array.isArray(parsed) || !parsed.length) return WELCOME;
    return parsed.map((line) => ({ ...line, text: cleanText(line.text || "") }));
  } catch {
    return WELCOME;
  }
}

function jobLines(job: AgentJob | null): JobLine[] {
  if (!job) return [];
  if (job.chat?.length) {
    return job.chat.map((row, i) => ({
      id: row.id || `${job.id}-${i}`,
      text: row.text,
      kind: row.kind || "say",
      at: row.at ? Date.parse(row.at) || Date.now() : Date.now(),
    }));
  }
  return (job.log || []).map((line, i) => {
    const hit = line.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/);
    return {
      id: `${job.id}-${i}`,
      text: hit ? hit[2] : line,
      kind: "say",
      at: Date.now(),
    };
  });
}

function stripLeaked(text: string) {
  return text
    .replace(
      /(?:^|\n)[ \t]*(?:invoke[ \t]+(?:tool[ \t]+)?)?[a-z][a-z0-9_]{1,48}[ \t]*\n(?:[ \t]*[a-z][a-z0-9_]*[ \t]*=[ \t]*"[^"]*"[ \t]*\n?)+/gi,
      "\n",
    )
    .replace(/<[a-z][a-z0-9_]{1,48}(?:\s+[a-z][a-z0-9_]*\s*=\s*"[^"]*")+\s*\/>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitBubbles(text: string) {
  return stripLeaked(text)
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanText(text: string) {
  return stripLeaked(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`+/g, "")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2");
}

function quipsFor(path: string) {
  const hit = QUIPS.find((q) => path === q.prefix || path.startsWith(`${q.prefix}/`));
  return hit?.lines ?? FALLBACK_QUIPS;
}

type Pt = { x: number; y: number };

function spotLabelStyle(box: { left: number; top: number; width: number; height: number }, label: string): CSSProperties {
  const pt = labelPoint(box, label, parkPoint(box));
  return { left: `${pt.left}px`, top: `${pt.top}px` };
}

function zigzagFrom(rail: HTMLElement): { d: string; w: number; h: number } {
  const w = Math.max(1, rail.clientWidth);
  const h = Math.max(1, rail.offsetHeight);
  const left = w * 0.16;
  const right = w * 0.78;
  const mid = (left + right) / 2;
  const rows = [...rail.querySelectorAll(".p5-row")] as HTMLElement[];
  if (!rows.length) return { d: "", w, h };
  const railBox = rail.getBoundingClientRect();
  const pts: Pt[] = rows.map((row, idx) => {
    const last = idx === rows.length - 1;
    const face = last ? (row.querySelector(".p5-face") as HTMLElement | null) : null;
    if (face) {
      const box = face.getBoundingClientRect();
      return {
        x: box.left - railBox.left + box.width / 2,
        y: box.top - railBox.top + box.height * 0.42,
      };
    }
    const user = row.classList.contains("p5-row--user");
    return {
      x: row.offsetLeft + (user ? row.offsetWidth - 36 : 36),
      y: row.offsetTop + row.offsetHeight * 0.7,
    };
  });
  const start: Pt = { x: pts[0].x, y: Math.max(8, pts[0].y - 40) };
  let d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`;
  let prev = start;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const dy = p.y - prev.y;
    if (dy < 10 && Math.abs(p.x - prev.x) < 8) {
      prev = p;
      continue;
    }
    const dropY = prev.y + Math.max(12, dy * 0.22);
    const sameSide = i > 0 && (prev.x - mid) * (p.x - mid) > 0 && Math.abs(p.x - prev.x) < w * 0.22;
    const last = i === pts.length - 1;
    if (last) {
      d += ` V ${dropY.toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    } else if (sameSide && dy > 24) {
      const bounceX = prev.x < mid ? right : left;
      const bounceY = prev.y + dy * 0.62;
      d += ` V ${dropY.toFixed(1)} L ${bounceX.toFixed(1)} ${bounceY.toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    } else {
      d += ` V ${dropY.toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    prev = p;
  }
  return { d, w, h };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isChatChrome(el: Element | null) {
  return Boolean(
    el?.closest(
      ".p5-dock, .p5-im, .p5-fab, .p5-quip, .p5-choices, .p5-compose, .p5-con-tab, .p5-console-drawer, .p5-agent-tab, .p5-agents-drawer, .p5-summon, .mona-stage",
    ),
  );
}

function loadConOpen() {
  try {
    return window.sessionStorage.getItem(CON_OPEN_STORE) === "1";
  } catch {
    return false;
  }
}

function loadAgentsOpen() {
  try {
    return window.sessionStorage.getItem(AGENTS_OPEN_STORE) === "1";
  } catch {
    return false;
  }
}

function loadFabHidden() {
  try {
    return window.localStorage.getItem(FAB_HIDE_STORE) === "1";
  } catch {
    return false;
  }
}

function controlScore(el: HTMLElement, needle: string): number {
  const n = needle.trim().toLowerCase();
  if (!n) return 0;
  const label = el.closest("label")?.innerText || "";
  const bits = [
    el.getAttribute("data-mona") || "",
    el.getAttribute("name") || "",
    el.id || "",
    el.getAttribute("aria-label") || "",
    el.getAttribute("placeholder") || "",
    el.getAttribute("title") || "",
    label,
    (el.textContent || "").replace(/\s+/g, " ").trim(),
  ].map((s) => s.toLowerCase());
  let best = 0;
  for (const b of bits) {
    if (!b) continue;
    if (b === n) best = Math.max(best, 100);
    else if (b.includes(n) || n.includes(b)) best = Math.max(best, 70);
  }
  return best;
}

function findControl(target: string): HTMLElement | null {
  const scene = findScene(target);
  if (scene) return scene;
  if (isPowerTarget(target)) return null;
  const nodes = [
    ...document.querySelectorAll<HTMLElement>(
      "input, textarea, select, button, a, [role='button'], [role='tab']",
    ),
  ];
  let best: HTMLElement | null = null;
  let score = 0;
  for (const el of nodes) {
    if (isChatChrome(el)) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    const s = controlScore(el, target);
    if (s > score) {
      score = s;
      best = el;
    }
  }
  return score >= 40 ? best : null;
}

function setFieldValue(el: HTMLElement, value: string) {
  if (el instanceof HTMLSelectElement) {
    const match = [...el.options].find(
      (o) =>
        o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase().includes(value.toLowerCase()),
    );
    el.value = match ? match.value : value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function waitControl(target: string, ms = 2400): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = findControl(target);
    if (hit) return hit;
    await sleep(80);
  }
  return findControl(target);
}

async function waitScenes(cmd: UiCmd, ms = 2600): Promise<HTMLElement[]> {
  const start = Date.now();
  const needles = [...(cmd.ids || []).map(String), cmd.target || ""].filter(Boolean);
  if (!needles.length) return [];
  while (Date.now() - start < ms) {
    const hits = needles.map((n) => findControl(n)).filter((el): el is HTMLElement => Boolean(el));
    const uniq = [...new Set(hits)];
    if (uniq.length) return uniq;
    await sleep(80);
  }
  return needles.map((n) => findControl(n)).filter((el): el is HTMLElement => Boolean(el));
}

type PlayStage = (opts: { action: string; label: string; els: HTMLElement[]; hold?: boolean }) => Promise<void>;

async function applyUi(
  router: { push: (href: string) => void },
  cmds: UiCmd[],
  onConsole: ((cmd: UiCmd) => void) | undefined,
  play: PlayStage,
  onAgents?: (id?: string) => void,
) {
  for (const cmd of cmds) {
    if (cmd.kind === "console") {
      onConsole?.(cmd);
      continue;
    }
    if (cmd.kind === "agents") {
      onAgents?.(cmd.id);
      continue;
    }
    if (cmd.kind === "testing-rack") {
      window.dispatchEvent(new CustomEvent("l12-testing-rack", { detail: cmd }));
      await sleep(80);
      continue;
    }
    if (cmd.kind === "navigate" && cmd.path && cmd.path.startsWith("/")) {
      router.push(cmd.path);
      await sleep(450);
      continue;
    }
    if (cmd.kind === "highlight") {
      const action = (cmd.action || "look").toLowerCase();
      if (action === "add" || cmd.refresh === "before") {
        window.dispatchEvent(new Event("l12-refresh"));
        await sleep(420);
      }
      if ((cmd.ids && cmd.ids.length) || cmd.target) {
        window.dispatchEvent(
          new CustomEvent("l12-focus-node", { detail: { ids: cmd.ids || [], target: cmd.target || "" } }),
        );
      }
      const els = await waitScenes(cmd);
      const nodeEl = els.find((el) => el.hasAttribute("data-mona-node"));
      if (nodeEl) nodeEl.click();
      els[0]?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await play({
        action,
        label: cmd.label || (action === "add" ? "adding…" : action === "remove" ? "yeeting…" : "look"),
        els,
      });
      if (action === "remove" || cmd.refresh === "after") {
        window.dispatchEvent(new Event("l12-refresh"));
        await sleep(220);
      }
      continue;
    }
    if (cmd.kind === "fill" && cmd.target) {
      const el = await waitControl(cmd.target);
      if (el) {
        await play({ action: "edit", label: cmd.label || `typing ${cmd.target}`, els: [el], hold: false });
        setFieldValue(el, String(cmd.value ?? ""));
        if (cmd.submit) {
          const form = el.closest("form");
          if (form) form.requestSubmit();
          else formSubmitNear(el)?.click();
        }
      }
      await sleep(120);
      continue;
    }
    if (cmd.kind === "click" && cmd.target) {
      const el = await waitControl(cmd.target);
      if (el) {
        await play({ action: "click", label: cmd.label || cmd.target, els: [el], hold: false });
        el.click();
      }
      await sleep(120);
    }
  }
}

function formSubmitNear(el: HTMLElement) {
  const form = el.closest("form");
  return form?.querySelector<HTMLButtonElement>("button[type='submit'], input[type='submit']") || null;
}

function loadPos(key: string, w: number, h: number): FabPos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FabPos;
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    return clampPanel(parsed.left, parsed.top, w, h);
  } catch {
    return null;
  }
}

function loadFab(): FabPos | null {
  return loadPos(FAB_STORE, 92, 92);
}

function savePos(key: string, pos: FabPos | null) {
  if (!pos) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(pos));
  } catch {
    /* quota */
  }
}

function clampFab(left: number, top: number): FabPos {
  return clampPanel(left, top, 92, 92);
}

function clampPanel(left: number, top: number, w: number, h: number): FabPos {
  const maxL = Math.max(8, window.innerWidth - w - 8);
  const maxT = Math.max(8, window.innerHeight - h - 8);
  return { left: Math.max(8, Math.min(left, maxL)), top: Math.max(8, Math.min(top, maxT)) };
}

function placeQuip(fab: FabPos): { left: number; top: number; maxWidth: number; side: "left" | "right" | "above" } {
  const pad = 10;
  const fabSize = 92;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ideal = 248;
  const minSide = 132;
  const rightSpace = vw - pad - (fab.left + fabSize);
  const leftSpace = fab.left - pad;
  const aboveSpace = fab.top - pad;
  let side: "left" | "right" | "above";
  if (rightSpace >= minSide && rightSpace >= leftSpace) side = "left";
  else if (leftSpace >= minSide) side = "right";
  else if (aboveSpace >= 44) side = "above";
  else side = rightSpace >= leftSpace ? "left" : "right";

  if (side === "left") {
    const maxWidth = Math.max(96, Math.min(ideal, rightSpace));
    return {
      left: fab.left + fabSize + 8,
      top: Math.max(pad, Math.min(fab.top + 10, vh - 72)),
      maxWidth,
      side,
    };
  }
  if (side === "right") {
    const maxWidth = Math.max(96, Math.min(ideal, leftSpace));
    return {
      left: Math.max(pad, fab.left - 8 - maxWidth),
      top: Math.max(pad, Math.min(fab.top + 10, vh - 72)),
      maxWidth,
      side,
    };
  }
  const maxWidth = Math.min(ideal, vw - pad * 2);
  const left = Math.max(pad, Math.min(fab.left + fabSize / 2 - maxWidth / 2, vw - pad - maxWidth));
  return { left, top: Math.max(pad, fab.top - 56), maxWidth, side: "above" };
}

function Face({ src, initials }: { src: string | null; initials?: string }) {
  return (
    <span className="p5-face" aria-hidden="true">
      {src ? <img src={src} alt="" /> : <b className="p5-face-ini">{initials || "?"}</b>}
    </span>
  );
}

export function P5Messenger() {
  const pathname = usePathname() || "/cluster";
  const router = useRouter();
  const { user } = useAuth();
  const meSrc = assetUrl(user?.avatar_url);
  const meIni = user?.initials || "?";
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(loadLines);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [quipIx, setQuipIx] = useState(0);
  const [fab, setFab] = useState<FabPos | null>(loadFab);
  const [im, setIm] = useState<FabPos | null>(() => loadPos(IM_STORE, 360, 620));
  const [conOpen, setConOpen] = useState(loadConOpen);
  const [agentsOpen, setAgentsOpen] = useState(loadAgentsOpen);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [jobPick, setJobPick] = useState<string | null>(null);
  const [picksOpen, setPicksOpen] = useState(true);
  const [fabHidden, setFabHidden] = useState(loadFabHidden);
  const [summonHost, setSummonHost] = useState<HTMLElement | null>(null);
  const [sess, setSess] = useState<ConsoleSess | null>(null);
  const [termDraft, setTermDraft] = useState("");
  const [termBusy, setTermBusy] = useState(false);
  const [, setView] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<SVGGElement>(null);
  const pawsRef = useRef<SVGGElement>(null);
  const drawnRef = useRef(0);
  const [stage, setStage] = useState<StageShow | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const agentThreadRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<FabPos | null>(fab);
  const imRef = useRef<FabPos | null>(im);
  const dockRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; kind: "fab" | "im" } | null>(null);
  const titleId = useId();
  const consId = useId();
  const agentsId = useId();
  const liveAgents = jobs.filter((j) => j.status === "running").length;
  const pickSet = !busy ? lines.findLast((l) => l.choices?.length)?.choices || [] : [];
  const pickKey = pickSet.map((c) => c.label).join("|");
  const pickedJob = jobPick ? jobs.find((j) => j.id === jobPick) || null : null;
  const pickedLines = jobLines(pickedJob);
  const pool = useMemo(() => (status && !status.online && !status.enabled ? AFK_QUIPS : quipsFor(pathname)), [pathname, status]);
  const quip = pool[quipIx % pool.length];

  useEffect(() => {
    setQuipIx(0);
  }, [pathname]);

  useEffect(() => {
    if (pickKey) setPicksOpen(true);
  }, [pickKey]);

  useEffect(() => {
    if (open) return;
    const t = window.setInterval(() => setQuipIx((n) => n + 1), 11000);
    return () => window.clearInterval(t);
  }, [open, pathname]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORE, JSON.stringify(lines.slice(-40)));
    } catch {
      /* quota */
    }
  }, [lines]);

  useEffect(() => {
    fabRef.current = fab;
  }, [fab]);

  useEffect(() => {
    imRef.current = im;
  }, [im]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(CON_OPEN_STORE, conOpen ? "1" : "0");
    } catch {
      /* quota */
    }
  }, [conOpen]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(AGENTS_OPEN_STORE, agentsOpen ? "1" : "0");
    } catch {
      /* quota */
    }
  }, [agentsOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FAB_HIDE_STORE, fabHidden ? "1" : "0");
    } catch {
      /* quota */
    }
  }, [fabHidden]);

  useEffect(() => {
    setSummonHost(document.querySelector(".rail-mona") as HTMLElement | null);
  }, [fabHidden]);

  useLayoutEffect(() => {
    if (!open || (!conOpen && !agentsOpen)) return;
    const dock = dockRef.current;
    const drawer = dock?.querySelector(
      ".p5-console-drawer[data-open='true'], .p5-agents-drawer[data-open='true']",
    ) as HTMLElement | null;
    if (!dock || !drawer) return;
    const box = drawer.getBoundingClientRect();
    if (box.left >= 8) return;
    const shift = 8 - box.left;
    setIm((cur) => {
      const d = dock.getBoundingClientRect();
      return clampPanel((cur?.left ?? d.left) + shift, cur?.top ?? d.top, d.width, d.height);
    });
  }, [conOpen, agentsOpen, open]);

  useEffect(() => {
    const node = termRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [sess, termBusy]);

  useEffect(() => {
    const node = agentThreadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [jobPick, pickedLines.length, pickedJob?.status, pickedJob?.doing]);

  useEffect(() => {
    const onResize = () => {
      setFab((cur) => (cur ? clampFab(cur.left, cur.top) : cur));
      setIm((cur) => {
        if (!cur) return cur;
        const el = dockRef.current;
        const box = el?.getBoundingClientRect();
        return clampPanel(cur.left, cur.top, box?.width || 360, box?.height || 620);
      });
      setView((n) => n + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    const t = window.setTimeout(() => inputRef.current?.focus(), 280);
    return () => window.clearTimeout(t);
  }, [open, lines, busy]);

  useEffect(() => {
    let dead = false;
    const pull = () => {
      api
        .agentStatus()
        .then((s) => {
          if (dead) return;
          setStatus({
            enabled: Boolean(s.enabled),
            online: Boolean(s.online ?? s.enabled),
            model: s.model ?? null,
            can_edit: Boolean(s.can_edit),
            hint: s.hint,
          });
        })
        .catch(() => {
          if (!dead) setStatus({ enabled: false, online: false, model: null, can_edit: false });
        });
    };
    pull();
    const t = window.setInterval(pull, 8000);
    return () => {
      dead = true;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let dead = false;
    const pull = () => {
      api
        .agentJobs()
        .then((out) => {
          if (!dead) setJobs(out.jobs || []);
        })
        .catch(() => {
          if (!dead) setJobs([]);
        });
    };
    pull();
    const t = window.setInterval(pull, 2000);
    return () => {
      dead = true;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const have = new Set(lines.map((l) => l.debriefId).filter((id): id is string => Boolean(id)));
    const extra = jobs.filter((job) => Boolean(job.debrief_id && job.debrief && !have.has(job.debrief_id)));
    if (!extra.length) return;
    setOpen(true);
    setFabHidden(false);
    setLines((cur) => {
      const got = new Set(cur.map((l) => l.debriefId).filter((id): id is string => Boolean(id)));
      const add = extra.filter((job) => job.debrief_id && !got.has(job.debrief_id));
      if (!add.length) return cur;
      let next = cur.map((l) => ({ ...l, choices: undefined }));
      for (const job of add) {
        const minion = job.minion || job.name;
        next = [
          ...next,
          {
            id: nid(),
            role: "assistant" as const,
            text: job.debrief || "",
            at: Date.now(),
            debriefId: job.debrief_id || undefined,
            choices: [
              {
                label: `See ${minion}`,
                tool: "open_agent",
                arguments: { id: job.id },
                hint: "minion radio",
              },
            ],
          },
        ];
      }
      return next;
    });
  }, [jobs, lines]);

  const playRef = useRef(playStage);
  playRef.current = playStage;

  useEffect(() => {
    function onPoint(e: Event) {
      const d = (e as CustomEvent<{ target?: string; action?: string; label?: string }>).detail || {};
      const target = String(d.target || "");
      const el = target ? findControl(target) : null;
      void playRef.current({
        action: String(d.action || "look"),
        label: String(d.label || "look"),
        els: el ? [el] : [],
      });
    }
    window.addEventListener("l12-mona-point", onPoint as EventListener);
    return () => window.removeEventListener("l12-mona-point", onPoint as EventListener);
  }, []);

  useEffect(() => {
    if (!stage) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (isChatChrome(t)) return;
      setStage(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [stage]);

  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent<{ node?: string; host?: string; user?: string }>).detail || {};
      const node = String(d.node || d.host || "node");
      const host = String(d.host || "");
      const user = String(d.user || "root");
      setSess({
        node,
        host,
        user,
        lines: [{ id: nid(), kind: "sys", text: `ssh ${user}@${host || node}` }],
      });
      setOpen(true);
      setConOpen(true);
      setFabHidden(false);
    }
    window.addEventListener("l12-open-console", onOpen as EventListener);
    return () => window.removeEventListener("l12-open-console", onOpen as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      drawnRef.current = 0;
      return;
    }
    const rail = railRef.current;
    const path = pathRef.current;
    const glow = glowRef.current;
    const tip = tipRef.current;
    const svg = path?.ownerSVGElement;
    if (!rail || !path || !svg) return;

    let cancelled = false;
    let raf = 0;
    let walkRaf = 0;
    let pawCount = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function dash(el: SVGPathElement, total: number, shown: number) {
      el.style.strokeDasharray = `${total}`;
      el.style.strokeDashoffset = `${Math.max(0, total - shown)}`;
    }

    function placeTip(at: number) {
      if (!tip || !path) return;
      const total = path.getTotalLength();
      if (!total) {
        tip.setAttribute("opacity", "0");
        return;
      }
      const end = Math.max(0, Math.min(at, total));
      const pt = path.getPointAtLength(end);
      const back = path.getPointAtLength(Math.max(0, end - 10));
      const ang = (Math.atan2(pt.y - back.y, pt.x - back.x) * 180) / Math.PI;
      tip.setAttribute("transform", `translate(${pt.x} ${pt.y}) rotate(${ang})`);
      tip.setAttribute("opacity", "1");
    }

    function layoutPaws(shown: number) {
      const group = pawsRef.current;
      if (!group || !path) return 0;
      const total = path.getTotalLength();
      if (!total || shown < 18) {
        group.replaceChildren();
        return 0;
      }
      const needed: string[] = [];
      let i = 0;
      const gap = 24;
      for (let at = 16; at < shown - 6; at += gap) {
        const pt = path.getPointAtLength(at);
        const back = path.getPointAtLength(Math.max(0, at - 8));
        const ang = (Math.atan2(pt.y - back.y, pt.x - back.x) * 180) / Math.PI;
        const nx = -(pt.y - back.y);
        const ny = pt.x - back.x;
        const nl = Math.hypot(nx, ny) || 1;
        const side = i % 2 === 0 ? 1 : -1;
        needed.push(
          `translate(${pt.x + (nx / nl) * 15 * side} ${pt.y + (ny / nl) * 15 * side}) rotate(${ang + side * 18})`,
        );
        i += 1;
      }
      while (group.childNodes.length > needed.length) {
        group.removeChild(group.lastChild as ChildNode);
      }
      while (group.childNodes.length < needed.length) {
        const wrap = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const inner = document.createElementNS("http://www.w3.org/2000/svg", "g");
        inner.setAttribute("class", "p5-spine-paw");
        inner.innerHTML = PAW_INNER;
        wrap.appendChild(inner);
        group.appendChild(wrap);
      }
      needed.forEach((transform, idx) => {
        const wrap = group.childNodes[idx] as SVGGElement;
        wrap.setAttribute("transform", transform);
        const inner = wrap.firstElementChild as SVGGElement | null;
        if (!inner) return;
        inner.style.setProperty("--i", String(idx));
        if (reduce) {
          inner.setAttribute("opacity", "1");
          inner.removeAttribute("transform");
        }
      });
      return needed.length;
    }

    function lightPaws(count: number, now: number) {
      const group = pawsRef.current;
      if (!group || count < 1) return;
      const stepMs = 260;
      const cycle = Math.max(stepMs, count * stepMs);
      const head = (now % cycle) / stepMs;
      for (let i = 0; i < count; i += 1) {
        const wrap = group.childNodes[i] as SVGGElement | undefined;
        const inner = wrap?.firstElementChild as SVGGElement | null;
        if (!inner) continue;
        let dist = head - i;
        if (dist < 0) dist += count;
        const glow = dist < 2.4 ? Math.max(0, 1 - dist / 2.4) : 0;
        inner.setAttribute("opacity", (0.78 + 0.22 * glow).toFixed(3));
        inner.setAttribute("transform", `scale(${(1.05 + 0.28 * glow).toFixed(3)})`);
      }
    }

    function startWalk() {
      if (reduce || walkRaf) return;
      const loop = (now: number) => {
        if (cancelled) return;
        lightPaws(pawCount, now);
        walkRaf = window.requestAnimationFrame(loop);
      };
      walkRaf = window.requestAnimationFrame(loop);
    }

    function paint(animate: boolean) {
      window.cancelAnimationFrame(raf);
      if (cancelled || !rail || !path || !svg) return;
      const built = zigzagFrom(rail);
      svg.setAttribute("viewBox", `0 0 ${built.w} ${built.h}`);
      svg.setAttribute("data-trail", animate ? "run" : "done");
      path.setAttribute("d", built.d);
      if (glow) glow.setAttribute("d", built.d);
      if (!built.d) {
        drawnRef.current = 0;
        pawCount = 0;
        if (tip) tip.setAttribute("opacity", "0");
        pawsRef.current?.replaceChildren();
        svg.setAttribute("data-trail", "done");
        return;
      }
      const toLen = path.getTotalLength();
      const fromLen = Math.max(0, Math.min(drawnRef.current, toLen));
      if (!animate || reduce || toLen <= fromLen + 2) {
        dash(path, toLen, toLen);
        if (glow) dash(glow, toLen, toLen);
        drawnRef.current = toLen;
        placeTip(toLen);
        pawCount = layoutPaws(toLen);
        startWalk();
        svg.setAttribute("data-trail", "done");
        return;
      }
      dash(path, toLen, fromLen);
      if (glow) dash(glow, toLen, fromLen);
      placeTip(fromLen);
      pawCount = layoutPaws(fromLen);
      startWalk();
      const ms =
        fromLen < 4 ? Math.min(980, 360 + toLen * 0.32) : Math.min(680, 260 + (toLen - fromLen) * 0.55);
      const start = performance.now();
      const ease = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / ms);
        const shown = fromLen + (toLen - fromLen) * ease(t);
        dash(path, toLen, shown);
        if (glow) dash(glow, toLen, shown);
        placeTip(shown);
        pawCount = layoutPaws(shown);
        drawnRef.current = shown;
        if (t < 1) {
          raf = window.requestAnimationFrame(step);
        } else {
          svg.setAttribute("data-trail", "done");
        }
      };
      raf = window.requestAnimationFrame(step);
    }

    paint(true);
    let lastW = rail.clientWidth;
    let lastH = rail.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (rail.clientWidth === lastW && rail.offsetHeight === lastH) return;
      lastW = rail.clientWidth;
      lastH = rail.offsetHeight;
      paint(false);
    });
    ro.observe(rail);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(walkRaf);
      ro.disconnect();
    };
  }, [open, lines, busy]);

  function addFiles(list: FileList | File[] | null) {
    if (!list || list.length === 0) return;
    setPending((cur) => {
      const next = [...cur];
      for (const file of Array.from(list)) {
        if (next.length >= ATTACH_MAX) break;
        if (file.size > ATTACH_BYTES) continue;
        if (next.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) continue;
        next.push(file);
      }
      return next;
    });
  }

  async function playStage(opts: { action: string; label: string; els: HTMLElement[]; hold?: boolean }) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const box = unionBox(opts.els);
    if (!box) return;
    const to = parkPoint(box);
    const dock = originPoint();
    const dx = to.x - dock.x;
    const dy = to.y - dock.y;
    const len = Math.hypot(dx, dy) || 1;
    const hop = Math.min(88, Math.max(48, len * 0.18));
    const from = { x: to.x - (dx / len) * hop, y: to.y - (dy / len) * hop };
    const d = catWalkPath(from, to);
    const paws = reduce ? [] : pawsAlong(d, 40);
    const walk = reduce ? 160 : Math.min(640, 320 + paws.length * 70);
    const id = nid();
    setStage({
      id,
      action: opts.action,
      label: opts.label,
      d,
      box,
      paws,
      hold: true,
      ms: walk,
      settled: false,
    });
    await sleep(walk);
    setStage((cur) => (cur?.id === id ? { ...cur, settled: true } : cur));
  }

  async function send(text: string, choice?: Choice) {
    if (choice?.tool === "open_agent") {
      setLines((cur) => cur.map((l) => ({ ...l, choices: undefined })));
      openAgents(String(choice.arguments?.id || "") || undefined);
      return;
    }
    const content = text.trim();
    const files = choice ? [] : pending;
    if ((!content && !files.length) || busy) return;
    const userLine: Line = {
      id: nid(),
      role: "user",
      text: content || (files.length ? files.map((f) => f.name).join(", ") : ""),
      at: Date.now(),
      files: files.map((f) => ({ name: f.name, kind: f.type.startsWith("image/") ? "image" : "file" })),
    };
    const next = [...lines.map((l) => ({ ...l, choices: undefined })), userLine];
    setLines(next);
    setDraft("");
    setPending([]);
    setStage(null);
    setBusy(true);
    const hunt = huntFor(choice?.tool, choice?.arguments);
    const huntEl = hunt.target ? findControl(hunt.target) : null;
    if (huntEl) {
      void playStage({
        action: "hunt",
        label: hunt.label,
        els: [huntEl],
      });
    }
    try {
      const ids: string[] = [];
      for (const file of files) {
        const row = await api.uploadAgentAttachment(file);
        ids.push(row.id);
      }
      const history = next
        .filter((l) => l.id !== "w1" && l.id !== "w2")
        .map((l) => ({ role: l.role, content: (l.text || "").slice(0, 8000) }))
        .filter((m) => m.content.trim())
        .slice(-24);
      const payload = history.length ? history : [{ role: "user" as const, content: content || "Please read the attached file(s)." }];
      const out = await api.agentChat(payload, {
        path: pathname,
        execute: choice
          ? { tool: choice.tool, arguments: choice.arguments || {}, label: choice.label }
          : undefined,
        attachment_ids: ids,
      });
      const bits = splitBubbles(out.reply || "") || [];
      const spoken = bits.length ? bits : ["Heh."];
      const now = Date.now();
      const picks = out.choices || [];
      setLines((cur) => [
        ...cur,
        ...spoken.map((text, i) => ({
          id: nid(),
          role: "assistant" as const,
          text,
          at: now + i,
          choices: i === spoken.length - 1 && picks.length ? picks : undefined,
        })),
      ]);
      if (out.ui?.length) await applyUi(router, out.ui, ingestConsole, playStage, openAgents);
      if (out.mutated && !out.ui?.some((c) => c.kind === "highlight" && (c.action === "remove" || c.action === "add"))) {
        window.dispatchEvent(new Event("l12-refresh"));
      }
    } catch (err) {
      const msg = chatFailLine(err);
      setLines((cur) => [...cur, { id: nid(), role: "assistant", text: msg, at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function ingestConsole(cmd: UiCmd) {
    const node = String(cmd.node || sess?.node || "node");
    const host = String(cmd.host || sess?.host || "");
    const user = String(cmd.user || sess?.user || "root");
    setSess((cur) => {
      const lines = cur && cur.node === node ? [...cur.lines] : [];
      if (!cur || cur.node !== node) {
        const cmdText = String(cmd.command || "");
        const banner = /^\s*(GET|POST)\b/i.test(cmdText)
          ? `redfish ${host || node}`
          : cmdText === "get_health"
            ? "cluster health"
            : `ssh ${user}@${host || node}`;
        lines.push({ id: nid(), kind: "sys", text: banner });
      }
      if (cmd.command) lines.push({ id: nid(), kind: "cmd", text: `$ ${cmd.command}` });
      if (cmd.stdout) lines.push({ id: nid(), kind: "out", text: String(cmd.stdout) });
      if (cmd.stderr) lines.push({ id: nid(), kind: "err", text: String(cmd.stderr) });
      if (cmd.error) lines.push({ id: nid(), kind: "err", text: String(cmd.error) });
      if (cmd.command && cmd.exit != null) lines.push({ id: nid(), kind: "sys", text: `exit ${cmd.exit}` });
      return { node, host, user, lines };
    });
    setConOpen(true);
    setOpen(true);
    setFabHidden(false);
  }

  async function runTerm(command: string) {
    const sessNow = sess;
    if (!sessNow || !command.trim() || termBusy) return;
    const cmd = command.trim();
    setTermDraft("");
    setTermBusy(true);
    setSess((cur) =>
      cur ? { ...cur, lines: [...cur.lines, { id: nid(), kind: "cmd", text: `$ ${cmd}` }] } : cur,
    );
    try {
      const out = await api.agentConsole(sessNow.host || sessNow.node, cmd);
      setSess((cur) => {
        if (!cur) return cur;
        const lines = [...cur.lines];
        if (out.stdout) lines.push({ id: nid(), kind: "out", text: out.stdout });
        if (out.stderr) lines.push({ id: nid(), kind: "err", text: out.stderr });
        if (out.error) lines.push({ id: nid(), kind: "err", text: out.error });
        if (out.exit != null) lines.push({ id: nid(), kind: "sys", text: `exit ${out.exit}` });
        return { ...cur, host: out.os_ip || cur.host, user: out.user || cur.user, lines };
      });
    } catch (err) {
      const msg = chatFailLine(err);
      setSess((cur) => (cur ? { ...cur, lines: [...cur.lines, { id: nid(), kind: "err", text: msg }] } : cur));
    } finally {
      setTermBusy(false);
    }
  }

  function onFabDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const node = e.currentTarget;
    node.setPointerCapture(e.pointerId);
    const box = node.getBoundingClientRect();
    dragRef.current = { x: e.clientX, y: e.clientY, left: box.left, top: box.top, moved: false, kind: "fab" };
  }

  function onFabMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "fab") return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && dx * dx + dy * dy < 64) return;
    drag.moved = true;
    const next = clampFab(drag.left + dx, drag.top + dy);
    fabRef.current = next;
    setFab(next);
  }

  function onFabUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== "fab") return;
    if (drag.moved) {
      savePos(FAB_STORE, fabRef.current);
      return;
    }
    setOpen((v) => !v);
  }

  function onPanelDown(kind: "im") {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const hit = e.target as HTMLElement;
      if (hit.closest("button, input, textarea, a, .p5-term, .p5-thread, .p5-compose, .p5-pending")) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const box = (dockRef.current || e.currentTarget).getBoundingClientRect();
      dragRef.current = { x: e.clientX, y: e.clientY, left: box.left, top: box.top, moved: false, kind };
    };
  }

  function onPanelMove(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "im") return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && dx * dx + dy * dy < 36) return;
    drag.moved = true;
    const panel = dockRef.current?.getBoundingClientRect();
    const w = panel?.width || 360;
    const h = panel?.height || 620;
    const next = clampPanel(drag.left + dx, drag.top + dy, w, h);
    imRef.current = next;
    setIm(next);
  }

  function onPanelUp(kind: "im") {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== kind || !drag.moved) return;
    savePos(IM_STORE, imRef.current);
  }

  function toggleConsole() {
    setAgentsOpen(false);
    setConOpen((cur) => {
      const next = !cur;
      if (next && !sess) {
        setSess({
          node: "idle",
          host: "",
          user: "root",
          lines: [{ id: nid(), kind: "sys", text: "idle. pick a node on Cluster, or ask Mona to open a console." }],
        });
      }
      return next;
    });
  }

  function openAgents(id?: string) {
    setConOpen(false);
    setAgentsOpen(true);
    if (id) setJobPick(id);
    setOpen(true);
    setFabHidden(false);
  }

  function toggleAgents() {
    setConOpen(false);
    setAgentsOpen((cur) => !cur);
  }

  async function stopJob(id: string) {
    try {
      await api.stopAgentJob(id);
      const out = await api.agentJobs();
      setJobs(out.jobs || []);
    } catch {
      /* ignore */
    }
  }

  const fabStyle = fab
    ? ({ left: `${fab.left}px`, top: `${fab.top}px`, right: "auto", bottom: "auto" } as const)
    : undefined;
  const imStyle = im
    ? ({ left: `${im.left}px`, top: `${im.top}px`, right: "auto", bottom: "auto" } as const)
    : undefined;
  const quipPlace = fab && typeof window !== "undefined" ? placeQuip(fab) : null;
  const quipStyle = quipPlace
    ? ({
        left: `${quipPlace.left}px`,
        top: `${quipPlace.top}px`,
        right: "auto",
        bottom: "auto",
        maxWidth: `${quipPlace.maxWidth}px`,
      } as const)
    : undefined;
  const botOn = Boolean(status?.online);

  function hideFab(e: ReactPointerEvent<HTMLElement>) {
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    setFabHidden(true);
  }

  function summonMona() {
    setFabHidden(false);
    setOpen(true);
  }

  return (
    <>
      {fabHidden && summonHost
        ? createPortal(
            <button type="button" className="nav-link p5-summon" title="Mona" onClick={summonMona}>
              <span className="nav-ico">
                <img src={CAT} alt="" />
              </span>
              <span className="nav-label">Mona</span>
            </button>,
            summonHost,
          )
        : null}
      {!open && !fabHidden ? (
        <p
          className="p5-quip"
          role="status"
          data-placed={fab ? "true" : undefined}
          data-side={quipPlace?.side}
          style={quipStyle}
        >
          {quip}
        </p>
      ) : null}
      {!open && !fabHidden ? (
        <button
          type="button"
          className="p5-fab"
          data-placed={fab ? "true" : undefined}
          style={fabStyle}
          onPointerDown={onFabDown}
          onPointerMove={onFabMove}
          onPointerUp={onFabUp}
          onPointerCancel={onFabUp}
          aria-label="Open Mona chat"
          aria-expanded={false}
          title="Drag to move. Click to open."
        >
          <img src={CAT_HOVER} alt="" draggable={false} />
          <span
            role="button"
            tabIndex={0}
            className="p5-fab-x"
            aria-label="Hide Mona"
            title="Hide Mona"
            onPointerDown={hideFab}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              setFabHidden(true);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setFabHidden(true);
            }}
          >
            ×
          </span>
        </button>
      ) : null}

      {open ? (
        <div
          ref={dockRef}
          className="p5-dock"
          data-placed={im ? "true" : undefined}
          data-con={conOpen ? "open" : "shut"}
          data-agents={agentsOpen ? "open" : "shut"}
          style={imStyle}
          onPointerDown={onPanelDown("im")}
          onPointerMove={onPanelMove}
          onPointerUp={() => onPanelUp("im")}
          onPointerCancel={() => onPanelUp("im")}
        >
          <aside
            className="p5-console-drawer"
            data-open={conOpen ? "true" : undefined}
            aria-hidden={!conOpen}
            aria-labelledby={consId}
          >
            <header className="p5-con-head">
              <strong id={consId}>CONSOLE</strong>
              <small>{sess ? `${sess.user}@${sess.host || sess.node}` : "idle"}</small>
            </header>
            <div className="p5-term" ref={termRef}>
              {(sess?.lines || []).map((line) => (
                <pre key={line.id} className={`p5-term-line p5-term-line--${line.kind}`}>
                  {line.text}
                </pre>
              ))}
              {termBusy ? <p className="p5-term-wait">working…</p> : null}
            </div>
            <form
              className="p5-compose p5-con-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void runTerm(termDraft);
              }}
            >
              <div className="p5-compose-row">
                <input
                  value={termDraft}
                  onChange={(e) => setTermDraft(e.target.value)}
                  placeholder="command…"
                  disabled={termBusy || !sess || sess.node === "idle"}
                  aria-label="Console command"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="p5-send" disabled={termBusy || !termDraft.trim()}>
                  RUN
                </button>
              </div>
            </form>
          </aside>
          <button
            type="button"
            className="p5-con-tab"
            aria-expanded={conOpen}
            aria-controls={consId}
            title={conOpen ? "Hide console" : "Show console"}
            onClick={toggleConsole}
          >
            <span>CONSOLE</span>
          </button>
          <aside
            className="p5-agents-drawer"
            data-open={agentsOpen ? "true" : undefined}
            data-chat={jobPick ? "true" : undefined}
            aria-hidden={!agentsOpen}
            aria-labelledby={agentsId}
            data-mona="agents"
          >
            {jobPick ? (
              <>
                <header className="p5-con-head p5-agent-chat-head">
                  <button type="button" className="p5-agent-back" onClick={() => setJobPick(null)} aria-label="Back to agents">
                    ←
                  </button>
                  <div className="p5-agent-who">
                    <strong id={agentsId}>{pickedJob?.minion || pickedJob?.name || "MINION"}</strong>
                    <small data-on={pickedJob?.status === "running" ? "busy" : pickedJob?.status === "failed" ? "false" : "true"}>
                      {pickedJob?.status === "running"
                        ? pickedJob.doing || pickedJob.mission || "on it"
                        : pickedJob?.status === "failed"
                          ? pickedJob.doing || "failed"
                          : pickedJob?.debrief
                            ? "reported"
                            : pickedJob?.status || "loading"}
                    </small>
                  </div>
                  {pickedJob?.status === "running" ? (
                    <button type="button" className="p5-agent-stop" onClick={() => void stopJob(pickedJob.id)}>
                      STOP
                    </button>
                  ) : null}
                </header>
                <div className="p5-thread p5-agent-thread" ref={agentThreadRef}>
                  <div className="p5-rail">
                    {pickedLines.map((line, i) => (
                      <article
                        key={line.id}
                        className={`p5-row p5-row--assistant${line.kind === "sys" ? " p5-row--sys" : ""}`}
                        style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                      >
                        <div className="p5-stack">
                          <div className="p5-bubble">
                            <div className="p5-bubble-in">
                              <p>{line.text}</p>
                            </div>
                          </div>
                          <Face src={CAT} />
                        </div>
                        <time dateTime={new Date(line.at).toISOString()}>{clock(line.at)}</time>
                      </article>
                    ))}
                    {pickedJob?.status === "running" ? (
                      <article className="p5-row p5-row--assistant p5-row--typing">
                        <div className="p5-stack">
                          <div className="p5-bubble">
                            <div className="p5-bubble-in">
                              <p className="p5-dots" aria-label="agent working">
                                <i />
                                <i />
                                <i />
                              </p>
                            </div>
                          </div>
                          <Face src={CAT} />
                        </div>
                      </article>
                    ) : null}
                    {!pickedLines.length && pickedJob?.status !== "running" ? (
                      <p className="p5-agent-empty">Quiet so far. Waiting on this minion.</p>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <>
                <header className="p5-con-head">
                  <strong id={agentsId}>AGENTS</strong>
                  <small>{liveAgents ? `${liveAgents} on a job` : jobs.length ? "crew idle" : "no minions out"}</small>
                </header>
                <div className="p5-agents">
                  {jobs.length ? (
                    jobs.map((job) => (
                      <article key={job.id} className="p5-agent" data-status={job.status}>
                        <button type="button" className="p5-agent-hit" onClick={() => setJobPick(job.id)}>
                          <strong>{job.minion || job.name}</strong>
                          <em>
                            {job.status === "running"
                              ? "on it"
                              : job.debrief
                                ? "reported"
                                : job.status}
                          </em>
                          <span>{job.doing || job.mission || "waiting"}</span>
                        </button>
                      </article>
                    ))
                  ) : (
                    <p className="p5-agent-empty">No minions out. Ask me to send one.</p>
                  )}
                </div>
              </>
            )}
          </aside>
          <button
            type="button"
            className="p5-agent-tab"
            data-mona="agents"
            data-live={liveAgents ? "true" : undefined}
            aria-expanded={agentsOpen}
            aria-controls={agentsId}
            title={agentsOpen ? "Hide agents" : "Show agents"}
            onClick={toggleAgents}
          >
            <span>AGENTS</span>
          </button>
          <div
            className="p5-im"
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
          >
          <div className="p5-wipe" aria-hidden="true" />
          <div className="p5-noise" aria-hidden="true" />
          <header className="p5-head" title="Drag to move">
            <div className="p5-head-slash" aria-hidden="true" />
            <div className="p5-head-inner">
              <b className="p5-im-mark">IM</b>
              <div className="p5-who">
                <strong id={titleId}>MONA</strong>
                <small data-on={busy ? "busy" : botOn ? "true" : "false"}>
                  {busy ? "on it" : botOn ? "online" : "away"}
                </small>
              </div>
              <button type="button" className="p5-x" onClick={() => setOpen(false)} aria-label="Close chat">
                <span>×</span>
              </button>
            </div>
          </header>
          {!botOn ? (
            <p className="p5-afk" role="status">
              AFK. No Grok key yet. Settings, then I&apos;m back.
            </p>
          ) : null}

          <div className="p5-talk" data-picks={pickSet.length ? (picksOpen ? "open" : "shut") : undefined}>
          <div
            className="p5-thread"
            ref={listRef}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
          >
            <div className="p5-rail" ref={railRef}>
              <svg className="p5-spine" aria-hidden="true">
                <path className="p5-spine-glow" ref={glowRef} />
                <path className="p5-spine-draw" ref={pathRef} />
                <g className="p5-spine-paws" ref={pawsRef} />
                <g className="p5-spine-tip" ref={tipRef} opacity="0">
                  <polygon points="10,0 -7,-7 -7,7" />
                </g>
              </svg>
              {lines.map((line, i) => (
                <article
                  key={line.id}
                  className={`p5-row p5-row--${line.role}`}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <div className="p5-stack">
                    <div className="p5-bubble">
                      <div className="p5-bubble-in">
                        {line.files?.length ? (
                          <ul className="p5-files">
                            {line.files.map((f) => (
                              <li key={f.name}>{f.name}</li>
                            ))}
                          </ul>
                        ) : null}
                        <p>{cleanText(line.text)}</p>
                      </div>
                    </div>
                    {line.role === "assistant" ? (
                      <Face src={CAT} />
                    ) : (
                      <Face src={meSrc} initials={meIni} />
                    )}
                  </div>
                  <time dateTime={new Date(line.at).toISOString()}>{clock(line.at)}</time>
                </article>
              ))}
              {busy ? (
                <article className="p5-row p5-row--assistant p5-row--typing">
                  <div className="p5-stack">
                    <div className="p5-bubble">
                      <div className="p5-bubble-in">
                        <p className="p5-dots" aria-label="Mona is thinking">
                          <i />
                          <i />
                          <i />
                        </p>
                      </div>
                    </div>
                    <Face src={CAT} />
                  </div>
                </article>
              ) : null}
              {!busy && lines.length <= WELCOME.length ? (
                <div className="p5-prompts">
                  {PROMPTS.map((p) => (
                    <button key={p} type="button" onClick={() => void send(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {pending.length ? (
              <ul className="p5-pending">
                {pending.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <span>{f.name}</span>
                    <button
                      type="button"
                      className="p5-pending-x"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {pickSet.length ? (
            <div className="p5-choices" data-open={picksOpen ? "true" : "false"} role="group" aria-label="Suggested actions">
              <button
                type="button"
                className="p5-choices-toggle"
                aria-expanded={picksOpen}
                aria-label={picksOpen ? "Hide suggestions" : "Show suggestions"}
                onClick={() => setPicksOpen((cur) => !cur)}
              >
                <span className="p5-choices-kicker">SELECT</span>
                <b aria-hidden="true">{picksOpen ? "–" : String(pickSet.length).padStart(2, "0")}</b>
              </button>
              {picksOpen
                ? pickSet.map((c) => (
                    <button
                      key={`${c.tool}-${c.label}`}
                      type="button"
                      className="p5-choice"
                      data-tool={c.tool}
                      data-mutating={c.mutating || c.tool === "bmc_reset" || c.tool === "os_exec" ? "true" : undefined}
                      onClick={() => {
                        if (
                          c.tool === "bmc_reset" &&
                          !window.confirm(`${c.label}? This talks to the BMC and can power-cycle the node.`)
                        ) {
                          return;
                        }
                        void send(c.label, c);
                      }}
                    >
                      <span>{c.label}</span>
                      {c.hint ? <small>{c.hint}</small> : null}
                    </button>
                  ))
                : null}
            </div>
          ) : null}
          </div>

          <form
            className="p5-compose"
            data-pending={pending.length}
            onSubmit={onSubmit}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileRef}
              className="p5-file"
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              onInput={(e) => addFiles(e.currentTarget.files)}
              onChange={(e) => {
                addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <div className="p5-compose-row">
              <button
                type="button"
                className="p5-clip"
                disabled={busy}
                aria-label="Attach a file for Mona"
                title="Attach a file"
                onClick={() => fileRef.current?.click()}
              >
                +
              </button>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={pending.length ? "Add a note, or send…" : "Enter message…"}
                maxLength={4000}
                disabled={busy}
                aria-label="Message"
              />
              <button type="submit" className="p5-send" disabled={busy || (!draft.trim() && !pending.length)}>
                SEND
              </button>
            </div>
          </form>
          </div>
        </div>
      ) : null}
      {stage
        ? createPortal(
            <div className="mona-stage" data-action={stage.action} data-settled={stage.settled ? "true" : "false"} aria-hidden="true">
              <svg className="mona-walk" viewBox={`0 0 ${typeof window !== "undefined" ? window.innerWidth : 1280} ${typeof window !== "undefined" ? window.innerHeight : 800}`}>
                <path className="mona-walk-line" d={stage.d} />
                {stage.paws.map((p) => (
                  <g key={p.i} transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
                    <g className="mona-paw" style={{ animationDelay: `${Math.min(p.i * 70, stage.ms - 80)}ms` }} dangerouslySetInnerHTML={{ __html: PAW_INNER }} />
                  </g>
                ))}
              </svg>
              {stage.box ? (
                <>
                  <div
                    className="mona-spot"
                    data-action={stage.action}
                    style={{
                      left: `${stage.box.left}px`,
                      top: `${stage.box.top}px`,
                      width: `${stage.box.width}px`,
                      height: `${Math.min(stage.box.height, typeof window !== "undefined" ? window.innerHeight - stage.box.top - 12 : stage.box.height)}px`,
                    }}
                  />
                  <span className="mona-spot-label" style={spotLabelStyle(stage.box, stage.label)}>
                    {stage.label}
                  </span>
                </>
              ) : (
                <p className="mona-hunt-label">{stage.label}</p>
              )}
              {stage.action === "remove" && stage.box ? (
                <div
                  className="mona-claw"
                  style={{
                    left: `${stage.box.left}px`,
                    top: `${stage.box.top}px`,
                    width: `${stage.box.width}px`,
                    height: `${stage.box.height}px`,
                  }}
                />
              ) : null}
              <span
                className="mona-walker"
                style={
                  {
                    ["--mona-path"]: `path("${stage.d}")`,
                    ["--mona-ms"]: `${stage.ms}ms`,
                  } as CSSProperties
                }
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
