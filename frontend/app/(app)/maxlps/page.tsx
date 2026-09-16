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
  const prevRank = useRef<Map<string, number>>(new Map());
  const [eta, setEta] = useState(RANK_MS / 1000);
  const [deltas, setDeltas] = useState<Record<string, number | "new">>({});

  const load = useCallback(async () => {
    gpuFlip.current = captureRects(gpuListRef.current);
    try {
      const next = await api.maxlps({ top: TOP, rack_id: rackId });
      const firstBoard = prevRank.current.size === 0;
      const nextDelta: Record<string, number | "new"> = {};
      for (const g of next.gpus) {
        const was = prevRank.current.get(g.id);
        if (firstBoard) nextDelta[g.id] = 0;
        else if (was == null) nextDelta[g.id] = "new";
        else nextDelta[g.id] = was - g.rank;
      }
      prevRank.current = new Map(next.gpus.map((g) => [g.id, g.rank]));
      setDeltas(nextDelta);
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
      playRankFlip(gpuListRef.current, gpuFlip.current, { duration: FLIP_MS, stagger: 18 });
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
          <span>At GPU limit</span>
          <b>{(totals?.gpus_at_cap ?? 0).toLocaleString()}</b>
          <small>Redfish SetPoint cap</small>
        </article>
        <article>
          <span>Racks</span>
          <b>
            {view?.racks_static_max ?? 0}
            <em> / {view?.racks_lps_max ?? 0}</em>
          </b>
          <small>Static max · MaxLPS cap</small>
        </article>
      </section>

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
            {(view?.racks ?? []).map((r) => (
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
              Highest wattage first · reshuffle in {eta}s · limit = rack allocation / {topo?.gpus_per_rack ?? 72}
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
              <GpuRow key={g.id} gpu={g} delta={deltas[g.id]} onRack={() => setRackId(g.rack_id)} />
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
  return (
    <button
      type="button"
      className="maxlps-shelf"
      data-active={active ? "true" : undefined}
      data-hot={rack.hot ? "true" : undefined}
      data-off={rack.power_state === "off" || !rack.enabled ? "true" : undefined}
      data-flip-id={`shelf-${rack.id}`}
      onClick={onSelect}
    >
      <span className="maxlps-shelf-id">{rack.label}</span>
      <span className="maxlps-shelf-bar" aria-hidden>
        <i data-k="gpu" style={{ width: `${Math.min(100, (rack.gpu_kw / cap) * 100)}%` }} />
        <i data-k="shelf" style={{ width: `${Math.min(100, (rack.shelf_kw / cap) * 100)}%` }} />
      </span>
      <span className="maxlps-shelf-kw">{formatKw(rack.shelf_kw)}</span>
    </button>
  );
}

function GpuRow({
  gpu,
  delta,
  onRack,
}: {
  gpu: MaxLpsGpu;
  delta?: number | "new";
  onRack: () => void;
}) {
  const tone = barTone(gpu);
  const tdpPct = Math.max(0, Math.min(100, gpu.pct_tdp));
  const limPct = gpu.tdp_w > 0 ? Math.max(0, Math.min(100, (gpu.setpoint_w / gpu.tdp_w) * 100)) : 0;
  const minPct = gpu.tdp_w > 0 ? Math.max(0, Math.min(100, (gpu.min_w / gpu.tdp_w) * 100)) : 0;
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
        <i data-k="used" style={{ width: `${tdpPct}%` }} />
        <i data-k="lim" style={{ left: `${limPct}%` }} />
        <i data-k="max" />
      </span>
    </button>
  );
}
