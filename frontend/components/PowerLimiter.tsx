"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import type { PowerLimiter as PowerLimiterData, PowerRack, PowerShowcaseSlot } from "@/lib/cluster";
import { formatKw } from "@/lib/cluster";

function barPct(kw: number, tdp: number) {
  if (tdp <= 0) return 0;
  return Math.max(0, Math.min(100, (kw / tdp) * 100));
}

/** Actual usage as a percent of control-loop max kW. */
function usageInLoop(consumed: number, _minKw: number, maxKw: number, fallbackPct?: number) {
  if (fallbackPct != null && Number.isFinite(fallbackPct)) {
    return Math.max(0, Math.min(100, fallbackPct));
  }
  if (!(maxKw > 0)) return 0;
  return Math.max(0, Math.min(100, (consumed / maxKw) * 100));
}

function limPct(kw: number, maxKw: number) {
  if (!(maxKw > 0)) return 0;
  return Math.max(0, Math.min(100, (kw / maxKw) * 100));
}

function RackLimiter({
  consumed,
  allocated,
  minKw,
  maxKw,
  usagePct,
  extra,
  denied,
  label,
}: {
  consumed: number;
  allocated: number;
  minKw: number;
  maxKw: number;
  usagePct?: number;
  extra?: boolean;
  denied?: boolean;
  label: string;
}) {
  if (denied) {
    return <span className="lps-heat-cell" data-k="deny" title={`${label} · no budget`} />;
  }
  const used = usageInLoop(consumed, minKw, maxKw, usagePct);
  const minP = limPct(minKw, maxKw);
  const limP = limPct(allocated, maxKw);
  const atMin = consumed <= minKw + 1.5;
  const atMax = consumed >= maxKw - 1.5;
  return (
    <span
      className="lps-heat-cell"
      data-k={extra ? "extra" : "on"}
      data-lim={atMax ? "max" : atMin ? "min" : "mid"}
      title={`${label} · ${Math.round(consumed)} kW used · ${Math.round(allocated)} kW limit · [${Math.round(minKw)}–${Math.round(maxKw)}] kW`}
    >
      {minP > 2 ? <i data-k="floor" style={{ height: `${minP}%` }} /> : null}
      <i data-k="c" style={{ height: `${used}%` }} />
      {minP > 2 ? <i data-k="min" style={{ bottom: `${minP}%` }} /> : null}
      {limP > 2 && Math.abs(limP - minP) > 3 && Math.abs(limP - 100) > 3 ? (
        <i data-k="lim" style={{ bottom: `${limP}%` }} />
      ) : null}
      <i data-k="max" />
    </span>
  );
}

function Stack({
  consumed,
  minKw,
  maxKw,
  policyKw,
  denied,
  extra,
  usagePct,
}: {
  consumed: number;
  minKw: number;
  maxKw: number;
  policyKw?: number;
  denied?: boolean;
  extra?: boolean;
  usagePct?: number;
}) {
  if (denied) {
    return (
      <div className="lps-stack" data-denied="true" title="No power budget for more rack">
        <span>No budget</span>
      </div>
    );
  }
  const used = usageInLoop(consumed, minKw, maxKw, usagePct);
  const mark = policyKw && policyKw > 0 ? usageInLoop(policyKw, minKw, maxKw) : 0;
  return (
    <div className="lps-stack" data-extra={extra ? "true" : undefined}>
      {mark > 0 ? <i className="lps-policy-mark" style={{ height: `${mark}%` }} title="Default share" /> : null}
      <i className="lps-used" style={{ height: `${used}%` }} />
    </div>
  );
}

