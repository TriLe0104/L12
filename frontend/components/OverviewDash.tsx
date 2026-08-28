"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { ClusterMetrics } from "@/lib/cluster";
import { formatGbps, formatKw } from "@/lib/cluster";

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
            stroke="#1c1c1c"
            strokeWidth="8"
            strokeLinecap="butt"
          />
          <path
            d="M16 66 A 44 44 0 0 1 104 66"
            fill="none"
            stroke="#e10600"
            strokeWidth="8"
            strokeDasharray={`${dash} ${c}`}
            strokeLinecap="butt"
          />
        </svg>
        <strong>{value}</strong>
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
}: {
  series: ClusterMetrics["series"];
  mode: "net" | "disk";
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
            <span key={t.text} style={{ top: `${t.y}%`, transform: tickTransform(t.y) }}>
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
          <span key={t.text} style={{ top: `${t.y}%`, transform: tickTransform(t.y) }}>
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
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeId>("5m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    let cancelled = false;
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
          if (!cancelled) setData(d);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Metrics failed");
        });
    };
    load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [range, customFrom, customTo]);

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

  if (error) return <p className="cluster-error">{error}</p>;
  if (!data || !last) return <p className="widget-empty">Loading telemetry…</p>;

  const coresUsed = Math.round((data.cpu_cores * last.cpu) / 100);
  const memUsed = ((data.mem_tb * last.mem) / 100).toFixed(2);
  const extraJobs = (data.workloads_running ?? []).filter((w) => w.name !== data.workload?.name);

  const racks = data.size.racks;
  const racksOn = data.size.racks_on ?? data.nodes.total - data.nodes.off;
  const compute = data.size.compute_nodes ?? racks * 4;
  const computeOn = data.size.compute_on ?? (racksOn * 4);
  const switches = data.size.switches ?? (data.size.spines ?? 8) + (data.size.leaves ?? 0);

  return (
    <section className="overview-dash">
      <div className="summary-strip">
        <div>
          <span>Racks</span>
          <b>{racks.toLocaleString()}</b>
          <small>{racksOn} on · {data.nodes.off} off</small>
        </div>
        <div>
          <span>Compute nodes</span>
          <b>{compute.toLocaleString()}</b>
          <small>{computeOn.toLocaleString()} on · 4 / rack</small>
        </div>
        <div>
          <span>Switches</span>
          <b>{switches}</b>
          <small>
            {data.size.spines ?? 8} spine · {data.size.leaves ?? 0} leaf
          </small>
        </div>
        <div>
          <span>GPUs</span>
          <b>{data.size.gpus.toLocaleString()}</b>
          <small>
            {data.gpu_used.toLocaleString()} used · {Math.round(last.gpu)}%
          </small>
        </div>
        <div>
          <span>Fabric</span>
          <b>{formatGbps(last.tx_gbps)}</b>
          <small>
            {data.size.active_links ?? "—"} links · {data.size.speed ?? "800G"}
          </small>
        </div>
        <div>
          <span>Power</span>
          <b>{formatKw(last.power_kw)}</b>
          <small>
            {data.now.power_pct.toFixed(0)}% of {formatKw(data.size.nameplate_kw)}
          </small>
        </div>
      </div>
      <div className="gauge-row">
        <Gauge
          title="Cluster GPU"
          pct={last.gpu}
          value={`${last.gpu.toFixed(1)}%`}
          used={`${data.gpu_used.toLocaleString()} GPU`}
          total={`${data.size.gpus.toLocaleString()} GPU`}
          detail={`72 GPU / rack · HBM3e · ${data.size.halls} halls`}
        />
        <Gauge
          title="Cluster CPU"
          pct={last.cpu}
          value={`${last.cpu.toFixed(1)}%`}
          used={`${coresUsed.toLocaleString()} cores`}
          total={`${data.cpu_cores.toLocaleString()} cores`}
          detail={`144 Grace cores / rack · 1m avg`}
        />
        <Gauge
          title="Cluster memory"
          pct={last.mem}
          value={`${last.mem.toFixed(1)}%`}
          used={`${memUsed} TB`}
          total={`${data.mem_tb.toFixed(1)} TB`}
          detail={`2.3 TB / rack · HBM + LPDDR`}
        />
        <Gauge
          title="Total power"
          pct={data.now.power_pct}
          value={formatKw(last.power_kw)}
          used={formatKw(last.power_kw)}
          total={formatKw(data.size.nameplate_kw)}
          detail={`120 kW TDP / rack · IT load`}
        />
        <article className="stat-panel">
          <h2>Cluster</h2>
          <dl>
            <div>
              <dt>Racks</dt>
              <dd>
                {racks} total · {racksOn} powered
                <small>
                  {data.size.halls} halls · {data.size.cols}×{data.size.rows} · {data.nodes.off} off
                </small>
              </dd>
            </div>
            <div>
              <dt>Nodes</dt>
              <dd>
                {compute.toLocaleString()} compute · {computeOn.toLocaleString()} on
                <small>
                  4 trays / rack · {data.nodes.active} running · {data.nodes.ready} ready · {data.nodes.idle} idle
                </small>
              </dd>
            </div>
            <div>
              <dt>Telemetry</dt>
              <dd>
                GPU {Math.round(last.gpu)}% · CPU {Math.round(last.cpu)}% · Mem {Math.round(last.mem)}%
                <small>
                  Disk {last.disk_pct.toFixed(0)}% · IB Tx {formatGbps(last.tx_gbps)} · Rx {formatGbps(last.rx_gbps)}
                </small>
              </dd>
            </div>
            <div>
              <dt>Fabric</dt>
              <dd>
                {data.size.spines ?? 8} spine · {data.size.leaves ?? 0} leaf · {data.size.active_links ?? 0} links
                <small>
                  {data.size.active_ports ?? 0}/{data.size.total_ports ?? 0} ports up · {data.size.speed ?? "800 Gbps"}
                </small>
              </dd>
            </div>
            <div>
              <dt>Workload</dt>
              <dd>
                {data.workload ? (
                  <>
                    <b>{data.workload.name}</b>
                    <small>
                      {data.workload.kind} · {data.workload.gpu_allocation} GPU
                      {data.workload.pods_running ? ` · ${data.workload.pods_running} pods` : ""}
                      {extraJobs.length > 0 ? ` · +${extraJobs.length} more` : ""}
                    </small>
                  </>
                ) : (
                  <>
                    None running
                    <small>Launch from Testing</small>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </article>
      </div>
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
            <h2>Network I/O</h2>
            <span className="net-legend-inline">
              <i data-k="tx" /> Tx {formatGbps(last.tx_gbps)}
              <i data-k="rx" /> Rx {formatGbps(last.rx_gbps)}
            </span>
          </header>
          <TimeChart series={data.series} mode="net" label="Network I/O" />
        </article>
        <article className="net-panel">
          <header>
            <h2>Disk usage</h2>
            <span className="net-legend-inline">
              <i data-k="tx" /> {last.disk_pct.toFixed(1)}% · {Math.round(data.disk_used_tb)} / {Math.round(data.disk_tb)} TB
              <i data-k="rx" /> R {last.disk_read_gbs.toFixed(1)} GB/s
              <i data-k="w" /> W {last.disk_write_gbs.toFixed(1)} GB/s
            </span>
          </header>
          <TimeChart series={data.series} mode="disk" label="Disk usage" />
        </article>
      </div>
    </section>
  );
}
