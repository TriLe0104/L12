"use client";

import type { PowerLimiter as PowerLimiterData, PowerRack } from "@/lib/cluster";
import { formatKw, formatRackKw } from "@/lib/cluster";

import "./Gb300PowerStencil.css";

const STENCIL = "/racks/gb300-stencil.png?v=2";

const NODES = 18;
const NVSWITCHES = 9;
const NVLINKS = 1296;
const POWER_SHELVES = 8;
const GPU_MAX_W = 1200;

/** Front-of-rack bands on the SuperMicro GB300 NVL72 photo, top → bottom. */
const ZONES: { id: string; label: string; detail: string; top: number; height: number; tone: string }[] = [
  { id: "net", label: "Networking (Spine/Leaf)", detail: "800G two-rack", top: 5.8, height: 6.4, tone: "net" },
  { id: "nvs", label: "NVSwitches", detail: `${NVSWITCHES} × NVSwitches · ${NVLINKS.toLocaleString()} NVLinks`, top: 12.4, height: 9.6, tone: "nvs" },
  { id: "compute", label: "Compute Nodes", detail: `${NODES} × GB300`, top: 20.6, height: 53.0, tone: "compute" },
  { id: "psu", label: "Power Shelf", detail: `${POWER_SHELVES} × power shelves`, top: 73.6, height: 9.2, tone: "psu" },
  { id: "cdu", label: "CDU", detail: "Liquid cooling", top: 82.8, height: 13.0, tone: "cdu" },
];

/**
 * Two compute cages on the NVL72 photo (239×800). Slots count from the bottom:
 * 1–9 (0–8) lower cage nearest the PSU, 10–18 (9–17) upper cage. Slot 1 / 0 is
 * the lowest compute tray; 18 / 17 is the top tray under the NVSwitches.
 * Mid-rack NVSwitch trays (≈41.4–58%) are not compute slots.
 */
const NODE_BANDS = [
  { from: 0, count: 9, top: 58.05, height: 15.15 },
  { from: 9, count: 9, top: 23.4, height: 18.0 },
];

export type StencilNodeHit = {
  index: number;
  status?: string;
  selected?: boolean;
  title?: string;
};

/** Map inventory 1–18 or 0–17 onto a 0-based bottom-up slot. */
export function rackSlot0(index: number): number {
  const n = Number(index);
  if (!Number.isFinite(n)) return -1;
  if (n >= 1 && n <= 18) return n - 1;
  if (n >= 0 && n <= 17) return n;
  return -1;
}

function nodeHitStyle(index: number): { top: string; height: string } | undefined {
  const slot = rackSlot0(index);
  if (slot < 0) return undefined;
  for (const band of NODE_BANDS) {
    if (slot >= band.from && slot < band.from + band.count) {
      const h = band.height / band.count;
      const fromBottom = slot - band.from;
      const top = band.top + band.height - (fromBottom + 1) * h;
      return { top: `${top}%`, height: `${h}%` };
    }
  }
}

export function rackLimiterView(data: PowerLimiterData | null | undefined, rack?: PowerRack | null) {
  const maxKw = rack?.max_kw ?? data?.max_rack_kw ?? data?.rack_hard_kw ?? 135;
  const minKw = rack?.min_kw ?? data?.min_rack_kw ?? 40;
  const thresholdPct = data?.threshold_pct ?? data?.stay_under_pct ?? 80;
  const envelopeKw = data?.envelope_kw ?? ((data?.total_budget_kw ?? data?.budget_kw ?? 0) * thresholdPct) / 100;
  if (rack) {
    const usedKw = rack.consumed_kw;
    const pct =
      rack.usage_pct != null && Number.isFinite(rack.usage_pct)
        ? rack.usage_pct
        : maxKw > 0
          ? (usedKw / maxKw) * 100
          : 0;
    return { usedKw, maxKw, minKw, pct, thresholdPct, envelopeKw, denied: rack.denied };
  }
  const n = Math.max(1, data?.active.racks_enabled || data?.racks_pool || data?.rack_count || 1);
  const usedKw = (data?.active.used_kw ?? data?.active.consumed_kw ?? 0) / n;
  const pct = maxKw > 0 ? (usedKw / maxKw) * 100 : 0;
  return { usedKw, maxKw, minKw, pct, thresholdPct, envelopeKw, denied: false };
}