function Slot({
  slot,
  side,
  minKw,
  maxKw,
  policyKw,
}: {
  slot: PowerShowcaseSlot;
  side: "static" | "dynamic";
  minKw: number;
  maxKw: number;
  policyKw: number;
}) {
  const row: PowerRack = slot[side];
  const hi = maxKw || row.max_kw || row.nameplate_kw || 120;
  const lo = minKw || row.min_kw || 0;
  const denied = side === "static" && (slot.additional || row.denied) && row.allocated_kw <= 0;
  const pct = usageInLoop(row.consumed_kw, lo, hi, row.usage_pct);
  return (
    <div
      className="lps-slot"
      data-side={side}
      data-consumed={Math.round(row.consumed_kw)}
      data-allocated={Math.round(row.allocated_kw)}
      data-tdp={Math.round(hi)}
      data-extra={row.extra ? "true" : undefined}
      data-denied={denied ? "true" : undefined}
      title={
        denied
          ? `${slot.label} · no budget`
          : `${slot.label} · ${Math.round(row.consumed_kw)} kW · ${Math.round(pct)}% of [${Math.round(lo)}–${Math.round(hi)}] kW`
      }
    >
      <Stack
        consumed={row.consumed_kw}
        minKw={lo}
        maxKw={hi}
        policyKw={policyKw || row.policy_kw}
        denied={denied}
        extra={row.extra}
        usagePct={row.usage_pct}
      />
      <b>{denied ? "—" : `${Math.round(row.consumed_kw)} kW`}</b>
      <small>
        {slot.label}
        {denied ? "" : ` · ${Math.round(pct)}%`}
      </small>
    </div>
  );
}

