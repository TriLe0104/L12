"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { PowerPolicyFields, usePowerLimiter } from "@/components/PowerLimiter";
import { api } from "@/lib/api";
import type { MaxLpsGpu, MaxLpsShelf, MaxLpsView } from "@/lib/cluster";
import { formatKw, formatW } from "@/lib/cluster";
import { captureRects, playRankFlip } from "@/lib/flip";

import "../cluster/cluster.css";
import "./maxlps.css";

const TOP = 80;
const RANK_MS = 10_000;
const FLIP_MS = 980;

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
  const gpuListRef = useRef<HTMLDivElement>(null);
  const gpuFlip = useRef<ReturnType<typeof captureRects> | null>(null);
  const movers = useRef<Set<string>>(new Set());
  const prevRank = useRef<Map<string, number>>(new Map());
  const prevWatts = useRef<Map<string, number>>(new Map());
  const [eta, setEta] = useState(RANK_MS / 1000);
  const [deltas, setDeltas] = useState<Record<string, number | "new">>({});
  const [wattDelta, setWattDelta] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    gpuFlip.current = captureRects(gpuListRef.current);
    try {
      const next = await api.maxlps({ top: TOP, rack_id: rackId });
      const firstBoard = prevRank.current.size === 0;
      const nextDelta: Record<string, number | "new"> = {};
      const nextWatt: Record<string, number> = {};
      const moved = new Set<string>();
      for (const g of next.gpus) {
        const was = prevRank.current.get(g.id);
        const prevW = prevWatts.current.get(g.id);
        nextWatt[g.id] = prevW == null ? 0 : Math.round(g.watts - prevW);
        if (firstBoard) nextDelta[g.id] = 0;
        else if (was == null) {
          nextDelta[g.id] = "new";
          moved.add(g.id);
        } else {
          nextDelta[g.id] = was - g.rank;
          if (was !== g.rank) moved.add(g.id);
        }
      }
      prevRank.current = new Map(next.gpus.map((g) => [g.id, g.rank]));
      prevWatts.current = new Map(next.gpus.map((g) => [g.id, g.watts]));
      movers.current = moved;
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

  useLayoutEffect(() => {
    if (gpuFlip.current) {
      playRankFlip(gpuListRef.current, gpuFlip.current, {
        duration: FLIP_MS,
        stagger: 28,
        only: movers.current,
      });
      gpuFlip.current = null;
    }
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
        history={view?.history ?? []}
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
                : `Power ranking · top ${totals?.gpus_listed ?? TOP}`}
            </h2>
            <p>
              Highest wattage first · next rank in {eta}s · limit follows usage (idle GPUs drop to {formatW(topo?.gpu_idle_w ?? 180)})
            </p>
          </header>
          <div className="maxlps-gpu-cols" aria-hidden>
            <span>#</span>
            <span>Δ</span>
            <span>GPU</span>
            <span>Rack</span>
            <span>Node</span>
            <span>Reading</span>
            <span>Limit</span>
            <span>vs TDP</span>
          </div>
          <div className="maxlps-gpu-list" ref={gpuListRef}>
            {(view?.gpus ?? []).map((g) => (
              <GpuRow
                key={g.id}
                gpu={g}
                delta={deltas[g.id]}
                wattDelta={wattDelta[g.id] ?? 0}
                onRack={() => setRackId(g.rack_id)}
              />
            ))}
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
            <p className="maxlps-hint">Click a shelf to pin one rack’s 72 GPUs. Limits move with MaxLPS.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function MixChart({
  gpuKw,
  overheadKw,
  shelfKw,
  envelopeKw,
  history,
}: {
  gpuKw: number;
  overheadKw: number;
  shelfKw: number;
  envelopeKw: number;
  history: { t: number; gpu_kw: number; overhead_kw: number; shelf_kw: number }[];
}) {
  const scale = Math.max(envelopeKw, shelfKw, gpuKw + overheadKw, 1);
  const gpuPct = (gpuKw / scale) * 100;
  const ohPct = (overheadKw / scale) * 100;
  const unused = Math.max(0, envelopeKw - shelfKw);
  const w = 320;
  const h = 56;
  const pad = 2;
  const maxY = Math.max(...history.map((p) => p.shelf_kw), scale, 1);
  const pts = (key: "gpu_kw" | "overhead_kw" | "shelf_kw") => {
    if (history.length < 2) return "";
    return history
      .map((p, i) => {
        const x = pad + (i / Math.max(1, history.length - 1)) * (w - pad * 2);
        const y = h - pad - (p[key] / maxY) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <section className="maxlps-mix">
      <div className="maxlps-mix-bar" title={`GPU ${formatKw(gpuKw)} · overhead ${formatKw(overheadKw)} · shelf ${formatKw(shelfKw)}`}>
        <i data-k="gpu" style={{ width: `${gpuPct}%` }} />
        <i data-k="oh" style={{ width: `${ohPct}%` }} />
      </div>
      <ul>
        <li data-k="gpu">
          GPU {formatKw(gpuKw)}
        </li>
        <li data-k="oh">
          Overhead {formatKw(overheadKw)}
        </li>
        <li data-k="shelf">
          Shelf {formatKw(shelfKw)}
        </li>
        <li data-k="free">
          Unused envelope {formatKw(unused)}
        </li>
      </ul>
      <svg className="maxlps-spark" viewBox={`0 0 ${w} ${h}`} aria-label="GPU vs overhead over time">
        <polyline data-k="shelf" points={pts("shelf_kw")} />
        <polyline data-k="oh" points={pts("overhead_kw")} />
        <polyline data-k="gpu" points={pts("gpu_kw")} />
      </svg>
    </section>
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
      <span className="maxlps-node">N{gpu.node}</span>
      <span className="maxlps-w">{formatW(gpu.watts)}</span>
      <span className="maxlps-lim">{formatW(gpu.setpoint_w)}</span>
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
    </button>
  );
}
