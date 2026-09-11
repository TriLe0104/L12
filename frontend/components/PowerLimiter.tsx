"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { PowerLimiter as PowerLimiterData, PowerRack, PowerShowcaseSlot } from "@/lib/cluster";
import { formatKw } from "@/lib/cluster";

function barPct(kw: number, tdp: number) {
  if (tdp <= 0) return 0;
  return Math.max(0, Math.min(100, (kw / tdp) * 100));
}

function Stack({
  consumed,
  unused,
  tdp,
  policyKw,
  denied,
  extra,
}: {
  consumed: number;
  unused: number;
  tdp: number;
  policyKw?: number;
  denied?: boolean;
  extra?: boolean;
}) {
  if (denied) {
    return (
      <div className="lps-stack" data-denied="true" title="No power budget for more rack">
        <span>No budget</span>
      </div>
    );
  }
  const mark = tdp > 0 && policyKw && policyKw > 0 ? barPct(policyKw, tdp) : 0;
  return (
    <div className="lps-stack" data-extra={extra ? "true" : undefined}>
      {mark > 0 ? <i className="lps-policy-mark" style={{ height: `${mark}%` }} title="Average share" /> : null}
      <i className="lps-unused" style={{ height: `${barPct(unused, tdp)}%` }} />
      <i className="lps-used" style={{ height: `${barPct(consumed, tdp)}%` }} />
    </div>
  );
}

function Slot({
  slot,
  side,
  maxKw,
  policyKw,
}: {
  slot: PowerShowcaseSlot;
  side: "static" | "dynamic";
  maxKw: number;
  policyKw: number;
}) {
  const row: PowerRack = slot[side];
  const tdp = maxKw || row.nameplate_kw || 120;
  const denied = side === "static" && (slot.additional || row.denied) && row.allocated_kw <= 0;
  return (
    <div
      className="lps-slot"
      data-side={side}
      data-consumed={Math.round(row.consumed_kw)}
      data-allocated={Math.round(row.allocated_kw)}
      data-tdp={Math.round(tdp)}
      data-extra={row.extra ? "true" : undefined}
      data-denied={denied ? "true" : undefined}
      title={
        denied
          ? `${slot.label} · no budget`
          : `${slot.label} · ${Math.round(row.consumed_kw)} consumed / ${Math.round(row.allocated_kw)} alloc / ${Math.round(tdp)} max kW`
      }
    >
      <Stack
        consumed={row.consumed_kw}
        unused={row.unused_kw}
        tdp={tdp}
        policyKw={policyKw || row.policy_kw}
        denied={denied}
        extra={row.extra}
      />
      <b>{denied ? "—" : `${Math.round(row.consumed_kw)} kW`}</b>
      <small>
        {slot.label}
        {denied ? "" : ` · ${Math.round(row.allocated_kw)}`}
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
          <dt>Floating</dt>
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
  envelope,
  racks,
  maxKw,
}: {
  used: number;
  available: number;
  floating: number;
  envelope: number;
  racks: PowerRack[];
  maxKw: number;
}) {
  const scale = Math.max(envelope, used + available + floating, 1);
  const pool = racks.filter((r) => r.enabled);
  const cols = [
    { key: "used", label: "Usage", kw: used, hint: "Workload consumption" },
    { key: "avail", label: "Available", kw: available, hint: "Allocated on racks, not consumed" },
    { key: "float", label: "Floating", kw: floating, hint: "Envelope not sitting on a rack" },
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
        {pool.map((r) => (
          <span
            key={r.id}
            title={`${r.label} · ${Math.round(r.consumed_kw)} used / ${Math.round(r.unused_kw)} avail / ${Math.round(r.allocated_kw)} alloc`}
          >
            <i data-k="u" style={{ height: `${barPct(r.unused_kw, maxKw)}%` }} />
            <i data-k="c" style={{ height: `${barPct(r.consumed_kw, maxKw)}%` }} />
          </span>
        ))}
        <em>{pool.length} rack{pool.length === 1 ? "" : "s"}</em>
      </div>
    </div>
  );
}

function Heat({ racks, maxKw }: { racks: PowerRack[]; maxKw: number }) {
  const on = racks.filter((r) => r.power_state !== "off");
  return (
    <div className="lps-heat" aria-label="All rack allocations">
      {on.map((r) => {
        const tdp = maxKw || r.nameplate_kw || 120;
        if (r.denied || r.allocated_kw <= 0) {
          return <span key={r.id} className="lps-heat-cell" data-k="deny" title={`${r.label} · no budget`} />;
        }
        return (
          <span
            key={r.id}
            className="lps-heat-cell"
            data-k={r.extra ? "extra" : "on"}
            title={`${r.label} · ${Math.round(r.consumed_kw)} consumed / ${Math.round(r.allocated_kw)} alloc / ${Math.round(tdp)} max kW`}
          >
            <i style={{ height: `${barPct(r.unused_kw, tdp)}%` }} data-k="u" />
            <i style={{ height: `${barPct(r.consumed_kw, tdp)}%` }} data-k="c" />
          </span>
        );
      })}
    </div>
  );
}