function Totals({
  title,
  kicker,
  used,
  available,
  floating,
  extra,
}: {
  title: string;
  kicker: string;
  used: number;
  available: number;
  floating: number;
  extra?: string;
}) {
  return (
    <header className="lps-head">
      <h2>{title}</h2>
      <p>
        {kicker}
        {extra ? ` · ${extra}` : ""}
      </p>
      <dl>
        <div>
          <dt>Usage</dt>
          <dd>{formatKw(used)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{formatKw(available)}</dd>
        </div>
        <div>
          <dt>Room to max</dt>
          <dd>{formatKw(floating)}</dd>
        </div>
      </dl>
    </header>
  );
}

function SummaryBars({
  used,
  available,
  floating,
  placeable,
  surplus,
  racks,
  minKw,
  maxKw,
}: {
  used: number;
  available: number;
  floating: number;
  placeable: number;
  surplus: number;
  racks: PowerRack[];
  minKw: number;
  maxKw: number;
}) {
  const scale = Math.max(placeable, used + available + floating, 1);
  const pool = racks.filter((r) => r.enabled);
  const cols = [
    { key: "used", label: "Usage", kw: used, hint: "Power the workloads are drawing" },
    { key: "avail", label: "Available", kw: available, hint: "Allocated on racks but not consumed — Dynamic Power Mode can move this" },
    { key: "float", label: "Room to max", kw: floating, hint: "Still under max kW/rack — can land on these racks" },
  ];
  return (
    <div className="lps-summary">
      {cols.map((c) => (
        <div key={c.key} className="lps-sum-col" title={`${c.hint} · ${formatKw(c.kw)}`}>
          <div className="lps-stack" data-k={c.key}>
            <i className={`lps-${c.key === "used" ? "used" : c.key === "avail" ? "unused" : "float"}`} style={{ height: `${barPct(c.kw, scale)}%` }} />
          </div>
          <b>{formatKw(c.kw)}</b>
          <small>{c.label}</small>
        </div>
      ))}
      <div className="lps-rack-strip" aria-label={`${pool.length} racks in the pool`}>
        {pool.map((r) => {
          const lo = r.min_kw ?? minKw;
          const hi = r.max_kw ?? maxKw;
          return (
            <RackLimiter
              key={r.id}
              label={r.label}
              consumed={r.consumed_kw}
              allocated={r.allocated_kw}
              minKw={lo}
              maxKw={hi}
              usagePct={r.usage_pct}
              extra={r.extra}
            />
          );
        })}
        <em>{pool.length} rack{pool.length === 1 ? "" : "s"}</em>
      </div>
      {surplus > 50 ? (
        <p className="lps-surplus">
          {formatKw(surplus)} over max kW/rack — cannot land unless you raise max or add racks
        </p>
      ) : null}
    </div>
  );
}

function Heat({ racks, minKw, maxKw }: { racks: PowerRack[]; minKw: number; maxKw: number }) {
  const on = racks.filter((r) => r.power_state !== "off");
  return (
    <div className="lps-heat" aria-label="Rack usage in the min–max limiter band">
      {on.map((r) => (
        <RackLimiter
          key={r.id}
          label={r.label}
          consumed={r.consumed_kw}
          allocated={r.allocated_kw}
          minKw={minKw || r.min_kw || 0}
          maxKw={maxKw || r.max_kw || r.nameplate_kw || 120}
          usagePct={r.usage_pct}
          extra={r.extra}
          denied={r.denied || r.allocated_kw <= 0}
        />
      ))}
    </div>
  );
}

function mwText(kw: number) {
  const mw = kw / 1000;
  return mw >= 10 ? mw.toFixed(1) : mw.toFixed(2);
}

function fitRacks(envKw: number, perKw: number, live: number) {
  if (!(perKw > 0) || !(envKw > 0)) return 0;
  const fit = Math.floor(envKw / perKw);
  if (live > 0) return Math.max(0, Math.min(fit, live));
  return Math.max(0, fit);
}

function placeTip(field: HTMLElement, tip: HTMLElement) {
  const pad = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.min(280, Math.max(160, vw - pad * 2));
  tip.style.position = "fixed";
  tip.style.width = `${maxW}px`;
  tip.style.maxWidth = `${maxW}px`;
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.style.right = "auto";
  tip.style.bottom = "auto";
  tip.style.transform = "none";
  tip.style.maxHeight = `${vh - pad * 2}px`;
  const r = field.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const spaceLeft = r.left - pad;
  const spaceRight = vw - r.right - pad;
  let left = spaceLeft >= tw + 6 || spaceLeft >= spaceRight ? r.left - tw - 8 : r.right + 8;
  left = Math.min(Math.max(pad, left), vw - tw - pad);
  let top = r.top;
  if (top + th > vh - pad) top = vh - th - pad;
  if (top < pad) top = pad;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function PolicyField({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: ReactNode;
}) {
  const fieldRef = useRef<HTMLLabelElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);

  function showTip() {
    const field = fieldRef.current;
    const box = tipRef.current;
    if (!field || !box) return;
    placeTip(field, box);
  }

  return (
    <label className="lps-field" ref={fieldRef} onMouseEnter={showTip} onFocus={showTip}>
      <span className="lps-field-name">{label}</span>
      {children}
      <span className="lps-tip" ref={tipRef} role="tooltip">
        {tip}
      </span>
    </label>
  );
}

export function PowerPolicyFields({
  data,
  onChange,
  locked,
  compact,
}: {
  data: PowerLimiterData;
  onChange?: (next: PowerLimiterData) => void;
  locked?: boolean;
  compact?: boolean;
}) {
  const totalKw = data.total_budget_kw ?? data.default_budget_kw ?? 0;
  const [budgetMw, setBudgetMw] = useState(mwText(totalKw));
  const [pct, setPct] = useState(String(Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80)));
  const [minKw, setMinKw] = useState(String(Math.round(data.min_rack_kw ?? 40)));
  const [rackKw, setRackKw] = useState(String(Math.round(data.max_rack_kw ?? 135)));
  const [nRacks, setNRacks] = useState(String(data.racks_wanted ?? data.racks_pool ?? ""));
  const editing = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (editing.current) return;
    const nextMw = data.total_budget_kw ?? data.default_budget_kw ?? 0;
    if (Math.abs(Number(budgetMw) * 1000 - nextMw) >= 50) setBudgetMw(mwText(nextMw));
    const nextPct = String(Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80));
    if (nextPct !== pct) setPct(nextPct);
    const nextMin = String(Math.round(data.min_rack_kw ?? 40));
    if (nextMin !== minKw) setMinKw(nextMin);
    const nextMax = String(Math.round(data.max_rack_kw ?? 135));
    if (nextMax !== rackKw) setRackKw(nextMax);
    const nextN = String(data.racks_wanted ?? data.racks_pool ?? "");
    if (nextN && nextN !== nRacks) setNRacks(nextN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.total_budget_kw,
    data.default_budget_kw,
    data.threshold_pct,
    data.stay_under_pct,
    data.min_rack_kw,
    data.max_rack_kw,
    data.racks_wanted,
    data.racks_pool,
  ]);

  async function commit(
    nextMw = budgetMw,
    nextPct = pct,
    nextMin = minKw,
    nextMax = rackKw,
    nextN = nRacks,
  ) {
    const total_budget_kw = Math.min(10_000_000, Math.max(100, Number(nextMw) * 1000));
    const stay_under_pct = Number(nextPct);
    const min_rack_kw = Number(nextMin);
    const max_rack_kw = Number(nextMax);
    const env = (total_budget_kw * stay_under_pct) / 100;
    const nHi = min_rack_kw > 0 ? Math.floor(env / min_rack_kw) : 0;
    const rawN = Number(nextN);
    let rack_count = Number.NaN;
    if (nextN !== "" && Number.isFinite(rawN) && rawN > 0 && nHi > 0) {
      rack_count = Math.max(1, Math.min(nHi, Math.round(rawN)));
    }
    if (![total_budget_kw, stay_under_pct, min_rack_kw, max_rack_kw].every(Number.isFinite)) return;
    if (stay_under_pct < 10 || stay_under_pct > 100) return;
    if (min_rack_kw < 8 || max_rack_kw < 20 || max_rack_kw > 2000 || min_rack_kw > max_rack_kw) return;
    const sameBudget = Math.abs(total_budget_kw - (data.total_budget_kw ?? data.default_budget_kw ?? 0)) < 50;
    const samePct = stay_under_pct === (data.threshold_pct ?? data.stay_under_pct);
    const sameMin = min_rack_kw === data.min_rack_kw;
    const sameMax = max_rack_kw === data.max_rack_kw;
    const sameN = Number.isFinite(rack_count) && rack_count === (data.racks_wanted ?? data.racks_pool);
    if (sameBudget && samePct && sameMin && sameMax && sameN) return;
    try {
      const res = await api.patchClusterPower({
        total_budget_kw,
        stay_under_pct,
        min_rack_kw,
        max_rack_kw,
        ...(Number.isFinite(rack_count) ? { rack_count } : {}),
      });
      onChange?.(res);
    } catch {
      /* keep local fields; next poll restores server values */
    }
  }

  function bind(setter: (v: string) => void) {
    return {
      disabled: locked,
      onChange: (e: { target: { value: string } }) => setter(e.target.value),
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        }
      },
    };
  }

  const pctLocal = Number(pct);
  const minLocal = Number(minKw);
  const maxLocal = Number(rackKw);
  const totalLocal = Number(budgetMw) * 1000;
  const envLocal = Number.isFinite(totalLocal) && Number.isFinite(pctLocal) ? (totalLocal * pctLocal) / 100 : 0;
  const nMin =
    Number.isFinite(maxLocal) && maxLocal > 0 ? Math.max(0, Math.floor(envLocal / maxLocal)) : 0;
  const nMax =
    Number.isFinite(minLocal) && minLocal > 0 ? Math.max(0, Math.floor(envLocal / minLocal)) : 0;

  useEffect(() => {
    if (editing.current) return;
    const n = Number(nRacks);
    if (!Number.isFinite(n) || nRacks === "") return;
    if (n > nMax) setNRacks(String(nMax));
  }, [nMax, nRacks]);

  return (
    <form
      ref={formRef}
      className="lps-policy"
      data-compact={compact ? "true" : undefined}
      onFocusCapture={() => {
        editing.current = true;
      }}
      onBlurCapture={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && formRef.current?.contains(next)) return;
        editing.current = false;
        void commit();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <PolicyField
        label="Total power"
        tip="Site budget for this cluster. Every rack and GPU stays under this cap."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={0.1}
            max={10000}
            step={0.1}
            value={budgetMw}
            aria-label="Total power in megawatts"
            {...bind(setBudgetMw)}
          />
          MW
        </span>
      </PolicyField>
      <PolicyField
        label="Threshold"
        tip="How much of the budget you actually allow to run. The rest is spare headroom for spikes."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={10}
            max={100}
            step={1}
            value={pct}
            aria-label="Threshold percentage of total power"
            {...bind(setPct)}
          />
          %
        </span>
      </PolicyField>
      <PolicyField
        label="Min kW / rack"
        tip="Lowest power a fed rack may sit at. A lower floor lets more racks stay on."
      >
        <input
          type="number"
          min={8}
          max={2000}
          step={5}
          value={minKw}
          aria-label="Minimum kilowatts per rack"
          {...bind(setMinKw)}
        />
      </PolicyField>
      <PolicyField
        label="Max kW / rack"
        tip="Highest power a rack may draw. Static mode runs every fed rack at this level."
      >
        <input
          type="number"
          min={20}
          max={2000}
          step={5}
          value={rackKw}
          aria-label="Maximum kilowatts per rack"
          {...bind(setRackKw)}
        />
      </PolicyField>
      <PolicyField
        label="Racks"
        tip="Suggested range from this budget: fewest at max kW/rack, most at min kW/rack. You can go below the low number; you cannot go above the high number."
      >
        <span className="lps-policy-pct">
          <input
            type="number"
            min={1}
            max={Math.max(1, nMax)}
            step={1}
            value={nRacks}
            aria-label="Number of racks to feed"
            onChange={(e) => {
              const raw = e.target.value;
              const n = Number(raw);
              if (!Number.isFinite(n) || raw === "") {
                setNRacks(raw);
                return;
              }
              const hi = Math.max(1, nMax);
              setNRacks(String(Math.max(1, Math.min(hi, Math.round(n)))));
            }}
            disabled={locked}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <small className="lps-field-hint">
            {nMin}–{nMax}
          </small>
        </span>
      </PolicyField>
    </form>
  );
}

