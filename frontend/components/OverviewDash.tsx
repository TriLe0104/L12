"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type {
  ClusterHealth,
  ClusterHealthCard,
  ClusterHealthNode,
  ClusterMetrics,
  MaxLpsInvRack,
  PowerLimiter as PowerLimiterData,
} from "@/lib/cluster";
import { formatKw, formatRackKw } from "@/lib/cluster";
import { NodeConsole } from "@/components/NodeConsole";
import { PodPowerBoard, type PickedNode } from "@/components/PodPowerBoard";

type TelemKind = "racks" | "compute" | "leak" | "temperature" | "system" | "power_shelf" | "psu" | "fans";
type HealthKind = Exclude<TelemKind, "racks" | "compute">;

const HEALTH_CARDS: { key: HealthKind; title: string }[] = [
  { key: "leak", title: "Leak detection" },
  { key: "temperature", title: "Temperature" },
  { key: "system", title: "System" },
  { key: "power_shelf", title: "Power shelf" },
  { key: "psu", title: "PSU" },
  { key: "fans", title: "Fans" },
];

const TELEM_TITLE: Record<TelemKind, string> = {
  racks: "Racks",
  compute: "Compute nodes",
  leak: "Leak detection",
  temperature: "Temperature",
  system: "System",
  power_shelf: "Power shelf",
  psu: "PSU",
  fans: "Fans",
};

