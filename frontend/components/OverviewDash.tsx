"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { ClusterMetrics, HallDetail, PowerLimiter as PowerLimiterData } from "@/lib/cluster";
import { formatGbps, formatKw, formatRackKw } from "@/lib/cluster";
import { PodPowerBoard } from "@/components/PodPowerBoard";

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
      { y: 0, text: formatKw(peak) },
      { y: 50, text: formatKw(peak / 2) },
      { y: 100, text: "0" },
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

export function OverviewDash({ halls = [] }: { halls?: HallDetail[] }) {
  const [data, setData] = useState<ClusterMetrics | null>(null);
  const [power, setPower] = useState<PowerLimiterData | null>(null);
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
      api
        .clusterPower()
        .then((d) => {
          if (!cancelled) setPower(d);
        })
        .catch(() => {
          /* limiter is additive; metrics still render */
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

  const liveInv = data.source === "inventory";
  const sensors = data.sensors ?? {};
  const racks = data.size.racks;
  const racksOn = data.size.racks_on ?? data.nodes.total - data.nodes.off;
  const gpusPerNode = data.size.gpus_per_node ?? 4;
  const compute = data.size.compute_nodes ?? racks * 18;
  const computeOn = data.size.compute_on ?? compute;
  const perRack = data.size.nodes_per_rack ?? (racks > 0 ? Math.round(compute / racks) : 18);
  const switches = liveInv ? (data.size.switches ?? 0) : (data.size.switches ?? (data.size.spines ?? 8) + (data.size.leaves ?? 0));
  const livePowerKw = power?.active.consumed_kw ?? last.power_kw;
  const fmtPower = liveInv ? formatRackKw : formatKw;
  const gpuLive = data.gpu_used;
  const gpuKw = data.now.gpu_kw ?? last.gpu_kw ?? 0;
  const gpuTdpKw = data.now.gpu_tdp_kw ?? (data.size.gpus * 1.4);
  const gpuPct = data.now.gpu_pct ?? last.gpu;
  const envelopeKw = data.now.envelope_kw ?? data.size.nameplate_kw;
  const availableKw = data.now.available_kw ?? envelopeKw - livePowerKw;
  const overheadKw = Math.max(0, livePowerKw - gpuKw);
  const gpuTdpPct = gpuTdpKw > 0 ? (gpuKw / gpuTdpKw) * 100 : 0;
  const nameplateKw = data.size.nameplate_kw;
  const thresholdPct = power?.threshold_pct ?? power?.stay_under_pct ?? 80;

  return (
    <section className="overview-dash">
      <div className="summary-strip">
        <div>
          <span>Racks</span>
          <b>{racks.toLocaleString()}</b>
          <small>
            {liveInv
              ? `${racksOn} on · ${fmtPower(livePowerKw)} shelf`
              : `${racksOn} on · ${data.nodes.off} off`}
          </small>
        </div>
        <div>
          <span>Compute nodes</span>
          <b>{compute.toLocaleString()}</b>
          <small>
            {computeOn.toLocaleString()} on · {gpusPerNode} GPU / node
          </small>
        </div>
        {liveInv ? (
          <div>
            <span>GPU draw</span>
            <b>{fmtPower(gpuKw)}</b>
            <small>
              {gpuLive.toLocaleString()} live · {gpuTdpPct.toFixed(0)}% of {fmtPower(gpuTdpKw)} TDP
            </small>
          </div>
        ) : (
          <div>
            <span>Switches</span>
            <b>{switches}</b>
            <small>
              {data.size.spines ?? 8} spine · {data.size.leaves ?? 0} leaf
            </small>
          </div>
        )}
        <div>
          <span>GPUs</span>
          <b>{data.size.gpus.toLocaleString()}</b>
          <small>
            {liveInv
              ? `${gpuLive.toLocaleString()} live · ${fmtPower(gpuKw)}`
              : `${data.gpu_used.toLocaleString()} used · ${Math.round(last.gpu)}%`}
          </small>
        </div>
        {liveInv ? (
          <div>
            <span>Available</span>
            <b>{fmtPower(availableKw)}</b>
            <small>
              {thresholdPct.toFixed(0)}% envelope {fmtPower(envelopeKw)} − rack {fmtPower(livePowerKw)}
            </small>
          </div>
        ) : (
          <div>
            <span>Fabric</span>
            <b>{formatGbps(last.tx_gbps)}</b>
            <small>
              {data.size.active_links ?? "—"} links · {data.size.speed ?? "800G"}
            </small>
          </div>
        )}
        <div>
          <span>{liveInv ? "Rack power" : "Power"}</span>
          <b>{fmtPower(livePowerKw)}</b>
          <small>
            {liveInv
              ? `Overhead ${fmtPower(overheadKw)} · ${data.now.power_pct.toFixed(0)}% of ${formatKw(nameplateKw)}`
              : power
                ? `${formatKw(power.active.stranded_kw)} stranded · ${power.mode === "dynamic" ? "Dynamic Power" : "static"}`
                : `${data.now.power_pct.toFixed(0)}% of ${formatKw(data.size.nameplate_kw)}`}
          </small>
        </div>
      </div>
      <div className="gauge-row">
        <Gauge
          title="Cluster GPU"
          pct={liveInv ? gpuPct : last.gpu}
          value={`${(liveInv ? gpuPct : last.gpu).toFixed(1)}%`}
          used={`${gpuLive.toLocaleString()} live`}
          total={`${data.size.gpus.toLocaleString()} GPU`}
          detail={
            liveInv
              ? `${sensors.gpu ? "Redfish PowerWatts" : "Waiting for hop / BMC"} · ${gpusPerNode} GPU / node`
              : `72 GPU / rack · HBM3e · ${data.size.halls} halls`
          }
        />
        {liveInv ? (
          <Gauge
            title="GPU draw"
            pct={gpuTdpKw > 0 ? (gpuKw / gpuTdpKw) * 100 : 0}
            value={fmtPower(gpuKw)}
            used={fmtPower(gpuKw)}
            total={fmtPower(gpuTdpKw)}
            detail={`${gpuLive.toLocaleString()} GPU live · ${fmtPower(gpuTdpKw)} TDP`}
          />
        ) : (
          <Gauge
            title="Cluster CPU"
            pct={last.cpu}
            value={`${last.cpu.toFixed(1)}%`}
            used={`${coresUsed.toLocaleString()} cores`}
            total={`${data.cpu_cores.toLocaleString()} cores`}
            detail={`144 Grace cores / rack · 1m avg`}
          />
        )}
        {liveInv ? (
          <Gauge
            title="Available power"
            pct={envelopeKw > 0 ? Math.max(0, (availableKw / envelopeKw) * 100) : 0}
            value={fmtPower(availableKw)}
            used={fmtPower(Math.max(0, availableKw))}
            total={fmtPower(envelopeKw)}
            detail={`${fmtPower(envelopeKw)} envelope − rack ${fmtPower(livePowerKw)}`}
          />
        ) : (
          <Gauge
            title="Cluster memory"
            pct={last.mem}
            value={`${last.mem.toFixed(1)}%`}
            used={`${memUsed} TB`}
            total={`${data.mem_tb.toFixed(1)} TB`}
            detail={`2.3 TB / rack · HBM + LPDDR`}
          />
        )}
        <Gauge
          title="Total power"
          pct={
            liveInv
              ? data.now.power_pct
              : power
                ? (power.active.consumed_kw / Math.max(power.max_budget_kw ?? power.nameplate_kw ?? power.budget_kw, 1)) * 100
                : data.now.power_pct
          }
          value={fmtPower(livePowerKw)}
          used={fmtPower(livePowerKw)}
          total={formatKw(liveInv ? data.size.nameplate_kw : (power?.max_budget_kw ?? power?.nameplate_kw ?? data.size.nameplate_kw))}
          detail={
            liveInv
              ? `BMC PowerShelf total_power_out · ${racks} registered rack${racks === 1 ? "" : "s"}`
              : power
                ? `${formatKw(power.envelope_kw ?? power.budget_kw)} envelope · static ${power.racks_static_max ?? 0} · Dynamic Power ${power.racks_lps_max ?? 0}${power.racks_lps_gain ? ` (+${power.racks_lps_gain})` : ""} · [${Math.round(power.min_rack_kw ?? 40)}–${Math.round(power.max_rack_kw ?? 300)}] kW`
                : `Set total power, threshold, min/max kW per rack`
          }
        />
        <article className="stat-panel">
          <h2>{liveInv ? "Power" : "Cluster"}</h2>
          <dl>
            <div>
              <dt>Rack draw</dt>
              <dd>
                {fmtPower(livePowerKw)}
                <small>
                  {liveInv
                    ? `${sensors.power ? "PowerShelf" : "No PSU meter"} · ${racksOn}/${racks} racks`
                    : `${data.size.halls} halls · ${data.size.cols}×${data.size.rows} · ${data.nodes.off} off`}
                </small>
              </dd>
            </div>
            <div>
              <dt>GPU draw</dt>
              <dd>
                {fmtPower(gpuKw)}
                <small>
                  {gpuLive.toLocaleString()} live · {gpuTdpPct.toFixed(0)}% of {fmtPower(gpuTdpKw)} TDP
                </small>
              </dd>
            </div>
            <div>
              <dt>Overhead</dt>
              <dd>
                {fmtPower(overheadKw)}
                <small>Shelf − GPU · {fmtPower(livePowerKw)} − {fmtPower(gpuKw)}</small>
              </dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>
                {fmtPower(availableKw)}
                <small>
                  {thresholdPct.toFixed(0)}% of budget · envelope {fmtPower(envelopeKw)}
                </small>
              </dd>
            </div>
            {!liveInv && (
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
            )}
          </dl>
        </article>
      </div>
      <PodPowerBoard halls={halls} power={power} />
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
            <h2>{liveInv ? "Rack power" : "Network I/O"}</h2>
            <span className="net-legend-inline">
              {liveInv ? (
                <>
                  <i data-k="tx" /> Shelf {fmtPower(last.power_kw)}
                </>
              ) : (
                <>
                  <i data-k="tx" /> Tx {formatGbps(last.tx_gbps)}
                  <i data-k="rx" /> Rx {formatGbps(last.rx_gbps)}
                </>
              )}
            </span>
          </header>
          <TimeChart
            series={data.series}
            mode={liveInv ? "kw" : "net"}
            field="power_kw"
            label={liveInv ? "Rack power" : "Network I/O"}
          />
        </article>
        <article className="net-panel">
          <header>
            <h2>{liveInv ? "GPU draw" : "Disk usage"}</h2>
            <span className="net-legend-inline">
              {liveInv ? (
                <>
                  <i data-k="tx" /> {fmtPower(last.gpu_kw ?? gpuKw)} Redfish
                  <i data-k="rx" /> {gpuLive} GPU live
                </>
              ) : (
                <>
                  <i data-k="tx" /> {last.disk_pct.toFixed(1)}% · {Math.round(data.disk_used_tb)} / {Math.round(data.disk_tb)} TB
                  <i data-k="rx" /> R {last.disk_read_gbs.toFixed(1)} GB/s
                  <i data-k="w" /> W {last.disk_write_gbs.toFixed(1)} GB/s
                </>
              )}
            </span>
          </header>
          <TimeChart
            series={data.series}
            mode={liveInv ? "kw" : "disk"}
            field="gpu_kw"
            label={liveInv ? "GPU draw" : "Disk usage"}
          />
        </article>
      </div>
    </section>
  );
}