export function PowerLimiterPanel({
  data,
  onChange,
  busy,
}: {
  data: PowerLimiterData | null;
  onChange?: (next: PowerLimiterData) => void;
  busy?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const locked = busy || pending;

  async function setMode(mode: "static" | "dynamic", reset = false) {
    setPending(true);
    try {
      const next = await api.patchClusterPower({ mode, reset });
      onChange?.(next);
    } finally {
      setPending(false);
    }
  }

  if (!data) return <section className="lps-row lps-pending">Loading power limiter…</section>;

  const extraN = data.dynamic.racks_extra ?? 0;
  const nStatic = data.racks_static_max ?? data.static.racks_enabled ?? 0;
  const nLps = data.racks_lps_max ?? 0;
  const gain = data.racks_lps_gain ?? Math.max(0, nLps - nStatic);
  const extraLabel =
    extraN > 0
      ? `${extraN} extra rack${extraN === 1 ? "" : "s"} vs static · ${data.dynamic.racks_enabled ?? 0} of ${nLps} Dynamic Power Mode`
      : `Dynamic Power Mode ${nLps} racks vs static ${nStatic}${gain > 0 ? ` · +${gain}` : ""}`;
  const maxKw = data.max_rack_kw ?? data.rack_hard_kw ?? 300;
  const minKw = data.min_rack_kw ?? 40;
  const envelope = data.envelope_kw ?? ((data.total_budget_kw ?? 0) * (data.threshold_pct ?? data.stay_under_pct ?? 80)) / 100;
  const staticUsed = data.static.used_kw ?? data.static.consumed_kw;
  const staticAvail = data.static.available_kw ?? data.static.stranded_kw;
  const staticPlace = data.static.placeable_kw ?? Math.min(envelope, (data.static.racks_enabled || nStatic) * maxKw);
  const staticFloat = data.static.floating_kw ?? Math.max(0, staticPlace - (data.static.allocated_kw ?? staticUsed + staticAvail));
  const staticSurplus = data.static.surplus_kw ?? Math.max(0, envelope - staticPlace);
  const dynUsed = data.dynamic.used_kw ?? data.dynamic.consumed_kw;
  const dynAvail = data.dynamic.available_kw ?? data.dynamic.stranded_kw;
  const dynPlace = data.dynamic.placeable_kw ?? Math.min(envelope, (data.dynamic.racks_enabled || nLps) * maxKw);
  const dynFloat = data.dynamic.floating_kw ?? Math.max(0, dynPlace - (data.dynamic.allocated_kw ?? dynUsed + dynAvail));
  const dynSurplus = data.dynamic.surplus_kw ?? Math.max(0, envelope - dynPlace);

  return (
    <section className="lps-row">
      <div className="lps-toolbar">
        <div>
          <strong>Closed-loop power limiter</strong>
          <span>
            {formatKw(data.total_budget_kw ?? data.budget_kw)} × {Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80)}% · static {nStatic} · Dynamic Power Mode {nLps}
            {gain > 0 ? ` (+${gain})` : ""} · [{Math.round(minKw)}–{Math.round(maxKw)}] kW
          </span>
        </div>
        <div className="lps-modes">
          <button type="button" data-active={data.mode === "static"} disabled={locked} onClick={() => setMode("static")}>
            Static
          </button>
          <button
            type="button"
            data-active={data.mode === "dynamic"}
            disabled={locked}
            onClick={() => setMode("dynamic")}
          >
            Dynamic Power Mode
          </button>
          <button type="button" disabled={locked} onClick={() => setMode("dynamic", true)}>
            Replay
          </button>
        </div>
      </div>

      <article className="lps-panel" data-active={data.mode === "static"}>
        <Totals
          title="Static power allocation"
          kicker={`${nStatic} racks at max · ${formatKw(data.total_budget_kw ?? 0)} × ${Math.round(data.threshold_pct ?? 80)}% = ${formatKw(envelope)}`}
          used={staticUsed}
          available={staticAvail}
          floating={staticFloat}
          extra={`[${Math.round(minKw)}–${Math.round(maxKw)}] kW`}
        />
        <SummaryBars
          used={staticUsed}
          available={staticAvail}
          floating={staticFloat}
          placeable={staticPlace}
          surplus={staticSurplus}
          racks={data.static_racks ?? []}
          minKw={minKw}
          maxKw={maxKw}
        />
      </article>

      <article className="lps-panel" data-kind="dyn" data-active={data.mode === "dynamic"}>
        <Totals
          title="Dynamic Power Mode allocation"
          kicker={`${data.dynamic.racks_enabled ?? 0} of ${nLps} Dynamic Power Mode racks · +${gain} vs static ${nStatic} · ${formatKw(envelope)} envelope`}
          used={dynUsed}
          available={dynAvail}
          floating={dynFloat}
          extra={extraLabel}
        />
        <SummaryBars
          used={dynUsed}
          available={dynAvail}
          floating={dynFloat}
          placeable={dynPlace}
          surplus={dynSurplus}
          racks={data.dynamic_racks ?? []}
          minKw={minKw}
          maxKw={maxKw}
        />
      </article>

      <aside className="lps-loop">
        <h2>Control loop</h2>
        <PowerPolicyFields data={data} onChange={onChange} locked={locked} />
        <dl>
          <div>
            <dt>Reduce</dt>
            <dd>{data.active.actions.reduce ?? 0}</dd>
          </div>
          <div>
            <dt>Hold</dt>
            <dd>{data.active.actions.hold ?? 0}</dd>
          </div>
          <div>
            <dt>Increase</dt>
            <dd>{data.active.actions.increase ?? 0}</dd>
          </div>
          <div>
            <dt>Enable</dt>
            <dd>{data.active.actions.enable ?? 0}</dd>
          </div>
        </dl>
        <p className="lps-event">
          tick {data.tick}
          {data.last_event ? ` · ${data.last_event}` : ""}
        </p>
        <Heat racks={(data.racks ?? []).filter((r) => r.enabled)} minKw={minKw} maxKw={maxKw} />
        <p className="lps-legend">
          <i data-k="c" /> Usage
          <i data-k="min" /> Min
          <i data-k="max" /> Max
          <i data-k="lim" /> Limit
        </p>
      </aside>
    </section>
  );
}

export function usePowerLimiter(active: boolean, intervalMs = 1200) {
  const [data, setData] = useState<PowerLimiterData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () => {
      api
        .clusterPower()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Power limiter failed");
        });
    };
    load();
    if (!(intervalMs > 0)) {
      return () => {
        cancelled = true;
      };
    }
    const id = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, intervalMs]);

  const byId = useMemo(() => {
    const map: Record<string, PowerRack> = {};
    for (const r of data?.racks ?? []) map[r.id] = r;
    return map;
  }, [data]);

  return { data, error, setData, byId };
}
