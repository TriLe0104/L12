"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PowerPolicyFields, usePowerLimiter } from "@/components/PowerLimiter";
import { api } from "@/lib/api";
import type { MaxLpsGpu, MaxLpsShelf, MaxLpsView } from "@/lib/cluster";
import { formatKw, formatW } from "@/lib/cluster";

import "../cluster/cluster.css";
import "./maxlps.css";

const RANK_MS = 10_000;
const ROW_H = 34;

function barTone(gpu: MaxLpsGpu) {
  if (!gpu.enabled) return "off";
  if (gpu.watts >= gpu.tdp_w - 20) return "max";
  if (gpu.setpoint_w > 1 && gpu.watts >= gpu.setpoint_w - 12) return "lim";
  if (gpu.watts <= gpu.min_w + 15) return "min";
  return "mid";
}

export default function MaxLpsPage() {
  const { data: power, setData: setPower } = usePowerLimiter(true);
  const [view, setView] = useState<MaxLpsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rackId, setRackId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const prevRank = useRef<Map<string, number>>(new Map());
  const prevWatts = useRef<Map<string, number>>(new Map());
  const [eta, setEta] = useState(RANK_MS / 1000);
  const [deltas, setDeltas] = useState<Record<string, number | "new">>({});
  const [wattDelta, setWattDelta] = useState<Record<string, number>>({});
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(640);
  const listOuter = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.maxlps({ top: 0, rack_id: rackId });
      const firstBoard = prevRank.current.size === 0;
      const nextDelta: Record<string, number | "new"> = {};
      const nextWatt: Record<string, number> = {};
      for (const g of next.gpus) {
        const was = prevRank.current.get(g.id);
        const prevW = prevWatts.current.get(g.id);
        nextWatt[g.id] = prevW == null ? 0 : Math.round(g.watts - prevW);
        if (firstBoard) nextDelta[g.id] = 0;
        else if (was == null) nextDelta[g.id] = "new";
        else nextDelta[g.id] = was - g.rank;
      }
      prevRank.current = new Map(next.gpus.map((g) => [g.id, g.rank]));
      prevWatts.current = new Map(next.gpus.map((g) => [g.id, g.watts]));
      setDeltas(nextDelta);
      setWattDelta(nextWatt);
      setView(next);
      setEta(RANK_MS / 1000);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MaxLPS failed");
    }
  }, [rackId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), RANK_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setEta((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const el = listOuter.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [view]);

  async function setMode(mode: "static" | "dynamic", reset = false) {
    setPending(true);
    try {
      const next = await api.patchClusterPower({ mode, reset });
      setPower(next);
      await load();
    } finally {
      setPending(false);
    }
  }

  const topo = view?.topology;
  const totals = view?.totals;
  const selected = view?.racks.find((r) => r.id === rackId) ?? null;
  const locked = pending;

  return (
    <div className="maxlps-page">
      <header className="maxlps-head">
        <div>
          <p className="maxlps-kicker">Closed-loop GPU power</p>
          <h1>MaxLPS</h1>
          <p>
            {topo
              ? `${topo.model} · ${topo.racks} racks · ${topo.nodes_per_rack} nodes/rack · ${topo.gpus_per_node} GPU/node · ${topo.gpu_count.toLocaleString()} GPU · TDP ${formatW(topo.gpu_tdp_w)}`
              : "GB300 NVL72"}
          </p>
        </div>
        <div className="lps-modes">
          <button type="button" data-active={power?.mode === "static"} disabled={locked} onClick={() => setMode("static")}>
            Static
          </button>
          <button type="button" data-active={power?.mode === "dynamic"} disabled={locked} onClick={() => setMode("dynamic")}>
            MaxLPS
          </button>
          <button type="button" disabled={locked} onClick={() => setMode("dynamic", true)}>
            Replay
          </button>
        </div>
      </header>

      {error ? <p className="cluster-error">{error}</p> : null}

      <section className="maxlps-stats">
        <article>
          <span>Power shelf</span>
          <b>{formatKw(totals?.shelf_kw ?? 0)}</b>
          <small>Rack input · all shelves</small>
        </article>
        <article>
          <span>GPU silicon</span>
          <b>{formatKw(totals?.gpu_kw ?? 0)}</b>
          <small>Sum of GB300 readings</small>
        </article>
        <article>
          <span>Overhead</span>
          <b>{formatKw(totals?.overhead_kw ?? 0)}</b>
          <small>Nodes + PSU / busbar</small>
        </article>
        <article data-lead="true">
          <span>Most power</span>
          <b>{formatW(view?.gpus[0]?.watts ?? totals?.hottest_w ?? 0)}</b>
          <small>
            {view?.gpus[0]
              ? `${view.gpus[0].rack_label} · n${String(view.gpus[0].node).padStart(2, "0")}·g${view.gpus[0].gpu}`
              : `of ${formatW(topo?.gpu_tdp_w ?? 1400)} TDP`}
          </small>
        </article>
        <article>
          <span>Avg GPU limit</span>
          <b>{formatW(totals?.avg_setpoint_w ?? 0)}</b>
          <small>TDP {formatW(topo?.gpu_tdp_w ?? 1400)} · unused drops to idle</small>
        </article>
      </section>

      <MixChart
        gpuKw={totals?.gpu_kw ?? 0}
        overheadKw={totals?.overhead_kw ?? 0}
        shelfKw={totals?.shelf_kw ?? 0}
        envelopeKw={view?.envelope_kw ?? 0}
        capKw={totals?.cap_kw ?? 0}
        allowableKw={totals?.allowable_kw ?? 0}
        history={view?.history ?? []}
        algo={view?.algo}
      />

      <div className="maxlps-grid">
        <aside className="maxlps-shelves">
          <header>
            <h2>Power shelves</h2>
            <p>Rack input from the busbar / shelf</p>
            {rackId ? (
              <button type="button" className="maxlps-clear" onClick={() => setRackId(null)}>
                All racks
              </button>
            ) : null}
          </header>
          <div className="maxlps-shelf-list">
            {[...(view?.racks ?? [])]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((r) => (
                <ShelfRow key={r.id} rack={r} active={r.id === rackId} onSelect={() => setRackId(r.id === rackId ? null : r.id)} />
              ))}
          </div>
        </aside>

        <section className="maxlps-gpus">
          <header>
            <h2>
              {rackId && selected
                ? `${selected.label} · ${topo?.gpus_per_rack ?? 72} GB300`
                : `Power ranking · ${(totals?.gpus_listed ?? 0).toLocaleString()} / ${(totals?.gpus_total ?? 0).toLocaleString()} GPU`}
            </h2>
            <p>
              All GPUs · highest watts first · next rank in {eta}s · cap = usage / max({view?.algo?.desired_cap_percent ?? 80}%, budget fit)
            </p>
          </header>
          <div className="maxlps-gpu-cols" aria-hidden>
            <span>#</span>
            <span>Δ</span>
            <span>GPU</span>
            <span>Rack</span>
            <span>W</span>
            <span>Cap</span>
            <span>Min–max</span>
            <span>Range</span>
            <span>Curve</span>
          </div>
          <div
            className="maxlps-gpu-list"
            ref={listOuter}
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <VirtualGpus
              gpus={view?.gpus ?? []}
              scroll={scroll}
              viewH={viewH}
              deltas={deltas}
              wattDelta={wattDelta}
              onRack={(id) => setRackId(id)}
            />
          </div>
        </section>

        <aside className="maxlps-loop">
          <h2>Control loop</h2>
          {power ? (
            <PowerPolicyFields
              data={power}
              onChange={(d) => {
                setPower(d);
                void load();
              }}
              locked={locked}
              compact
            />
          ) : (
            <p>Loading limiter…</p>
          )}
          <p className="lps-event">
            tick {power?.tick ?? view?.tick ?? 0}
            {power?.last_event ? ` · ${power.last_event}` : ""}
          </p>
          {selected ? (
            <dl className="maxlps-detail">
              <div>
                <dt>Shelf</dt>
                <dd>{formatKw(selected.shelf_kw)}</dd>
              </div>
              <div>
                <dt>GPUs</dt>
                <dd>{formatKw(selected.gpu_kw)}</dd>
              </div>
              <div>
                <dt>Overhead</dt>
                <dd>{formatKw(selected.overhead_kw)}</dd>
              </div>
              <div>
                <dt>SetPoint</dt>
                <dd>{formatW(selected.setpoint_w)} / GPU</dd>
              </div>
            </dl>
          ) : (
            <p className="maxlps-hint">
              {view?.algo
                ? `N=${view.algo.n.toLocaleString()} · budget ${formatW(view.algo.power_budget_w)} × ${view.algo.budget_grace}% grace × ${view.algo.gpu_power_percent}% GPU · allowable ${formatW(view.algo.max_allowable_w)} · best cap% ${view.algo.best_cap_percent}`
                : "Click a shelf to pin one rack’s 72 GPUs."}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function logApproach(min: number, current: number, n = 12) {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 1 : i / (n - 1);
    const logu = Math.log1p(9 * u) / Math.log(10);
    pts.push(min + (current - min) * logu);
  }
  return pts;
}

function logY(v: number, vmin: number, vmax: number, h: number, pad: number) {
  const a = Math.log10(Math.max(v, vmin));
  const b = Math.log10(vmin);
  const c = Math.log10(Math.max(vmax, vmin * 10));
  const t = (a - b) / Math.max(c - b, 1e-6);
  return h - pad - t * (h - pad * 2);
}

function MixChart({
  gpuKw,
  overheadKw,
  shelfKw,
  envelopeKw,
  capKw,
  allowableKw,
  history,
  algo,
}: {
  gpuKw: number;
  overheadKw: number;
  shelfKw: number;
  envelopeKw: number;
  capKw: number;
  allowableKw: number;
  history: { t: number; gpu_kw: number; overhead_kw: number; shelf_kw: number; cap_kw?: number; allowable_kw?: number }[];
  algo?: MaxLpsView["algo"];
}) {
  const scale = Math.max(envelopeKw, shelfKw, gpuKw + overheadKw, capKw, allowableKw, 1);
  const gpuPct = (gpuKw / scale) * 100;
  const ohPct = (overheadKw / scale) * 100;
  const capPct = Math.max(0, (capKw / scale) * 100 - gpuPct);
  const unused = Math.max(0, allowableKw - capKw);
  const w = 420;
  const h = 72;
  const pad = 4;
  const ymin = 1;
  const ymax = Math.max(...history.map((p) => Math.max(p.shelf_kw, p.cap_kw ?? 0, p.allowable_kw ?? 0)), scale, 10);
  const pts = (key: "gpu_kw" | "overhead_kw" | "shelf_kw" | "cap_kw" | "allowable_kw") => {
    if (history.length < 2) return "";
    return history
      .map((p, i) => {
        const raw = (p[key as keyof typeof p] as number | undefined) ?? 0;
        const x = pad + (i / Math.max(1, history.length - 1)) * (w - pad * 2);
        const y = logY(raw, ymin, ymax, h, pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <section className="maxlps-mix">
      <div>
        <div className="maxlps-mix-bar" title={`GPU ${formatKw(gpuKw)} · overhead ${formatKw(overheadKw)} · caps ${formatKw(capKw)}`}>
          <i data-k="gpu" style={{ width: `${gpuPct}%` }} />
          <i data-k="oh" style={{ width: `${ohPct}%` }} />
          <i data-k="cap" style={{ width: `${Math.max(0, capPct)}%` }} />
        </div>
        <ul>
          <li data-k="gpu">GPU {formatKw(gpuKw)}</li>
          <li data-k="oh">Overhead {formatKw(overheadKw)}</li>
          <li data-k="cap">GPU caps {formatKw(capKw)}</li>
          <li data-k="shelf">Shelf {formatKw(shelfKw)}</li>
          <li data-k="free">Headroom {formatKw(unused)}</li>
        </ul>
        {algo ? (
          <p className="maxlps-algo">
            cap_i = usage_i / {algo.best_cap_percent}% · allowable {formatKw(algo.max_allowable_w / 1000)} = budget × {algo.budget_grace}% × {algo.gpu_power_percent}%
          </p>
        ) : null}
      </div>
      <svg className="maxlps-spark" viewBox={`0 0 ${w} ${h}`} aria-label="Log power curve">
        <polyline data-k="allow" points={pts("allowable_kw")} />
        <polyline data-k="cap" points={pts("cap_kw")} />
        <polyline data-k="shelf" points={pts("shelf_kw")} />
        <polyline data-k="oh" points={pts("overhead_kw")} />
        <polyline data-k="gpu" points={pts("gpu_kw")} />
      </svg>
    </section>
  );
}

function VirtualGpus({
  gpus,
  scroll,
  viewH,
  deltas,
  wattDelta,
  onRack,
}: {
  gpus: MaxLpsGpu[];
  scroll: number;
  viewH: number;
  deltas: Record<string, number | "new">;
  wattDelta: Record<string, number>;
  onRack: (rackId: string) => void;
}) {
  const start = Math.max(0, Math.floor(scroll / ROW_H) - 6);
  const end = Math.min(gpus.length, start + Math.ceil(viewH / ROW_H) + 12);
  return (
    <div className="maxlps-gpu-virt" style={{ height: Math.max(gpus.length * ROW_H, viewH) }}>
      {gpus.slice(start, end).map((g) => {
        const d = deltas[g.id];
        const moved = d === "new" || (typeof d === "number" && d !== 0);
        return (
          <div
            key={g.id}
            className="maxlps-gpu-abs"
            data-moved={moved ? "true" : undefined}
            style={{ top: (g.rank - 1) * ROW_H, height: ROW_H }}
          >
            <GpuRow gpu={g} delta={d} wattDelta={wattDelta[g.id] ?? 0} onRack={() => onRack(g.rack_id)} />
          </div>
        );
      })}
    </div>
  );
}

function ShelfRow({
  rack,
  active,
  onSelect,
}: {
  rack: MaxLpsShelf;
  active: boolean;
  onSelect: () => void;
}) {
  const cap = Math.max(rack.allocated_kw, rack.shelf_kw, 1);
  const gpuPct = Math.min(100, (rack.gpu_kw / cap) * 100);
  const ohPct = Math.min(100 - gpuPct, (rack.overhead_kw / cap) * 100);
  return (
    <button
      type="button"
      className="maxlps-shelf"
      data-active={active ? "true" : undefined}
      data-hot={rack.hot ? "true" : undefined}
      data-off={rack.power_state === "off" || !rack.enabled ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="maxlps-shelf-id">{rack.label}</span>
      <span className="maxlps-shelf-bar" aria-hidden>
        <i data-k="gpu" style={{ width: `${gpuPct}%` }} />
        <i data-k="oh" style={{ left: `${gpuPct}%`, width: `${ohPct}%` }} />
      </span>
      <span className="maxlps-shelf-kw">{formatKw(rack.shelf_kw)}</span>
    </button>
  );
}

function GpuRow({
  gpu,
  delta,
  wattDelta,
  onRack,
}: {
  gpu: MaxLpsGpu;
  delta?: number | "new";
  wattDelta: number;
  onRack: () => void;
}) {
  const tone = barTone(gpu);
  const tdpPct = Math.max(0, Math.min(100, gpu.pct_tdp));
  const limPct = gpu.tdp_w > 0 ? Math.max(0, Math.min(100, (gpu.setpoint_w / gpu.tdp_w) * 100)) : 0;
  const minPct = gpu.tdp_w > 0 ? Math.max(0, Math.min(100, (gpu.min_w / gpu.tdp_w) * 100)) : 0;
  const dPct = gpu.tdp_w > 0 ? (wattDelta / gpu.tdp_w) * 100 : 0;
  const prevPct = Math.max(0, Math.min(100, tdpPct - dPct));
  const gainLeft = Math.min(prevPct, tdpPct);
  const gainWidth = Math.abs(tdpPct - prevPct);
  const place = gpu.rank <= 3 ? String(gpu.rank) : undefined;
  let deltaLabel = "–";
  let deltaDir: "up" | "down" | "new" | "flat" = "flat";
  if (delta === "new") {
    deltaLabel = "NEW";
    deltaDir = "new";
  } else if (typeof delta === "number" && delta > 0) {
    deltaLabel = `↑${delta}`;
    deltaDir = "up";
  } else if (typeof delta === "number" && delta < 0) {
    deltaLabel = `↓${Math.abs(delta)}`;
    deltaDir = "down";
  }
  const offLabel =
    Math.abs(wattDelta) >= 4 ? `${wattDelta > 0 ? "+" : ""}${Math.round(wattDelta)}` : "";
  return (
    <button
      type="button"
      className="maxlps-gpu"
      data-tone={tone}
      data-place={place}
      data-flip-id={gpu.id}
      onClick={onRack}
    >
      <span className="maxlps-rank">{gpu.rank === 1 ? "1st" : gpu.rank === 2 ? "2nd" : gpu.rank === 3 ? "3rd" : gpu.rank}</span>
      <span className="maxlps-delta" data-dir={deltaDir}>
        {deltaLabel}
      </span>
      <span className="maxlps-gid">
        n{String(gpu.node).padStart(2, "0")}·g{gpu.gpu}
      </span>
      <span className="maxlps-rack">{gpu.rack_label}</span>
      <span className="maxlps-w">{formatW(gpu.watts)}</span>
      <span className="maxlps-lim">{formatW(gpu.setpoint_w)}</span>
      <span className="maxlps-minmax">
        {formatW(gpu.min_w)}–{formatW(gpu.max_w ?? gpu.tdp_w)}
      </span>
      <span className="maxlps-meter" aria-hidden>
        <i data-k="floor" style={{ width: `${minPct}%` }} />
        <i data-k="used" style={{ width: `${Math.min(prevPct, tdpPct)}%` }} />
        {gainWidth > 0.4 ? (
          <i
            data-k={wattDelta >= 0 ? "gain" : "loss"}
            style={{ left: `${gainLeft}%`, width: `${gainWidth}%` }}
          />
        ) : null}
        <i data-k="min" style={{ left: `${minPct}%` }} />
        <i data-k="lim" style={{ left: `${limPct}%` }} />
        <i data-k="max" />
        {offLabel ? (
          <em data-off={wattDelta >= 0 ? "up" : "down"}>
            {offLabel}
          </em>
        ) : null}
      </span>
      <LogSpark
        points={gpu.curve ?? logApproach(gpu.min_w, gpu.watts)}
        min={gpu.min_w}
        max={gpu.max_w ?? gpu.tdp_w}
        cap={gpu.setpoint_w}
      />
    </button>
  );
}

function LogSpark({ points, min, max, cap }: { points: number[]; min: number; max: number; cap: number }) {
  const w = 72;
  const h = 22;
  const pad = 1;
  const lo = Math.max(1, min * 0.8);
  const hi = Math.max(max, cap, 10);
  if (points.length < 2) return <span className="maxlps-spark-mini" />;
  const line = points
    .map((v, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = logY(v, lo, hi, h, pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const capY = logY(cap, lo, hi, h, pad);
  const minY = logY(min, lo, hi, h, pad);
  const maxY = logY(max, lo, hi, h, pad);
  return (
    <svg className="maxlps-spark-mini" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <line data-k="max" x1="0" x2={w} y1={maxY} y2={maxY} />
      <line data-k="min" x1="0" x2={w} y1={minY} y2={minY} />
      <line data-k="cap" x1="0" x2={w} y1={capY} y2={capY} />
      <polyline points={line} />
    </svg>
  );
}