function HealthSummary({
  health,
  open,
  onOpen,
}: {
  health: ClusterHealth | null;
  open?: TelemKind | null;
  onOpen?: (kind: TelemKind) => void;
}) {
  const waiting = !(health?.node_count);
  return (
    <div className="summary-strip" data-k="health" data-mona="health">
      {HEALTH_CARDS.map(({ key, title }) => {
        const card = health?.[key] as ClusterHealthCard | undefined;
        const status = waiting ? "unknown" : (card?.status ?? "unknown");
        const counts = card?.counts;
        const clickable = Boolean(onOpen);
        const body =
          key === "leak" && !waiting ? (
            <>
              <span>{title}</span>
              <div className="health-cats">
                <i data-status="ok" data-n={String(counts?.dry ?? 0)}>
                  Dry {counts?.dry ?? 0}
                </i>
                <i data-status="warning" data-n={String(counts?.warn ?? 0)}>
                  Warn {counts?.warn ?? 0}
                </i>
                <i data-status="critical" data-n={String(counts?.leak ?? 0)}>
                  Leak {counts?.leak ?? 0}
                </i>
              </div>
              <small>
                Unknown {counts?.unknown ?? 0}
                {counts?.total != null ? ` · ${counts.total} nodes` : ""}
              </small>
            </>
          ) : key === "temperature" && !waiting ? (
            <>
              <span>{title}</span>
              <div className="health-cats">
                <i data-status="ok" data-n={String(counts?.ok ?? 0)}>
                  OK {counts?.ok ?? 0}
                </i>
                <i data-status="warning" data-n={String(counts?.warn ?? counts?.warning ?? 0)}>
                  Warn {counts?.warn ?? counts?.warning ?? 0}
                </i>
                <i
                  data-status="critical"
                  data-n={String(counts?.critical ?? 0)}
                  className={(counts?.critical ?? 0) > 0 ? "health-hot" : undefined}
                >
                  Hot {counts?.critical ?? 0}
                  {(counts?.critical ?? 0) > 0 ? (
                    <span className="flame" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : null}
                </i>
              </div>
              <small>
                hottest {fmtC(card?.celsius)}
                {counts?.total != null ? ` · ${counts.total} nodes` : ""}
              </small>
            </>
          ) : (
            <>
              <span>{title}</span>
              <b>{waiting ? "—" : (card?.value ?? "—")}</b>
              <small>{waiting ? "No registered BMC" : (card?.label || card?.detail || "")}</small>
            </>
          );
        if (!clickable) {
          return (
            <div key={key} data-status={status}>
              {body}
            </div>
          );
        }
        return (
          <button
            key={key}
            type="button"
            data-status={status}
            data-open={open === key ? "true" : undefined}
            aria-pressed={open === key}
            aria-label={title}
            onClick={() => onOpen?.(key)}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

function fmtC(v?: number | null) {
  return v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}°C`;
}

function fmtW(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} kW` : `${Math.round(v)} W`;
}

function fmtRpm(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k RPM` : `${Math.round(v)} RPM`;
}

type FanItem = NonNullable<NonNullable<ClusterHealthNode["fans"]>["items"]>[number];
type TempItem = NonNullable<NonNullable<ClusterHealthNode["thermal"]>["temps"]>[number];

type FanModule = {
  id: number;
  label: string;
  pwm?: number | null;
  front?: number | null;
  rear?: number | null;
  status: string;
};

function groupFanModules(items?: FanItem[] | null): FanModule[] {
  const map = new Map<number, FanModule>();
  const extra: FanModule[] = [];
  let extraId = 1000;
  for (const it of items || []) {
    const name = it.name || "";
    const idMatch = name.match(/FAN\s*#?\s*(\d+)/i);
    const role = (name.match(/\b(PWM|FRONT|REAR)\b/i)?.[1] || it.kind || "").toUpperCase();
    if (!idMatch) {
      extra.push({
        id: extraId++,
        label: name || "Fan",
        pwm: it.kind === "pwm" ? it.pct : null,
        front: it.kind === "rpm" ? it.rpm : null,
        rear: null,
        status: it.status || "ok",
      });
      continue;
    }
    const id = Number(idMatch[1]);
    const row = map.get(id) || { id, label: `FAN ${id}`, pwm: null, front: null, rear: null, status: "ok" };
    if (role === "PWM" || it.kind === "pwm") row.pwm = it.pct ?? row.pwm;
    else if (role === "FRONT") row.front = it.rpm ?? row.front;
    else if (role === "REAR") row.rear = it.rpm ?? row.rear;
    else if (it.kind === "rpm") {
      if (row.front == null) row.front = it.rpm ?? null;
      else row.rear = it.rpm ?? row.rear;
    }
    if (it.status === "critical") row.status = "critical";
    else if (it.status === "warning" && row.status !== "critical") row.status = "warning";
    map.set(id, row);
  }
  const grouped = [...map.values()].sort((a, b) => a.id - b.id);
  for (const row of grouped) {
    if ((row.pwm ?? 1) === 0 && row.status === "ok") row.status = "warning";
  }
  return grouped.concat(extra);
}

function isNicTemp(t: TempItem) {
  if (/network/i.test(String(t.context || ""))) return true;
  return /bf3|bluefield|cx\d|connectx|\bnic\b|ethernet/i.test(`${t.name || ""} ${t.label || ""}`);
}

function isGpuTemp(t: TempItem) {
  if (/gpusubsystem/i.test(String(t.context || ""))) return true;
  return /ProcessorModule_|GPU\s*\d/i.test(`${t.name || ""} ${t.label || ""}`);
}

function tempKindLabel(t: TempItem) {
  if (isNicTemp(t)) return "NIC";
  const s = `${t.name || ""} ${t.label || ""} ${t.context || ""}`;
  if (isGpuTemp(t)) return /exhaust/i.test(s) ? "GPU exh" : "GPU";
  if (/inlet/i.test(s)) return "Inlet";
  if (/exhaust/i.test(s)) return "Exhaust";
  if (/cpu|dimm|memory/i.test(s)) return "CPU";
  if (/ssd|nvme|drive/i.test(s)) return "Drive";
  if (/\bbmc\b/i.test(s)) return "BMC";
  if (/front.?io|io.?board/i.test(s)) return "I/O";
  return t.context || "Sensor";
}

function gpuIndexFromName(name?: string | null) {
  const m = String(name || "").match(/ProcessorModule_(\d+)_(?:Inlet|Exhaust)_Temp_(\d+)/i);
  if (!m) return null;
  const idx = Number(m[1]) * 2 + Number(m[2]);
  return idx >= 0 && idx <= 3 ? idx : null;
}

function gpuTemps(live?: ClusterHealthNode | null): { index: number; label: string; celsius: number | null }[] {
  const fromCard = live?.thermal?.gpu_temps;
  if (fromCard?.length) {
    const map = new Map(fromCard.map((g) => [g.index ?? -1, g.celsius ?? null]));
    return [0, 1, 2, 3].map((i) => ({ index: i, label: `GPU ${i}`, celsius: map.get(i) ?? null }));
  }
  const found = new Map<number, number>();
  for (const t of live?.thermal?.temps || []) {
    if (t.celsius == null || !Number.isFinite(t.celsius)) continue;
    const idx = gpuIndexFromName(t.name);
    if (idx == null) continue;
    if (/exhaust/i.test(t.name || "")) continue;
    const prev = found.get(idx);
    if (prev == null || t.celsius > prev) found.set(idx, t.celsius);
  }
  return [0, 1, 2, 3].map((i) => ({ index: i, label: `GPU ${i}`, celsius: found.get(i) ?? null }));
}

function tempTone(c?: number | null) {
  if (c == null || !Number.isFinite(c)) return "unknown";
  if (c >= 85) return "critical";
  if (c >= 75) return "warning";
  return "ok";
}

function sortedTemps(temps?: TempItem[] | null): TempItem[] {
  return [...(temps || [])].sort((a, b) => {
    const rank = (t: TempItem) => (isNicTemp(t) ? 0 : isGpuTemp(t) ? 1 : 2);
    const d = rank(a) - rank(b);
    if (d) return d;
    return (b.celsius ?? 0) - (a.celsius ?? 0);
  });
}

const POWER_OPTS: { id: string; label: string; warn?: boolean }[] = [
  { id: "On", label: "Power on" },
  { id: "GracefulShutdown", label: "Shut down", warn: true },
  { id: "ForceOff", label: "Force off", warn: true },
  { id: "GracefulRestart", label: "Restart", warn: true },
  { id: "ForceRestart", label: "Force restart", warn: true },
];

function NodePanel({
  picked,
  live,
  consoleOpen,
  onConsole,
  onClose,
}: {
  picked: PickedNode;
  live: ClusterHealthNode | null;
  consoleOpen: boolean;
  onConsole: () => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const editor = canEdit(user);
  const [powerOpen, setPowerOpen] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerNote, setPowerNote] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const st = live?.status || (picked.bmcIp ? "unknown" : "empty");
  const leak = live?.leak;
  const th = live?.thermal;
  const sys = live?.system;
  const fans = live?.fans;
  const pw = live?.power;
  const cbc = live?.cbc;
  const powerLabel = sys?.power_state || "Power";

  useEffect(() => {
    if (!powerOpen) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setPowerOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [powerOpen]);

  async function applyPower(resetType: string, warn?: boolean) {
    if (!picked.bmcIp || !editor) return;
    if (warn && !window.confirm(`${resetType} on ${picked.hostname || picked.bmcIp}?`)) return;
    setPowerBusy(true);
    setPowerNote(null);
    setPowerOpen(false);
    try {
      await api.nodePower(picked.bmcIp, resetType);
      setPowerNote(`${resetType} sent`);
    } catch (err) {
      setPowerNote(err instanceof Error ? err.message : "Power command failed");
    } finally {
      setPowerBusy(false);
    }
  }

  function openConsole() {
    onConsole();
  }

  return (
    <aside className="rack-panel node-telem-panel" aria-label="Node telemetry" onPointerDown={(e) => e.stopPropagation()}>
      <header className="rack-panel-head">
        <nav className="rack-panel-tabs">
          <button type="button" data-active="true">
            Node telemetry
          </button>
        </nav>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="rack-panel-title">
        <strong>{picked.hostname || picked.label || `Node ${picked.index}`}</strong>
        <span>
          Slot {picked.index}
          {picked.bmcIp ? ` · ${picked.bmcIp}` : " · no BMC"}
          {live?.serial ? ` · ${live.serial}` : ""}
          {live?.vendor ? ` · ${live.vendor}` : ""}
        </span>
        <div className="rack-chips">
          <span className="chip" data-tone={st === "ok" ? "on" : st === "critical" ? "off" : "idle"}>
            {st === "ok" ? "OK" : st === "empty" ? "Empty" : live?.error ? "Unreachable" : st}
          </span>
          <div className="power-ctl" ref={menuRef}>
            <button
              type="button"
              className="chip chip-btn"
              data-tone={String(powerLabel).toLowerCase() === "on" ? "on" : "off"}
              disabled={!picked.bmcIp || !editor || powerBusy}
              aria-haspopup="menu"
              aria-expanded={powerOpen}
              onClick={() => setPowerOpen((v) => !v)}
            >
              {powerBusy ? "…" : powerLabel}
              <span aria-hidden>▾</span>
            </button>
            {powerOpen ? (
              <menu className="power-menu">
                {POWER_OPTS.map((opt) => (
                  <button key={opt.id} type="button" data-warn={opt.warn || undefined} onClick={() => void applyPower(opt.id, opt.warn)}>
                    {opt.label}
                  </button>
                ))}
              </menu>
            ) : null}
          </div>
          <button
            type="button"
            className="chip chip-btn"
            data-open={consoleOpen ? "true" : undefined}
            aria-pressed={consoleOpen}
            onClick={openConsole}
            disabled={!picked.bmcIp && !picked.osIp}
          >
            Console
          </button>
        </div>
        {powerNote ? <small className="power-note">{powerNote}</small> : null}
      </div>
      <dl className="node-telem-dl node-login">
        <div>
          <dt>BMC</dt>
          <dd>
            {picked.bmcUser || "—"} / {picked.bmcPassword || "—"}
          </dd>
          <small>{picked.bmcIp || "no IP"}</small>
        </div>
        <div>
          <dt>OS</dt>
          <dd>
            {picked.osUser || "—"} / {picked.osPassword || "—"}
          </dd>
          <small>{picked.osIp || "no IP"}</small>
        </div>
      </dl>
      {!picked.bmcIp ? (
        <p className="widget-empty">No BMC address on this slot.</p>
      ) : !live || live.error ? (
        <p className="widget-empty">{live?.error || "Waiting for Redfish…"}</p>
      ) : (
        <dl className="node-telem-dl">
          <div>
            <dt>Leak detection</dt>
            <dd data-status={leak?.status}>
              {leak?.status === "ok" ? "Dry" : leak?.status === "critical" ? "Leak" : leak?.status || "—"}
              {leak?.total ? ` · ${leak.ok ?? 0}/${leak.total}` : ""}
            </dd>
            {(leak?.detectors || []).map((d) => (
              <small key={d.label}>
                {d.label} · {d.detector_state || d.status}
              </small>
            ))}
          </div>
          <div>
            <dt>Temperature</dt>
            <dd data-status={th?.status}>
              {gpuTemps(live)
                .map((g) => `GPU${g.index} ${fmtC(g.celsius)}`)
                .join(" · ") || `${fmtC(th?.hottest_c)}${th?.hottest ? ` · ${th.hottest}` : ""}`}
            </dd>
            <small>
              Inlet {fmtC(th?.inlet_c)} · Exhaust {fmtC(th?.exhaust_c)}
            </small>
            {sortedTemps(th?.temps).map((t, i) => (
              <small key={t.name || t.label || i} data-kind={isNicTemp(t) ? "nic" : undefined}>
                {isNicTemp(t) ? "NIC · " : ""}
                {t.label || t.name} · {fmtC(t.celsius)}
              </small>
            ))}
          </div>
          <div>
            <dt>System</dt>
            <dd data-status={sys?.status}>{sys?.model || live.product || "GB NVL"}</dd>
            <small>
              HGX {live.hgx?.status === "ok" ? "OK" : live.hgx?.status || "—"}
              {live.hgx?.model ? ` · ${live.hgx.model}` : ""}
            </small>
            {live.hgx?.power_limit_w != null ? <small>HGX limit {fmtW(live.hgx.power_limit_w)}</small> : null}
          </div>
          <div>
            <dt>Power shelf</dt>
            <dd data-status={pw?.status || cbc?.status}>{pw?.pdb_model || pw?.pdb || "PDB"}</dd>
            <small>
              {cbc?.total ? `${cbc.ok ?? 0}/${cbc.total} CBC` : "No CBC"}
              {pw?.watts != null ? ` · ${fmtW(pw.watts)}` : ""}
            </small>
            {(cbc?.items || []).map((c) => (
              <small key={c.id || c.model}>
                {c.id || "CBC"} · {c.health || "—"}
                {c.power_state ? ` · ${c.power_state}` : ""}
              </small>
            ))}
          </div>
          <div>
            <dt>PSU</dt>
            <dd data-status={pw?.status}>{fmtW(pw?.watts)}</dd>
            <small>{pw?.psu_count ? `${pw.psu_count} PSU` : "Chassis HSC meter"}</small>
          </div>
          <div>
            <dt>Fans</dt>
            <dd data-status={fans?.status}>
              {fans?.running != null && fans?.count
                ? `${fans.running}/${fans.count} running`
                : fans?.pwm_pct != null
                  ? `${Math.round(fans.pwm_pct)}%`
                  : fmtRpm(fans?.rpm_avg)}
            </dd>
            <small>
              {fans?.pwm_pct != null ? `${Math.round(fans.pwm_pct)}% PWM` : ""}
              {fans?.rpm_avg != null ? `${fans?.pwm_pct != null ? " · " : ""}${fmtRpm(fans.rpm_avg)} avg` : ""}
              {fans?.rpm_min != null ? ` · min ${fmtRpm(fans.rpm_min)}` : ""}
            </small>
            {groupFanModules(fans?.items).map((f) => (
              <small key={f.id} data-status={f.status}>
                {f.label}
                {f.pwm != null ? ` · ${Math.round(f.pwm)}%` : ""}
                {f.front != null ? ` · F ${fmtRpm(f.front)}` : ""}
                {f.rear != null ? ` · R ${fmtRpm(f.rear)}` : ""}
              </small>
            ))}
          </div>
        </dl>
      )}
    </aside>
  );
}

function liveForIp(health: ClusterHealth | null, ip?: string | null) {
  const bmc = (ip || "").trim();
  if (!bmc) return undefined;
  return health?.nodes?.find((n) => n.bmc_ip === bmc);
}

function populatedNodes(inv: MaxLpsInvRack[], health: ClusterHealth | null) {
  const rows: { rack: MaxLpsInvRack; index: number; hostname: string | null; bmcIp: string; key: string }[] = [];
  for (const rack of inv) {
    for (const n of rack.nodes ?? []) {
      const bmc = (n.bmc_ip || "").trim();
      if (!bmc) continue;
      rows.push({
        rack,
        index: n.index,
        hostname: n.hostname,
        bmcIp: bmc,
        key: `${rack.id}:${n.index}`,
      });
    }
  }
  if (rows.length) return rows.sort((a, b) => a.rack.label.localeCompare(b.rack.label) || a.index - b.index);
  const byId = new Map(inv.map((r) => [r.id, r]));
  for (const n of health?.nodes ?? []) {
    const bmc = (n.bmc_ip || "").trim();
    if (!bmc) continue;
    const rack = (n.rack_id && byId.get(n.rack_id)) || inv[0];
    const index = Number(n.node_index);
    rows.push({
      rack: rack || {
        id: n.rack_id || "rack",
        label: n.rack_id || "Rack",
        serial: null,
        hall: null,
        model: "",
        notes: null,
        origin: "manual",
        enabled: true,
        power_state: "on",
        created_at: null,
        updated_at: null,
        node_count: 0,
        shelf_count: 0,
        gpu_count: 0,
        nodes: [],
        shelves: [],
        gpus: [],
      },
      index: Number.isFinite(index) && index > 0 ? index : rows.length + 1,
      hostname: null,
      bmcIp: bmc,
      key: `${n.rack_id || "rack"}:${n.node_index || rows.length + 1}`,
    });
  }
  return rows.sort((a, b) => a.rack.label.localeCompare(b.rack.label) || a.index - b.index);
}

function leakLabel(live?: ClusterHealthNode) {
  const st = live?.leak?.status;
  if (st === "ok") return live?.leak?.total ? `Dry · ${live.leak.ok ?? 0}/${live.leak.total}` : "Dry";
  if (st === "critical") return "Leak";
  if (st === "warning") return "Warn";
  if (live?.error) return "Unreachable";
  return live ? st || "—" : "—";
}

function TelemList({
  kind,
  health,
  inv,
  power,
  onClose,
  onPick,
}: {
  kind: TelemKind;
  health: ClusterHealth | null;
  inv: MaxLpsInvRack[];
  power: PowerLimiterData | null;
  onClose: () => void;
  onPick: (node: PickedNode) => void;
}) {
  const nodes = populatedNodes(inv, health);
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOpenKeys({});
  }, [kind]);
  const toggleOpen = (key: string, e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setOpenKeys((cur) => ({ ...cur, [key]: !cur[key] }));
  };
  const pick = (row: (typeof nodes)[number]) =>
    onPick({
      key: row.key,
      rackId: row.rack.id,
      index: row.index,
      bmcIp: row.bmcIp,
      hostname: row.hostname,
      label: row.rack.label,
    });

  const columns =
    kind === "racks"
      ? ["Rack", "Nodes", "Power", "Status"]
      : kind === "compute"
        ? ["Slot", "Host", "BMC", "Status"]
        : kind === "leak"
          ? ["Slot", "Host", "Leak", "Detectors"]
          : kind === "temperature"
            ? ["Slot", "GPU 0", "GPU 1", "GPU 2", "GPU 3"]
            : kind === "system"
              ? ["Slot", "Host", "Power", "Model"]
              : kind === "power_shelf"
                ? ["Slot", "Host", "Shelves", "CBC"]
                : kind === "psu"
                  ? ["Slot", "Host", "Watts", "Source"]
                  : ["Slot", "Host", "Fans", "PWM"];

  return (
    <aside className="rack-panel node-telem-panel telem-list" aria-label={TELEM_TITLE[kind]} onPointerDown={(e) => e.stopPropagation()}>
      <header className="rack-panel-head">
        <nav className="rack-panel-tabs">
          <button type="button" data-active="true">
            {TELEM_TITLE[kind]}
          </button>
        </nav>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {kind === "racks" ? (
        inv.length === 0 ? (
          <p className="telem-list-empty">No registered rack.</p>
        ) : (
          <table className="telem-list-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {inv.map((rack) => {
                const bmcNodes = (rack.nodes ?? []).filter((n) => (n.bmc_ip || "").trim());
                const lives = bmcNodes.map((n) => liveForIp(health, n.bmc_ip));
                const pr = power?.racks?.find((r) => r.id === rack.id);
                const watts = pr?.consumed_kw ?? 0;
                const liveMeter = pr?.meter_source === "redfish" || pr?.meter_source === "argus" || watts > 0.05;
                const bad = lives.find((l) => l?.status === "critical") ? "critical" : lives.find((l) => l?.status === "warning") ? "warning" : lives.some((l) => l?.status === "ok") ? "ok" : bmcNodes.length ? "unknown" : "empty";
                const first = bmcNodes[0];
                return (
                  <tr
                    key={rack.id}
                    onClick={() => {
                      if (!first) return;
                      onPick({
                        key: `${rack.id}:${first.index}`,
                        rackId: rack.id,
                        index: first.index,
                        bmcIp: first.bmc_ip,
                        hostname: first.hostname,
                        label: rack.label,
                      });
                    }}
                  >
                    <td>
                      {rack.label}
                      <small>{rack.origin || "manual"}</small>
                    </td>
                    <td>
                      {bmcNodes.length}/{rack.nodes?.length ?? 0}
                    </td>
                    <td>{liveMeter ? formatRackKw(watts) : "—"}</td>
                    <td data-status={bad}>{bad === "ok" ? "OK" : bad === "empty" ? "Empty" : bad}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      ) : nodes.length === 0 ? (
        <p className="telem-list-empty">No compute node with a BMC address.</p>
      ) : (
        <table className="telem-list-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kind === "fans"
              ? nodes.flatMap((row) => {
                  const live = liveForIp(health, row.bmcIp);
                  const modules = groupFanModules(live?.fans?.items);
                  const slot = `n${String(row.index).padStart(2, "0")}`;
                  const host = row.hostname || row.rack.label;
                  const open = Boolean(openKeys[row.key]);
                  const st = live?.fans?.status || live?.status || "unknown";
                  const head = (
                    <tr key={row.key} onClick={() => pick(row)}>
                      <td>
                        <button
                          type="button"
                          className="telem-exp"
                          aria-expanded={open}
                          aria-label={open ? "Collapse fans" : "Expand fans"}
                          onClick={(e) => toggleOpen(row.key, e)}
                        >
                          {open ? "▾" : "▸"}
                        </button>
                        {slot}
                        <small>{row.rack.label}</small>
                      </td>
                      <td>{host}</td>
                      <td data-status={st}>
                        {live?.fans?.running != null && live?.fans?.count
                          ? `${live.fans.running}/${live.fans.count}`
                          : fmtRpm(live?.fans?.rpm_avg)}
                      </td>
                      <td data-status={st}>{live?.fans?.pwm_pct != null ? `${Math.round(live.fans.pwm_pct)}%` : "—"}</td>
                    </tr>
                  );
                  if (!open) return [head];
                  if (!modules.length) {
                    return [
                      head,
                      <tr key={`${row.key}:empty`} className="telem-sub">
                        <td colSpan={4}>No fan telemetry.</td>
                      </tr>,
                    ];
                  }
                  return [
                    head,
                    ...modules.map((fan) => (
                      <tr key={`${row.key}:${fan.id}`} className="telem-sub" onClick={() => pick(row)}>
                        <td>{fan.label}</td>
                        <td data-status={fan.status}>{fan.pwm != null ? `${Math.round(fan.pwm)}% PWM` : "—"}</td>
                        <td data-status={fan.status}>{fmtRpm(fan.front)}</td>
                        <td data-status={fan.status}>{fmtRpm(fan.rear)}</td>
                      </tr>
                    )),
                  ];
                })
              : kind === "temperature"
                ? nodes.flatMap((row) => {
                    const live = liveForIp(health, row.bmcIp);
                    const temps = sortedTemps(live?.thermal?.temps);
                    const gpus = gpuTemps(live);
                    const slot = `n${String(row.index).padStart(2, "0")}`;
                    const host = row.hostname || row.rack.label;
                    const open = Boolean(openKeys[row.key]);
                    const head = (
                      <tr key={row.key} onClick={() => pick(row)}>
                        <td>
                          <button
                            type="button"
                            className="telem-exp"
                            aria-expanded={open}
                            aria-label={open ? "Collapse temperatures" : "Expand temperatures"}
                            onClick={(e) => toggleOpen(row.key, e)}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                          {slot}
                          <small>{host}</small>
                        </td>
                        {gpus.map((g) => (
                          <td key={g.index} data-status={tempTone(g.celsius)}>
                            {fmtC(g.celsius)}
                          </td>
                        ))}
                      </tr>
                    );
                    if (!open) return [head];
                    if (!temps.length) {
                      return [
                        head,
                        <tr key={`${row.key}:empty`} className="telem-sub">
                          <td colSpan={5}>No temperature sensors.</td>
                        </tr>,
                      ];
                    }
                    return [
                      head,
                      <tr key={`${row.key}:subh`} className="telem-sub telem-sub-head">
                        <td>Sensor</td>
                        <td colSpan={2}>Kind</td>
                        <td colSpan={2}>Temp</td>
                      </tr>,
                      ...temps.map((t, i) => {
                        const nic = isNicTemp(t);
                        return (
                          <tr key={`${row.key}:${t.name || t.label || i}`} className="telem-sub" onClick={() => pick(row)}>
                            <td>{t.label || t.name || "sensor"}</td>
                            <td colSpan={2} data-kind={nic ? "nic" : undefined}>
                              {tempKindLabel(t)}
                            </td>
                            <td colSpan={2} data-status={live?.thermal?.status || live?.status}>
                              {fmtC(t.celsius)}
                            </td>
                          </tr>
                        );
                      }),
                    ];
                  })
              : kind === "power_shelf"
                ? nodes.flatMap((row) => {
                    const live = liveForIp(health, row.bmcIp);
                    const shelves = [
                      {
                        id: "PDB",
                        label: "PDB",
                        model: live?.power?.pdb_model || "Power shelf",
                        health: live?.power?.pdb || live?.power?.status || "unknown",
                        power_state: live?.system?.power_state || "—",
                      },
                      ...(live?.cbc?.items || []).map((c, i) => ({
                        id: c.id || `CBC ${i}`,
                        label: c.id || `CBC ${i}`,
                        model: c.model || "CBC",
                        health: c.health || "unknown",
                        power_state: c.power_state || "—",
                      })),
                    ];
                    const slot = `n${String(row.index).padStart(2, "0")}`;
                    const host = row.hostname || row.rack.label;
                    const open = Boolean(openKeys[row.key]);
                    const st = live?.cbc?.status || live?.power?.status || live?.status || "unknown";
                    const head = (
                      <tr key={row.key} onClick={() => pick(row)}>
                        <td>
                          <button
                            type="button"
                            className="telem-exp"
                            aria-expanded={open}
                            aria-label={open ? "Collapse power shelves" : "Expand power shelves"}
                            onClick={(e) => toggleOpen(row.key, e)}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                          {slot}
                          <small>{row.rack.label}</small>
                        </td>
                        <td>{host}</td>
                        <td data-status={st}>{live?.power?.pdb_model || live?.power?.pdb || "—"}</td>
                        <td data-status={st}>
                          {live?.cbc?.total ? `${live.cbc.ok ?? 0}/${live.cbc.total} CBC` : "—"}
                        </td>
                      </tr>
                    );
                    if (!open) return [head];
                    if (!shelves.length) {
                      return [
                        head,
                        <tr key={`${row.key}:empty`} className="telem-sub">
                          <td colSpan={4}>No power shelf telemetry.</td>
                        </tr>,
                      ];
                    }
                    return [
                      head,
                      <tr key={`${row.key}:subh`} className="telem-sub telem-sub-head">
                        <td>Shelf</td>
                        <td>Model</td>
                        <td>State</td>
                        <td>Health</td>
                      </tr>,
                      ...shelves.map((s) => (
                        <tr key={`${row.key}:${s.id}`} className="telem-sub" onClick={() => pick(row)}>
                          <td>{s.label}</td>
                          <td>{s.model}</td>
                          <td>{s.power_state}</td>
                          <td data-status={s.health}>{s.health === "ok" ? "OK" : s.health}</td>
                        </tr>
                      )),
                    ];
                  })
                : nodes.map((row) => {
                    const live = liveForIp(health, row.bmcIp);
                    const st = live?.status || "unknown";
                    const slot = `n${String(row.index).padStart(2, "0")}`;
                    const host = row.hostname || row.rack.label;
                    let c2 = row.bmcIp;
                    let c3 = st === "ok" ? "OK" : live?.error ? "Unreachable" : st;
                    let s3 = st;
                    if (kind === "leak") {
                      c2 = leakLabel(live);
                      c3 = (live?.leak?.detectors || []).map((d) => d.detector_state || d.status).filter(Boolean).join(", ") || "—";
                      s3 = live?.leak?.status || st;
                    } else if (kind === "system") {
                      c2 = live?.system?.power_state || "—";
                      c3 = live?.system?.model || live?.product || "—";
                      s3 = live?.system?.status || st;
                    } else if (kind === "psu") {
                      c2 = fmtW(live?.power?.watts);
                      c3 = live?.power?.psu_count ? `${live.power.psu_count} PSU` : "Chassis HSC";
                      s3 = live?.power?.status || st;
                    }
                    return (
                      <tr key={row.key} onClick={() => pick(row)}>
                        <td>
                          {slot}
                          <small>{row.rack.label}</small>
                        </td>
                        <td>{host}</td>
                        <td data-status={kind === "compute" ? undefined : s3}>{c2}</td>
                        <td data-status={s3}>{c3}</td>
                      </tr>
                    );
                  })}
          </tbody>
        </table>
      )}
    </aside>
  );
}

function Gauge({
  title,
  pct,
  value,
  used,
  total,
  detail,
}: {
  title: string;
  pct: number;
  value: string;
  used: string;
  total: string;
  detail?: string;
}) {
  const r = 42;
  const c = Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  return (
    <article className="gauge">
      <h2>{title}</h2>
      <div className="gauge-arc">
        <svg viewBox="0 0 120 74" aria-hidden>
          <path
            d="M16 66 A 44 44 0 0 1 104 66"
            fill="none"
            className="gauge-track"
            strokeWidth="8"
            strokeLinecap="butt"
          />
          <path
            d="M16 66 A 44 44 0 0 1 104 66"
            fill="none"
            className="gauge-used"
            strokeWidth="8"
            strokeDasharray={`${dash} ${c}`}
            strokeLinecap="butt"
          />
        </svg>
        <strong data-wide={value.length > 5 ? "true" : undefined}>{value}</strong>
      </div>
      <div className="gauge-foot">
        <div>
          <span>Used</span>
          <b>{used}</b>
        </div>
        <div>
          <span>Total</span>
          <b>{total}</b>
        </div>
      </div>
      {detail && <p className="gauge-detail">{detail}</p>}
    </article>
  );
}

function axisRate(v: number) {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}T`;
  if (v >= 10) return `${v.toFixed(0)}G`;
  if (v >= 1) return `${v.toFixed(1)}G`;
  return `${(v * 1000).toFixed(0)}M`;
}

function axisTime(ts: number, spanSec: number) {
  const d = new Date(ts * 1000);
  if (spanSec >= 20 * 3600) {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tickTransform(y: number) {
  if (y <= 0) return "none";
  if (y >= 100) return "translateY(-100%)";
  return "translateY(-50%)";
}

function toLocalInput(ts: number) {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(s: string) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t / 1000 : NaN;
}

function TimeChart({
  series,
  mode,
  label,
  field = "power_kw",
}: {
  series: ClusterMetrics["series"];
  mode: "net" | "disk" | "kw";
  field?: "power_kw" | "gpu_kw";
  label: string;
}) {
  const W = 600;
  const H = 120;
  const x = (i: number) => (i / Math.max(series.length - 1, 1)) * W;
  const spanSec = series.length > 1 ? series[series.length - 1].t - series[0].t : 300;
  const xLabels = [
    series[0] ? axisTime(series[0].t, spanSec) : "",
    series[Math.floor(series.length / 2)] ? axisTime(series[Math.floor(series.length / 2)].t, spanSec) : "",
    series.at(-1) ? axisTime(series[series.length - 1].t, spanSec) : "",
  ];

  if (mode === "kw") {
    const values = series.map((p) => Number(field === "gpu_kw" ? p.gpu_kw : p.power_kw) || 0);
    const peak = Math.max(1, ...values);
    const y = (v: number) => H - (v / peak) * (H - 4);
    const usedLine = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const usedArea = `0,${H} ${usedLine} ${W},${H}`;
    const ticks = [
      { y: 0, text: formatRackKw(peak) },
      { y: 50, text: formatRackKw(peak / 2) },
      { y: 100, text: "0" },
    ];
    return (
      <div className="chart-plot">
        <div className="chart-y" aria-hidden>
          {ticks.map((t) => (
            <span key={t.y} style={{ top: `${t.y}%`, transform: tickTransform(t.y) }}>
              {t.text}
            </span>
          ))}
        </div>
        <svg className="net-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="net-grid" />
          <polygon points={usedArea} className="net-fill-tx" />
          <polyline points={usedLine} className="net-line-tx" />
        </svg>
        <div className="chart-x">
          {xLabels.map((t, i) => (
            <span key={`${i}-${t}`}>{t}</span>
          ))}
        </div>
      </div>
    );
  }

  if (mode === "net") {
    const peak = Math.max(1, ...series.map((p) => Math.max(p.tx_gbps, p.rx_gbps)));
    const mid = H / 2;
    const yTx = (v: number) => mid - (v / peak) * (mid - 2);
    const yRx = (v: number) => mid + (v / peak) * (mid - 2);
    const txLine = series.map((p, i) => `${x(i).toFixed(1)},${yTx(p.tx_gbps).toFixed(1)}`).join(" ");
    const rxLine = series.map((p, i) => `${x(i).toFixed(1)},${yRx(p.rx_gbps).toFixed(1)}`).join(" ");
    const txArea = `0,${mid} ${txLine} ${W},${mid}`;
    const rxArea = `0,${mid} ${rxLine} ${W},${mid}`;
    const ticks = [
      { y: 0, text: `+${axisRate(peak)}` },
      { y: 50, text: "0" },
      { y: 100, text: `−${axisRate(peak)}` },
    ];
    return (
      <div className="chart-plot">
        <div className="chart-y" aria-hidden>
          {ticks.map((t) => (
            <span key={t.y} style={{ top: `${t.y}%`, transform: tickTransform(t.y) }}>
              {t.text}
            </span>
          ))}
        </div>
        <svg className="net-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          <line x1="0" x2={W} y1={mid} y2={mid} className="net-grid" />
          <line x1="0" x2={W} y1="0" y2="0" className="net-grid" />
          <line x1="0" x2={W} y1={H} y2={H} className="net-grid" />
          <polygon points={txArea} className="net-fill-tx" />
          <polygon points={rxArea} className="net-fill-rx" />
          <polyline points={txLine} className="net-line-tx" />
          <polyline points={rxLine} className="net-line-rx" />
        </svg>
        <div className="chart-x">
          {xLabels.map((t, i) => (
            <span key={`${i}-${t}`}>{t}</span>
          ))}
        </div>
      </div>
    );
  }

  const y = (v: number) => H - (v / 100) * H;
  const usedLine = series.map((p, i) => `${x(i).toFixed(1)},${y(p.disk_pct).toFixed(1)}`).join(" ");
  const usedArea = `0,${H} ${usedLine} ${W},${H}`;
  const ticks = [
    { y: 0, text: "100%" },
    { y: 50, text: "50%" },
    { y: 100, text: "0%" },
  ];
  return (
    <div className="chart-plot">
      <div className="chart-y" aria-hidden>
        {ticks.map((t) => (
          <span key={t.y} style={{ top: `${t.y}%`, transform: tickTransform(t.y) }}>
            {t.text}
          </span>
        ))}
      </div>
      <svg className="net-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="net-grid" />
        <polygon points={usedArea} className="net-fill-tx" />
        <polyline points={usedLine} className="net-line-tx" />
      </svg>
      <div className="chart-x">
        {xLabels.map((t, i) => (
          <span key={`${i}-${t}`}>{t}</span>
        ))}
      </div>
    </div>
  );
}

const RANGE_OPTS = [
  { id: "5m", label: "5m" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "custom", label: "Custom" },
] as const;

type RangeId = (typeof RANGE_OPTS)[number]["id"];

const RANGE_LABEL: Record<string, string> = {
  "5m": "Last 5 min",
  "15m": "Last 15 min",
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
};

export function OverviewDash() {
  const [data, setData] = useState<ClusterMetrics | null>(null);
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [power, setPower] = useState<PowerLimiterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeId>("5m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [picked, setPicked] = useState<PickedNode | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [nodeLive, setNodeLive] = useState<ClusterHealthNode | null>(null);
  const [inv, setInv] = useState<MaxLpsInvRack[]>([]);
  const [telem, setTelem] = useState<TelemKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadHealth = () => {
      api
        .clusterHealth()
        .then((d) => {
          if (!cancelled) setHealth(d);
        })
        .catch(() => {
          /* health is additive */
        });
    };
    const load = () => {
      const params =
        range === "custom"
          ? { from_ts: fromLocalInput(customFrom), to_ts: fromLocalInput(customTo) }
          : { range };
      if (range === "custom") {
        const a = params.from_ts;
        const b = params.to_ts;
        if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
          return;
        }
      }
      api
        .clusterMetrics(params)
        .then((d) => {
          if (!cancelled) {
            setData(d);
            if (d.health) setHealth(d.health);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Metrics failed");
        });
      api
        .clusterPower()
        .then((d) => {
          if (!cancelled) setPower(d);
        })
        .catch(() => {
          /* limiter is additive; metrics still render */
        });
      loadHealth();
      api
        .maxlpsInventory()
        .then((d) => {
          if (!cancelled) setInv(d.racks ?? []);
        })
        .catch(() => {
          /* list panel uses health nodes if inventory is empty */
        });
    };
    load();
    const id = window.setInterval(load, 2000);
    const onRefresh = () => load();
    window.addEventListener("l12-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("l12-refresh", onRefresh);
    };
  }, [range, customFrom, customTo]);

  useEffect(() => {
    if (!picked) {
      setNodeLive(null);
      return;
    }
    const fromSnap = picked.bmcIp
      ? (health?.nodes?.find((n) => n.bmc_ip === picked.bmcIp) ?? null)
      : null;
    if (fromSnap) setNodeLive(fromSnap);
    else if (!picked.bmcIp) setNodeLive(null);
  }, [health, picked]);

  useEffect(() => {
    if (!picked?.bmcIp) return;
    let cancelled = false;
    api
      .clusterHealthNode(picked.bmcIp)
      .then((d) => {
        if (!cancelled) setNodeLive(d);
      })
      .catch(() => {
        /* keep snapshot */
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (consoleOpen) {
        setConsoleOpen(false);
        return;
      }
      if (picked) {
        setConsoleOpen(false);
        setPicked(null);
        return;
      }
      if (telem) setTelem(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, telem, consoleOpen]);

  const toggleTelem = (kind: TelemKind) => {
    setConsoleOpen(false);
    setPicked(null);
    setTelem((cur) => (cur === kind ? null : kind));
  };

  const pickNode = (node: PickedNode) => {
    const rack = inv.find((r) => r.id === node.rackId);
    const slot = rack?.nodes?.find((n) => n.index === node.index);
    setPicked({
      ...node,
      osIp: node.osIp || slot?.os_ip || null,
      hostname: node.hostname || slot?.hostname || node.hostname,
      serial: node.serial || slot?.serial || null,
      bmcIp: node.bmcIp || slot?.bmc_ip || node.bmcIp,
      bmcUser: node.bmcUser || slot?.bmc_user || null,
      bmcPassword: node.bmcPassword || slot?.bmc_password || null,
      osUser: node.osUser || slot?.os_username || null,
      osPassword: node.osPassword || slot?.os_password || null,
    });
  };

  const closeOverlays = () => {
    setTelem(null);
    setConsoleOpen(false);
    setPicked(null);
  };

  const last = data?.series.at(-1);
  const windowLabel = useMemo(() => {
    if (range === "custom" && customFrom && customTo) {
      const a = fromLocalInput(customFrom);
      const b = fromLocalInput(customTo);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        return `${axisTime(a, b - a)} – ${axisTime(b, b - a)}`;
      }
    }
    return RANGE_LABEL[range] ?? "Last 5 min";
  }, [range, customFrom, customTo]);

  if (error && !data) {
    return (
      <section className="overview-dash" data-mona="overview">
        <HealthSummary health={health} />
        <p className="cluster-error">{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="overview-dash" data-mona="overview">
        <HealthSummary health={null} />
        <p className="widget-empty">Loading telemetry…</p>
      </section>
    );
  }

  const registered = data.source === "inventory";
  const sensors = data.sensors ?? {};
  const racks = data.size.racks;
  const racksOn = data.size.racks_on ?? 0;
  const gpusPerNode = data.size.gpus_per_node ?? 4;
  const compute = data.size.compute_nodes ?? 0;
  const computeOn = data.size.compute_on ?? 0;
  const livePowerKw = registered ? (data.now.power_kw ?? 0) : 0;
  const powerLive = registered && (Boolean(sensors.power) || livePowerKw > 0);
  const gpuLive = registered ? data.gpu_used : 0;
  const gpuKw = registered ? (data.now.gpu_kw ?? 0) : 0;
  const gpuWattsLive = registered && gpuKw > 0;
  const gpuTdpKw = data.now.gpu_tdp_kw ?? 0;
  const gpuPct = registered ? (data.now.gpu_pct ?? 0) : 0;
  const envelopeKw = data.now.envelope_kw ?? 0;
  const availableKw = data.now.available_kw ?? (envelopeKw - livePowerKw);
  const overheadKw = Math.max(0, livePowerKw - gpuKw);
  const nameplateKw = data.size.nameplate_kw;
  const thresholdPct = power?.threshold_pct ?? power?.stay_under_pct ?? 80;
  const dash = "—";
  const showN = (n: number) => (registered ? n.toLocaleString() : dash);
  const showKw = (kw: number, live: boolean) => (live ? formatRackKw(kw) : dash);

  return (
    <section
      className="overview-dash"
      data-mona="overview"
      onPointerDownCapture={(e) => {
        if (!telem && !picked) return;
        const el = e.target as HTMLElement;
        if (el.closest(".telem-list, .node-telem-panel, .node-console, .gb300-node-hit, .pod-node, .pod-node-pick")) return;
        if (el.closest(".summary-strip button")) return;
        closeOverlays();
        e.stopPropagation();
      }}
    >
      <div className="summary-strip">
        <button type="button" data-open={telem === "racks" ? "true" : undefined} aria-pressed={telem === "racks"} aria-label="Racks" onClick={() => toggleTelem("racks")}>
          <span>Racks</span>
          <b>{registered ? `${racksOn.toLocaleString()} / ${racks.toLocaleString()}` : dash}</b>
          <small>{registered ? `${racksOn.toLocaleString()} live of ${racks.toLocaleString()} · ${showKw(livePowerKw, powerLive)} shelf` : "Register a rack"}</small>
        </button>
        <button type="button" data-open={telem === "compute" ? "true" : undefined} aria-pressed={telem === "compute"} aria-label="Compute nodes" onClick={() => toggleTelem("compute")}>
          <span>Compute nodes</span>
          <b>{registered ? `${computeOn.toLocaleString()} / ${compute.toLocaleString()}` : dash}</b>
          <small>
            {registered
              ? `${computeOn.toLocaleString()} alive of ${compute.toLocaleString()} · ${gpusPerNode} GPU / node`
              : "BMC IP on a node slot"}
          </small>
        </button>
        <div>
          <span>GPU draw</span>
          <b>{showKw(gpuKw, gpuWattsLive)}</b>
          <small>
            {registered
              ? `${gpuLive.toLocaleString()} live of ${data.size.gpus.toLocaleString()} · ${gpuTdpKw > 0 ? formatRackKw(gpuTdpKw) : dash} TDP`
              : dash}
          </small>
        </div>
        <div>
          <span>GPUs</span>
          <b>{registered ? `${gpuLive.toLocaleString()} / ${data.size.gpus.toLocaleString()}` : dash}</b>
          <small>{registered ? `${gpuLive.toLocaleString()} live of ${data.size.gpus.toLocaleString()} · ${showKw(gpuKw, gpuWattsLive)}` : dash}</small>
        </div>
        <div>
          <span>Available</span>
          <b>{registered && envelopeKw > 0 ? formatRackKw(availableKw) : dash}</b>
          <small>
            {registered && envelopeKw > 0
              ? `${thresholdPct.toFixed(0)}% envelope ${formatRackKw(envelopeKw)} − rack ${showKw(livePowerKw, powerLive)}`
              : dash}
          </small>
        </div>
        <div>
          <span>Rack power</span>
          <b>{showKw(livePowerKw, powerLive)}</b>
          <small>
            {powerLive
              ? `Overhead ${formatRackKw(overheadKw)} · ${data.now.power_pct.toFixed(0)}% of ${formatKw(nameplateKw)}`
              : registered
                ? "Waiting for BMC"
                : dash}
          </small>
        </div>
      </div>
      <HealthSummary health={registered ? health : null} open={telem} onOpen={toggleTelem} />
      <div className="gauge-row">
        <Gauge
          title="Cluster GPU"
          pct={registered ? gpuPct : 0}
          value={registered ? `${gpuPct.toFixed(1)}%` : dash}
          used={registered ? `${gpuLive.toLocaleString()} / ${data.size.gpus.toLocaleString()}` : dash}
          total={registered ? `${data.size.gpus.toLocaleString()} GPU` : dash}
          detail={registered ? `${gpuWattsLive ? "Redfish PowerWatts" : "No GPU watts"} · ${gpusPerNode} GPU / node` : "Register inventory"}
        />
        <Gauge
          title="GPU draw"
          pct={gpuWattsLive && gpuTdpKw > 0 ? (gpuKw / gpuTdpKw) * 100 : 0}
          value={showKw(gpuKw, gpuWattsLive)}
          used={showKw(gpuKw, gpuWattsLive)}
          total={registered && gpuTdpKw > 0 ? formatRackKw(gpuTdpKw) : dash}
          detail={registered ? `${gpuLive.toLocaleString()} GPU live · ${gpuTdpKw > 0 ? formatRackKw(gpuTdpKw) : dash} TDP` : dash}
        />
        <Gauge
          title="Available power"
          pct={registered && envelopeKw > 0 ? Math.max(0, (availableKw / envelopeKw) * 100) : 0}
          value={registered && envelopeKw > 0 ? formatRackKw(availableKw) : dash}
          used={registered && envelopeKw > 0 ? formatRackKw(Math.max(0, availableKw)) : dash}
          total={registered && envelopeKw > 0 ? formatRackKw(envelopeKw) : dash}
          detail={registered && envelopeKw > 0 ? `${formatRackKw(envelopeKw)} envelope − rack ${showKw(livePowerKw, powerLive)}` : dash}
        />
        <Gauge
          title="Total power"
          pct={powerLive ? data.now.power_pct : 0}
          value={showKw(livePowerKw, powerLive)}
          used={showKw(livePowerKw, powerLive)}
          total={registered && nameplateKw > 0 ? formatKw(nameplateKw) : dash}
          detail={
            powerLive
              ? `Chassis / PowerShelf · ${racks} registered rack${racks === 1 ? "" : "s"}`
              : registered
                ? "No live watt reading"
                : "No registered cluster"
          }
        />
      </div>
      <PodPowerBoard
        power={power}
        health={health}
        selectedKey={picked?.key ?? null}
        onSelectNode={pickNode}
      />
      {telem ? (
        <TelemList
          kind={telem}
          health={registered ? health : null}
          inv={inv}
          power={power}
          onClose={() => setTelem(null)}
          onPick={pickNode}
        />
      ) : null}
      {picked && consoleOpen ? (
        <NodeConsole key={picked.key} picked={picked} onClose={() => setConsoleOpen(false)} />
      ) : null}
      {picked ? (
        <NodePanel
          picked={picked}
          live={nodeLive}
          consoleOpen={consoleOpen}
          onConsole={() => setConsoleOpen((open) => !open)}
          onClose={() => {
            setConsoleOpen(false);
            setPicked(null);
          }}
        />
      ) : null}
      <div className="chart-row">
        <div className="range-bar">
          <span>Range</span>
          {RANGE_OPTS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              data-active={range === opt.id}
              onClick={() => {
                if (opt.id === "custom" && range !== "custom") {
                  const end = Date.now() / 1000;
                  setCustomFrom(toLocalInput(end - 3600));
                  setCustomTo(toLocalInput(end));
                }
                setRange(opt.id);
              }}
            >
              {opt.label}
            </button>
          ))}
          {range === "custom" && (
            <div className="range-custom">
              <input
                type="datetime-local"
                aria-label="From"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span>to</span>
              <input
                type="datetime-local"
                aria-label="To"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </div>
          )}
          <em>{windowLabel}</em>
        </div>
        <article className="net-panel">
          <header>
            <h2>Rack power</h2>
            <span className="net-legend-inline">
              <i data-k="tx" /> Shelf {showKw(last?.power_kw ?? livePowerKw, powerLive)}
            </span>
          </header>
          {registered && last ? (
            <TimeChart series={data.series} mode="kw" field="power_kw" label="Rack power" />
          ) : (
            <p className="widget-empty">No registered cluster</p>
          )}
        </article>
        <article className="net-panel">
          <header>
            <h2>GPU draw</h2>
            <span className="net-legend-inline">
              <i data-k="tx" /> {showKw(last?.gpu_kw ?? gpuKw, gpuWattsLive)} Redfish
              <i data-k="rx" /> {registered ? `${gpuLive} GPU live` : dash}
            </span>
          </header>
          {registered && last ? (
            <TimeChart series={data.series} mode="kw" field="gpu_kw" label="GPU draw" />
          ) : (
            <p className="widget-empty">No registered cluster</p>
          )}
        </article>
      </div>
    </section>
  );
}