export function Gb300PowerStencil({
  usedKw,
  maxKw,
  minKw = 0,
  thresholdPct = 80,
  envelopeKw,
  label = "GB300 Rack",
  mode = "full",
  off,
  denied,
  nodes,
  onSelectNode,
}: {
  usedKw: number;
  maxKw: number;
  minKw?: number;
  thresholdPct?: number;
  envelopeKw?: number;
  label?: string;
  mode?: "full" | "compact" | "elev" | "infra";
  off?: boolean;
  denied?: boolean;
  nodes?: StencilNodeHit[];
  onSelectNode?: (index: number) => void;
}) {
  const cap = Math.max(maxKw, 1);
  const pct = Math.max(0, Math.min(100, (usedKw / cap) * 100));
  const tone = denied ? "deny" : off ? "off" : pct >= 92 ? "hot" : pct >= 70 ? "busy" : "ok";
  const minP = minKw > 0 ? Math.max(0, Math.min(100, (minKw / cap) * 100)) : 0;

  return (
    <article className="gb300-stencil" data-mode={mode} data-tone={tone} data-off={off ? "true" : undefined}>
      {mode !== "compact" ? (
        <header className="gb300-stencil-head">
          <h2>{label}</h2>
          <p>
            {denied
              ? "No power budget"
              : `${formatRackKw(usedKw)} of ${formatRackKw(maxKw)} · ${Math.round(pct)}%`}
          </p>
        </header>
      ) : null}

      <div className="gb300-stencil-body">
        {mode === "full" ? (
          <ul className="gb300-callouts">
            {ZONES.map((z) => (
              <li
                key={z.id}
                data-tone={z.tone}
                style={{ top: `${z.top}%`, height: `${z.height}%` }}
              >
                <strong>{z.label}</strong>
                <span>{z.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="gb300-frame" aria-hidden={mode === "compact" && !onSelectNode ? true : undefined}>
          <div className="gb300-photo">
            {mode === "full"
              ? ZONES.map((z) => (
                  <i
                    key={z.id}
                    className="gb300-band"
                    data-tone={z.tone}
                    style={{ top: `${z.top}%`, height: `${z.height}%` }}
                  />
                ))
              : null}
            <img src={STENCIL} alt="SuperMicro GB300 NVL72 rack" />
            <span className="gb300-fill" style={{ height: `${pct}%` }} />
            {onSelectNode
              ? (nodes ?? []).map((n) => {
                  const box = nodeHitStyle(n.index);
                  if (!box) return null;
                  return (
                    <button
                      key={n.index}
                      type="button"
                      className="gb300-node-hit"
                      style={box}
                      data-slot={String(n.index)}
                      data-status={n.status || "empty"}
                      data-on={n.selected ? "true" : undefined}
                      title={n.title || `Node ${n.index}`}
                      aria-label={n.title || `Node ${n.index}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectNode(n.index);
                      }}
                    />
                  );
                })
              : null}
          </div>
        </div>

        <div
          className="gb300-usage"
          title={`${formatRackKw(usedKw)} used · max ${formatRackKw(maxKw)}`}
        >
          <span className="gb300-usage-max">Max {formatRackKw(maxKw)}</span>
          <div className="gb300-usage-track">
            {minP > 2 ? <i data-k="min" style={{ bottom: `${minP}%` }} /> : null}
            <i data-k="used" style={{ height: `${pct}%` }} />
          </div>
          <strong>
            {denied ? "—" : formatRackKw(usedKw)}
            <em>{denied ? "no budget" : `${Math.round(pct)}%`}</em>
          </strong>
        </div>
      </div>

      {mode === "full" ? (
        <footer className="gb300-stencil-foot">
          <dl>
            <div>
              <dt>Total nodes</dt>
              <dd>{NODES}</dd>
            </div>
            <div>
              <dt>NVSwitches</dt>
              <dd>{NVSWITCHES}</dd>
            </div>
            <div>
              <dt>NVLinks</dt>
              <dd>{NVLINKS.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Power shelves</dt>
              <dd>{POWER_SHELVES}</dd>
            </div>
            <div>
              <dt>Max GPU power</dt>
              <dd>{GPU_MAX_W.toLocaleString()} W</dd>
            </div>
            <div>
              <dt>Rack max power</dt>
              <dd>{formatKw(maxKw)}</dd>
            </div>
          </dl>
          <div className="gb300-consider">
            <strong>Power consideration</strong>
            <ul>
              {envelopeKw && envelopeKw > 0 ? (
                <li>
                  Pause if room power ≥ {formatKw(envelopeKw)} ({Math.round(thresholdPct)}% envelope)
                </li>
              ) : null}
              <li>800G two-rack Spine/Leaf</li>
              <li>
                Limiter band [{Math.round(minKw)}–{Math.round(maxKw)}] kW / rack
              </li>
            </ul>
          </div>
        </footer>
      ) : null}
    </article>
  );
}