function mwText(kw: number) {
  const mw = kw / 1000;
  return mw >= 10 ? mw.toFixed(1) : mw.toFixed(2);
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
  const [racks, setRacks] = useState(String(data.rack_count ?? data.racks_on ?? 1));
  const [pct, setPct] = useState(String(Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80)));
  const [minKw, setMinKw] = useState(String(Math.round(data.min_rack_kw ?? 40)));
  const [rackKw, setRackKw] = useState(String(Math.round(data.max_rack_kw ?? 300)));
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setBudgetMw(mwText(data.total_budget_kw ?? data.default_budget_kw ?? 0));
    setRacks(String(data.rack_count ?? data.racks_on ?? 1));
    setPct(String(Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80)));
    setMinKw(String(Math.round(data.min_rack_kw ?? 40)));
    setRackKw(String(Math.round(data.max_rack_kw ?? 300)));
  }, [
    data.total_budget_kw,
    data.default_budget_kw,
    data.rack_count,
    data.racks_on,
    data.threshold_pct,
    data.stay_under_pct,
    data.min_rack_kw,
    data.max_rack_kw,
  ]);

  async function commit(
    nextMw = budgetMw,
    nextRacks = racks,
    nextPct = pct,
    nextMin = minKw,
    nextMax = rackKw,
  ) {
    const total_budget_kw = Math.min(135000, Math.max(100, Number(nextMw) * 1000));
    const rack_count = Math.round(Number(nextRacks));
    const stay_under_pct = Number(nextPct);
    const min_rack_kw = Number(nextMin);
    const max_rack_kw = Number(nextMax);
    if (![total_budget_kw, rack_count, stay_under_pct, min_rack_kw, max_rack_kw].every(Number.isFinite)) return;
    if (rack_count < 1 || rack_count > 2000) return;
    if (stay_under_pct < 10 || stay_under_pct > 100) return;
    if (min_rack_kw < 8 || max_rack_kw < 20 || max_rack_kw > 2000 || min_rack_kw > max_rack_kw) return;
    const sameBudget = Math.abs(total_budget_kw - (data.total_budget_kw ?? data.default_budget_kw ?? 0)) < 50;
    const sameRacks = rack_count === (data.rack_count ?? data.racks_on);
    const samePct = stay_under_pct === (data.threshold_pct ?? data.stay_under_pct);
    const sameMin = min_rack_kw === data.min_rack_kw;
    const sameMax = max_rack_kw === data.max_rack_kw;
    if (sameBudget && sameRacks && samePct && sameMin && sameMax) return;
    try {
      const res = await api.patchClusterPower({
        total_budget_kw,
        rack_count,
        stay_under_pct,
        min_rack_kw,
        max_rack_kw,
        reset: true,
      });
      onChange?.(res);
    } catch {
      /* keep local fields; next poll restores server values */
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => {
      void commit(budgetMw, racks, pct, minKw, rackKw);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    budgetMw,
    racks,
    pct,
    minKw,
    rackKw,
    data.total_budget_kw,
    data.rack_count,
    data.threshold_pct,
    data.min_rack_kw,
    data.max_rack_kw,
  ]);

  function bind(setter: (v: string) => void) {
    return {
      disabled: locked,
      onChange: (e: { target: { value: string } }) => setter(e.target.value),
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
        void commit();
      },
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        }
      },
    };
  }

  const nLocal = Math.max(1, Math.round(Number(racks)) || 1);
  const pctLocal = Number(pct);
  const minLocal = Number(minKw);
  const maxLocal = Number(rackKw);
  const totalLocal = Number(budgetMw) * 1000;
  const envLocal = Number.isFinite(totalLocal) && Number.isFinite(pctLocal) ? (totalLocal * pctLocal) / 100 : 0;
  const rawLocal = envLocal / nLocal;
  const shareLocal =
    Number.isFinite(rawLocal) && Number.isFinite(minLocal) && Number.isFinite(maxLocal)
      ? Math.min(maxLocal, Math.max(minLocal, rawLocal))
      : data.rack_policy_kw ?? 0;
  const unused = Math.max(0, envLocal - shareLocal * nLocal);
  const capped = rawLocal > shareLocal + 0.5;
  const source = data.power_source === "breaker" ? "smart breaker" : "manual";

  return (
    <form
      className="lps-policy"
      data-compact={compact ? "true" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <label>
        Total power
        <span className="lps-policy-pct">
          <input
            type="number"
            min={0.1}
            max={135}
            step={0.1}
            value={budgetMw}
            aria-label="Total power in megawatts"
            {...bind(setBudgetMw)}
          />
          MW
        </span>
      </label>
      <label>
        Threshold
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
      </label>
      <label>
        Racks
        <input
          type="number"
          min={1}
          max={2000}
          step={1}
          value={racks}
          aria-label="Number of racks to distribute the budget across"
          {...bind(setRacks)}
        />
      </label>
      <label>
        Min kW / rack
        <input
          type="number"
          min={8}
          max={2000}
          step={5}
          value={minKw}
          aria-label="Minimum kilowatts per rack"
          {...bind(setMinKw)}
        />
      </label>
      <label>
        Max kW / rack
        <input
          type="number"
          min={20}
          max={2000}
          step={10}
          value={rackKw}
          aria-label="Maximum kilowatts per rack"
          {...bind(setRackKw)}
        />
      </label>
      <p>
        Default {formatKw(shareLocal)} / rack = ({formatKw(Number.isFinite(totalLocal) ? totalLocal : 0)} × {Number.isFinite(pctLocal) ? Math.round(pctLocal) : 0}%) / {nLocal}
        {capped ? " · clamped to max" : ""}
        {unused > 50 ? ` · ${formatKw(unused)} floating` : ""}
        {` · envelope ${formatKw(envLocal)} · ${source}`}
      </p>
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
  const extraLabel =
    extraN > 0
      ? `${extraN} extra rack${extraN === 1 ? "" : "s"} from leftover envelope`
      : `Share ${formatKw(data.rack_policy_kw ?? data.rack_avg_kw ?? data.tdp_kw)} per rack`;
  const maxKw = data.max_rack_kw ?? data.rack_hard_kw ?? 300;
  const policyKw = data.rack_policy_kw ?? data.rack_avg_kw ?? (maxKw * (data.stay_under_pct ?? 80)) / 100;
  const nRacks = data.racks_pool ?? data.rack_count ?? data.racks_on ?? 0;
  const envelope = data.envelope_kw ?? data.budget_kw;

  return (
    <section className="lps-row">
      <div className="lps-toolbar">
        <div>
          <strong>Closed-loop power limiter</strong>
          <span>
            {formatKw(data.total_budget_kw ?? data.budget_kw)} × {Math.round(data.threshold_pct ?? data.stay_under_pct ?? 80)}% · {nRacks} racks · default{" "}
            {formatKw(data.rack_policy_kw ?? data.rack_avg_kw ?? 0)} · [{Math.round(data.min_rack_kw ?? 40)}–{Math.round(data.max_rack_kw ?? 300)}] kW
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
            MaxLPS
          </button>
          <button type="button" disabled={locked} onClick={() => setMode("dynamic", true)}>
            Replay
          </button>
        </div>
      </div>

      <article className="lps-panel" data-active={data.mode === "static"}>
        <Totals
          title="Static power allocation"
          kicker={`${nRacks} racks · envelope ${formatKw(data.static.budget_kw)}`}
          used={data.static.used_kw ?? data.static.consumed_kw}
          available={data.static.available_kw ?? data.static.stranded_kw}
          floating={data.static.floating_kw ?? data.static.headroom_kw}
          extra={`[${Math.round(data.min_rack_kw ?? 40)}–${Math.round(data.max_rack_kw ?? 300)}] kW`}
        />
        <SummaryBars
          used={data.static.used_kw ?? data.static.consumed_kw}
          available={data.static.available_kw ?? data.static.stranded_kw}
          floating={data.static.floating_kw ?? data.static.headroom_kw}
          envelope={envelope}
          racks={data.static_racks ?? []}
          maxKw={maxKw}
        />
      </article>

      <article className="lps-panel" data-kind="dyn" data-active={data.mode === "dynamic"}>
        <Totals
          title="MaxLPS dynamic allocation"
          kicker={`${nRacks} racks · live ${formatKw(data.budget_kw)} · default ${formatKw(policyKw)}`}
          used={data.dynamic.used_kw ?? data.dynamic.consumed_kw}
          available={data.dynamic.available_kw ?? data.dynamic.stranded_kw}
          floating={data.dynamic.floating_kw ?? data.dynamic.headroom_kw}
          extra={extraLabel}
        />
        <SummaryBars
          used={data.dynamic.used_kw ?? data.dynamic.consumed_kw}
          available={data.dynamic.available_kw ?? data.dynamic.stranded_kw}
          floating={data.dynamic.floating_kw ?? data.dynamic.headroom_kw}
          envelope={envelope}
          racks={data.dynamic_racks ?? []}
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
        <Heat racks={(data.racks ?? []).filter((r) => r.enabled)} maxKw={maxKw} />
        <p className="lps-legend">
          <i data-k="c" /> Usage
          <i data-k="u" /> Available
          <i data-k="f" /> Floating
        </p>
      </aside>
    </section>
  );
}

export function usePowerLimiter(active: boolean) {
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
    const id = window.setInterval(load, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  const byId = useMemo(() => {
    const map: Record<string, PowerRack> = {};
    for (const r of data?.racks ?? []) map[r.id] = r;
    return map;
  }, [data]);

  return { data, error, setData, byId };
}
